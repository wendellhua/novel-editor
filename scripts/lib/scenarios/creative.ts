import { MOCK_EXPANSION } from '../mock-review.ts';
import { apiCall, startTypoLlm } from './checks.ts';
import type { ScenarioContext } from './outline.ts';

/** 第 1 章：满 3000 字（触发剧情记忆自动建立），含两处 mock AI 味；第 2 章：短，用来灵感与扩写。 */
const para = (k: number): string => `【E${k}】林远走过长街，看见第${k}块石碑上的刻字。风从山口吹来，雾气慢慢散开，远处的钟声一下一下地响着。`;
const C1 = `赵峰看着他，嘴角勾起一抹弧度。林远眼中闪过一丝冷意，没有说话。\n${Array.from({ length: 60 }, (_, i) => para(i + 1)).join('\n')}`;
const C2 = '林远回到山门，看见师姐站在台阶上。';

const TASK_KINDS = ['typo', 'review', 'setting', 'character', 'ai_flavor', 'inspiration', 'expand', 'bible_extract', 'memory', 'summary'];
const editorText = `document.querySelector('.cm-content').innerText`;

/**
 * 创作辅助与剧情记忆：写满 3000 字后剧情记忆自动建立并可查阅 → AI 味检测 → 完成提示中「一键优化」→
 * 灵感胶囊（只能当前章节，报告含五条路线）→ 智能扩写（只能当前章节，结果确认后插入章末，可撤销）。全部经由界面操作。
 */
