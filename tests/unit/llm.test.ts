import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LLM_PROFILE_DEFAULTS, LLM_RETRY_AFTER_MAX_MS, LLM_RETRY_DELAYS_MS, LLM_TIMEOUT_RETRIES, TASK_KINDS } from '../../src/shared/constants';
import type { LlmConfig, LlmProfileRecord, LlmProfileStatus } from '../../src/shared/types';
import {
  LlmClient,
  buildRequestBody,
  chatCompletionsUrl,
  ensureJsonKeyword,
  extractJson,
  type ChatMessage,
} from '../../src/server/llm/client';
import { LlmError } from '../../src/server/llm/errors';
import { ALL_MODES_FAILED_HINT, llmErrorHint, meansUnavailable } from '../../src/server/llm/health';
import { Semaphore } from '../../src/server/llm/limiter';
import { LLM_PRESETS, findPresetProblems, validatePresets } from '../../src/server/llm/presets';
import { probeProfile } from '../../src/server/llm/probe';
import { LlmProfiles, normalizeBaseUrl, toLlmProfile } from '../../src/server/llm/profiles';
import { parseRetryAfter, withRetry } from '../../src/server/llm/retry';
import { defaultLlmConfig, sanitizeLlmConfig } from '../../src/server/system/config';
import { createSilentLogger } from '../../src/server/system/logger';
import { DomainError } from '../../src/server/errors';
import { completion, errorReply, startMockLlm, type MockLlm } from '../helpers/mock-llm';

const KEY = 'sk-unit-SECRET-0123456789abcdef';
const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, count: { type: 'integer' } },
  required: ['title', 'count'],
  additionalProperties: false,
} as const;
const MESSAGES: ChatMessage[] = [
  { role: 'system', content: '你是测试助手，输出 JSON。' },
  { role: 'user', content: '给出标题和数量' },
];

function profile(overrides: Partial<LlmProfileRecord> = {}): LlmProfileRecord {
  return {
    id: 'p1',
    name: '测试模型',
    baseUrl: mock.baseUrl,
    apiKey: KEY,
    model: 'mock-model',
    jsonMode: 'json_object',
    maxConcurrency: 3,
    timeoutMs: 5000,
    maxOutputTokens: 1024,
    contextTokens: 8192,
    temperature: 0.2,
    extraBody: {},
    ...overrides,
  };
}

let mock: MockLlm;
let sleeps: number[] = [];
const log = createSilentLogger();
const client = new LlmClient({
  log,
  userAgent: 'NovelEditor/test',
  sleep: (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  },
});

beforeAll(async () => {
  mock = await startMockLlm();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.requests.length = 0;
  mock.maxInFlight = 0;
  sleeps = [];
  mock.handle = () => completion('{"title":"第一章","count":3}');
});

const chat = (p: LlmProfileRecord = profile(), signal?: AbortSignal) =>
  client.chatJson<{ title: string; count: number }>({ profile: p, messages: MESSAGES, schema: SCHEMA, schemaName: 'out', signal });

async function llmError(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error('应当抛出 LlmError');
}

// ---------------------------------------------------------------------------

