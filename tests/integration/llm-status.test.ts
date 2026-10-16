import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../../scripts/lib/smoke-runner.ts';
import { mockTypoContent } from '../../scripts/lib/mock-typo.ts';
import { RESTART_MESSAGE } from '../../src/server/llm';
import type { Chapter, Job, LlmProfile, LlmProfileStatus, ProbeResult, ServerEvent, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, errorReply, startMockLlm, type MockLlm, type MockReply, type MockRequest } from '../helpers/mock-llm';

/**
 * 模型运行状态与异常处理（§7.3「运行状态」）：状态接口与推送、测试连接不排在任务后面且可中止、
 * 任务请求的失败反映到状态、运行中修改配置后按新配置重发。
 */
const OLD_KEY = 'sk-old-SECRET-1111111111';
const NEW_KEY = 'sk-new-SECRET-2222222222';
const OK = '{"ok":true,"reply":"pong"}';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

async function ok<T>(t: TestApp, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  return res.json as T;
}

const isProbe = (req: MockRequest): boolean => (req.body.messages?.[0]?.content ?? '').includes('连通性测试');
const typoReply = (req: MockRequest): MockReply => completion(mockTypoContent(req.body));

interface Env {
  t: TestApp;
  llm: MockLlm;
  profile: LlmProfile;
  W: string;
  workId: string;
}

async function setup(handler: (req: MockRequest, i: number) => MockReply | Promise<MockReply>, profile: Record<string, unknown> = {}): Promise<Env> {
  const llm = await startMockLlm(handler);
  const t = await startTestApp();
  opened.push(llm, { close: () => t.cleanup() });
  const p = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock-model', apiKey: OLD_KEY, maxConcurrency: 1, ...profile });
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '状态测试' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const chapterId = tree.volumes[0]!.chapters[0]!.id;
  await ok(t, 'PUT', `${W}/chapters/${chapterId}/body`, { body: '他在接再厉，终于练成了第一式。', baseRev: 0 });
  return { t, llm, profile: p, W, workId: work.id };
}

const statusOf = async (env: Env): Promise<LlmProfileStatus> => {
  const all = await ok<Record<string, LlmProfileStatus>>(env.t, 'GET', '/api/llm/status');
  for (const s of Object.values(all)) assertDto('LlmProfileStatus', s);
  return all[env.profile.id]!;
};

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, what: string, timeoutMs = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}：${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const jobOf = (env: Env, id: string) => ok<Job>(env.t, 'GET', `${env.W}/jobs/${id}`);
const startTypo = (env: Env) => ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'typo', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });

function collectEvents(t: TestApp, workId: string): { events: ServerEvent[]; close(): void } {
  const events: ServerEvent[] = [];
  let buf = '';
  const req = request({ host: '127.0.0.1', port: t.app.port, path: `/api/events?workId=${workId}`, headers: { Host: `127.0.0.1:${t.app.port}`, Cookie: t.cookie } });
  req.on('response', (res) =>
    res.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line !== undefined) events.push(JSON.parse(line.slice(6)) as ServerEvent);
      }
    }),
  );
  req.on('error', () => undefined);
  req.end();
  return { events, close: () => req.destroy() };
}

