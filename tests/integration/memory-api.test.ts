import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_OPENINGS, mockReviewContent, taskOf } from '../../scripts/lib/mock-review.ts';
import { targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { MEMORY_PROTOCOL } from '../../src/server/checks/protocol';
import { CHUNK_CHARS, CREATIVE_LIMITS, TASK_KINDS } from '../../src/shared/constants';
import type { Chapter, Job, LlmProfile, PlotMemory, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, startMockLlm, type MockLlm, type MockRequest } from '../helpers/mock-llm';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

interface Env {
  t: TestApp;
  llm: MockLlm;
  profile: LlmProfile;
  W: string;
  workId: string;
  ids: string[];
}

async function ok<T>(t: TestApp, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  return res.json as T;
}

async function setup(chapters = 3): Promise<Env> {
  const llm = await startMockLlm((req) => completion(mockReviewContent(req.body)));
  const t = await startTestApp();
  opened.push(llm, { close: () => t.cleanup() });
  const profile = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock-memory', maxConcurrency: 3 });
  await ok(t, 'PUT', '/api/llm/defaults', Object.fromEntries(TASK_KINDS.map((k) => [k, profile.id])));
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '剧情记忆测试' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < chapters; i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: `第${i + 1}章` })).id);
  return { t, llm, profile, W, workId: work.id, ids };
}

/** 约 n 字的正文：每段以【E序号】开头（mock 剧情记忆把它记为事件），段与段之间换行。 */
function book(n: number, first: number): string {
  const paras: string[] = [];
  let len = 0;
  for (let k = first; len < n; k++) {
    const p = `【E${k}】林远走过长街，看见第${k}块石碑上的刻字。风从山口吹来，雾气慢慢散开，远处的钟声一下一下地响着。`;
    paras.push(p);
    len += p.length + 1;
  }
  return paras.join('\n');
}

