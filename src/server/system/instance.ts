import { rmSync } from 'node:fs';
import { readTextIfExists, writeJsonAtomic } from './atomic';

export interface InstanceInfo {
  pid: number;
  port: number;
  startedAt: number;
}

function isInstanceInfo(v: unknown): v is InstanceInfo {
  if (typeof v !== 'object' || v === null) return false;
  const { pid, port, startedAt } = v as Record<string, unknown>;
  return Number.isInteger(pid) && Number.isInteger(port) && Number.isInteger(startedAt);
}

export function readInstance(file: string): InstanceInfo | null {
  const text = readTextIfExists(file);
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return isInstanceInfo(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeInstance(file: string, info: InstanceInfo): void {
  writeJsonAtomic(file, info);
}

/** 只删除属于自己的锁文件，避免误删后启动实例写入的新文件。 */
export function removeInstance(file: string, pid: number): boolean {
  const current = readInstance(file);
  if (current !== null && current.pid !== pid) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * 向已运行的实例申请一次性 nonce（INV-14）。
 * 连不上、超时、或对方不是本应用（鉴权失败 / 返回格式不符）时返回 null，调用方视为残留锁文件。
 */
export async function requestNonceFromInstance(port: number, authSecret: string, timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/nonce`, {
      method: 'POST',
      headers: { 'X-Auth-Secret': authSecret },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const nonce = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).nonce : undefined;
    return typeof nonce === 'string' && /^[0-9a-f]{32}$/.test(nonce) ? nonce : null;
  } catch {
    return null;
  }
}
