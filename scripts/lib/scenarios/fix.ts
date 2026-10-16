import { apiCall, startTypoLlm } from './checks.ts';
import type { ScenarioContext } from './outline.ts';

/** mock 审稿：「突然」只有意见（没有修改建议），「非常非常」建议改为「非常」；mock 修复把「突然」改写为「猛然间」。 */
const C1 = '林远突然停下脚步。他非常非常紧张。';
const C2 = '远处突然传来钟声。';

const editorText = `document.querySelector('.cm-content').innerText`;
const items = `document.querySelectorAll('[data-testid="issue-item"]')`;
const itemByTarget = (target: string): string => `[...${items}].find((e) => e.querySelector('.target')?.textContent === ${JSON.stringify(target)})`;
const inBar = (id: string): string => `!!document.querySelector('[data-testid="chapter-editor"] .bar [data-testid="${id}"]')`;
const inSider = (id: string): string => `!!document.querySelector('.sider [data-testid="${id}"]')`;

/**
 * 界面优化与 AI 修复：作品级操作在编辑器顶栏 → 审稿意见的单条「修复」（AI 按意见改写并修正、可撤销）→
 * 「全部修复」中途停止（不改正文）→ 全书「全部修复」（有建议的直接采纳，没有建议的由 AI 改写，跨章节）。
 */
