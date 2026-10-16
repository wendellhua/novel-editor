import { apiCall, startTypoLlm } from './checks.ts';
import type { ScenarioContext } from './outline.ts';

/** 样书：mock 抽取按「X的属性是值。」「X又名Y。」句式取设定。 */
const BODIES = [
  '林远推开山门。\n林远的境界是炼气三层。林远又名小林。青云门的位置是东荒。',
  '雨夜。\n林远的位置是青云山。苏晴的师承是青云门。',
  '小林的伤势是轻伤。他咬牙站起。',
];

interface Entry {
  id: string;
  name: string;
  aliases: string[];
}
interface Fact {
  attribute: string;
  value: string;
  chapterId: string | null;
  quote: string;
}

const groupSel = (name: string): string => `document.querySelector('[data-testid="candidate-group"][data-group-name="${name}"]')`;

/**
 * T16：设定库。从设定库发起「AI 抽取设定」（检查面板预选类型）→ 完成提示「去审核」→ 待审核按条目分组 →
 * 整组接受 → 同名组提示并合并到已有条目 → 编辑后接受 → 整组拒绝 → 条目页查看事实与来源 → 手动添加事实 →
 * 改名与其他条目冲突时提示（INV-9）。
 */
export async function bibleScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const llm = await startTypoLlm(20);
  try {
    const profile = await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: 'Mock 设定', baseUrl: llm.baseUrl, model: 'mock-extract', maxConcurrency: 2 }));
    const work = await d.eval<{ id: string }>(apiCall('POST', '/api/works', { title: '设定冒烟' }));
    const W = `/api/works/${work.id}`;
    const tree = await d.fetchJson<{ volumes: { id: string; chapters: { id: string }[] }[] }>(`${W}/tree`);
    const ids = [tree.volumes[0]!.chapters[0]!.id];
    for (let i = 1; i < BODIES.length; i++) ids.push((await d.eval<{ id: string }>(apiCall('POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: `第${i + 1}章` }))).id);
    for (const [i, id] of ids.entries()) await d.eval(apiCall('PUT', `${W}/chapters/${id}/body`, { body: BODIES[i], baseRev: 0 }));

    await d.eval(`localStorage.setItem('ne.issuePanel', 'closed')`);
    await d.navigate(`${ctx.origin}/works/${work.id}/${ids[0]}`);
    await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('林远推开山门')`, '打开第一章');
    await d.clickTestId('bible-open');
    await d.waitFor(`document.querySelector('[data-testid="bible-drawer"]')`, '设定库');
    await d.clickTestId('bible-tab-candidates');
    await d.clickTestId('bible-extract');
    await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
    const typeText = await d.eval<string>(`document.querySelector('[data-testid="check-type"]').innerText`);
    ok(typeText.includes('设定抽取'), '从设定库点「AI 抽取设定」打开检查面板，并预选「设定抽取」');
    await d.eval(`document.querySelector('[data-testid="check-model"] .n-base-selection').click()`);
    await d.clickText('.n-base-select-option', 'Mock 设定（mock-extract）');
    await d.waitFor(`document.querySelector('[data-testid="check-estimate"]')?.innerText.includes('3 个片段')`, '预估');
    await d.clickTestId('check-start');

    await d.waitFor(`document.querySelector('[data-testid="bible-open-toast"]')`, '抽取完成提示', 15_000);
    const toast = await d.eval<string>(`document.querySelector('[data-testid="bible-open-toast"]').closest('.n-message').innerText`);
    ok(/设定抽取完成：\d+ 条候选待审核/.test(toast), `抽取完成提示待审核数并提供「去审核」：${toast.replace(/\s+/g, ' ').trim()}`);
    await d.clickTestId('bible-open-toast');
    await d.waitFor(`${groupSel('林远')}`, '待审核分组');
    const groups = await d.eval<string[]>(`[...document.querySelectorAll('[data-testid="candidate-group"]')].map((g) => g.dataset.groupName + ':' + g.querySelectorAll('[data-testid="candidate-item"]').length)`);
    ok(groups[0] === '林远:2' && groups.length === 4, `待审核按条目分组、出现次数多的在前：${groups.join(' / ')}`);
    await shot('bible-candidates');

    await d.eval(`${groupSel('林远')}.querySelector('[data-testid="group-accept"]').click()`);
    await d.waitFor(`!${groupSel('林远')} && ${groupSel('小林')}?.querySelector('[data-testid="group-merge-conflict"]')`, '接受后「小林」组提示同名');
    ok(true, '整组接受「林远」（两章的候选合并为一个条目）；「小林」组随即提示「与已有条目同名」');
    await d.eval(`${groupSel('小林')}.querySelector('[data-testid="group-merge-conflict"]').click()`);
    await d.waitFor(`!${groupSel('小林')}`, '合并后消失');

    await d.eval(`${groupSel('苏晴')}.querySelector('[data-testid="candidate-edit"]').click()`);
    await d.waitFor(`document.querySelector('[data-testid="edit-name"] input')`, '编辑框');
    await d.focus('[data-testid="edit-name"] input');
    await d.eval(`document.querySelector('[data-testid="edit-name"] input').select()`);
    await d.insertText('苏晴儿');
    await d.clickTestId('edit-accept');
    await d.waitFor(`!${groupSel('苏晴')}`, '编辑后接受');
    await d.eval(`${groupSel('青云门')}.querySelector('[data-testid="group-reject"]').click()`);
    await d.waitFor(`document.querySelectorAll('[data-testid="candidate-group"]').length === 0`, '全部处理');
    ok(true, '合并到已有条目、编辑后接受（改名为「苏晴儿」）、整组拒绝后，待审核清空');

    const entries = await d.fetchJson<Entry[]>(`${W}/bible/entries`);
    const lin = entries.find((e) => e.name === '林远');
    const facts = lin === undefined ? [] : await d.fetchJson<Fact[]>(`${W}/bible/entries/${lin.id}/facts`);
    const bodies = new Map(ids.map((id, i) => [id, BODIES[i] as string]));
    ok(
      JSON.stringify(entries.map((e) => [e.name, e.aliases])) === JSON.stringify([['林远', ['小林']], ['苏晴儿', []]]) &&
        JSON.stringify(facts.map((f) => [f.attribute, f.value, f.chapterId])) === JSON.stringify([['境界', '炼气三层', ids[0]], ['位置', '青云山', ids[1]], ['伤势', '轻伤', ids[2]]]) &&
        facts.every((f) => f.chapterId !== null && (bodies.get(f.chapterId) ?? '').includes(f.quote)),
      '设定库中：林远（别名小林）三条事实各带章节来源，引文都是原文逐字子串（INV-8）；苏晴儿',
    );

    await d.clickText('.n-tabs-tab', `条目（${entries.length}）`);
    await d.eval(`document.querySelector('[data-testid="bible-entry"][data-entry-name="林远"]').click()`);
    await d.waitFor(`document.querySelectorAll('[data-testid="entry-fact"]').length === 3`, '事实列表');
    const sources = await d.eval<string>(`[...document.querySelectorAll('[data-testid="entry-fact"]')].map((e) => e.innerText).join(' | ')`);
    ok(sources.includes('第一章') && sources.includes('第2章') && sources.includes('第3章') && sources.includes('可变'), '条目页列出事实、可变标记与来源章节');
    await d.focus('[data-testid="fact-attribute"] input');
    await d.insertText('出身');
    await d.focus('[data-testid="fact-value"] input');
    await d.insertText('渔村');
    await d.clickTestId('fact-add');
    await d.waitFor(`document.querySelectorAll('[data-testid="entry-fact"]').length === 4`, '添加事实');
    ok(true, '手动添加事实「出身：渔村」（作者设定）');
    await shot('bible-entry');

    // 故意制造的 409 会被浏览器记为网络错误，属于预期
    const allow = ctx.allowNetworkLog(/status of 409 \(Conflict\)/);
    await d.focus('[data-testid="entry-name"] input');
    await d.eval(`document.querySelector('[data-testid="entry-name"] input').select()`);
    await d.insertText('苏晴儿');
    await d.clickTestId('entry-save');
    await d.waitText('已是条目「苏晴儿」的名称或别名');
    ok(true, '把「林远」改名为已有条目的名称时提示冲突，可以合并（INV-9）');
    await new Promise((r) => setTimeout(r, 200));
    allow();
    await d.eval(apiCall('DELETE', `/api/llm/profiles/${profile.id}`));
  } finally {
    await llm.close();
  }
}
