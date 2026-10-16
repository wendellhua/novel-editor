import type { ErrorBody } from '../../shared/types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function parseErrorBody(data: unknown): ErrorBody['error'] | null {
  if (typeof data !== 'object' || data === null) return null;
  const err = (data as Partial<ErrorBody>).error;
  return typeof err?.code === 'string' && typeof err.message === 'string' ? err : null;
}

export async function apiRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return send<T>(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json', signal);
}

/** 发送原始请求体（如技能 zip）。 */
export function apiRequestRaw<T>(method: string, path: string, body: Blob, contentType: string): Promise<T> {
  return send<T>(method, path, body, contentType);
}

async function send<T>(method: string, path: string, body: BodyInit | undefined, contentType: string | undefined, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: contentType === undefined ? {} : { 'Content-Type': contentType },
      body,
      signal,
    });
  } catch {
    if (signal?.aborted === true) throw new ApiError(0, 'ABORTED', '已取消');
    throw new ApiError(0, 'NETWORK', '无法连接到本地服务');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text === '' ? undefined : JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = parseErrorBody(data);
    throw new ApiError(res.status, err?.code ?? 'INTERNAL', err?.message ?? `请求失败（HTTP ${res.status}）`, err ?? {});
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => apiRequest<T>('GET', path),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => apiRequest<T>('POST', path, body, signal),
  put: <T>(path: string, body?: unknown) => apiRequest<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>('PATCH', path, body),
  delete: <T>(path: string, body?: unknown) => apiRequest<T>('DELETE', path, body),
};
