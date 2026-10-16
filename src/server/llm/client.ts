import type { ErrorObject, ValidateFunction } from 'ajv';
import { LLM_EXTRA_BODY_RESERVED, LLM_RETRY_DELAYS_MS, LLM_TIMEOUT_RETRIES } from '../../shared/constants';
import type { Id, JsonMode, LlmProfileRecord, LlmProfileStatus } from '../../shared/types';
import { ajv } from '../system/ajv';
import { redact, type Logger } from '../system/logger';
import { LlmError, abortError, addUsage, zeroUsage, type Usage } from './errors';
import { LlmHealth, llmErrorHint, meansUnavailable } from './health';
import { LimiterRegistry } from './limiter';
import { abortableSleep, parseRetryAfter, withRetry, type Sleep } from './retry';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatJsonRequest {
  profile: LlmProfileRecord;
  messages: ChatMessage[];
  /** 期望的输出 JSON Schema（json_schema 档要求所有属性 required、additionalProperties: false）。 */
  schema: object;
  /** json_schema 档的 schema 名称：字母、数字、下划线、连字符。 */
  schemaName: string;
  signal?: AbortSignal;
}

export interface ChatJsonResult<T> {
  value: T;
  usage: Usage;
  /** 实际发出的 HTTP 请求数（含重试与修复重试）。 */
  requests: number;
  repaired: boolean;
}

export interface CompletionResult {
  content: string;
  usage: Usage;
  latencyMs: number;
}

export interface LlmClientOptions {
  log: Logger;
  userAgent: string;
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
  sleep?: Sleep;
  now?: () => number;
  /** 模型运行状态变化（合并 statusThrottleMs 内的多次变化）后调用，用于推送 llm.status。 */
  onStatus?: (profileId: Id, status: LlmProfileStatus) => void;
  statusThrottleMs?: number;
}

/** 单次请求是否计入模型运行状态：任务请求计入；测试连接由 Llm.test 记录最终结果，中间的逐档尝试不计入。 */
export type CompleteRequest = ChatJsonRequest & { mode: JsonMode; track?: boolean };

const PROVIDER_TEXT_MAX = 300;
const REPAIR_ECHO_MAX = 20_000;
const SCHEMA_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const chatCompletionsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

/** json_object 档要求提示词中出现 "JSON"（§7.3）；缺少时在第一条 system 消息末尾补一句，没有 system 就新增一条。 */
export function ensureJsonKeyword(messages: ChatMessage[]): ChatMessage[] {
  if (messages.some((m) => /json/i.test(m.content))) return messages;
  const note = '请只输出一个 JSON 对象。';
  const i = messages.findIndex((m) => m.role === 'system');
  if (i < 0) return [{ role: 'system', content: note }, ...messages];
  return messages.map((m, j) => (j === i ? { ...m, content: `${m.content}\n\n${note}` } : m));
}

/**
 * 组装请求体（§7.3）：`{ model, messages, temperature, max_tokens, response_format?, ...extraBody }`。
 * extraBody 中值为 null 的键表示删除该字段（如 `max_tokens: null` 配合 `max_completion_tokens`）；保留字段被忽略。
 */
export function buildRequestBody(
  profile: LlmProfileRecord,
  messages: ChatMessage[],
  mode: JsonMode,
  schema: object,
  schemaName: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    temperature: profile.temperature,
    max_tokens: profile.maxOutputTokens,
  };
  if (mode === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  } else if (mode === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  const reserved: readonly string[] = LLM_EXTRA_BODY_RESERVED;
  for (const [key, value] of Object.entries(profile.extraBody)) {
    if (reserved.includes(key)) continue;
    if (value === null) delete body[key];
    else body[key] = value;
  }
  return body;
}

/** 先整体解析；失败时取第一个 `{` 到最后一个 `}` 之间的内容（兼容 prompt 档和带代码围栏的输出）。 */
export function extractJson(content: string): unknown {
  const text = content.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new SyntaxError('输出中没有 JSON 对象');
    return JSON.parse(text.slice(start, end + 1));
  }
}

const validators = new WeakMap<object, ValidateFunction>();

function validatorFor(schema: object): ValidateFunction {
  let fn = validators.get(schema);
  if (fn === undefined) {
    fn = ajv.compile(schema);
    validators.set(schema, fn);
  }
  return fn;
}

function describeSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  const list = (errors ?? []).slice(0, 3).map((e) => {
    const where = e.instancePath === '' ? '根对象' : e.instancePath;
    if (e.keyword === 'required') return `${where} 缺少字段 ${String(e.params.missingProperty)}`;
    if (e.keyword === 'additionalProperties') return `${where} 有多余字段 ${String(e.params.additionalProperty)}`;
    return `${where} ${e.message ?? '不合法'}`;
  });
  return list.length > 0 ? list.join('；') : '不符合 Schema';
}

export type OutputCheck<T> = { ok: true; value: T } | { ok: false; message: string };

