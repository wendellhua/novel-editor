import { appendFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** 登记需要在日志中脱敏的密钥（API Key、authSecret 等，INV-17）。 */
  registerSecret(secret: string): void;
}

export interface LoggerOptions {
  dir: string | null;
  console: boolean;
  retainDays?: number;
  now?: () => Date;
}

const LOG_FILE_RE = /^app-(\d{8})\.log$/;

/** 掩码格式：`sk-****abcd`；长度 ≤ 8 的值整体替换为 `****`。 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '****';
  const prefix = secret.startsWith('sk-') ? 'sk-' : secret.slice(0, 2);
  return `${prefix}****${secret.slice(-4)}`;
}

const PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /(?<=\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?<=["']?(?:apiKey|api_key|authSecret|authorization|x-auth-secret)["']?\s*[:=]\s*["']?)[^"'\s,}]{4,}/gi,
];

export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(maskSecret(secret));
  }
  for (const re of PATTERNS) out = out.replace(re, (m) => (m.includes('****') ? m : maskSecret(m)));
  return out;
}

function formatData(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return ` ${data.stack ?? `${data.name}: ${data.message}`}`;
  if (typeof data === 'string') return ` ${data}`;
  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` ${String(data)}`;
  }
}

function localDateStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 删除超出保留天数的日志（文件名中的日期早于 today - (retainDays - 1)）。 */
export function pruneLogs(dir: string, today: Date, retainDays: number): string[] {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (retainDays - 1));
  const cutoffStamp = localDateStamp(cutoff);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const stamp = LOG_FILE_RE.exec(name)?.[1];
    if (stamp !== undefined && stamp < cutoffStamp) {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

export function createLogger({ dir, console: toConsole, retainDays = 7, now = () => new Date() }: LoggerOptions): Logger {
  const secrets = new Set<string>();
  if (dir !== null) {
    try {
      pruneLogs(dir, now(), retainDays);
    } catch {
      // 清理失败不影响启动
    }
  }

  const write = (level: LogLevel, message: string, data?: unknown): void => {
    const time = now();
    const line = redact(`${time.toISOString()} [${level}] ${message}${formatData(data)}`, secrets);
    if (toConsole) {
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
    }
    if (dir !== null) {
      try {
        appendFileSync(join(dir, `app-${localDateStamp(time)}.log`), `${line}\n`, 'utf8');
      } catch {
        // 磁盘满等情况下日志失败不能拖垮主流程
      }
    }
  };

  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    registerSecret: (secret) => {
      if (secret.length >= 8) secrets.add(secret);
    },
  };
}

/** 测试与工具用：不输出任何内容的 Logger。 */
export function createSilentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const secrets = new Set<string>();
  const write = (level: LogLevel, message: string, data?: unknown): void => {
    lines.push(redact(`[${level}] ${message}${formatData(data)}`, secrets));
  };
  return {
    lines,
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    registerSecret: (secret) => {
      if (secret.length >= 8) secrets.add(secret);
    },
  };
}
