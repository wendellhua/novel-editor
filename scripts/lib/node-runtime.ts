import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { unzipSync } from 'fflate';
import { CACHE } from './project.ts';
import { readTarGz } from './tar.ts';

/** 安装包内置的 Node 运行时版本（ADR-002）。升级时只改这一处，并重新跑打包冒烟。 */
export const NODE_RUNTIME_VERSION = 'v26.11.1';

export type NodeTarget = 'win-x64' | 'darwin-arm64';

const DEFAULT_MIRRORS = ['https://nodejs.org/dist', 'https://npmmirror.com/mirrors/node'];

function mirrors(): string[] {
  const custom = process.env.NE_NODE_MIRROR?.trim();
  return custom ? [custom.replace(/\/+$/, ''), ...DEFAULT_MIRRORS] : DEFAULT_MIRRORS;
}

function archiveName(target: NodeTarget): string {
  return target === 'win-x64' ? `node-${NODE_RUNTIME_VERSION}-win-x64.zip` : `node-${NODE_RUNTIME_VERSION}-darwin-arm64.tar.gz`;
}

function binaryInArchive(target: NodeTarget): string {
  return target === 'win-x64'
    ? `node-${NODE_RUNTIME_VERSION}-win-x64/node.exe`
    : `node-${NODE_RUNTIME_VERSION}-darwin-arm64/bin/node`;
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 从 SHASUMS256.txt 中取出指定文件的哈希。 */
export function expectedHash(shasums: string, file: string): string {
  for (const line of shasums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === file && hash !== undefined && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  throw new Error(`SHASUMS256.txt 中没有 ${file}`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || res.body === null) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;
  let lastPct = -10;
  const source = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
    if (pct >= lastPct + 10) {
      lastPct = pct;
      process.stdout.write(`  下载 ${pct}%（${(received / 1048576).toFixed(1)} MB）\n`);
    }
  });
  await pipeline(source, createWriteStream(dest));
}

function extractBinary(target: NodeTarget, archive: Buffer): Buffer {
  const inner = binaryInArchive(target);
  if (target === 'win-x64') {
    const files = unzipSync(archive, { filter: (f) => f.name === inner });
    const data = files[inner];
    if (data === undefined) throw new Error(`压缩包中没有 ${inner}`);
    return Buffer.from(data);
  }
  const entry = readTarGz(archive).find((e) => e.name === inner && e.type === 'file');
  if (entry === undefined) throw new Error(`压缩包中没有 ${inner}`);
  return entry.data;
}

/**
 * 下载并缓存指定平台的 Node 官方二进制：按 SHASUMS256.txt 校验 SHA-256，主站失败时切换镜像。
 * 缓存位置：.cache/node/{version}/{target}/。
 */
export async function ensureNodeBinary(target: NodeTarget): Promise<string> {
  const dir = join(CACHE, 'node', NODE_RUNTIME_VERSION, target);
  const bin = join(dir, target === 'win-x64' ? 'node.exe' : 'node');
  const marker = `${bin}.verified`;
  if (existsSync(bin) && existsSync(marker)) return bin;
  mkdirSync(dir, { recursive: true });

  const file = archiveName(target);
  const errors: string[] = [];
  for (const base of mirrors()) {
    try {
      console.log(`获取 Node ${NODE_RUNTIME_VERSION}（${target}）：${base}`);
      const sumsRes = await fetch(`${base}/${NODE_RUNTIME_VERSION}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
      if (!sumsRes.ok) throw new Error(`SHASUMS256.txt HTTP ${sumsRes.status}`);
      const expected = expectedHash(await sumsRes.text(), file);
      const archivePath = join(dir, file);
      await download(`${base}/${NODE_RUNTIME_VERSION}/${file}`, archivePath);
      const archive = readFileSync(archivePath);
      const actual = sha256(archive);
      if (actual !== expected) throw new Error(`SHA-256 不匹配：期望 ${expected}，实际 ${actual}`);
      writeFileSync(bin, extractBinary(target, archive));
      writeFileSync(marker, `${file} ${expected}\n`);
      rmSync(archivePath, { force: true });
      console.log(`  已校验并缓存：${bin}`);
      return bin;
    } catch (err) {
      errors.push(`${base}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`无法获取 Node 运行时：\n${errors.join('\n')}`);
}
