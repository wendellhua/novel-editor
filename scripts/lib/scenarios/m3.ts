import { apiCall, startTypoLlm } from './checks.ts';
import type { ScenarioContext } from './outline.ts';

/**
 * 样书（mock 模型的触发规则）：抽取按「X的属性是值。」；错别字按 mock-typo 词表（在接再厉）；审稿按「突然」；
 * 设定一致性：正文有「半日」且 ③ 列出「落霞镇」；角色一致性：正文有「苏师妹」且 ③ 列出「苏晴」。
 */
const BODIES = [
  '林远的境界是炼气三层。落霞镇的路程是三日。苏晴的身份是师姐。\n他在接再厉地修炼。',
  '林远突然收到家书，只用了半日便赶回落霞镇。',
  '苏晴站在山门前。林远笑道：“苏师妹，我回来了。”',
];

interface Issue {
  id: string;
  category: string;
  target: string;
  replacement: string | null;
  evidence: string;
  status: string;
}

/**
 * M3 交付冒烟：作品级「抽取 → 审核 → 四类检查 → 一键修正」全流程，全部经由界面操作。
 */
export async function m3Scenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const llm = await startTypoLlm(10);
  try {
    const profile = await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: 'Mock 全流程', baseUrl: llm.baseUrl, model: 'mock-all', maxConcurrency: 3 }));
    const work = await d.eval<{ id: string }>(apiCall('POST', '/api/works', { title: 'M3 全流程' }));
    const W = `/api/works/${work.id}`;
    const tree = await d.fetchJson<{ volumes: { id: string; chapters: { id: string }[] }[] }>(`${W}/tree`);
    const ids = [tree.volumes[0]!.chapters[0]!.id];
    for (let i = 1; i < BODIES.length; i++) ids.push((await d.eval<{ id: string }>(apiCall('POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: `第${i + 1}章` }))).id);
    for (const [i, id] of ids.entries()) await d.eval(apiCall('PUT', `${W}/chapters/${id}/body`, { body: BODIES[i], baseRev: 0 }));

    await d.eval(`localStorage.setItem('ne.issuePanel', 'closed')`);
    await d.navigate(`${ctx.origin}/works/${work.id}/${ids[0]}`);
    await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('炼气三层')`, '打开第一章');

    const chooseModel = async (): Promise<void> => {
      await d.eval(`document.querySelector('[data-testid="check-model"] .n-base-selection').click()`);
      await d.clickText('.n-base-select-option', 'Mock 全流程（mock-all）');
      await d.waitFor(`document.querySelector('[data-testid="check-start"]') && !document.querySelector('[data-testid="check-start"]').disabled`, '可以开始');
    };
    const doneJobs = `[...document.querySelectorAll('[data-testid="job-row"][data-status="done"]')].length`;

    // 1. 抽取 → 审核
    await d.clickTestId('bible-open');
    await d.waitFor(`document.querySelector('[data-testid="bible-drawer"]')`, '设定库');
    await d.clickTestId('bible-tab-candidates');
    await d.clickTestId('bible-extract');
    await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
    await chooseModel();
    await d.clickTestId('check-start');
    await d.waitFor(`document.querySelector('[data-testid="bible-open-toast"]')`, '抽取完成', 15_000);
    await d.clickTestId('bible-open-toast');
    await d.waitFor(`document.querySelector('[data-testid="candidates-accept-all"]')`, '待审核');
    await d.clickTestId('candidates-accept-all');
    await d.clickText('.n-popconfirm__action button', '全部接受');
    await d.waitFor(`document.querySelectorAll('[data-testid="candidate-group"]').length === 0`, '全部接受');
    const entries = await d.fetchJson<{ name: string }[]>(`${W}/bible/entries`);
    ok(entries.map((e) => e.name).sort().join('、') === ['林远', '苏晴', '落霞镇'].sort().join('、'), `① 抽取并全部接受：设定库中有 ${entries.map((e) => e.name).join('、')}`);
    await d.eval(`document.querySelector('[data-testid="bible-drawer"]').closest('.n-drawer').querySelector('.n-base-close').click()`);

    // 2. 四类检查
    for (const [i, label] of ['错别字与标点', '编辑审稿', '设定一致性', '角色一致性'].entries()) {
      await d.clickTestId('check-open');
      await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
      await d.eval(`document.querySelector('[data-testid="check-type"] .n-base-selection').click()`);
      await d.clickText('.n-base-select-option', label);
      await chooseModel();
      await d.clickTestId('check-start');
      await d.waitFor(`${doneJobs} === ${i + 2}`, `「${label}」完成`, 15_000);
      await d.eval(`document.querySelector('[data-testid="check-panel"]').closest('.n-drawer').querySelector('.n-base-close').click()`);
      await d.waitFor(`!document.querySelector('[data-testid="check-panel"]')`, '关闭检查面板');
    }
    const all = await d.fetchJson<Issue[]>(`${W}/issues`);
    const cats = [...new Set(all.map((i) => i.category))].sort();
    ok(
      JSON.stringify(cats) === JSON.stringify(['character', 'review', 'setting', 'typo']) &&
        all.some((i) => i.category === 'setting' && i.evidence.startsWith('【落霞镇】')) &&
        all.some((i) => i.category === 'character' && i.evidence.startsWith('【苏晴】')),
      `② 四类检查都发现了问题：${all.map((i) => `${i.category}「${i.target}」`).join('、')}；一致性问题带有依据`,
    );

    // 3. 问题面板（全书）→ 采纳全部
    // 检查发现问题时面板已自动打开
    if (!(await d.eval<boolean>(`!!document.querySelector('[data-testid="issue-panel"]')`))) await d.clickTestId('issues-toggle');
    await d.waitFor(`document.querySelector('[data-testid="issue-panel"]')`, '问题面板');
    await d.clickText('[data-testid="issue-scope"] .n-radio-button', '全书');
    await d.waitFor(`document.querySelectorAll('[data-testid="issue-item"]').length === ${all.length}`, '全书问题');
    const evidenceShown = await d.eval<boolean>(`[...document.querySelectorAll('[data-testid="issue-item"]')].some((e) => e.innerText.includes('【落霞镇】'))`);
    ok(evidenceShown, '③ 问题面板中展示一致性问题的依据（evidence）');
    await shot('m3-issues');
    await d.clickTestId('issue-apply-all');
    await d.clickText('.n-popconfirm__action button', '全部修正');
    await d.waitFor(`document.querySelectorAll('[data-testid="issue-item"]').length === ${all.filter((i) => i.replacement === null).length}`, '修正后只剩不可修正的意见');
    const bodies = await Promise.all(ids.map((id) => d.fetchJson<{ body: string }>(`${W}/chapters/${id}`).then((c) => c.body)));
    ok(
      bodies[0]!.includes('再接再厉') && bodies[1]!.includes('只用了三日') && bodies[2]!.includes('“师姐，我回来了。”') && bodies[1]!.includes('突然'),
      '④ 一键修正：错别字、设定矛盾、称谓矛盾都已改正；只有意见、没有修改建议的审稿问题保留在列表中',
    );
    await d.eval(apiCall('DELETE', `/api/llm/profiles/${profile.id}`));
  } finally {
    await llm.close();
  }
}
