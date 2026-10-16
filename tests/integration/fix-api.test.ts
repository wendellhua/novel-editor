import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_OPENINGS, mockReviewContent, sectionOf, taskOf } from '../../scripts/lib/mock-review.ts';
import { FIX_PROTOCOL } from '../../src/server/checks/protocol';
import { TASK_KINDS } from '../../src/shared/constants';
import type { Chapter, Issue, Job, LlmProfile, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, errorReply, startMockLlm, type MockLlm, type MockReply, type MockRequest } from '../helpers/mock-llm';

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
  /** 测试可替换 AI 修复的回复；默认按 mock-review 的 MOCK_FIXES 改写。 */
  fixReply: ((req: MockRequest) => MockReply) | null;
}

async function ok<T>(t: TestApp, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  return res.json as T;
}

async function fail(t: TestApp, method: string, path: string, status: number, message: RegExp): Promise<void> {
  const res = await t.call(method, path);
  expect(res.status, res.body).toBe(status);
  expect((res.json as { error: { message: string } }).error.message).toMatch(message);
}

async function setup(bodies: string[]): Promise<Env> {
  const env = { fixReply: null } as Env;
  env.llm = await startMockLlm((req) => (taskOf(req.body) === 'fix' && env.fixReply !== null ? env.fixReply(req) : completion(mockReviewContent(req.body))));
  env.t = await startTestApp();
  opened.push(env.llm, { close: () => env.t.cleanup() });
  env.profile = await ok<LlmProfile>(env.t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: env.llm.baseUrl, model: 'mock-a', maxConcurrency: 2 });
  // 与界面一致：第一个模型成为全部任务的默认模型
  await ok(env.t, 'PUT', '/api/llm/defaults', Object.fromEntries(TASK_KINDS.map((k) => [k, env.profile.id])));
  const work = await ok<{ id: string }>(env.t, 'POST', '/api/works', { title: '修复测试' });
  env.workId = work.id;
  env.W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(env.t, 'GET', `${env.W}/tree`);
  env.ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < bodies.length; i++) env.ids.push((await ok<Chapter>(env.t, 'POST', `${env.W}/chapters`, { volumeId: tree.volumes[0]!.id, title: `第${i + 1}章` })).id);
  for (const [i, id] of env.ids.entries()) await ok(env.t, 'PUT', `${env.W}/chapters/${id}/body`, { body: bodies[i], baseRev: 0 });
  return env;
}