describe('retry：Retry-After 解析与退避', () => {
  it('秒数、小数、HTTP 日期、过大值、过去的日期、非法值', () => {
    const now = Date.parse('2026-10-09T08:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('0.5', now)).toBe(500);
    expect(parseRetryAfter('Fri, 09 Oct 2026 08:00:07 GMT', now)).toBe(7000);
    expect(parseRetryAfter('9999', now)).toBe(LLM_RETRY_AFTER_MAX_MS);
    expect(parseRetryAfter('Fri, 09 Oct 2026 07:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('只重试可重试错误，次数等于间隔数组长度；Retry-After 优先', async () => {
    const waits: number[] = [];
    const opts = { delaysMs: [10, 20, 40], sleep: (ms: number) => (waits.push(ms), Promise.resolve()) };
    let n = 0;
    await expect(
      withRetry(() => {
        n++;
        throw new LlmError('http', '限流', { status: 429, retryAfterMs: 1500 });
      }, opts),
    ).rejects.toThrow('限流');
    expect(n).toBe(4);
    expect(waits).toEqual([1500, 1500, 1500]);

    n = 0;
    waits.length = 0;
    await expect(
      withRetry(() => {
        n++;
        throw new LlmError('http', '未授权', { status: 401 });
      }, opts),
    ).rejects.toThrow('未授权');
    expect(n).toBe(1);
    expect(waits).toEqual([]);
  });

  it('timeoutRetries：超时单独限制次数，其他可重试错误不受影响', async () => {
    const opts = { delaysMs: [10, 20, 40], sleep: () => Promise.resolve(), timeoutRetries: 1 };
    let n = 0;
    await expect(
      withRetry(() => {
        n++;
        throw new LlmError('timeout', '超时');
      }, opts),
    ).rejects.toThrow('超时');
    expect(n).toBe(2);
    n = 0;
    await expect(
      withRetry(() => {
        n++;
        throw new LlmError('network', '断网');
      }, opts),
    ).rejects.toThrow('断网');
    expect(n).toBe(4);
  });

  it('LlmError.retryable 与 §7.3 一致', () => {
    const r = (kind: LlmError['kind'], status?: number): boolean => new LlmError(kind, '', { status }).retryable;
    expect([r('http', 429), r('http', 500), r('http', 503), r('timeout'), r('network'), r('empty'), r('length')]).toEqual(
      Array(7).fill(true),
    );
    expect([r('http', 400), r('http', 401), r('http', 404), r('bad_response'), r('invalid_output'), r('aborted'), r('config')]).toEqual(
      Array(7).fill(false),
    );
  });
});

describe('limiter：信号量', () => {
  it('并发不超过 size；调大后立即放行排队者', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const task = (): Promise<void> =>
      sem.run(
        () =>
          new Promise<void>((resolve) => {
            active++;
            peak = Math.max(peak, active);
            releases.push(() => {
              active--;
              resolve();
            });
          }),
      );
    const all = Promise.all([task(), task(), task(), task()]);
    await Promise.resolve();
    expect(sem.active).toBe(2);
    expect(sem.waiting).toBe(2);
    sem.setSize(3);
    await Promise.resolve();
    expect(sem.active).toBe(3);
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await all;
    expect(peak).toBe(3);
  });

  it('排队中被取消：移出队列并以 aborted 拒绝', async () => {
    const sem = new Semaphore(1);
    let release = (): void => undefined;
    const first = sem.run(() => new Promise<void>((r) => (release = r)));
    const ac = new AbortController();
    const second = sem.run(() => Promise.resolve('不应执行'), ac.signal);
    expect(sem.waiting).toBe(1);
    ac.abort();
    expect((await llmError(second)).kind).toBe('aborted');
    expect(sem.waiting).toBe(0);
    release();
    await first;
    expect(sem.active).toBe(0);
  });

  it('进行中、排队数变化时通知（用于推送模型运行状态）；中止原因随拒绝透传', async () => {
    const seen: string[] = [];
    const sem = new Semaphore(1, () => seen.push(`${sem.active}/${sem.waiting}`));
    let release = (): void => undefined;
    const first = sem.run(() => new Promise<void>((r) => (release = r)));
    const ac = new AbortController();
    const second = sem.run(() => Promise.resolve(), ac.signal);
    ac.abort(new LlmError('aborted', '模型配置已修改'));
    expect((await llmError(second)).message).toBe('模型配置已修改');
    release();
    await first;
    expect(seen).toEqual(['1/0', '1/1', '1/0', '0/0']);
  });
});

describe('health：模型运行状态与处理建议（§7.3「运行状态」）', () => {
  it('哪些失败说明服务不可用；每类都有处理建议', () => {
    const e = (kind: LlmError['kind'], status?: number) => new LlmError(kind, '', { status });
    expect([e('timeout'), e('network'), e('config'), e('bad_response'), e('http', 401), e('http', 402), e('http', 404), e('http', 429), e('http', 503), e('http', 302)].map(meansUnavailable)).toEqual(
      Array(10).fill(true),
    );
    expect([e('http', 400), e('http', 413), e('http', 422), e('empty'), e('length'), e('invalid_output'), e('aborted')].map(meansUnavailable)).toEqual(Array(7).fill(false));
    expect(llmErrorHint(e('http', 401))).toContain('API Key');
    expect(llmErrorHint(e('http', 402))).toContain('余额');
    expect(llmErrorHint(e('http', 404))).toContain('模型名');
    expect(llmErrorHint(e('http', 429))).toContain('并发');
    expect(llmErrorHint(e('http', 502))).toContain('服务端');
    expect(llmErrorHint(e('http', 302))).toContain('最终地址');
    expect(llmErrorHint(e('timeout'))).toContain('超时');
    expect(llmErrorHint(e('network'))).toContain('服务地址');
    expect(llmErrorHint(e('bad_response'))).toContain('/v1');
  });

  function freshClient(): { c: LlmClient; events: LlmProfileStatus[] } {
    const events: LlmProfileStatus[] = [];
    const c = new LlmClient({ log, userAgent: 'NovelEditor/test', sleep: () => Promise.resolve(), now: () => 1000, onStatus: (_id, s) => events.push(s), statusThrottleMs: 0 });
    return { c, events };
  }
  const chatWith = (c: LlmClient, p: LlmProfileRecord, signal?: AbortSignal) =>
    c.chatJson<{ title: string; count: number }>({ profile: p, messages: MESSAGES, schema: SCHEMA, schemaName: 'out', signal });
  const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('任务请求：成功为 ok；401 为 error 并带建议；400 等与内容有关的失败不改变状态；变化会推送', async () => {
    const { c, events } = freshClient();
    const p = profile({ id: 'h1' });
    expect(c.health.get('h1')).toEqual({ state: 'unknown', at: null, source: null, latencyMs: null, error: null, hint: null, active: 0, waiting: 0, retrying: 0 });
    await chatWith(c, p);
    expect(c.health.get('h1')).toMatchObject({ state: 'ok', source: 'task', at: 1000, error: null });
    expect(c.health.get('h1').latencyMs).toBeGreaterThanOrEqual(0);

    mock.handle = () => errorReply(401, `bad key ${KEY}`);
    await llmError(chatWith(c, p));
    const s = c.health.get('h1');
    expect(s).toMatchObject({ state: 'error', source: 'task' });
    expect(s.error).toContain('HTTP 401');
    expect(s.error).not.toContain(KEY);
    expect(s.hint).toContain('API Key');

    mock.handle = () => errorReply(400, 'content risk');
    await llmError(chatWith(c, p));
    expect(c.health.get('h1').error).toContain('HTTP 401');
    await tick(20);
    expect(events.at(-1)).toMatchObject({ state: 'error', active: 0, waiting: 0 });
  });

  it('进行中、排队与重试中的数量', async () => {
    const { c } = freshClient();
    const p = profile({ id: 'h2', maxConcurrency: 1 });
    let seenRetrying = -1;
    mock.handle = (_req, i) => {
      if (i === 0) return errorReply(503, 'busy');
      if (i === 1) seenRetrying = c.health.get('h2').retrying;
      return { ...completion('{"title":"a","count":1}'), delayMs: 40 };
    };
    const a = chatWith(c, p);
    const b = chatWith(c, p);
    await tick();
    expect(c.health.get('h2')).toMatchObject({ active: 1, waiting: 1 });
    await Promise.all([a, b]);
    expect(seenRetrying).toBe(1);
    expect(c.health.get('h2')).toMatchObject({ state: 'ok', active: 0, waiting: 0, retrying: 0 });
  });

  it('restart：中止进行中、排队与等待重试的请求，带上原因；之后的请求正常', async () => {
    const { c } = freshClient();
    const p = profile({ id: 'h3', maxConcurrency: 1 });
    mock.handle = () => ({ ...completion('{"title":"a","count":1}'), delayMs: 300 });
    const running = chatWith(c, p);
    const queued = chatWith(c, p);
    await tick(30);
    expect(c.restart('h3', '模型配置已修改')).toBe(2);
    const [e1, e2] = await Promise.all([llmError(running), llmError(queued)]);
    expect([e1.kind, e1.message, e2.kind, e2.message]).toEqual(['aborted', '模型配置已修改', 'aborted', '模型配置已修改']);
    expect(c.health.get('h3')).toMatchObject({ active: 0, waiting: 0, state: 'unknown' });
    mock.handle = () => completion('{"title":"b","count":2}');
    expect((await chatWith(c, p)).value).toEqual({ title: 'b', count: 2 });
  });
});

describe('client：请求体与输出解析', () => {
  it('三档 response_format（§7.3）', () => {
    const p = profile();
    const schemaBody = buildRequestBody(p, MESSAGES, 'json_schema', SCHEMA, 'out');
    expect(schemaBody).toEqual({
      model: 'mock-model',
      messages: MESSAGES,
      temperature: 0.2,
      max_tokens: 1024,
      response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema: SCHEMA } },
    });
    expect(buildRequestBody(p, MESSAGES, 'json_object', SCHEMA, 'out').response_format).toEqual({ type: 'json_object' });
    expect('response_format' in buildRequestBody(p, MESSAGES, 'prompt', SCHEMA, 'out')).toBe(false);
  });

  it('extraBody 透传；值为 null 表示删除字段；保留字段被忽略', () => {
    const p = profile({
      extraBody: { enable_thinking: false, max_tokens: null, max_completion_tokens: 2048, model: 'evil', stream: true },
    });
    const body = buildRequestBody(p, MESSAGES, 'json_object', SCHEMA, 'out');
    expect(body.enable_thinking).toBe(false);
    expect('max_tokens' in body).toBe(false);
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.model).toBe('mock-model');
    expect('stream' in body).toBe(false);
  });

  it('json_object 档缺少 "JSON" 字样时自动补充', () => {
    const plain: ChatMessage[] = [
      { role: 'system', content: '你是编辑' },
      { role: 'user', content: '检查' },
    ];
    expect(ensureJsonKeyword(plain)[0]?.content).toMatch(/JSON/);
    expect(ensureJsonKeyword(plain)[1]).toEqual(plain[1]);
    expect(ensureJsonKeyword([{ role: 'user', content: '检查' }])[0]?.role).toBe('system');
    expect(ensureJsonKeyword(MESSAGES)).toBe(MESSAGES);
  });

  it('extractJson：整体解析、代码围栏、前后夹杂说明文字', () => {
    expect(extractJson(' {"a":1} ')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":{"b":2}}\n```')).toEqual({ a: { b: 2 } });
    expect(extractJson('好的，结果如下：{"a":"}"} 希望有帮助')).toEqual({ a: '}' });
    expect(() => extractJson('没有 JSON')).toThrow(SyntaxError);
  });

  it('chatCompletionsUrl 去掉末尾斜杠', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/chat/completions');
  });
});

