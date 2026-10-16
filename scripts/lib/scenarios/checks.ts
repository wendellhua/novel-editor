import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mockReviewContent } from '../mock-review.ts';
import type { ScenarioContext } from './outline.ts';

interface Job {
  id: string;
  status: string;
  totalUnits: number;
  doneUnits: number;
  failedUnits: number;
  promptTokens: number;
}

/** 模拟检查模型：每个请求延迟 delayMs 后返回——错别字检查按 mock-typo 词表，摘要 / 审稿 / 审稿汇总按 mock-review。 */
export async function startTypoLlm(delayMs: number): Promise<{ baseUrl: string; requests: number; close(): Promise<void> }> {
  const state = { baseUrl: '', requests: 0, close: (): Promise<void> => Promise.resolve() };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.requests++;
      let body: { messages?: { role: string; content: string }[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
      } catch {
        // 保持空对象
      }
      setTimeout(() => {
        if (res.destroyed) return;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: mockReviewContent(body) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1200, completion_tokens: 80 },
          }),
        );
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  state.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return state;
}

/** 在页面里以当前会话调用接口（带 Cookie 与同源 Origin）。 */
export const apiCall = (method: string, path: string, body?: unknown): string =>
  `fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${
    body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))
  } }).then(async (r) => { const t = await r.text(); if (!r.ok) throw new Error(r.status + ' ' + t); return t === '' ? null : JSON.parse(t); })`;

const rowStatus = `document.querySelector('[data-testid="job-row"]')?.dataset.status`;

/**
 * T13：工作区 → AI 检查面板。选择模型 → 预估 → 开始检查 → 进度经 SSE 实时更新 → 暂停 → 继续 → 完成；
 * 勾选「只查改动过的章节」后预估为 0 且显示跳过章数；删除任务。
 */
