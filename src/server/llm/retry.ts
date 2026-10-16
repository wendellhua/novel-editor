import { LLM_RETRY_AFTER_MAX_MS } from '../../shared/constants';
import { LlmError, abortError } from './errors';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** 可被取消的等待；取消时以 LlmError('aborted')（或中止时附带的 LlmError）拒绝。 */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * 解析 Retry-After（秒数或 HTTP 日期），结果限制在 [0, LLM_RETRY_AFTER_MAX_MS]。无法解析时返回 null。
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(Math.max(0, Math.round(ms)), LLM_RETRY_AFTER_MAX_MS);
}

export interface RetryOptions {
  /** 第 i 次重试前的等待时长；重试次数 = 数组长度。 */
  delaysMs: readonly number[];
  sleep: Sleep;
  signal?: AbortSignal;
  /** 超时最多重试几次（不超过 delaysMs 的长度）；省略时与其他可重试错误相同。 */
  timeoutRetries?: number;
  onRetry?: (err: LlmError, retryNo: number, delayMs: number) => void;
}

/** 只重试 retryable 的 LlmError；服务端给了 Retry-After 时优先遵守（§7.3）。 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const max = options.delaysMs.length;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const limit = err instanceof LlmError && err.kind === 'timeout' ? Math.min(max, options.timeoutRetries ?? max) : max;
      if (!(err instanceof LlmError) || !err.retryable || attempt >= limit) throw err;
      const delay = err.retryAfterMs ?? options.delaysMs[attempt] ?? 0;
      options.onRetry?.(err, attempt + 1, delay);
      await options.sleep(delay, options.signal);
    }
  }
}