async function save(env: Env, i: number, body: string): Promise<void> {
  const c = await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[i]}`);
  await ok(env.t, 'PUT', `${env.W}/chapters/${env.ids[i]}/body`, { body, baseRev: c.rev });
}

/** 触发防抖中的检查并等任务跑完。 */
async function settle(env: Env): Promise<void> {
  env.t.app.services.memory.flushScheduled();
  await env.t.app.services.checks.whenIdle();
}

const memoryOf = async (env: Env): Promise<PlotMemory> => {
  const m = await ok<PlotMemory>(env.t, 'GET', `${env.W}/memory`);
  assertDto('PlotMemory', m);
  if (m.job !== null) assertDto('Job', m.job);
  return m;
};
const memoryRequests = (env: Env): MockRequest[] => env.llm.requests.filter((r) => taskOf(r.body) === 'memory');
const userOf = (r: MockRequest): string => r.body.messages?.find((m) => m.role === 'user')?.content ?? '';
const markers = (s: string): string[] => [...s.matchAll(/【E\d+】/gu)].map((m) => m[0]);

describe('剧情记忆：自动增量更新（ADR-011）', () => {
  it('mock 按协议开头识别剧情记忆请求', () => {
    expect(MEMORY_PROTOCOL.startsWith(PROTOCOL_OPENINGS.memory)).toBe(true);
  });

  it('不足 3000 字不更新；满 3000 字自动更新；之后只把新写的正文发给模型，状态逐次累积；改动已纳入的部分不重新发送', async () => {
    const env = await setup();
    const ch1 = book(2000, 1);
    await save(env, 0, ch1);
    await settle(env);
    let m = await memoryOf(env);
    expect(m.job, '不足阈值不创建任务').toBeNull();
    expect(m.state).toBeNull();
    expect(m.pendingChars).toBe(ch1.length);
    expect(m.thresholdChars).toBe(CREATIVE_LIMITS.memoryThresholdChars);

    const ch2 = book(1500, 100);
    await save(env, 1, ch2);
    await settle(env);
    m = await memoryOf(env);
    expect(m.job?.status).toBe('done');
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.label).toBe('第1卷第1章～第1卷第2章');
    expect(m.entries[0]!.chars).toBe(ch1.length + ch2.length);
    expect(m.state?.mainline, '一个批次纳入了两章（首尾标记）').toBe(`【E1】～${markers(ch2).at(-1)}`);
    expect(m.pendingChars).toBe(0);
    expect(m.coveredChars).toBe(ch1.length + ch2.length);
    const [first] = memoryRequests(env);
    expect(userOf(first!)).toContain('（空：这是第一次建立剧情记忆）');

    // 在第 2 章后面接着写 3200 字：只发送新写的部分，旧状态作为前情
    const more = book(3200, 200);
    await save(env, 1, `${ch2}\n${more}`);
    await settle(env);
    m = await memoryOf(env);
    expect(m.entries).toHaveLength(2);
    expect(m.entries[0]!.label, '最新的在前').toBe('第1卷第2章');
    const second = memoryRequests(env)[1]!;
    const sent = targetTextOf(userOf(second));
    expect(markers(sent)[0]).toBe('【E200】');
    expect(sent, '已纳入的正文不再发送').not.toContain('【E1】');
    expect(sent).not.toContain('【E100】');
    expect(sent).toContain('（接上次记录）');
    expect(userOf(second), '上一次的状态作为当前剧情记忆').toContain('主线进展：【E1】');
    expect(m.state?.mainline, '主线在上一次的基础上累积').toBe(`【E1】～${markers(ch2).at(-1)}→【E200】～${markers(more).at(-1)}`);

    // 修改已纳入部分（改一个字、长度变化）：不重新发送，待纳入仍为 0
    await save(env, 0, ch1.replace('第1块石碑', '第一块残破的石碑'));
    await settle(env);
    m = await memoryOf(env);
    expect(m.pendingChars).toBe(0);
    expect(memoryRequests(env)).toHaveLength(2);
  });

  it('超过自动上限时不自动开始；手动更新按批次串行处理，每段正文只发送一次', async () => {
    const env = await setup();
    const body = book(CREATIVE_LIMITS.memoryAutoMaxChars + 1000, 1);
    await save(env, 0, body);
    await settle(env);
    let m = await memoryOf(env);
    expect(m.job, '超过自动上限不自动开始').toBeNull();
    expect(m.pendingChars).toBe(body.length);

    const job = await ok<Job>(env.t, 'POST', `${env.W}/memory/update`);
    expect(job.type).toBe('memory');
    expect(job.totalUnits).toBe(Math.ceil(body.length / CHUNK_CHARS.memory));
    await env.t.app.services.checks.whenIdle();
    m = await memoryOf(env);
    expect(m.pendingChars).toBe(0);
    expect(env.llm.maxInFlight, '批次之间串行（模型配置允许 3 个并发）').toBe(1);
    const sent = memoryRequests(env).map((r) => markers(targetTextOf(userOf(r))));
    const all = sent.flat();
    expect(new Set(all).size, '没有一段正文被发送两次').toBe(all.length);
    expect(all).toEqual(markers(body));
    expect(m.entries.length).toBe(sent.filter((x) => x.length > 0).length);
    expect(sent.every((x) => x.length > 0), '每个批次都有内容').toBe(true);

    await ok(env.t, 'POST', `${env.W}/memory/update`, undefined, 400);
  });

  it('剧情记忆接入 ④：审稿只取本章之前的快照；灵感胶囊可以包含本章已写的部分', async () => {
    const env = await setup();
    await save(env, 0, book(3500, 1));
    await settle(env);
    expect((await memoryOf(env)).entries).toHaveLength(1);
    await save(env, 1, '林远回到山门，看见师姐站在台阶上。');

    const run = async (type: string, chapter: number): Promise<string> => {
      const from = env.llm.requests.length;
      await ok(env.t, 'POST', `${env.W}/jobs`, { type, scope: { kind: 'chapter', id: env.ids[chapter] }, profileId: env.profile.id });
      await env.t.app.services.checks.whenIdle();
      const req = env.llm.requests.slice(from).find((r) => taskOf(r.body) === type);
      expect(req, `${type} 的请求`).toBeDefined();
      return userOf(req!);
    };
    const reviewLater = await run('review', 1);
    expect(reviewLater).toContain('【剧情记忆 · 截至第1卷第1章】');
    expect(reviewLater).toContain('【近期剧情】');
    expect(reviewLater).toContain('主线进展：【E1】');
    const reviewSame = await run('review', 0);
    expect(reviewSame, '本章自己写到的内容不算前情').not.toContain('【剧情记忆');
    const inspiration = await run('inspiration', 0);
    expect(inspiration, '灵感胶囊可以包含本章已写的部分').toContain('【剧情记忆 · 截至第1卷第1章】');
  });

  it('系统任务不能手动创建；重建清空后重新建立；没有可用模型时不自动更新', async () => {
    const env = await setup();
    const res = await env.t.call('POST', `${env.W}/jobs`, { type: 'memory', scope: { kind: 'work', id: env.workId } });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/由系统在写作过程中自动更新/);

    await save(env, 0, book(3500, 1));
    await settle(env);
    expect((await memoryOf(env)).entries).toHaveLength(1);
    await ok<Job>(env.t, 'POST', `${env.W}/memory/rebuild`);
    await env.t.app.services.checks.whenIdle();
    const m = await memoryOf(env);
    expect(m.entries, '重建后只有新建立的一条').toHaveLength(1);
    expect(memoryRequests(env)).toHaveLength(2);
    expect(userOf(memoryRequests(env)[1]!)).toContain('（空：这是第一次建立剧情记忆）');

    // 默认模型全部清空 → 没有可用模型 → 不自动更新
    await ok(env.t, 'PUT', '/api/llm/defaults', Object.fromEntries(TASK_KINDS.map((k) => [k, null])));
    await save(env, 1, book(3500, 500));
    await settle(env);
    const after = await memoryOf(env);
    expect(after.hasModel).toBe(false);
    expect(after.pendingChars).toBeGreaterThan(3000);
    expect(memoryRequests(env)).toHaveLength(2);
  });

  it('未单独设置剧情记忆的默认模型时沿用章节摘要 / 编辑审稿的默认模型', async () => {
    const env = await setup();
    const defaults = Object.fromEntries(TASK_KINDS.map((k) => [k, k === 'review' ? env.profile.id : null]));
    await ok(env.t, 'PUT', '/api/llm/defaults', defaults);
    await save(env, 0, book(3500, 1));
    await settle(env);
    const m = await memoryOf(env);
    expect(m.hasModel).toBe(true);
    expect(m.entries).toHaveLength(1);
  });
});
