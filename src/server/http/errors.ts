import type { ErrorBody, ErrorCode } from '../../shared/types';
import { DomainError } from '../errors';
import { LlmError } from '../llm/errors';
import { HubError, SkillInvalidError } from '../skills/errors';
import { WorkDbError } from '../storage/work-db';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toBody(): ErrorBody {
    return { error: { ...this.extra, code: this.code, message: this.message } };
  }
}

export const badRequest = (message: string, extra?: Record<string, unknown>): HttpError =>
  new HttpError(400, 'VALIDATION', message, extra);
export const unauthorized = (message = '会话已失效，请从 NovelEditor 程序重新打开'): HttpError =>
  new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message: string): HttpError => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = '资源不存在'): HttpError => new HttpError(404, 'NOT_FOUND', message);
export const payloadTooLarge = (limit: number): HttpError =>
  new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过上限（${limit} 字节）`);

/** 把业务层错误映射为 HTTP 错误（§7.1）；无法识别的返回 null，由调用方按 500 处理。 */
export function toHttpError(err: unknown): HttpError | null {
  if (err instanceof HttpError) return err;
  if (err instanceof DomainError) {
    if (err.code === 'VALIDATION') return new HttpError(400, 'VALIDATION', err.message, err.extra);
    if (err.code === 'NOT_FOUND') return new HttpError(404, 'NOT_FOUND', err.message, err.extra);
    if (err.code === 'NAME_CONFLICT') return new HttpError(409, 'NAME_CONFLICT', err.message, err.extra);
    return new HttpError(409, 'REV_CONFLICT', err.message, err.extra);
  }
  if (err instanceof LlmError) return new HttpError(502, 'LLM_ERROR', err.message);
  if (err instanceof SkillInvalidError) return new HttpError(422, 'SKILL_INVALID', err.message);
  if (err instanceof HubError) return new HttpError(502, 'HUB_ERROR', err.message);
  if (err instanceof WorkDbError) {
    if (err.code === 'NOT_FOUND') return new HttpError(404, 'NOT_FOUND', '作品不存在');
    if (err.code === 'EXISTS') return new HttpError(400, 'VALIDATION', err.message);
    return new HttpError(500, 'INTERNAL', `作品文件无法使用：${err.message}`);
  }
  return null;
}