describe('模型运行状态（§7.3「运行状态」）', () => {
  it('初始未检测；测试成功为 ok，失败为 error 并带处理建议；修改连接配置后回到未检测，改其他参数不变', async () => {
    let reply: MockReply = completion(OK);
    const env = await setup(() => reply);
    expect(await statusOf(env)).toMatchObject({ state: 'unknown', at: null, source: null, error: null, active: 0, waiting: 0, retrying: 0 });

    const r = await ok<ProbeResult>(env.t, 'POST', `/api/llm/profiles/${env.profile.id}/test`);
    assertDto('ProbeResult', r);
    expect(r).toMatchObject({ ok: true, error: null, hint: null });
    expect(await statusOf(env)).toMatchObject({ state: 'ok', source: 'test', latencyMs: r.latencyMs, error: null });

    reply = errorReply(401, `Incorrect API key provided: ${OLD_KEY}`);
    const bad = await ok<ProbeResult>(env.t, 'POST', `/api/llm/profiles/${env.profile.id}/test`);
    expect(bad.hint).toContain('API Key');
    const s = await statusOf(env);
    expect(s).toMatchObject({ state: 'error', source: 'test', hint: bad.hint });
    expect(s.error).toContain('HTTP 401');
    expect(JSON.stringify(s)).not.toContain(OLD_KEY);

    await ok(env.t, 'PATCH', `/api/llm/profiles/${env.profile.id}`, { temperature: 0.5 });
    expect((await statusOf(env)).state).toBe('error');
    await ok(env.t, 'PATCH', `/api/llm/profiles/${env.profile.id}`, { apiKey: NEW_KEY });
    expect((await statusOf(env)).state).toBe('unknown');

    await ok(env.t, 'DELETE', `/api/llm/profiles/${env.profile.id}`, undefined, 204);
    expect(await ok<Record<string, LlmProfileStatus>>(env.t, 'GET', '/api/llm/status')).toEqual({});
  });

  it('状态变化通过 SSE 推送 llm.status，订阅某部作品的连接也能收到', async () => {
    const env = await setup(() => completion(OK));
    const sse = collectEvents(env.t, env.workId);
    opened.push({ close: async () => sse.close() });
    await new Promise((r) => setTimeout(r, 50));
    await ok(env.t, 'POST', `/api/llm/profiles/${env.profile.id}/test`);
    const ev = await waitFor(
      async () => sse.events.find((e): e is Extract<ServerEvent, { type: 'llm.status' }> => e.type === 'llm.status' && e.profileId === env.profile.id),
      (e) => e?.status.state === 'ok',
      'llm.status 推送',
    );
    assertDto('LlmProfileStatus', ev?.status);
  });

  it('任务请求的失败反映到状态：401 → 任务失败、模型异常（来自 AI 任务）并给出建议', async () => {
    const env = await setup(() => errorReply(401, 'invalid api key'));
    const job = await startTypo(env);
    await waitFor(() => jobOf(env, job.id), (j) => j.status === 'failed', '任务失败');
    const s = await waitFor(() => statusOf(env), (x) => x.state === 'error', '状态变为异常');
    expect(s).toMatchObject({ source: 'task', active: 0, waiting: 0 });
    expect(s.hint).toContain('API Key');
  });
});

describe('测试连接不再「一直测试中」', () => {
  it('任务的请求卡住时，测试连接不排在它后面；状态显示进行中的请求', async () => {
    // 任务请求一直不返回（并发 1，名额被占满）；测试连接的请求立即返回
    const env = await setup((req) => (isProbe(req) ? completion(OK) : { ...typoReply(req), delayMs: 20_000 }), { timeoutMs: 60_000 });
    const job = await startTypo(env);
    await waitFor(() => statusOf(env), (s) => s.active === 1, '任务请求进行中');
    const t0 = Date.now();
    const r = await ok<ProbeResult>(env.t, 'POST', `/api/llm/profiles/${env.profile.id}/test`);
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await statusOf(env)).toMatchObject({ state: 'ok', source: 'test', active: 1 });
    await ok(env.t, 'POST', `${env.W}/jobs/${job.id}/cancel`);
  });

  it('客户端断开（界面上「取消测试」或关闭页面）时服务端中止测试，不记录结果', async () => {
    const env = await setup(() => ({ ...completion(OK), delayMs: 20_000 }));
    await rawRequest(env.t.app.port, {
      method: 'POST',
      path: `/api/llm/profiles/${env.profile.id}/test`,
      headers: { Cookie: env.t.cookie, Origin: `http://127.0.0.1:${env.t.app.port}` },
      timeoutMs: 100,
    }).catch(() => undefined);
    await waitFor(async () => env.t.log.lines.some((l) => l.includes('/test') && l.includes('已取消')), Boolean, '服务端中止测试');
    expect(await statusOf(env)).toMatchObject({ state: 'unknown' });
    expect(env.t.log.lines.some((l) => l.includes('测试连接成功') || l.includes('测试连接失败'))).toBe(false);
  });
});

