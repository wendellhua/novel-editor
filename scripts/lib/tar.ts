import { gunzipSync, gzipSync } from 'node:zlib';

export type TarEntryType = 'file' | 'dir' | 'symlink' | 'other';

export interface TarEntry {
  name: string;
  type: TarEntryType;
  mode: number;
  data: Buffer;
  linkname: string;
}

export interface TarInput {
  name: string;
  type: 'file' | 'dir';
  mode: number;
  data?: Uint8Array;
  mtime?: number;
}

const BLOCK = 512;

function cstring(buf: Uint8Array, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return Buffer.from(nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function parseOctal(buf: Uint8Array, start: number, length: number): number {
  const text = cstring(buf, start, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function parseSize(buf: Uint8Array, start: number, length: number): number {
  const first = buf[start] ?? 0;
  if ((first & 0x80) === 0) return parseOctal(buf, start, length);
  let value = first & 0x7f;
  for (let i = 1; i < length; i++) value = value * 256 + (buf[start + i] ?? 0);
  return value;
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum;
}

function parsePax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const text = Buffer.from(data).toString('utf8');
  let pos = 0;
  while (pos < text.length) {
    const space = text.indexOf(' ', pos);
    if (space === -1) break;
    const len = Number.parseInt(text.slice(pos, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, pos + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    pos += len;
  }
  return out;
}

function typeOf(flag: string): TarEntryType {
  if (flag === '0' || flag === '\0' || flag === '' || flag === '7') return 'file';
  if (flag === '5') return 'dir';
  if (flag === '2') return 'symlink';
  return 'other';
}

/** 解析 ustar / pax / GNU longname 格式的 tar（足以读取 Node 官方发行包）。 */
export function readTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let paxPath: string | null = null;
  let longName: string | null = null;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    if (parseOctal(header, 148, 8) !== checksum(header)) throw new Error(`tar 头校验和错误（偏移 ${offset}）`);
    const flag = String.fromCharCode(header[156] ?? 0);
    const size = parseSize(header, 124, 12);
    const dataStart = offset + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === 'x') {
      paxPath = parsePax(data).get('path') ?? null;
      continue;
    }
    if (flag === 'g') continue;
    if (flag === 'L') {
      longName = cstring(data, 0, data.length);
      continue;
    }
    const prefix = cstring(header, 257, 6).startsWith('ustar') ? cstring(header, 345, 155) : '';
    const shortName = cstring(header, 0, 100);
    const name = paxPath ?? longName ?? (prefix !== '' ? `${prefix}/${shortName}` : shortName);
    paxPath = null;
    longName = null;
    entries.push({ name, type: typeOf(flag), mode: parseOctal(header, 100, 8), data: Buffer.from(data), linkname: cstring(header, 157, 100) });
  }
  return entries;
}

export function readTarGz(buf: Uint8Array): TarEntry[] {
  return readTar(gunzipSync(buf));
}

function writeString(header: Buffer, value: string, start: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`tar 字段过长：${value}`);
  bytes.copy(header, start);
}

function writeOctal(header: Buffer, value: number, start: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new Error(`tar 数值超出字段长度：${value}`);
  writeString(header, text, start, length);
}

function splitName(name: string): { prefix: string; base: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', base: name };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100 && base !== '') return { prefix, base };
  }
  throw new Error(`路径过长，无法写入 ustar：${name}`);
}

/** 写 ustar：权限位直接写入头部（不依赖文件系统），保证在 Windows 上也能产出 0755 的可执行文件。 */
export function writeTar(inputs: readonly TarInput[]): Buffer {
  const blocks: Buffer[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const input of inputs) {
    const isDir = input.type === 'dir';
    const data = isDir ? Buffer.alloc(0) : Buffer.from(input.data ?? new Uint8Array());
    const name = isDir && !input.name.endsWith('/') ? `${input.name}/` : input.name;
    const { prefix, base } = splitName(name);
    const header = Buffer.alloc(BLOCK);
    writeString(header, base, 0, 100);
    writeOctal(header, input.mode & 0o7777, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, data.length, 124, 12);
    writeOctal(header, input.mtime ?? now, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (isDir ? '5' : '0').charCodeAt(0);
    writeString(header, 'ustar\u0000', 257, 6);
    writeString(header, '00', 263, 2);
    writeString(header, 'root', 265, 32);
    writeString(header, 'wheel', 297, 32);
    writeString(header, prefix, 345, 155);
    writeString(header, `${checksum(header).toString(8).padStart(6, '0')}\u0000 `, 148, 8);
    blocks.push(header, data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

export function writeTarGz(inputs: readonly TarInput[]): Buffer {
  return gzipSync(writeTar(inputs), { level: 9 });
}