async function runReview(env: Env, profileId = env.profile.id): Promise<Issue[]> {
  const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'review', scope: { kind: 'work', id: env.workId }, profileId });
  await env.t.app.services.checks.whenIdle();
  expect((await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`)).status).toBe('done');
  return ok<Issue[]>(env.t, 'GET', `${env.W}/issues`);
}

const fixRequests = (env: Env): MockRequest[] => env.llm.requests.filter((r) => taskOf(r.body) === 'fix');
const userOf = (r: MockRequest): string => r.body.messages?.find((m) => m.role === 'user')?.content ?? '';
const issueOf = async (env: Env, id: string): Promise<Issue> => (await ok<Issue[]>(env.t, 'GET', `${env.W}/issues`)).find((i) => i.id === id)!;
const suggestPath = (env: Env, id: string): string => `${env.W}/issues/${id}/suggest`;
const BODY = '林远推开山门，雾气扑面而来。远处突然传来一声钟响。他非常非常紧张。';

describe('AI 修复：生成修改建议', () => {
  it('mock 按协议开头识别修复请求', () => {
    expect(FIX_PROTOCOL.startsWith(PROTOCOL_OPENINGS.fix)).toBe(true);
  });

  it('没有建议的审稿问题：按意见生成建议写入 replacement（不改正文）；提示词含意见、前文、原文、后文；随后一键修正写入正文', async () => {
    const env = await setup([BODY]);
    const issues = await runReview(env);
    const sudden = issues.find((i) => i.target === '突然')!;
    expect(sudden.replacement).toBeNull();

    const fixed = await ok<Issue>(env.t, 'POST', suggestPath(env, sudden.id));
    assertDto('Issue', fixed);
    expect(fixed).toMatchObject({ id: sudden.id, replacement: '猛然间', status: 'open', target: '突然' });
    const [req] = fixRequests(env);
    expect(req!.body.model).toBe('mock-a');
    expect(req!.body.messages?.[0]?.content).toBe(FIX_PROTOCOL);
    const user = userOf(req!);
    expect(sectionOf(user, '修改意见')).toContain('类别：编辑审稿意见');
    expect(sectionOf(user, '修改意见')).toContain(`意见：${sudden.message}`);
    expect(sectionOf(user, '前文')).toBe('林远推开山门，雾气扑面而来。远处');
    expect(sectionOf(user, '待修改的原文')).toBe('突然');
    expect(sectionOf(user, '后文')).toBe('传来一声钟响。他非常非常紧张。');
    expect((await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[0]}`)).body, '只生成建议，不改正文').toBe(BODY);
    expect((await issueOf(env, sudden.id)).replacement).toBe('猛然间');

    const res = await ok<{ applied: string[] }>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [sudden.id] });
    expect(res.applied).toEqual([sudden.id]);
    expect((await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[0]}`)).body).toBe(BODY.replace('突然', '猛然间'));
    const revs = await ok<{ reason: string }[]>(env.t, 'GET', `${env.W}/chapters/${env.ids[0]}/revisions`);
    expect(revs.some((r) => r.reason === 'before_fix')).toBe(true);
  });

  it('已有建议的不调用模型；已忽略的 400；原文已改动的 400 并标为失效；不存在的 404', async () => {
    const env = await setup([BODY, '远处突然传来钟声。']);
    const issues = await runReview(env);
    const [s1, s2] = issues.filter((i) => i.target === '突然');
    const verbose = issues.find((i) => i.target === '非常非常')!;

    expect(await ok<Issue>(env.t, 'POST', suggestPath(env, verbose.id))).toMatchObject({ replacement: '非常' });
    expect(fixRequests(env)).toHaveLength(0);

    await ok(env.t, 'POST', `${env.W}/issues/ignore`, { issueIds: [s1!.id] }, 204);
    await fail(env.t, 'POST', suggestPath(env, s1!.id), 400, /已经处理过/);

    const c2 = await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[1]}`);
    await ok(env.t, 'PUT', `${env.W}/chapters/${env.ids[1]}/body`, { body: '远处忽然传来钟声。', baseRev: c2.rev });
    await fail(env.t, 'POST', suggestPath(env, s2!.id), 400, /原文已改动/);
    expect((await issueOf(env, s2!.id)).status, '失效状态已提交').toBe('stale');
    await fail(env.t, 'POST', suggestPath(env, 'no-such-issue'), 404, /不存在/);
    expect(fixRequests(env)).toHaveLength(0);
  });

  it('改写整理：去掉引号与重复的前后文；与原文相同、过长时 400 且不写入', async () => {
    const env = await setup([BODY, '远处突然传来钟声。', '他突然笑了。']);
    const issues = (await runReview(env)).filter((i) => i.target === '突然');
    expect(issues).toHaveLength(3);
    const replies = ['“远处猛地传来”', '突然', '很长'.repeat(150)];
    env.fixReply = () => completion(JSON.stringify({ replacement: replies.shift() }));

    expect((await ok<Issue>(env.t, 'POST', suggestPath(env, issues[0]!.id))).replacement, '引号与前后文重复的「远处」「传来」都去掉').toBe('猛地');
    await fail(env.t, 'POST', suggestPath(env, issues[1]!.id), 400, /不需要修改/);
    await fail(env.t, 'POST', suggestPath(env, issues[2]!.id), 400, /过长/);
    expect((await issueOf(env, issues[1]!.id)).replacement).toBeNull();
    expect((await issueOf(env, issues[2]!.id)).replacement).toBeNull();
  });

  it('用发现问题的任务所用的模型，该配置删除后用默认模型；模型出错 502 且问题不变', async () => {
    const env = await setup([BODY, '远处突然传来钟声。', '他突然笑了。']);
    const other = await ok<LlmProfile>(env.t, 'POST', '/api/llm/profiles', { name: 'Mock B', baseUrl: env.llm.baseUrl, model: 'mock-b' });
    const issues = (await runReview(env, other.id)).filter((i) => i.target === '突然');

    await ok(env.t, 'POST', suggestPath(env, issues[0]!.id));
    expect(fixRequests(env).at(-1)!.body.model).toBe('mock-b');
    await ok(env.t, 'DELETE', `/api/llm/profiles/${other.id}`, undefined, 204);
    await ok(env.t, 'POST', suggestPath(env, issues[1]!.id));
    expect(fixRequests(env).at(-1)!.body.model, '回落到审稿的默认模型').toBe('mock-a');

    env.fixReply = () => errorReply(401, 'invalid api key');
    const res = await env.t.call('POST', suggestPath(env, issues[2]!.id));
    expect(res.status).toBe(502);
    expect((res.json as { error: { code: string } }).error.code).toBe('LLM_ERROR');
    expect((await issueOf(env, issues[2]!.id)).replacement).toBeNull();
  });

  it('客户端断开（界面上「停止」）时中止模型调用，不写入建议', async () => {
    const env = await setup([BODY]);
    const sudden = (await runReview(env)).find((i) => i.target === '突然')!;
    env.fixReply = () => ({ ...completion(JSON.stringify({ replacement: '猛然间' })), delayMs: 600 });
    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: env.t.app.port,
        method: 'POST',
        path: suggestPath(env, sudden.id),
        headers: { Cookie: env.t.cookie, Origin: `http://127.0.0.1:${env.t.app.port}` },
      });
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    // mock 在 600 ms 后才回复：没有中止的话，服务端此时已经写入建议
    await new Promise((r) => setTimeout(r, 1000));
    expect(fixRequests(env)).toHaveLength(1);
    expect((await issueOf(env, sudden.id)).replacement).toBeNull();

    // 直接调用时同样可以中止
    const ac = new AbortController();
    const pending = env.t.app.services.fixer.suggest(env.workId, sudden.id, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toThrow();
    expect((await issueOf(env, sudden.id)).replacement).toBeNull();
  });
});
