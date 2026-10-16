import { afterEach, describe, expect, it } from 'vitest';
import { mockTypoContent } from '../../scripts/lib/mock-typo.ts';
import type { Chapter, Job, LlmProfile, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { completion, startMockLlm, type MockLlm } from '../helpers/mock-llm';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

async function ok<T>(t: TestApp, method: string, path: string, body?: unknown): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(200);
  return res.json as T;
}

const wait = async (cond: () => Promise<boolean>, ms = 10_000): Promise<void> => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('T18：拔网线（模型服务不可达）', () => {
  it('任务失败并保留进度；期间编辑与保存照常；网络恢复后「重试」只执行剩下的单元并完成', async () => {
    const reply = (req: { body: { messages?: { role: string; content: string }[] } }) => ({ ...completion(mockTypoContent(req.body)), delayMs: 40 });
    let llm: MockLlm = await startMockLlm(reply);
    const t = await startTestApp();
    opened.push({ close: () => t.cleanup() }, { close: () => llm.close() });
    const profile = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock', maxConcurrency: 1 });
    const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '断网' });
    const W = `/api/works/${work.id}`;
    const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
    const ids = [tree.volumes[0]!.chapters[0]!.id];
    for (let i = 1; i < 10; i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: `第${i + 1}章` })).id);
    for (const [i, id] of ids.entries()) await ok(t, 'PUT', `${W}/chapters/${id}/body`, { body: `【C${i}】他在接再厉。`, baseRev: 0 });

    const job = await ok<Job>(t, 'POST', `${W}/jobs`, { type: 'typo', scope: { kind: 'work', id: work.id }, profileId: profile.id });
    await wait(async () => (await ok<Job>(t, 'GET', `${W}/jobs/${job.id}`)).doneUnits >= 3);
    // 拔网线：模型服务关闭，进行中的请求断开，之后的连接被拒绝
    await llm.close();
    await t.app.services.checks.whenIdle();
    const failed = await ok<Job>(t, 'GET', `${W}/jobs/${job.id}`);
    expect(failed.status).toBe('failed');
    expect(failed.error ?? '').toMatch(/网络|连接|network|ECONNREFUSED|fetch failed/i);
    const doneBefore = failed.doneUnits;
    expect(doneBefore).toBeGreaterThanOrEqual(3);
    expect(doneBefore).toBeLessThan(10);

    // 断网期间编辑照常：保存、读取目录、读取已发现的问题
    for (const id of ids.slice(0, 3)) {
      const c = await ok<Chapter>(t, 'GET', `${W}/chapters/${id}`);
      const saved = await ok<{ rev: number }>(t, 'PUT', `${W}/chapters/${id}/body`, { body: `${c.body}断网时继续写。`, baseRev: c.rev });
      expect(saved.rev).toBe(c.rev + 1);
    }
    expect((await ok<WorkTree>(t, 'GET', `${W}/tree`)).volumes[0]!.chapters).toHaveLength(10);
    expect((await ok<unknown[]>(t, 'GET', `${W}/issues`)).length).toBe(doneBefore);

    // 网络恢复（换成新的服务地址）→ 重试：只执行剩下的单元
    llm = await startMockLlm(reply);
    await ok(t, 'PATCH', `/api/llm/profiles/${profile.id}`, { baseUrl: llm.baseUrl });
    await ok(t, 'POST', `${W}/jobs/${job.id}/resume`, {});
    await t.app.services.checks.whenIdle();
    const done = await ok<Job>(t, 'GET', `${W}/jobs/${job.id}`);
    expect([done.status, done.doneUnits, done.failedUnits, done.totalUnits]).toEqual(['done', 10, 0, 10]);
    expect(llm.requests, '恢复后只请求剩下的单元').toHaveLength(10 - doneBefore);
    // 已完成的章节没有重复的问题；被改过的章节旧问题随正文重新锚定
    const issues = await ok<{ chapterId: string; status: string }[]>(t, 'GET', `${W}/issues`);
    expect(issues).toHaveLength(10);
    expect(new Set(issues.map((i) => i.chapterId)).size).toBe(10);
    expect(issues.every((i) => i.status === 'open')).toBe(true);
  });
});