describe('client：与 mock OpenAI 服务交互', () => {
  it('成功：带 Bearer 与 User-Agent，读取 content 并校验，累计用量', async () => {
    const r = await chat();
    expect(r).toEqual({ value: { title: '第一章', count: 3 }, usage: { promptTokens: 10, completionTokens: 5 }, requests: 1, repaired: false });
    const req = mock.requests[0];
    expect(req?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req?.headers['user-agent']).toBe('NovelEditor/test');
    expect(req?.body.response_format).toEqual({ type: 'json_object' });
  });

  it('没有 Key 时不发送 Authorization（本机服务）', async () => {
    await chat(profile({ apiKey: '' }));
    expect(mock.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('忽略 reasoning_content，只读 content', async () => {
    mock.handle = () => ({
      json: {
        choices: [{ message: { content: '{"title":"t","count":1}', reasoning_content: '{"title":"错","count":9}' }, finish_reason: 'stop' }],
      },
    });
    expect((await chat()).value).toEqual({ title: 't', count: 1 });
  });

  it('429 + Retry-After：按服务端给的时长等待后重试', async () => {
    mock.handle = (_req, i) => (i === 0 ? errorReply(429, 'rate limited', { 'Retry-After': '2' }) : completion('{"title":"a","count":1}'));
    const r = await chat();
    expect(r.requests).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('5xx 按 2 s、4 s 指数退避', async () => {
    mock.handle = (_req, i) => (i < 2 ? errorReply(502, 'bad gateway') : completion('{"title":"a","count":1}'));
    const r = await chat();
    expect(r.requests).toBe(3);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it('401 不重试，错误带提示；服务端回显的 Key 被脱敏（INV-17）', async () => {
    mock.handle = () => errorReply(401, `Incorrect API key provided: ${KEY}`);
    const err = await llmError(chat());
    expect(err.kind).toBe('http');
    expect(err.status).toBe(401);
    expect(err.message).toContain('API Key 无效');
    expect(err.message).not.toContain(KEY);
    expect(mock.requests).toHaveLength(1);
  });

  it('空 content：重试，失败那次的用量也计入', async () => {
    mock.handle = (_req, i) => (i === 0 ? completion(null, { promptTokens: 7, completionTokens: 0 }) : completion('{"title":"a","count":1}'));
    const r = await chat();
    expect(r.requests).toBe(2);
    expect(r.usage).toEqual({ promptTokens: 17, completionTokens: 5 });
    expect(sleeps).toEqual([2000]);
  });

  it('finish_reason=length：重试 3 次后仍截断则抛 length，并带上全部用量', async () => {
    mock.handle = () => completion('{"title":"被截', { finishReason: 'length', promptTokens: 10, completionTokens: 1024 });
    const err = await llmError(chat());
    expect(err.kind).toBe('length');
    expect(mock.requests).toHaveLength(4);
    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(err.usage).toEqual({ promptTokens: 40, completionTokens: 4096 });
  });

  it('非法 JSON → 一次修复重试：把原输出和错误发回模型', async () => {
    mock.handle = (_req, i) => (i === 0 ? completion('{"title": "缺引号, count: 1}') : completion('{"title":"修好了","count":1}'));
    const r = await chat();
    expect(r).toMatchObject({ value: { title: '修好了', count: 1 }, requests: 2, repaired: true });
    const msgs = mock.requests[1]?.body.messages ?? [];
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toEqual({ role: 'assistant', content: '{"title": "缺引号, count: 1}' });
    expect(msgs[3]?.role).toBe('user');
    expect(msgs[3]?.content).toContain('不是合法 JSON');
    expect(sleeps, '修复重试不需要等待').toEqual([]);
  });

  it('Schema 不符（缺字段、多字段）同样触发修复；两次都不符抛 invalid_output', async () => {
    mock.handle = (_req, i) => completion(i === 0 ? '{"title":"a"}' : '{"title":"a","count":1,"extra":true}');
    const err = await llmError(chat());
    expect(err.kind).toBe('invalid_output');
    expect(err.message).toContain('多余字段 extra');
    expect(mock.requests[1]?.body.messages?.[3]?.content).toContain('缺少字段 count');
    expect(mock.requests).toHaveLength(2);
    expect(err.usage).toEqual({ promptTokens: 20, completionTokens: 10 });
  });

  it('超时可重试，但最多 LLM_TIMEOUT_RETRIES 次（每次都要等满超时）；之后抛 timeout', async () => {
    mock.handle = () => ({ ...completion('{"title":"a","count":1}'), delayMs: 300 });
    const err = await llmError(chat(profile({ timeoutMs: 60 })));
    expect(err.kind).toBe('timeout');
    expect(mock.requests).toHaveLength(LLM_TIMEOUT_RETRIES + 1);
    expect(LLM_TIMEOUT_RETRIES).toBeLessThan(LLM_RETRY_DELAYS_MS.length);
  });

  it('取消：请求进行中 abort → aborted，不重试', async () => {
    mock.handle = () => ({ ...completion('{"title":"a","count":1}'), delayMs: 300 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const err = await llmError(chat(profile(), ac.signal));
    expect(err.kind).toBe('aborted');
    expect(mock.requests).toHaveLength(1);
  });

  it('网络错误（连接被断开）可重试，消息中不含 Key', async () => {
    mock.handle = (_req, i) => (i < 2 ? { destroy: true } : completion('{"title":"a","count":1}'));
    expect((await chat()).requests).toBe(3);
    mock.handle = () => ({ destroy: true });
    const err = await llmError(chat());
    expect(err.kind).toBe('network');
    expect(err.message).toContain('网络错误');
    expect(err.message).not.toContain(KEY);
  });

  it('200 但不是 chat/completions 响应（如填错地址返回 HTML）：bad_response，不重试', async () => {
    mock.handle = () => ({ text: '<html><body>Welcome</body></html>' });
    const err = await llmError(chat());
    expect(err.kind).toBe('bad_response');
    expect(mock.requests).toHaveLength(1);
  });

  it('重定向不跟随（避免把 Key 带到别的地址）', async () => {
    mock.handle = () => ({ status: 302, headers: { Location: 'https://elsewhere.example/v1/chat/completions' } });
    const err = await llmError(chat());
    expect(err.kind).toBe('http');
    expect(err.message).toContain('重定向');
    expect(mock.requests).toHaveLength(1);
  });

  it('缺少服务地址或模型名：config 错误，不发请求', async () => {
    expect((await llmError(chat(profile({ model: ' ' })))).kind).toBe('config');
    expect(mock.requests).toHaveLength(0);
  });

  it('并发受 maxConcurrency 限制', async () => {
    mock.handle = () => ({ ...completion('{"title":"a","count":1}'), delayMs: 40 });
    const p = profile({ id: 'concurrency', maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => chat(p)));
    expect(mock.requests).toHaveLength(6);
    expect(mock.maxInFlight).toBe(2);
  });

  it('日志中不出现明文 Key（INV-17）', () => {
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.lines.join('\n')).not.toContain(KEY);
  });
});

describe('probe：能力探测逐档降级', () => {
  const OK = '{"ok":true,"reply":"pong"}';
  const modeOf = (i: number): string => mock.requests[i]?.body.response_format?.type ?? 'prompt';

  it('支持 json_schema 时取 json_schema，只发 1 个请求', async () => {
    mock.handle = () => completion(OK);
    const r = await probeProfile(client, profile());
    expect(r).toMatchObject({ ok: true, jsonMode: 'json_schema', error: null });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'probe', strict: true } });
  });

  it('json_schema 返回 400 → json_object（DeepSeek 的情况）', async () => {
    mock.handle = (req) =>
      req.body.response_format?.type === 'json_schema' ? errorReply(400, 'This response_format type is unavailable now') : completion(OK);
    const r = await probeProfile(client, profile({ jsonMode: 'prompt' }));
    expect(r).toMatchObject({ ok: true, jsonMode: 'json_object' });
    expect([modeOf(0), modeOf(1)]).toEqual(['json_schema', 'json_object']);
  });

  it('前两档都不支持 → prompt（输出夹杂说明文字也能解析）', async () => {
    mock.handle = (req) => (req.body.response_format !== undefined ? errorReply(400, 'unsupported') : completion(`好的：${OK}`));
    const r = await probeProfile(client, profile());
    expect(r).toMatchObject({ ok: true, jsonMode: 'prompt' });
    expect(mock.requests).toHaveLength(3);
  });

  it('json_schema 档输出不合格也算不支持，降级到下一档', async () => {
    mock.handle = (req) => completion(req.body.response_format?.type === 'json_schema' ? '{"answer":"pong"}' : OK);
    expect(await probeProfile(client, profile())).toMatchObject({ ok: true, jsonMode: 'json_object' });
  });

  it('空 content 在同一档再试一次（DeepSeek 偶发空内容）', async () => {
    mock.handle = (req, i) => {
      if (req.body.response_format?.type === 'json_schema') return errorReply(400, 'unsupported');
      return i === 1 ? completion(null) : completion(OK);
    };
    expect(await probeProfile(client, profile())).toMatchObject({ ok: true, jsonMode: 'json_object' });
    expect([modeOf(0), modeOf(1), modeOf(2)]).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('401：与档位无关，立即失败，不继续降级，jsonMode 保持原值，错误中无 Key', async () => {
    mock.handle = () => errorReply(401, `invalid key ${KEY}`);
    const r = await probeProfile(client, profile({ jsonMode: 'json_object' }));
    expect(r).toMatchObject({ ok: false, jsonMode: 'json_object' });
    expect(r.error).toContain('API Key 无效');
    expect(r.error).not.toContain(KEY);
    expect(mock.requests).toHaveLength(1);
  });

  it('429 / 网络错误也立即失败（不误判为能力不足）', async () => {
    mock.handle = () => errorReply(429, 'slow down');
    expect(await probeProfile(client, profile())).toMatchObject({ ok: false });
    expect(mock.requests).toHaveLength(1);
    mock.handle = () => ({ destroy: true });
    const r = await probeProfile(client, profile());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('网络错误');
    expect(mock.requests).toHaveLength(2);
  });

  it('三档都不合格：失败并列出每档原因', async () => {
    mock.handle = () => completion('pong');
    const r = await probeProfile(client, profile());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/json_schema：.*json_object：.*prompt：/);
    expect(r.hint).toBe(ALL_MODES_FAILED_HINT);
    expect(mock.requests).toHaveLength(3);
  });

  it('失败带处理建议，成功时 hint 为 null；探测不计入任务的运行状态', async () => {
    mock.handle = () => errorReply(401, 'invalid key');
    const p = profile({ id: 'probe-hint' });
    expect((await probeProfile(client, p)).hint).toContain('API Key');
    mock.handle = () => completion(OK);
    expect((await probeProfile(client, p)).hint).toBeNull();
    expect(client.health.get('probe-hint').state).toBe('unknown');
  });

  it('不排在任务后面：并发名额被占满时立即发出', async () => {
    const p = profile({ id: 'probe-busy', maxConcurrency: 1 });
    mock.handle = (req) => (req.body.response_format === undefined ? { ...completion('{"title":"a","count":1}'), delayMs: 300 } : completion(OK));
    const order: string[] = [];
    const task = chat({ ...p, jsonMode: 'prompt' }).then(() => order.push('task'));
    const queued = chat({ ...p, jsonMode: 'prompt' }).then(() => order.push('queued'));
    await new Promise((r) => setTimeout(r, 20));
    const r = await probeProfile(client, p);
    order.push('probe');
    await Promise.all([task, queued]);
    expect(r.ok).toBe(true);
    expect(order).toEqual(['probe', 'task', 'queued']);
  });

  it('单次请求的超时不超过 requestTimeoutMs：超时立即失败，建议检查网络', async () => {
    mock.handle = () => ({ ...completion(OK), delayMs: 300 });
    const r = await probeProfile(client, profile({ timeoutMs: 180_000 }), undefined, { requestTimeoutMs: 50 });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain('请求超时');
    expect(r.hint).toContain('网络');
    expect(mock.requests).toHaveLength(1);
  });

  it('整个探测超过 deadlineMs：返回测试超时', async () => {
    mock.handle = () => ({ ...completion(OK), delayMs: 300 });
    const r = await probeProfile(client, profile(), undefined, { requestTimeoutMs: 5000, deadlineMs: 60 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('测试超时');
  });

  it('调用方取消或配置被修改：抛出 aborted，不返回结果', async () => {
    mock.handle = () => ({ ...completion(OK), delayMs: 300 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    expect((await llmError(probeProfile(client, profile(), ac.signal))).kind).toBe('aborted');
    const p = profile({ id: 'probe-restart' });
    setTimeout(() => client.restart('probe-restart', '模型配置已修改'), 20);
    expect((await llmError(probeProfile(client, p))).message).toBe('模型配置已修改');
  });
});

describe('profiles：模型配置管理', () => {
  function setup(config: LlmConfig = defaultLlmConfig()) {
    const saved: LlmConfig[] = [];
    let ids = 0;
    const profiles = new LlmProfiles({ config, save: (c) => saved.push(structuredClone(c)), log: createSilentLogger(), newId: () => `id${++ids}` });
    return { profiles, saved };
  }
  const base = { name: ' DeepSeek ', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', apiKey: KEY };

  it('新建：规范化、补默认值、响应只含掩码 Key 并持久化', () => {
    const { profiles, saved } = setup();
    const p = profiles.create(base);
    expect(p).toEqual({
      id: 'id1',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyMasked: 'sk-****cdef',
      jsonMode: LLM_PROFILE_DEFAULTS.jsonMode,
      maxConcurrency: LLM_PROFILE_DEFAULTS.maxConcurrency,
      timeoutMs: LLM_PROFILE_DEFAULTS.timeoutMs,
      maxOutputTokens: LLM_PROFILE_DEFAULTS.maxOutputTokens,
      contextTokens: LLM_PROFILE_DEFAULTS.contextTokens,
      temperature: LLM_PROFILE_DEFAULTS.temperature,
      extraBody: {},
    });
    expect(JSON.stringify(profiles.list())).not.toContain(KEY);
    expect(saved.at(-1)?.profiles[0]?.apiKey).toBe(KEY);
    expect(profiles.get('id1').apiKey).toBe(KEY);
    expect(toLlmProfile({ ...profiles.get('id1'), apiKey: '' }).apiKeyMasked).toBe('');
  });

  it('修改：apiKey 为空表示不修改；同域名换路径保留 Key；换域名未给新 Key 时清空', () => {
    const { profiles } = setup();
    profiles.create(base);
    profiles.update('id1', { name: '改名', apiKey: '' });
    expect(profiles.get('id1').apiKey).toBe(KEY);
    profiles.update('id1', { baseUrl: 'https://api.deepseek.com/v1' });
    expect(profiles.get('id1').apiKey).toBe(KEY);
    profiles.update('id1', { baseUrl: 'https://proxy.example.com/v1' });
    expect(profiles.get('id1').apiKey, '换了服务方，旧 Key 不能被发过去').toBe('');
    profiles.update('id1', { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-new-key-000000001' });
    expect(profiles.get('id1').apiKey).toBe('sk-new-key-000000001');
  });

  it('校验：保留字段、上下文预算、空名称、非法地址；失败时不写入', () => {
    const { profiles, saved } = setup();
    profiles.create(base);
    const n = saved.length;
    const expectInvalid = (fn: () => unknown, msg: RegExp): void => {
      expect(fn).toThrow(DomainError);
      expect(fn).toThrow(msg);
    };
    expectInvalid(() => profiles.update('id1', { extraBody: { stream: true } }), /stream/);
    expectInvalid(() => profiles.update('id1', { maxOutputTokens: 8192, contextTokens: 9000 }), /至少要比最大输出多/);
    expectInvalid(() => profiles.update('id1', { name: '   ' }), /名称不能为空/);
    expectInvalid(() => profiles.create({ ...base, baseUrl: 'ftp://x' }), /http/);
    expectInvalid(() => profiles.create({ ...base, baseUrl: 'https://u:p@x.com' }), /用户名或密码/);
    expect(saved.length).toBe(n);
    expect(() => profiles.update('nope', { name: 'x' })).toThrow(/不存在/);
  });

  it('normalizeBaseUrl：去掉末尾斜杠与 /chat/completions', () => {
    expect(normalizeBaseUrl(' https://api.openai.com/v1/chat/completions/ ')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1///')).toBe('http://127.0.0.1:11434/v1');
  });

  it('默认模型：只能指向已有配置；删除配置时对应默认项改为 null', () => {
    const { profiles } = setup();
    profiles.create(base);
    profiles.create({ ...base, name: '千问' });
    const map = Object.fromEntries(TASK_KINDS.map((k) => [k, k === 'summary' ? 'id2' : 'id1'])) as Record<(typeof TASK_KINDS)[number], string>;
    expect(profiles.setDefaults(map)).toEqual(map);
    expect(profiles.resolve('typo').id).toBe('id1');
    expect(profiles.resolve('typo', 'id2').id).toBe('id2');
    expect(() => profiles.setDefaults({ ...map, typo: 'ghost' })).toThrow(/不存在/);
    profiles.remove('id1');
    expect(profiles.getDefaults().typo).toBeNull();
    expect(profiles.getDefaults().summary).toBe('id2');
    expect(() => profiles.resolve('typo')).toThrow(/尚未为这类任务选择模型/);
  });

  it('setJsonMode：写回探测结果；配置已删除时忽略', () => {
    const { profiles, saved } = setup();
    profiles.create(base);
    profiles.setJsonMode('id1', 'prompt');
    expect(profiles.get('id1').jsonMode).toBe('prompt');
    const n = saved.length;
    profiles.setJsonMode('id1', 'prompt');
    profiles.setJsonMode('ghost', 'json_schema');
    expect(saved.length, '无变化时不写文件').toBe(n);
  });

  it('保存失败时内存状态不变', () => {
    const profiles = new LlmProfiles({
      config: defaultLlmConfig(),
      save: () => {
        throw new Error('磁盘已满');
      },
      log: createSilentLogger(),
    });
    expect(() => profiles.create(base)).toThrow('磁盘已满');
    expect(profiles.list()).toEqual([]);
  });

  it('构造时登记已有 Key，日志自动脱敏', () => {
    const logger = createSilentLogger();
    const config = sanitizeLlmConfig({ version: 1, profiles: [{ id: 'a', name: 'x', baseUrl: '', apiKey: 'plainkey-without-prefix-123' }] }).value;
    new LlmProfiles({ config, save: () => undefined, log: logger });
    logger.warn('上游返回：plainkey-without-prefix-123 无效');
    expect(logger.lines.join('')).not.toContain('plainkey-without-prefix-123');
  });
});

describe('presets：内置预设（§6.5）', () => {
  it('内置预设全部合法', () => {
    expect(() => validatePresets()).not.toThrow();
    expect(LLM_PRESETS.length).toBeGreaterThanOrEqual(7);
  });

  it('故意改坏：非本机 http、名称重复、末尾斜杠、空提示都会被发现', () => {
    const problems = findPresetProblems([
      { name: 'A', baseUrl: 'http://api.example.com/v1', modelHint: 'm' },
      { name: 'A', baseUrl: 'https://ok.example.com/', modelHint: ' ' },
      { name: 'B', baseUrl: 'http://localhost.evil.com/v1', modelHint: 'm' },
    ]);
    expect(problems).toHaveLength(5);
    expect(() => validatePresets([{ name: 'X', baseUrl: 'http://10.0.0.1/v1', modelHint: 'm' }])).toThrow(/https/);
  });
});
