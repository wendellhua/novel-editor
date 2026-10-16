import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

/**
 * 原子写（INV-16）：写临时文件 → fsync → rename 覆盖。
 * Windows 上目标文件可能被杀毒软件短暂占用，rename 遇到 EPERM/EACCES/EBUSY 时重试。
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= 9) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(25);
    }
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readTextIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}
