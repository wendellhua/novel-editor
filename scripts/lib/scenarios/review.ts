import { apiCall, startTypoLlm } from './checks.ts';
import type { ScenarioContext } from './outline.ts';

const CHAPTERS = 10;
const bodyOf = (i: number): string =>
  `【第${i + 1}章】林远推开山门，雾气扑面而来。${i % 3 === 0 ? '他非常非常紧张，' : ''}远处突然传来一声钟响。\n他握紧了剑柄，向演武场走去。`;

/**
 * T15：对 10 章样书执行编辑审稿 → 完成提示中的「查看报告」→ 整体报告（Markdown 渲染：标题、列表、加粗）→
 * 逐章意见（10 章评语 + 各章意见）→ 点击报告中的意见：打开问题面板并跳到该章选中原文 → 检查面板中也能打开报告。
 */
export async function reviewScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const llm = await startTypoLlm(30);
  try {
    const profile = await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: 'Mock 审稿', baseUrl: llm.baseUrl, model: 'mock-review', maxConcurrency: 3 }));
    const work = await d.eval<{ id: string }>(apiCall('POST', '/api/works', { title: '审稿冒烟' }));
    const W = `/api/works/${work.id}`;
    const tree = await d.fetchJson<{ volumes: { id: string; chapters: { id: string }[] }[] }>(`${W}/tree`);
    const volumeId = tree.volumes[0]!.id;
    const ids = [tree.volumes[0]!.chapters[0]!.id];
    for (let i = 1; i < CHAPTERS; i++) ids.push((await d.eval<{ id: string }>(apiCall('POST', `${W}/chapters`, { volumeId, title: `第${i + 1}章` }))).id);
    for (const [i, id] of ids.entries()) await d.eval(apiCall('PUT', `${W}/chapters/${id}/body`, { body: bodyOf(i), baseRev: 0 }));

    await d.eval(`localStorage.setItem('ne.issuePanel', 'closed')`);
    await d.navigate(`${ctx.origin}/works/${work.id}/${ids[0]}`);
    await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('林远推开山门')`, '打开第一章');
    await d.clickTestId('check-open');
    await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
    await d.eval(`document.querySelector('[data-testid="check-type"] .n-base-selection').click()`);
    await d.clickText('.n-base-select-option', '编辑审稿');
    await d.eval(`document.querySelector('[data-testid="check-model"] .n-base-selection').click()`);
    await d.clickText('.n-base-select-option', 'Mock 审稿（mock-review）');
    // 9 个摘要（前 9 章都是某章的「前 3 章」之一）+ 10 个审稿片段 + 1 个汇总
    await d.waitFor(`document.querySelector('[data-testid="check-estimate"]')?.innerText.includes('20 个片段')`, '预估含摘要与汇总');
    ok(true, '选择「编辑审稿」后预估为 10 章 · 20 个片段（9 个章节摘要 + 10 个审稿片段 + 1 个汇总）');
    await d.clickTestId('check-start');

    await d.waitFor(`document.querySelector('[data-testid="report-open-toast"]')`, '审稿完成提示', 20_000);
    const toast = await d.eval<string>(`document.querySelector('[data-testid="report-open-toast"]').closest('.n-message').innerText`);
    ok(/审稿完成：\d+ 条修改意见/.test(toast), `审稿完成后提示意见数并提供「查看报告」：${toast.replace(/\s+/g, ' ').trim()}`);
    await d.clickTestId('report-open-toast');
    await d.waitFor(`document.querySelector('[data-testid="report-overall"]')`, '整体报告');
    const overall = await d.eval<{ h: string[]; li: number; strong: string[]; text: string }>(
      `(() => { const el = document.querySelector('[data-testid="report-overall"]'); return { h: [...el.querySelectorAll('h4')].map((e) => e.textContent), li: el.querySelectorAll('li').length, strong: [...el.querySelectorAll('strong')].map((e) => e.textContent), text: el.innerText }; })()`,
    );
    ok(
      overall.h.includes('总体评价') && overall.li === 4 && overall.strong.includes('节奏') && overall.text.includes('共审读 10 章') && !overall.text.includes('##'),
      `整体报告按 Markdown 渲染：${overall.h.length} 个小标题、${overall.li} 个列表项、加粗「${overall.strong.join('、')}」`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await shot('review-report');

    await d.clickText('.n-tabs-tab', `逐章意见（${CHAPTERS}）`);
    await d.waitFor(`document.querySelectorAll('[data-testid="report-chapter"]').length === ${CHAPTERS}`, '逐章意见');
    const perChapter = await d.eval<{ comments: number; issues: number }>(
      `({ comments: [...document.querySelectorAll('[data-testid="report-chapter"]')].filter((e) => e.innerText.includes('评语：')).length, issues: document.querySelectorAll('[data-testid="report-issue"]').length })`,
    );
    ok(perChapter.comments === CHAPTERS && perChapter.issues === CHAPTERS + 4, `逐章意见：${perChapter.comments} 章评语、${perChapter.issues} 条意见`);
    await new Promise((r) => setTimeout(r, 400));
    await shot('review-chapters');

    const target = await d.eval<string>(
      `(() => { const sec = document.querySelector('[data-testid="report-chapter"][data-chapter-id="${ids[4]}"]'); const it = [...sec.querySelectorAll('[data-testid="report-issue"]')].find((e) => e.innerText.includes('突然')); it.click(); return it.dataset.issueId; })()`,
    );
    await d.waitFor(`location.pathname.endsWith(${JSON.stringify(ids[4])}) && document.getSelection().toString() === '突然'`, '跳转并选中', 8000);
    await d.waitFor(`document.querySelector('[data-testid="issue-item"].active')?.dataset.issueId === ${JSON.stringify(target)}`, '问题面板选中同一条');
    ok(true, '点击报告中的意见：打开问题面板、跳到第 5 章并选中「突然」（与问题面板共用同一条问题）');

    await d.clickTestId('check-open');
    await d.waitFor(`document.querySelector('[data-testid="job-report"]')`, '检查面板中的「查看报告」');
    await d.clickTestId('job-report');
    await d.waitFor(`document.querySelector('[data-testid="report-overall"]')?.innerText.includes('共审读 10 章')`, '从检查面板打开报告');
    ok(true, '检查面板的任务列表中可以随时打开审稿报告');
    await d.eval(apiCall('DELETE', `/api/llm/profiles/${profile.id}`));
  } finally {
    await llm.close();
  }
}