export async function creativeScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const llm = await startTypoLlm(60);
  try {
    const profile = await d.eval<{ id: string }>(apiCall('POST', '/api/llm/profiles', { name: 'Mock 创作', baseUrl: llm.baseUrl, model: 'mock-creative', maxConcurrency: 3 }));
    const previous = await d.fetchJson<Record<string, string | null>>('/api/llm/defaults');
    await d.eval(apiCall('PUT', '/api/llm/defaults', Object.fromEntries(TASK_KINDS.map((k) => [k, profile.id]))));
    const work = await d.eval<{ id: string }>(apiCall('POST', '/api/works', { title: '创作辅助冒烟' }));
    const W = `/api/works/${work.id}`;
    const tree = await d.fetchJson<{ volumes: { id: string; chapters: { id: string }[] }[] }>(`${W}/tree`);
    const c1 = tree.volumes[0]!.chapters[0]!.id;
    const c2 = (await d.eval<{ id: string }>(apiCall('POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: '第二章' }))).id;
    await d.eval(apiCall('PUT', `${W}/chapters/${c2}/body`, { body: C2, baseRev: 0 }));
    await d.eval(`localStorage.setItem('ne.issuePanel', 'closed')`);
    await d.navigate(`${ctx.origin}/works/${work.id}/${c1}`);
    await d.waitFor(`document.querySelector('.cm-content')`, '打开第一章');

    // 1. 剧情记忆：写满 3000 字后自动建立（保存后防抖约 3 秒）
    await d.eval(apiCall('PUT', `${W}/chapters/${c1}/body`, { body: C1, baseRev: 0 }));
    await d.page.send('Page.reload');
    await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('嘴角勾起一抹弧度')`, '重新载入第一章');
    await d.clickTestId('memory-open');
    await d.waitFor(`document.querySelector('[data-testid="memory-drawer"]')`, '剧情记忆抽屉');
    await d.waitFor(`document.querySelectorAll('[data-testid="memory-entry"]').length === 1`, '剧情记忆自动建立', 20_000);
    const state = await d.eval<string>(`document.querySelector('[data-testid="memory-state"]').innerText`);
    ok(state.includes('主线进展') && state.includes('【E1】') && state.includes('林远'), '正文满 3000 字后剧情记忆自动建立：抽屉中显示主线进展、人物现状与更新记录');
    await new Promise((r) => setTimeout(r, 300));
    await shot('memory-drawer');
    await d.eval(`document.querySelector('[data-testid="memory-drawer"]').closest('.n-drawer').querySelector('.n-base-close').click()`);
    await d.waitFor(`!document.querySelector('[data-testid="memory-drawer"]')`, '关闭剧情记忆');

    const chooseType = async (label: string): Promise<void> => {
      await d.eval(`document.querySelector('[data-testid="check-type"] .n-base-selection').click()`);
      await d.waitFor(`document.querySelector('.n-base-select-option')`, '类型下拉');
      // 下拉是虚拟列表：先滚到能看到目标选项
      await d.eval(`(() => { const list = document.querySelector('.n-base-select-menu .v-vl'); const has = () => [...document.querySelectorAll('.n-base-select-option')].some((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (!has() && list) list.scrollTop = list.scrollHeight; })()`);
      await d.clickText('.n-base-select-option', label);
    };
    const chooseModel = async (): Promise<void> => {
      await d.eval(`document.querySelector('[data-testid="check-model"] .n-base-selection').click()`);
      await d.clickText('.n-base-select-option', 'Mock 创作（mock-creative）');
      await d.waitFor(`document.querySelector('[data-testid="check-start"]') && !document.querySelector('[data-testid="check-start"]').disabled`, '可以开始', 8000);
    };
    const closeCheck = async (): Promise<void> => {
      await d.eval(`document.querySelector('[data-testid="check-panel"]')?.closest('.n-drawer')?.querySelector('.n-base-close')?.click()`);
      await d.waitFor(`!document.querySelector('[data-testid="check-panel"]')`, '关闭检查面板');
    };

    // 2. AI 味检测 → 完成提示「一键优化」
    await d.clickTestId('check-open');
    await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
    await chooseType('AI 味检测');
    await chooseModel();
    await d.clickTestId('check-start');
    await d.waitFor(`document.querySelector('[data-testid="ai-flavor-optimize-toast"]')`, 'AI 味检测完成提示', 15_000);
    await closeCheck();
    const toast = await d.eval<string>(`document.querySelector('[data-testid="ai-flavor-optimize-toast"]').closest('.n-message').innerText`);
    await d.clickTestId('ai-flavor-optimize-toast');
    await d.clickText('.n-dialog .n-button', '全部优化');
    await d.waitFor(`${editorText}.includes('赵峰看着他，笑了笑。林远眯起了眼')`, '一键优化后编辑器更新');
    await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved'`, '已保存', 8000);
    const body1 = (await d.fetchJson<{ body: string }>(`${W}/chapters/${c1}`)).body;
    ok(/发现 2 处/.test(toast) && body1.startsWith('赵峰看着他，笑了笑。林远眯起了眼，没有说话。'), `AI 味检测：「${toast.replace(/\s+/g, ' ').trim()}」，点「一键优化」后两处改写都已写入正文`);

    // 3. 灵感胶囊：只能当前章节；报告含五条路线
    await d.navigate(`${ctx.origin}/works/${work.id}/${c2}`);
    await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('林远回到山门')`, '打开第二章');
    await d.clickTestId('check-open');
    await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
    await chooseType('灵感胶囊');
    const scope = await d.eval<{ work: boolean; chapter: boolean; label: string }>(
      `(() => { const r = [...document.querySelectorAll('[data-testid="check-scope"] .n-radio-button')]; return { work: r[0].classList.contains('n-radio-button--disabled'), chapter: r[2].classList.contains('n-radio-button--checked'), label: document.querySelector('[data-testid="check-start"]').innerText.trim() }; })()`,
    );
    ok(scope.work && scope.chapter && scope.label === '生成灵感', '选择「灵感胶囊」后范围固定为当前章节（整部作品不可选），按钮为「生成灵感」');
    await chooseModel();
    await d.clickTestId('check-start');
    await d.waitFor(`document.querySelector('[data-testid="inspiration-open-toast"]')`, '灵感胶囊完成提示', 15_000);
    await closeCheck();
    await d.clickTestId('inspiration-open-toast');
    await d.waitFor(`document.querySelector('[data-testid="report-overall"]')`, '灵感报告');
    const report = await d.eval<{ title: string; routes: string[]; text: string }>(
      `(() => { const el = document.querySelector('[data-testid="report-overall"]'); return { title: document.querySelector('[data-testid="report-title"]').innerText, routes: [...el.querySelectorAll('h5')].map((e) => e.textContent), text: el.innerText }; })()`,
    );
    ok(
      report.title === '灵感胶囊' && report.routes.length === 5 && report.routes[0] === '路线一：宗门危机' && report.text.includes('（已参考剧情记忆）') && report.text.includes('章末钩子'),
      `灵感胶囊报告：${report.routes.join('、')}；局势分析参考了剧情记忆`,
    );
    await new Promise((r) => setTimeout(r, 300));
    await shot('inspiration-report');
    await d.eval(`document.querySelector('[data-testid="report-drawer"]').closest('.n-drawer').querySelector('.n-base-close').click()`);
    await d.waitFor(`!document.querySelector('[data-testid="report-drawer"]')`, '关闭报告');

    // 4. 智能扩写：结果确认后插入章末，可撤销
    await d.clickTestId('check-open');
    await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
    await chooseType('智能扩写');
    await d.waitFor(`document.querySelector('[data-testid="check-target-chars"]')?.innerText.includes('约 2000 字')`, '默认篇幅约 2000 字');
    await chooseModel();
    ok(await d.eval<boolean>(`document.querySelector('[data-testid="check-start"]').innerText.trim() === '开始扩写'`), '选择「智能扩写」后显示篇幅（默认约 2000 字），按钮为「开始扩写」');
    await d.clickTestId('check-start');
    await d.waitFor(`document.querySelector('[data-testid="expansion-text"]')?.innerText.includes('远处传来一声钟响')`, '扩写完成后打开结果', 15_000);
    await new Promise((r) => setTimeout(r, 300));
    await shot('expand-drawer');
    await d.clickTestId('expansion-apply');
    await d.waitFor(`document.querySelector('[data-testid="expansion-applied"]')`, '已插入');
    await d.waitFor(`${editorText}.includes('山门前空无一人')`, '编辑器中出现续写');
    const body2 = (await d.fetchJson<{ body: string }>(`${W}/chapters/${c2}`)).body;
    const revs = await d.fetchJson<{ reason: string }[]>(`${W}/chapters/${c2}/revisions`);
    ok(body2 === `${C2}\n${MOCK_EXPANSION}` && revs.some((r) => r.reason === 'before_expand'), '「插入到章末」：续写另起一段接在本章末尾，生成「AI 扩写前」历史版本，不能重复插入');
    await d.eval(`document.querySelector('[data-testid="expand-drawer"]').closest('.n-drawer').querySelector('.n-base-close').click()`);
    await d.waitFor(`!document.querySelector('[data-testid="expand-drawer"]')`, '关闭扩写');
    await d.eval(`document.querySelector('.cm-content').focus()`);
    await d.shortcut('z');
    await d.waitFor(`!${editorText}.includes('山门前空无一人')`, '撤销插入');
    await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved'`, '撤销后自动保存', 8000);
    ok((await d.fetchJson<{ body: string }>(`${W}/chapters/${c2}`)).body === C2, '插入的续写可以在编辑器中按 Ctrl/Cmd+Z 撤销');

    await d.eval(apiCall('PUT', '/api/llm/defaults', previous));
    await d.eval(apiCall('DELETE', `/api/llm/profiles/${profile.id}`));
  } finally {
    await llm.close();
  }
}
