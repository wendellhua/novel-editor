import { JSON_MODES, LLM_PROBE_DEADLINE_MS, LLM_PROBE_REQUEST_TIMEOUT_MS } from '../../shared/constants';
import type { JsonMode, LlmProfileRecord, ProbeResult } from '../../shared/types';
import { checkOutput, type ChatMessage, type LlmClient } from './client';
import { LlmError } from './errors';
import { ALL_MODES_FAILED_HINT, llmErrorHint } from './health';

export const PROBE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, reply: { type: 'string' } },
  required: ['ok', 'reply'],
  additionalProperties: false,
} as const;

const PROBE_MESSAGES: ChatMessage[] = [
  {
    role: 'system',
    content: '你是接口连通性测试助手。只输出一个 JSON 对象，格式为 {"ok": true, "reply": "pong"}，不要输出任何其他内容。',
  },
  { role: 'user', content: '请按要求输出 JSON。' },
];

export interface ProbeOptions {
  /** 单次请求的超时上限（实际取它与配置的 timeoutMs 中较小的）。 */
  requestTimeoutMs?: number;
  /** 整个探测的时限。 */
  deadlineMs?: number;
}

/**
 * 这些错误说明「这一档不被支持」，换下一档继续探测；其余错误（Key 无效、地址错误、限流、超时、网络）
 * 与档位无关，立即结束并报告，避免把连通性问题误判成能力不足。
 */
function meansUnsupported(err: LlmError): boolean {
  if (err.kind === 'http') return err.status === 400 || err.status === 422;
  return err.kind === 'bad_response' || err.kind === 'empty' || err.kind === 'length';
}

/**
 * 能力探测（§7.3）：依次尝试 json_schema → json_object → prompt，取第一个「HTTP 200 且输出通过校验」的档位。
 * 空内容或截断时同一档再试一次（DeepSeek 偶发空 content，ADR-007）。latencyMs 为成功那次请求的耗时。
 *
 * 测试连接是作者主动发起的诊断：**不占任务的并发名额**（否则会排在卡住的任务后面一直等），单次请求的超时不超过
 * requestTimeoutMs，整个探测不超过 deadlineMs。调用方取消（界面上「取消」、关闭页面）或配置被修改时抛出
 * LlmError('aborted')，不返回结果。
 */
export async function probeProfile(client: LlmClient, profile: LlmProfileRecord, signal?: AbortSignal, options: ProbeOptions = {}): Promise<ProbeResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const fail = (error: string, hint: string): ProbeResult => ({ ok: false, latencyMs: elapsed(), jsonMode: profile.jsonMode, error, hint });
  const deadlineMs = options.deadlineMs ?? LLM_PROBE_DEADLINE_MS;
  const deadline = AbortSignal.timeout(deadlineMs);
  const scoped = client.scoped(profile.id, signal);
  const combined = AbortSignal.any([scoped, deadline]);
  const target: LlmProfileRecord = { ...profile, timeoutMs: Math.min(profile.timeoutMs, options.requestTimeoutMs ?? LLM_PROBE_REQUEST_TIMEOUT_MS) };

  const reasons: string[] = [];
  for (const mode of JSON_MODES) {
    const outcome = await tryMode(client, target, mode, combined);
    if (outcome.ok) return { ok: true, latencyMs: outcome.latencyMs, jsonMode: mode, error: null, hint: null };
    if (outcome.error?.kind === 'aborted') {
      if (scoped.aborted) throw outcome.error;
      return fail(`测试超时：${Math.round(deadlineMs / 1000)} 秒内没有完成`, llmErrorHint({ kind: 'timeout', status: null }));
    }
    if (outcome.fatal) return fail(outcome.reason, outcome.error === null ? ALL_MODES_FAILED_HINT : llmErrorHint(outcome.error));
    reasons.push(`${mode}：${outcome.reason}`);
  }
  return fail(`三种结构化输出方式都未通过（${reasons.join('；')}）`, ALL_MODES_FAILED_HINT);
}

type ModeOutcome = { ok: true; latencyMs: number } | { ok: false; fatal: boolean; reason: string; error: LlmError | null };

async function tryMode(client: LlmClient, profile: LlmProfileRecord, mode: JsonMode, signal: AbortSignal): Promise<ModeOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await client.complete({ profile, messages: PROBE_MESSAGES, schema: PROBE_SCHEMA, schemaName: 'probe', signal, mode, track: false });
      const check = checkOutput(PROBE_SCHEMA, r.content);
      return check.ok ? { ok: true, latencyMs: r.latencyMs } : { ok: false, fatal: false, reason: `输出${check.message}`, error: null };
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      const retrySameMode = attempt === 0 && (err.kind === 'empty' || err.kind === 'length');
      if (retrySameMode) continue;
      return { ok: false, fatal: !meansUnsupported(err), reason: err.message, error: err };
    }
  }
  return { ok: false, fatal: false, reason: '连续两次返回空内容', error: null };
}
