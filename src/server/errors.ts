/** 业务模块抛出的错误（不依赖 http 层）；http/server 统一映射为 §7.1 的错误响应。 */
export type DomainErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'REV_CONFLICT' | 'NAME_CONFLICT';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.extra = extra;
  }
}

export const invalid = (message: string): DomainError => new DomainError('VALIDATION', message);
export const missing = (message: string): DomainError => new DomainError('NOT_FOUND', message);