export async function checksScenario(ctx: ScenarioContext): Promise<void> {
  const { d, ok, shot } = ctx;
  const llm = await startTypoLlm(350);
  try {
    const profile = await d.eval<{ id: string }>(
      apiCall('POST', '/api/llm/profiles', { name: 'Mock 检查', baseUrl: llm.baseUrl, model: 'mock-typo', maxConcurrency: 1 }),
    );
    const work = await d.eval<{ id: string }>(apiCall('POST', '/api/works', { title: '检查冒烟' }));
    const W = `/api/works/${work.id}`;
    const tree = await d.fetchJson<{ volumes: { id: string; chapters: { id: string }[] }[] }>(`${W}/tree`);
    const volumeId = tree.volumes[0]!.id;
    const ids = [tree.volumes[0]!.chapters[0]!.id];
    for (let i = 1; i < 5; i++) ids.push((await d.eval<{ id: string }>(apiCall('POST', `${W}/chapters`, { volumeId, title: `第${i + 1}章` }))).id);
    for (const [i, id] of ids.entries()) {
      await d.eval(apiCall('PUT', `${W}/chapters/${id}/body`, { body: `第${i + 1}章正文。他在接再厉，终于突破。\n众人迫不急待地围了上来。`, baseRev: 0 }));
    }

    await d.navigate(`${ctx.origin}/works/${work.id}/${ids[0]}`);
    await d.waitFor(`document.querySelector('[data-testid="check-open"]')`, '工作区出现「AI 检查」按钮');
    await d.clickTestId('check-open');
    await d.waitFor(`document.querySelector('[data-testid="check-panel"]')`, '检查面板');
    await d.eval(`document.querySelector('[data-testid="check-model"] .n-base-selection').click()`);
    await d.clickText('.n-base-select-option', 'Mock 检查（mock-typo）');
    await d.waitFor(`document.querySelector('[data-testid="check-estimate"]')?.innerText.includes('5 个片段')`, '预估显示 5 个片段');
    const estimateText = await d.eval<string>(`document.querySelector('[data-testid="check-estimate"]').innerText`);
    ok(/5 章 · \d+ 字 · 5 个片段 · 预计输入约 [\d.]+( 万)? token/.test(estimateText), `选择模型后显示预估：${estimateText.trim()}`);
    await d.eval(`document.querySelector('[data-testid="check-type"] .n-base-selection').click()`);
    const disabled = `[...document.querySelectorAll('.n-base-select-option--disabled')].filter((e) => e.textContent.includes('即将提供')).length`;
    // 下拉框是虚拟列表，只渲染可见的选项：断言渲染出来的选项都可选、没有「即将提供」
    const options = `[...document.querySelectorAll('.n-base-select-option')]`;
    await d.waitFor(`${options}.length >= 3 && ${disabled} === 0 && !${options}.some((e) => e.textContent.includes('即将提供'))`, '检查类型都可选');
    ok(true, '检查类型都可以选择，不再有「即将提供」（错别字、审稿、设定一致性、角色一致性、设定抽取）');
    // 点抽屉标题收起下拉框（Escape 会把整个抽屉关掉）
    const at = await d.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('.n-drawer-header__main').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`,
    );
    await d.clickAt(at.x, at.y);
    await d.waitFor(`![...document.querySelectorAll('.n-base-select-menu')].some((e) => e.offsetParent !== null)`, '下拉框已收起');

    await d.clickTestId('check-start');
    await d.waitFor(`${rowStatus} === 'running'`, '任务进入「进行中」', 5000);
    ok(true, '开始检查后任务出现在列表中并进入「进行中」（SSE 推送）');
    await d.waitFor(
      `(() => { const t = document.querySelector('[data-testid="job-row"]')?.innerText ?? ''; return /[12]\\/5 片段/.test(t); })()`,
      '进度实时更新',
      5000,
    );
    ok(true, '进度随单元完成实时更新');

    await d.clickTestId('job-pause');
    await d.waitFor(`${rowStatus} === 'paused'`, '暂停');
    const paused = (await d.fetchJson<Job[]>(`${W}/jobs`))[0]!;
    const sentAtPause = llm.requests;
    await new Promise((r) => setTimeout(r, 800));
    ok(paused.status === 'paused' && paused.doneUnits < 5 && llm.requests === sentAtPause, `暂停后不再请求模型（已完成 ${paused.doneUnits}/5）`);
    await d.waitFor(`document.querySelector('[data-testid="check-estimate"]')?.innerText.includes('5 个片段')`, '开始检查后预估仍然显示');
    ok(true, '开始检查后预估仍然显示，可以继续创建其他任务');
    await shot('check-panel-paused');

    await d.clickTestId('job-resume');
    await d.waitFor(`${rowStatus} === 'done'`, '恢复后完成', 15_000);
    const done = (await d.fetchJson<Job[]>(`${W}/jobs`))[0]!;
    ok(done.status === 'done' && done.doneUnits === 5 && done.failedUnits === 0, '继续后任务完成：5/5 片段');
    ok(llm.requests <= 6, `恢复后跳过已完成的单元（共请求模型 ${llm.requests} 次）`);
    const meta = await d.eval<string>(`document.querySelector('[data-testid="job-row"]').innerText`);
    ok(meta.includes('5/5 片段') && meta.includes('已完成'), '列表显示完成状态与用量');

    await d.eval(`document.querySelector('[data-testid="check-only-changed"]').click()`);
    await d.waitFor(`document.querySelector('[data-testid="check-estimate"]')?.innerText.includes('已跳过')`, '只查改动章节的预估');
    const skipText = await d.eval<string>(`document.querySelector('[data-testid="check-estimate"]').innerText`);
    const startDisabled = await d.eval<boolean>(`document.querySelector('[data-testid="check-start"]').disabled`);
    ok(skipText.includes('0 个片段') && skipText.includes('5 章自上次检查后没有改动') && startDisabled, '勾选「只查改动过的章节」后预估为 0 并显示跳过章数，开始按钮不可用');
    await new Promise((r) => setTimeout(r, 300));
    await shot('check-panel');

    await d.clickTestId('job-delete');
    await d.clickText('.n-popconfirm__action button', '删除');
    await d.waitFor(`!document.querySelector('[data-testid="job-row"]')`, '任务已删除');
    ok((await d.fetchJson<Job[]>(`${W}/jobs`)).length === 0, '删除任务后列表为空');
    await d.press('Escape');
    await d.eval(apiCall('DELETE', `/api/llm/profiles/${profile.id}`));
  } finally {
    await llm.close();
  }
}