describe('运行中修改模型配置：进行中的请求按新配置重发', () => {
  it('Key 填错导致请求卡住，改成正确的 Key 后任务立即按新 Key 重发并完成', async () => {
    const keys: string[] = [];
    const env = await setup(
      (req) => {
        const auth = req.headers.authorization ?? '';
        keys.push(auth.slice(-4));
        // 旧 Key 的请求一直不返回（模拟卡在超时上）；新 Key 正常
        return auth === `Bearer ${NEW_KEY}` ? typoReply(req) : { ...typoReply(req), delayMs: 20_000 };
      },
      { timeoutMs: 60_000 },
    );
    const job = await startTypo(env);
    await waitFor(() => statusOf(env), (s) => s.active === 1, '旧 Key 的请求进行中');
    await ok(env.t, 'PATCH', `/api/llm/profiles/${env.profile.id}`, { apiKey: NEW_KEY });
    const done = await waitFor(() => jobOf(env, job.id), (j) => j.status === 'done', '任务按新 Key 完成');
    expect(done).toMatchObject({ doneUnits: 1, failedUnits: 0, error: null });
    expect(keys).toEqual([OLD_KEY.slice(-4), NEW_KEY.slice(-4)]);
    expect((await ok<unknown[]>(env.t, 'GET', `${env.W}/issues?jobId=${job.id}`)).length).toBeGreaterThan(0);
    expect(env.t.log.lines.some((l) => l.includes('1 个进行中的请求已停止'))).toBe(true);
    expect(await statusOf(env)).toMatchObject({ state: 'ok', source: 'task', active: 0 });
  });

  it('只改其他参数时：模型正常不打断请求；模型异常且有请求卡住时同样中止重发', async () => {
    let slow = true;
    const env = await setup((req) => (slow ? { ...typoReply(req), delayMs: 300 } : typoReply(req)), { timeoutMs: 60_000 });
    const job = await startTypo(env);
    await waitFor(() => statusOf(env), (s) => s.active === 1, '请求进行中');
    await ok(env.t, 'PATCH', `/api/llm/profiles/${env.profile.id}`, { temperature: 0.4 });
    await waitFor(() => jobOf(env, job.id), (j) => j.status === 'done', '任务完成');
    expect(env.llm.requests).toHaveLength(1);

    // 异常状态（如上一次超时）+ 有请求卡住：改超时后中止重发
    env.t.app.services.llm.client.health.failure(env.profile.id, 'task', '请求超时（180 秒）', '');
    slow = true;
    env.llm.handle = (req) => (slow ? { ...typoReply(req), delayMs: 20_000 } : typoReply(req));
    const second = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'typo', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });
    await waitFor(() => statusOf(env), (s) => s.active === 1, '第二个任务的请求进行中');
    slow = false;
    await ok(env.t, 'PATCH', `/api/llm/profiles/${env.profile.id}`, { timeoutMs: 120_000 });
    await waitFor(() => jobOf(env, second.id), (j) => j.status === 'done', '第二个任务按新配置完成');
    expect(env.llm.requests).toHaveLength(3);
  });

  it('删除运行中任务使用的模型配置：任务失败并说明原因', async () => {
    const env = await setup((req) => ({ ...typoReply(req), delayMs: 20_000 }), { timeoutMs: 60_000 });
    const job = await startTypo(env);
    await waitFor(() => statusOf(env), (s) => s.active === 1, '请求进行中');
    await ok(env.t, 'DELETE', `/api/llm/profiles/${env.profile.id}`, undefined, 204);
    const failed = await waitFor(() => jobOf(env, job.id), (j) => j.status === 'failed', '任务失败');
    expect(failed.error).toContain('模型配置已被删除');
  });

  it('测试连接进行中修改了配置：测试中止并说明原因（不记录过时的结果）', async () => {
    const env = await setup(() => ({ ...completion(OK), delayMs: 20_000 }));
    const pending = env.t.call('POST', `/api/llm/profiles/${env.profile.id}/test`);
    await new Promise((r) => setTimeout(r, 100));
    await ok(env.t, 'PATCH', `/api/llm/profiles/${env.profile.id}`, { model: 'mock-model-2' });
    const res = await pending;
    expect(res.status).toBe(502);
    expect((res.json as { error: { message: string } }).error.message).toBe(RESTART_MESSAGE);
    expect((await statusOf(env)).state).toBe('unknown');
  });
});
