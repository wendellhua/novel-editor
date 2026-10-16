import { apiCall, startTypoLlm } from './checks.ts';
import type { ScenarioContext } from './outline.ts';

interface IssueDto {
  id: string;
  chapterId: string;
  target: string;
  status: string;
}

const C1 = '第一段。他在接再厉，终于突破。\n众人迫不急待地围了上来。';
const C2 = '一但开始就停不下来。';

const editorText = `document.querySelector('.cm-content').innerText`;
const marks = `[...document.querySelectorAll('.cm-content .ne-issue')].map((e) => e.textContent)`;
const itemByTarget = (target: string): string =>
  `[...document.querySelectorAll('[data-testid="issue-item"]')].find((e) => e.querySelector('.target')?.textContent === ${JSON.stringify(target)})`;

/**
 * T14：问题面板与一键修正。检查完成后自动打开面板 → 正文高亮 → 列表点击定位（选中文字）↔ 点击高亮选中条目 →
 * 逐条采纳（before_fix 版本）→ Ctrl/Cmd+Z 撤销并自动保存 → 批量采纳 → 全书范围跳到其他章节定位 → 忽略。
 */
export async function issuesScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const llm = await startTypoLlm(50);
  try {
    const profile = await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: 'Mock 问题', baseUrl: llm.baseUrl, model: 'mock-typo', maxConcurrency: 2 }));
    const work = await d.eval<{ id: string }>(apiCall('POST', '/api/works', { title: '修正冒烟' }));
    const W = `/api/works/${work.id}`;
    const tree = await d.fetchJson<{ volumes: { id: string; chapters: { id: string }[] }[] }>(`${W}/tree`);
    const c1 = tree.volumes[0]!.chapters[0]!.id;
    const c2 = (await d.eval<{ id: string }>(apiCall('POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: '第二章' }))).id;
    await d.eval(apiCall('PUT', `${W}/chapters/${c1}/body`, { body: C1, baseRev: 0 }));
    await d.eval(apiCall('PUT', `${W}/chapters/${c2}/body`, { body: C2, baseRev: 0 }));

    await d.eval(`localStorage.setItem('ne.issuePanel', 'closed')`);
    await d.navigate(`${ctx.origin}/works/${work.id}/${c1}`);
    // 本次冒烟已整页导航多次：旧页面的 SSE 若没有在 pagehide 时断开，连接池会被占满、这里要等几十秒
    await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('在接再厉')`, '打开第一章');
    await d.eval(apiCall('POST', `${W}/jobs`, { type: 'typo', scope: { kind: 'work', id: work.id }, profileId: profile.id }));
    await d.waitText('检查完成：发现 3 处问题', 15_000);
    await d.waitFor(`document.querySelector('[data-testid="issue-panel"]')`, '问题面板自动打开');
    ok(true, '检查完成后提示「发现 3 处问题」并自动打开问题面板');

    await d.waitFor(`document.querySelectorAll('[data-testid="issue-item"]').length === 2`, '本章 2 条问题');
    await d.waitFor(`JSON.stringify(${marks}) === JSON.stringify(['在接再厉', '迫不急待'])`, '正文高亮');
    ok(true, '本章 2 处问题在正文中以波浪线高亮（在接再厉、迫不急待）');

    await d.eval(`${itemByTarget('迫不急待')}.click()`);
    await d.waitFor(`document.getSelection().toString() === '迫不急待'`, '列表点击后选中正文');
    ok(true, '点击列表中的问题：编辑器滚动到该处并选中「迫不急待」');

    const at = await d.eval<{ x: number; y: number; id: string }>(
      `(() => { const el = [...document.querySelectorAll('.cm-content .ne-issue')].find((e) => e.textContent === '在接再厉'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: el.dataset.issueId }; })()`,
    );
    await d.clickAt(at.x, at.y);
    await d.waitFor(`document.querySelector('[data-testid="issue-item"].active')?.dataset.issueId === ${JSON.stringify(at.id)}`, '点击高亮选中条目');
    ok(true, '点击正文中的高亮：问题列表选中对应条目');
    await shot('issues-panel');

    await d.eval(`${itemByTarget('在接再厉')}.querySelector('[data-testid="issue-apply"]').click()`);
    await d.waitFor(`${editorText}.includes('再接再厉')`, '采纳后编辑器更新');
    await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved'`, '已保存');
    const ch1 = await d.fetchJson<{ body: string; rev: number }>(`${W}/chapters/${c1}`);
    const revs = await d.fetchJson<{ reason: string }[]>(`${W}/chapters/${c1}/revisions`);
    ok(ch1.body === C1.replace('在接再厉', '再接再厉') && revs.some((r) => r.reason === 'before_fix'), '逐条采纳：服务端正文已修正，并生成「修正前」历史版本');
    await d.waitFor(`JSON.stringify(${marks}) === JSON.stringify(['迫不急待'])`, '剩余高亮');
    ok(true, '采纳后该处高亮消失，相邻问题的高亮保留');

    await d.eval(`document.querySelector('.cm-content').focus()`);
    await d.shortcut('z');
    await d.waitFor(`${editorText}.includes('在接再厉')`, '撤销');
    await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved'`, '撤销后自动保存', 8000);
    const undone = await d.fetchJson<{ body: string; rev: number }>(`${W}/chapters/${c1}`);
    ok(undone.body === C1 && undone.rev === ch1.rev + 1, '在编辑器中按 Ctrl/Cmd+Z 撤销修正，恢复的内容自动保存');

    await d.clickTestId('issue-apply-all');
    await d.clickText('.n-popconfirm__action button', '全部修正');
    await d.waitFor(`${editorText}.includes('迫不及待')`, '批量采纳后编辑器更新');
    await d.waitFor(`document.querySelectorAll('[data-testid="issue-item"]').length === 0`, '本章没有待处理问题');
    const fixedAll = await d.fetchJson<{ body: string }>(`${W}/chapters/${c1}`);
    ok(fixedAll.body === C1.replace('迫不急待', '迫不及待'), '「采纳全部」修正本章剩余的问题（已撤销的那处保持作者的选择）');

    await d.clickText('[data-testid="issue-scope"] .n-radio-button', '全书');
    await d.waitFor(`${itemByTarget('一但')}`, '全书范围显示第二章的问题');
    await d.eval(`${itemByTarget('一但')}.click()`);
    await d.waitFor(`location.pathname.endsWith(${JSON.stringify(c2)}) && document.getSelection().toString() === '一但'`, '跳转到第二章并选中', 8000);
    ok(true, '全书范围中点击其他章节的问题：自动打开该章并选中「一但」');

    await d.eval(`${itemByTarget('一但')}.querySelector('[data-testid="issue-ignore"]').click()`);
    await d.waitFor(`!${itemByTarget('一但')} && document.querySelectorAll('.cm-content .ne-issue').length === 0`, '忽略后消失');
    const all = await d.fetchJson<IssueDto[]>(`${W}/issues`);
    ok(
      JSON.stringify(all.map((i) => [i.target, i.status])) === JSON.stringify([['在接再厉', 'applied'], ['迫不急待', 'applied'], ['一但', 'ignored']]),
      '忽略后该问题从待处理列表与正文高亮中消失，状态为「已忽略」',
    );
    await d.eval(apiCall('DELETE', `/api/llm/profiles/${profile.id}`));
  } finally {
    await llm.close();
  }
}
