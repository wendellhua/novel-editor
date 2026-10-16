/**
 * 大模型调用错误（§7.3）。kind 决定是否重试：
 * - 可重试：429 / 5xx、超时、网络错误、空 content、finish_reason=length
 * - 不可重试：配置缺失、其他 HTTP 状态、响应不是 chat/completions 格式、两次输出都未通过校验、已取消
 */
export type LlmErrorKind =
  | 'config'
  | 'http'
  | 'timeout'
  | 'network'
  | 'empty'
  | 'length'
  | 'bad_response'
  | 'invalid_output'
  | 'aborted';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export const zeroUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0 });

export function addUsage(into: Usage, more: Usage | null | undefined): void {
  if (more === null || more === undefined) return;
  into.promptTokens += more.promptTokens;
  into.completionTokens += more.completionTokens;
}

/** 取消原因：中止时附带了 LlmError（如「模型配置已修改」）就用它，否则是普通的取消。 */
export function abortError(signal: AbortSignal | undefined): LlmError {
  const reason: unknown = signal?.reason;
  return reason instanceof LlmError ? reason : new LlmError('aborted', '已取消');
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** 已消耗的 token（失败也要计入任务用量）；chatJson 抛出前会替换为整次调用的累计值。 */
  usage: Usage | null;

  constructor(
    kind: LlmErrorKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number | null; usage?: Usage | null } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = extra.status ?? null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.usage = extra.usage ?? null;
  }

  get retryable(): boolean {
    switch (this.kind) {
      case 'timeout':
      case 'network':
      case 'empty':
      case 'length':
        return true;
      case 'http':
        return this.status === 429 || (this.status !== null && this.status >= 500);
      default:
        return false;
    }
  }
}
