import type { ScenarioContext } from './outline.ts';

interface ChapterDto {
  id: string;
  body: string;
  rev: number;
  title: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

/** T9：编辑与三层防丢稿（ADR-004）。在 outlineScenario 之后运行（作品库中已有一部作品）。 */
export async function editorScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, note, shot } = ctx;
  await d.eval(`document.querySelector('[data-testid="work-card"]').click()`);
  await d.waitFor(`document.querySelector('.cm-content')`, '打开作品后显示编辑器');
  const workId = await d.eval<string>(`location.pathname.split('/')[2]`);
  const chapterId = await d.eval<string>(`location.pathname.split('/')[3]`);
  const C = `/api/works/${workId}/chapters/${chapterId}`;
  const server = (): Promise<ChapterDto> => d.fetchJson<ChapterDto>(C);
  const status = (): Promise<string> => d.eval<string>(`document.querySelector('[data-testid="save-status"]')?.dataset.status ?? ''`);
  let step = '输入与自动保存';
  /** 超时时报告所在步骤与当前状态（强杀 / 重启相关的步骤偶发超时，便于判断是哪一步、卡在什么状态）。 */
  const waitStatus = async (s: string, ms = 8000): Promise<void> => {
    try {
      await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === ${JSON.stringify(s)}`, `保存状态变为 ${s}`, ms);
    } catch {
      const now = await d.eval<string>(`document.querySelector('[data-testid="save-status"]')?.innerText ?? '（无）'`).catch(() => '（读取失败）');
      throw new Error(`等待超时：「${step}」中保存状态未在 ${ms} ms 内变为 ${s}，当前「${now}」`);
    }
  };

  // 1. 输入 + 输入法组字 + 自动保存
  await d.focusEditorEnd();
  await d.insertText('第一段正文。');
  await d.press('Enter');
  await d.imeType(['n', 'ni', 'ni h', 'ni ha', 'ni hao'], '你好');
  await d.insertText('，世界！');
  await waitStatus('dirty', 1000);
  await waitStatus('saved', 5000);
  let s = await server();
  ok(s.body === '第一段正文。\n你好，世界！', `输入（含模拟输入法组字「ni hao」→「你好」）后 1.5 s 自动保存，服务端正文逐字一致`);
  ok((await d.eval<string>(`document.querySelector('[data-testid="word-count"]').textContent`)) === '12 字', '字数实时统计为 12 字');

  // 2. 强杀进程：草稿兜底 → 离线继续写 → 重启后自动同步
  step = '强杀后离线继续写、重启后自动同步';
  await d.focusEditorEnd();
  await d.insertText('强杀前写的。');
  await sleep(500);
  await ctx.killServer();
  await waitStatus('offline', 6000);
  ok((await d.eval<string>(`document.querySelector('[data-testid="save-status"]').textContent`)).includes('未连接'), '强杀进程后编辑器显示「未连接，内容已存在浏览器草稿」');
  await d.focusEditorEnd();
  await d.insertText('离线时继续写。');
  await sleep(400);
  await ctx.startServer();
  await waitStatus('saved', 12_000);
  s = await server();
  ok(s.body.endsWith('强杀前写的。离线时继续写。'), '重启服务后自动重试保存，强杀前与离线期间写的内容都完好');

  // 3. 关闭标签页（服务不可达，keepalive 失败）→ 重新打开时从草稿自动恢复
  step = '关页后从草稿自动恢复';
  await ctx.killServer();
  await d.focusEditorEnd();
  await d.insertText('关页前的草稿。');
  await sleep(500);
  const reopenUrl = await d.eval<string>('location.href');
  await d.navigate('about:blank');
  // 关页时的 keepalive 请求在 Windows 上会持续重连 1～2 s，若服务在此期间重启，请求会成功送达（同样不丢稿）。
  // 这里等它彻底失败，专门验证「只剩草稿」的恢复路径。
  await sleep(5000);
  await ctx.startServer();
  await d.navigate(`${ctx.origin}/settings?tab=about`);
  await d.waitText('数据目录');
  const beforeReopen = await server();
  await d.navigate(reopenUrl);
  await d.waitFor(`document.querySelector('[data-testid="chapter-editor"]')?.dataset.recovery`, '重新打开章节并完成草稿检查');
  const decision = await d.eval<string>(`document.querySelector('[data-testid="chapter-editor"]').dataset.recovery`);
  ok(!beforeReopen.body.endsWith('关页前的草稿。'), '关页时服务不可达，内容此时只存在浏览器草稿中');
  ok(decision === 'restore', `重新打开时草稿恢复决策为 restore（实际 ${decision}）`);
  await waitStatus('saved', 6000);
  s = await server();
  ok(s.body.endsWith('关页前的草稿。'), '草稿自动恢复并保存到服务端');

  // 4. 多标签页冲突：本地未保存期间，另一端（同一接口）先保存
  const allow409 = ctx.allowNetworkLog(/status of 409 \(Conflict\)/);
  await d.focusEditorEnd();
  await d.insertText('本页的修改。');
  await d.eval(`fetch(${JSON.stringify(C)}).then(r => r.json()).then(c => fetch(${JSON.stringify(`${C}/body`)}, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: c.body + '另一标签页的修改。', baseRev: c.rev }) }))`);
  await d.waitFor(`document.querySelector('[data-testid="compare-modal"]')`, '出现冲突对话框', 6000);
  const left = await d.eval<string>(`document.querySelector('[data-testid="compare-left"]').textContent`);
  const right = await d.eval<string>(`document.querySelector('[data-testid="compare-right"]').textContent`);
  ok(
    left.endsWith('本页的修改。') && right.endsWith('另一标签页的修改。'),
    `另一端先保存后出现冲突对比框，左右分别是本页与已保存的内容${left.endsWith('本页的修改。') && right.endsWith('另一标签页的修改。') ? '' : `（左：${JSON.stringify(left.slice(-30))}，右：${JSON.stringify(right.slice(-30))}）`}`,
  );
  await shot('conflict');
  await d.clickTestId('compare-left-action');
  await waitStatus('saved', 6000);
  allow409();
  s = await server();
  ok(s.body.endsWith('本页的修改。') && !s.body.includes('另一标签页的修改。'), '选择「保留我的」后以本页内容覆盖');

  // 5. 历史版本：手动存版本 → 恢复最早的自动版本（恢复前自动快照）
  await d.clickTestId('open-revisions');
  await d.waitFor(`document.querySelectorAll('[data-testid="revision-item"]').length >= 1`, '历史版本列表');
  await d.clickTestId('snapshot');
  await d.waitText('已存为版本');
  await d.waitFor(`[...document.querySelectorAll('[data-testid="revision-item"]')].some(e => e.textContent.includes('手动'))`, '出现手动版本');
  await d.eval(`[...document.querySelectorAll('[data-testid="revision-item"]')].at(-1).click()`);
  await d.waitFor(`document.querySelector('[data-testid="revision-preview"]')?.textContent === '第一段正文。\\n你好，世界！'`, '预览最早的自动版本');
  await d.clickTestId('revision-restore');
  await d.clickText('.n-dialog .n-button', '恢复');
  await d.waitText('已恢复该版本');
  s = await server();
  const editorText = await d.eval<string>(`[...document.querySelectorAll('.cm-line')].map(l => l.textContent).join('\\n')`);
  ok(s.body === '第一段正文。\n你好，世界！' && editorText === s.body, '恢复最早版本：服务端与编辑器内容都回到该版本');
  const revs = await d.fetchJson<{ reason: string }[]>(`${C}/revisions`);
  ok(revs.some((r) => r.reason === 'before_restore'), '恢复前自动生成「恢复前」版本');

  // 6. 纯文本模式（输入法兜底）
  await d.clickTestId('plain-mode');
  await d.waitFor(`document.querySelector('[data-testid="plain-editor"]')?.value === ${JSON.stringify(s.body)}`, '纯文本模式显示同样内容');
  await d.eval(`(() => { const t = document.querySelector('[data-testid="plain-editor"]'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
  await d.insertText('纯文本模式写的。');
  await waitStatus('saved', 5000);
  ok((await server()).body.endsWith('纯文本模式写的。'), '纯文本模式下输入同样自动保存');
  await d.clickTestId('plain-mode');
  await d.waitFor(`document.querySelector('.cm-content')?.textContent.includes('纯文本模式写的。')`, '切回编辑器模式');

  // 7. 5 万字章节：打开耗时与输入延迟
  const big = Array.from({ length: 800 }, (_, i) => `第${i + 1}段：天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡。`).join('\n').slice(0, 50_000);
  const created = await d.eval<ChapterDto>(`(async () => {
    const tree = await fetch('/api/works/${workId}/tree').then(r => r.json());
    const ch = await fetch('/api/works/${workId}/chapters', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volumeId: tree.volumes[0].id, title: '五万字章节' }) }).then(r => r.json());
    await fetch('/api/works/${workId}/chapters/' + ch.id + '/body', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: ${JSON.stringify(big)}, baseRev: 0 }) });
    return ch;
  })()`);
  await d.page.send('Page.reload');
  await d.waitFor(`document.querySelector('[data-testid="outline-chapter"][data-id="${created.id}"]')`, '目录树出现五万字章节');
  const t0 = Date.now();
  await d.eval(`document.querySelector('[data-testid="outline-chapter"][data-id="${created.id}"]').click()`);
  await d.waitFor(
    `parseInt(document.querySelector('[data-testid="word-count"]')?.textContent ?? '0') > 45000 && document.querySelector('[data-testid="chapter-title"]')?.textContent === '五万字章节'`,
    '打开五万字章节',
  );
  ok(big.length === 50_000, '测试章节正文为 50000 个字符');
  const openMs = Date.now() - t0;
  await d.focusEditorEnd();
  const lat: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await d.insertText('字');
    await d.nextFrame();
    lat.push(performance.now() - t);
  }
  note(`5 万字章节：打开 ${openMs} ms；每次输入到下一帧渲染 中位数 ${median(lat).toFixed(1)} ms、最大 ${Math.max(...lat).toFixed(1)} ms（含 CDP 往返）`);
  ok(openMs < 1500 && median(lat) < 50, '5 万字章节打开 < 1.5 s，输入到渲染中位数 < 50 ms（不卡顿）');
  await waitStatus('saved', 6000);
  const bigSaved = await d.fetchJson<ChapterDto>(`/api/works/${workId}/chapters/${created.id}`);
  ok(bigSaved.body === `${big}${'字'.repeat(40)}`, '5 万字章节追加 40 字后保存，服务端正文逐字一致');
  await shot('editor');
  ok((await status()) === 'saved', '离开前全部内容已保存');
}