/** 解析并按 Schema 校验模型输出（INV-11）。 */
export function checkOutput<T>(schema: object, content: string): OutputCheck<T> {
  let value: unknown;
  try {
    value = extractJson(content);
  } catch (err) {
    return { ok: false, message: `不是合法 JSON（${err instanceof Error ? err.message : String(err)}）` };
  }
  const fn = validatorFor(schema);
  if (!fn(value)) return { ok: false, message: describeSchemaErrors(fn.errors) };
  return { ok: true, value: value as T };
}

function repairPrompt(problem: string): string {
  return `你上一次的输出不符合要求：${problem}。请严格按照要求的 JSON 结构重新输出完整结果，只输出 JSON，不要任何解释。`;
}

function causeMessage(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code} ${cause.message}` : cause.message;
  }
  return String(cause);
}

const HTTP_HINTS: Record<number, string> = {
  400: '请求参数不被接受',
  401: 'API Key 无效或未填写',
  402: '账户余额不足',
  403: '无权访问，请检查 Key 权限或账户状态',
  404: '接口地址或模型名不存在',
  413: '请求内容过长',
  429: '请求过于频繁或额度不足',
};

function providerDetail(text: string): string {
  let detail = text;
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const err = data.error;
    if (typeof err === 'string') detail = err;
    else if (typeof err?.message === 'string') detail = err.message;
    else if (typeof data.message === 'string') detail = data.message;
  } catch {
    detail = text.replace(/<[^>]*>/g, ' ');
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  return detail.length > PROVIDER_TEXT_MAX ? `${detail.slice(0, PROVIDER_TEXT_MAX)}…` : detail;
}

function readUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return { promptTokens: n(u.prompt_tokens), completionTokens: n(u.completion_tokens) };
}

/** OpenAI 兼容 chat/completions 客户端（ADR-007、§7.3）。非流式；只读 choices[0].message.content。 */
export class LlmClient {
  private readonly log: Logger;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly delaysMs: readonly number[];
  private readonly sleep: Sleep;
  readonly limiters: LimiterRegistry;
  /** 模型运行状态（§7.3「运行状态」）。 */
  readonly health: LlmHealth;
  /** 每个模型配置一个「代」：restart() 中止这一代的全部请求（进行中、排队、重试等待），之后的请求属于新的一代。 */
  private readonly generations = new Map<Id, AbortController>();

  constructor(options: LlmClientOptions) {
    this.log = options.log;
    this.userAgent = options.userAgent;
    this.fetchImpl = options.fetch ?? fetch;
    this.delaysMs = options.retryDelaysMs ?? LLM_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.limiters = new LimiterRegistry((id) => this.health.changed(id));
    this.health = new LlmHealth({
      now: options.now ?? Date.now,
      activity: (id) => this.limiters.activity(id),
      publish: options.onStatus,
      throttleMs: options.statusThrottleMs ?? 200,
    });
  }

  /** 在该模型配置的并发信号量内执行（§7.3「并发」）。 */
  runLimited<T>(profile: LlmProfileRecord, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.limiters.get(profile.id, profile.maxConcurrency).run(fn, signal);
  }

  /** 调用方的 signal 与该模型配置当前一代合并：任一中止都会停止请求。 */
  scoped(profileId: Id, signal?: AbortSignal): AbortSignal {
    let gen = this.generations.get(profileId);
    if (gen === undefined) {
      gen = new AbortController();
      this.generations.set(profileId, gen);
    }
    return signal === undefined ? gen.signal : AbortSignal.any([signal, gen.signal]);
  }

  /**
   * 中止该模型配置正在进行、排队和等待重试的全部请求（修改或删除配置时，§7.3「运行状态」）。被中止的调用抛出
   * LlmError('aborted', message)：任务把这些单元留作待执行并按新配置重新发送，AI 修复把原因返回给界面。
   * 返回被中止前进行中与排队的请求数。
   */
  restart(profileId: Id, message: string): number {
    const { active, waiting } = this.limiters.activity(profileId);
    this.generations.get(profileId)?.abort(new LlmError('aborted', message));
    this.generations.delete(profileId);
    return active + waiting;
  }

  /**
   * 结构化调用：可重试错误按退避重试（超时最多重试 LLM_TIMEOUT_RETRIES 次）；输出未通过 Schema 时做 1 次修复重试，
   * 仍失败抛 invalid_output。整个调用（含重试等待）占用一个并发名额，429 时不会让其他单元一起涌上去。
   */
  async chatJson<T>(req: ChatJsonRequest): Promise<ChatJsonResult<T>> {
    const { profile, schema } = req;
    const signal = this.scoped(profile.id, req.signal);
    const usage = zeroUsage();
    let requests = 0;
    let retrying = false;
    try {
      return await this.runLimited(
        profile,
        async () => {
          const messages = profile.jsonMode === 'json_object' ? ensureJsonKeyword(req.messages) : req.messages;
          const call = (msgs: ChatMessage[]): Promise<CompletionResult> =>
            withRetry(
              async () => {
                requests++;
                try {
                  const r = await this.complete({ ...req, signal, messages: msgs, mode: profile.jsonMode });
                  addUsage(usage, r.usage);
                  return r;
                } catch (err) {
                  if (err instanceof LlmError) addUsage(usage, err.usage);
                  throw err;
                }
              },
              {
                delaysMs: this.delaysMs,
                sleep: this.sleep,
                signal,
                timeoutRetries: LLM_TIMEOUT_RETRIES,
                onRetry: (err, n, delay) => {
                  if (!retrying) {
                    retrying = true;
                    this.health.retrying(profile.id, 1);
                  }
                  this.log.warn(`模型「${profile.name}」请求失败，${(delay / 1000).toFixed(1)} s 后第 ${n} 次重试：${err.message}`);
                },
              },
            );

          const first = await call(messages);
          const check = checkOutput<T>(schema, first.content);
          if (check.ok) return { value: check.value, usage, requests, repaired: false };

          this.log.warn(`模型「${profile.name}」输出未通过校验，进行一次修复重试：${check.message}`);
          const second = await call([
            ...messages,
            { role: 'assistant', content: first.content.slice(0, REPAIR_ECHO_MAX) },
            { role: 'user', content: repairPrompt(check.message) },
          ]);
          const recheck = checkOutput<T>(schema, second.content);
          if (recheck.ok) return { value: recheck.value, usage, requests, repaired: true };
          throw new LlmError('invalid_output', `模型输出经修复重试后仍不符合要求：${recheck.message}`);
        },
        signal,
      );
    } catch (err) {
      if (err instanceof LlmError) err.usage = usage;
      throw err;
    } finally {
      if (retrying) this.health.retrying(profile.id, -1);
    }
  }

  /**
   * 单次 HTTP 请求（不重试、不占信号量）。供 chatJson 与能力探测使用。
   * 失败时抛 LlmError；错误信息中的 Key 会被脱敏（INV-17）。空 content 与截断时 error.usage 为本次用量。
   * track（默认 true）：把结果记入模型运行状态——成功为 ok，说明服务不可用的失败为 error（meansUnavailable）。
   */
  async complete(req: CompleteRequest): Promise<CompletionResult> {
    try {
      const r = await this.request(req);
      if (req.track !== false) this.health.success(req.profile.id, 'task', r.latencyMs);
      return r;
    } catch (err) {
      if (req.track !== false && err instanceof LlmError && meansUnavailable(err)) this.health.failure(req.profile.id, 'task', err.message, llmErrorHint(err));
      throw err;
    }
  }

  private async request(req: CompleteRequest): Promise<CompletionResult> {
    const { profile, signal } = req;
    if (profile.baseUrl === '' || profile.model.trim() === '') {
      throw new LlmError('config', '模型配置缺少服务地址或模型名');
    }
    if (!SCHEMA_NAME_RE.test(req.schemaName)) throw new LlmError('config', `schemaName 不合法：${req.schemaName}`);
    const scrub = (text: string): string => redact(text, [profile.apiKey]);
    const body = buildRequestBody(profile, req.messages, req.mode, req.schema, req.schemaName);
    const timeout = AbortSignal.timeout(profile.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const failure = (err: unknown): LlmError => {
      if (signal?.aborted === true) return abortError(signal);
      if (timeout.aborted) return new LlmError('timeout', `请求超时（${Math.round(profile.timeoutMs / 1000)} 秒）`);
      return new LlmError('network', scrub(`网络错误：${causeMessage(err)}`));
    };

    const started = performance.now();
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(chatCompletionsUrl(profile.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': this.userAgent,
          ...(profile.apiKey === '' ? {} : { Authorization: `Bearer ${profile.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'manual',
      });
      text = await res.text();
    } catch (err) {
      throw failure(err);
    }
    const latencyMs = Math.round(performance.now() - started);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      throw new LlmError('http', scrub(`服务地址发生了重定向（HTTP ${res.status}${location ? ` → ${location}` : ''}），请填写最终地址`), {
        status: res.status,
      });
    }
    if (!res.ok) {
      const hint = HTTP_HINTS[res.status] ?? (res.status >= 500 ? '服务端错误' : '');
      const detail = providerDetail(text);
      throw new LlmError('http', scrub(`HTTP ${res.status}${hint ? `（${hint}）` : ''}${detail ? `：${detail}` : ''}`), {
        status: res.status,
        retryAfterMs: res.status === 429 || res.status === 503 ? parseRetryAfter(res.headers.get('retry-after')) : null,
      });
    }

    let data: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: unknown; error?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new LlmError('bad_response', '响应不是 JSON，请确认服务地址是 OpenAI 兼容接口（通常以 /v1 结尾）');
    }
    if (!Array.isArray(data.choices)) {
      const detail = data.error === undefined ? '' : `：${providerDetail(JSON.stringify({ error: data.error }))}`;
      throw new LlmError('bad_response', scrub(`响应中没有 choices${detail}`));
    }
    const usage = readUsage(data.usage);
    const choice = data.choices[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (choice?.finish_reason === 'length') {
      throw new LlmError('length', '输出被截断（finish_reason=length），可在模型配置中调大「最大输出 token」', { usage });
    }
    if (content.trim() === '') throw new LlmError('empty', '模型返回了空内容', { usage });
    return { content, usage, latencyMs };
  }
}