export async function fixScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const llm = await startTypoLlm(80);
  const slow = await startTypoLlm(10_000);
  try {
    const profile = await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: 'Mock 修复', baseUrl: llm.baseUrl, model: 'mock-fix', maxConcurrency: 3 }));
    const work = await d.eval<{ id: string }>(apiCall('POST', '/api/works', { title: 'AI 修复冒烟' }));
    const W = `/api/works/${work.id}`;
    const tree = await d.fetchJson<{ volumes: { id: string; chapters: { id: string }[] }[] }>(`${W}/tree`);
    const c1 = tree.volumes[0]!.chapters[0]!.id;
    const c2 = (await d.eval<{ id: string }>(apiCall('POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: '第二章' }))).id;
    await d.eval(apiCall('PUT', `${W}/chapters/${c1}/body`, { body: C1, baseRev: 0 }));
    await d.eval(apiCall('PUT', `${W}/chapters/${c2}/body`, { body: C2, baseRev: 0 }));
    const bodyOf = async (id: string): Promise<string> => (await d.fetchJson<{ body: string }>(`${W}/chapters/${id}`)).body;

    await d.eval(`localStorage.setItem('ne.issuePanel', 'closed')`);
    await d.navigate(`${ctx.origin}/works/${work.id}/${c1}`);
    await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('林远突然')`, '打开第一章');

    // 1. 作品级操作移到编辑器顶栏右侧、保存状态左边
    const placed = await d.eval<boolean>(
      `${inBar('check-open')} && ${inBar('open-trash')} && ${inBar('export-open')} && !${inSider('check-open')} && !${inSider('open-trash')} && !${inSider('export-open')}`,
    );
    const leftOfStatus = await d.eval<boolean>(
      `(() => { const a = document.querySelector('[data-testid="work-actions"]').getBoundingClientRect(); const s = document.querySelector('[data-testid="save-status"]').getBoundingClientRect(); return a.right <= s.left && Math.abs(a.top + a.height / 2 - (s.top + s.height / 2)) < 6; })()`,
    );
    ok(placed && leftOfStatus, '「AI 检查」「回收站」「导出」位于编辑器顶栏右侧、保存状态左边（左侧栏不再显示）');
    await shot('fix-toolbar');

    // 2. 审稿：本章一条只有意见、一条有修改建议
    await d.eval(apiCall('POST', `${W}/jobs`, { type: 'review', scope: { kind: 'work', id: work.id }, profileId: profile.id }));
    await d.waitFor(`document.querySelector('[data-testid="report-open-toast"]')`, '审稿完成', 15_000);
    await d.waitFor(`document.querySelector('[data-testid="issue-panel"]') && ${items}.length === 2`, '问题面板：本章 2 条');
    const panel = await d.eval<{ applyAll: string; fixAll: string; ignoreAll: boolean; sameRow: boolean; suddenFix: boolean; suddenApply: boolean; verboseApply: boolean }>(
      `(() => {
        const text = (id) => document.querySelector('[data-testid="' + id + '"]')?.textContent.trim() ?? '';
        const tops = ['issue-apply-all', 'issue-fix-all', 'issue-ignore-all'].map((id) => Math.round(document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect().top));
        const sudden = ${itemByTarget('突然')}, verbose = ${itemByTarget('非常非常')};
        return { applyAll: text('issue-apply-all'), fixAll: text('issue-fix-all'), ignoreAll: !!document.querySelector('[data-testid="issue-ignore-all"]'), sameRow: new Set(tops).size === 1,
          suddenFix: !!sudden.querySelector('[data-testid="issue-fix"]'), suddenApply: !!sudden.querySelector('[data-testid="issue-apply"]'),
          verboseApply: !!verbose.querySelector('[data-testid="issue-apply"]') };
      })()`,
    );
    ok(
      panel.applyAll === '采纳全部（1）' && panel.fixAll === '全部修复（2）' && panel.ignoreAll && panel.sameRow && panel.suddenFix && !panel.suddenApply && panel.verboseApply,
      `批量操作排成一行：${panel.applyAll}、${panel.fixAll}、全部忽略；只有意见的审稿问题在「忽略」旁显示「修复」，有建议的显示「采纳」`,
    );
    await shot('fix-panel');

    // 3. 单条修复：AI 按意见改写 → 修正写入正文 → 编辑器更新、可撤销
    await d.eval(`${itemByTarget('突然')}.querySelector('[data-testid="issue-fix"]').click()`);
    await d.waitFor(`${editorText}.includes('林远猛然间停下脚步')`, '单条修复后编辑器更新', 8000);
    await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved'`, '已保存');
    await d.waitText('已修复：「突然」 → 「猛然间」');
    const revs = await d.fetchJson<{ reason: string }[]>(`${W}/chapters/${c1}/revisions`);
    ok((await bodyOf(c1)) === C1.replace('突然', '猛然间') && revs.some((r) => r.reason === 'before_fix'), '单条「修复」：AI 按意见改写「突然」→「猛然间」并写入正文，生成「修正前」历史版本');
    await d.waitFor(`${items}.length === 1 && !${itemByTarget('突然')}`, '修复后该条移出待处理');
    await d.eval(`document.querySelector('.cm-content').focus()`);
    await d.shortcut('z');
    await d.waitFor(`${editorText}.includes('林远突然停下脚步')`, '撤销');
    await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved'`, '撤销后自动保存', 8000);
    ok((await bodyOf(c1)) === C1, '修复后可以在编辑器中按 Ctrl/Cmd+Z 撤销');

    // 4. 全书「全部修复」中途停止：已生成的建议保留，正文不改
    await d.clickText('[data-testid="issue-scope"] .n-radio-button', '全书');
    await d.waitFor(`${items}.length === 2 && ${itemByTarget('非常非常')} && ${itemByTarget('突然')}`, '全书 2 条（第一章「非常非常」、第二章「突然」）');
    await d.eval(apiCall('PATCH', `/api/llm/profiles/${profile.id}`, { baseUrl: slow.baseUrl }));
    const allowAbort = ctx.allowNetworkLog(/ERR_ABORTED|canceled|aborted/i);
    await d.clickTestId('issue-fix-all');
    await d.clickText('.n-popconfirm__action button', '全部修复');
    await d.waitFor(`document.querySelector('[data-testid="issue-fix-progress"]')?.innerText.includes('AI 修复中 0/1')`, '修复进度');
    await d.clickTestId('issue-fix-stop');
    await d.waitText('已停止修复');
    await new Promise((r) => setTimeout(r, 200));
    allowAbort();
    ok(
      (await bodyOf(c1)) === C1 && (await bodyOf(c2)) === C2 && (await d.eval<number>(`${items}.length`)) === 2,
      '「全部修复」显示进度「AI 修复中 0/1」，点「停止」后中止模型调用，正文不改动',
    );

    // 5. 全书「全部修复」：有建议的直接采纳，没有建议的由 AI 改写，跨章节一次完成
    await d.eval(apiCall('PATCH', `/api/llm/profiles/${profile.id}`, { baseUrl: llm.baseUrl }));
    await d.clickTestId('issue-fix-all');
    await d.clickText('.n-popconfirm__action button', '全部修复');
    await d.waitText('已修复 2 处（其中 AI 改写 1 处）', 10_000);
    await d.waitFor(`${items}.length === 0 && ${editorText}.includes('他非常紧张')`, '全部修复后列表清空、编辑器更新');
    const [b1, b2] = [await bodyOf(c1), await bodyOf(c2)];
    ok(b1 === C1.replace('非常非常', '非常') && b2 === C2.replace('突然', '猛然间'), '全书「全部修复」：第一章按建议改「非常非常」→「非常」，第二章由 AI 改写「突然」→「猛然间」');
    await d.eval(apiCall('DELETE', `/api/llm/profiles/${profile.id}`));
  } finally {
    await llm.close();
    await slow.close();
  }
}
