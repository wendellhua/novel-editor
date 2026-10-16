import { crc32, inflateRawSync } from 'node:zlib';
import { skillInvalid } from './errors';

export interface ZipLimits {
  maxZipBytes: number;
  maxUnpackedBytes: number;
  maxFiles: number;
}

export interface PackageFile {
  /** 相对路径，/ 分隔，已通过 normalizeEntryPath 校验。 */
  path: string;
  data: Buffer;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const UNIX_HOSTS = new Set([3, 19]); // Unix、OS X

/**
 * 校验并规范化包内路径（INV-13）：反斜杠视为分隔符；拒绝绝对路径、盘符、`..`、`.`、空段与 NUL。
 * 返回 / 分隔的相对路径；目录项（以 / 结尾）返回时去掉末尾的 /。
 */
export function normalizeEntryPath(raw: string): string {
  const p = raw.replace(/\\/g, '/');
  if (p.includes('\0')) throw skillInvalid(`文件路径含非法字符：${JSON.stringify(raw)}`);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw skillInvalid(`不允许绝对路径：${raw}`);
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const segments = trimmed.split('/');
  if (segments.some((s) => s === '..')) throw skillInvalid(`不允许包含 .. 的路径：${raw}`);
  if (trimmed === '' || segments.some((s) => s === '' || s === '.')) throw skillInvalid(`文件路径不合法：${raw}`);
  return trimmed;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gbk = new TextDecoder('gbk');

/** 未标记 UTF-8 的文件名：中文 Windows 自带压缩工具常用 GBK，先按 UTF-8 严格解码，失败再按 GBK。 */
function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString('utf8');
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return gbk.decode(bytes);
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

interface CentralEntry {
  path: string;
  isDir: boolean;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  localOffset: number;
}

/**
 * 解压技能包（INV-13）。自己解析中央目录以识别符号链接与加密项；解压时用 zlib 的 maxOutputLength 硬性限额，
 * 并核对实际大小与 CRC，声明大小造假（zip 炸弹）也无法突破 20 MB。只支持 stored / deflate，不支持 ZIP64、分卷与加密。
 */
export function readZip(buf: Buffer, limits: ZipLimits): PackageFile[] {
  if (buf.length > limits.maxZipBytes) throw skillInvalid(`压缩包超过 ${Math.round(limits.maxZipBytes / 1048576)} MB`);
  const eocd = buf.length >= 22 ? findEocd(buf) : -1;
  if (eocd < 0) throw skillInvalid('不是有效的 zip 文件');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw skillInvalid('不支持分卷压缩包');
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw skillInvalid('不支持 ZIP64 格式');
  if (cdOffset + cdSize > eocd) throw skillInvalid('zip 目录损坏');

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  let declaredTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) throw skillInvalid('zip 目录损坏');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) throw skillInvalid('zip 目录损坏');
    const rawName = decodeName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    p += 46 + nameLen + extraLen + commentLen;

    const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
    const path = normalizeEntryPath(rawName);
    if (UNIX_HOSTS.has(madeBy >>> 8) && ((extAttr >>> 16) & S_IFMT) === S_IFLNK) throw skillInvalid(`不允许包含符号链接：${path}`);
    if (isDir) continue;
    if ((flags & 0x1) !== 0) throw skillInvalid('不支持加密的压缩包');
    if (method !== 0 && method !== 8) throw skillInvalid(`不支持的压缩方式（${method}）：${path}`);
    if (size === 0xffffffff || compSize === 0xffffffff) throw skillInvalid('不支持 ZIP64 格式');
    if (seen.has(path)) throw skillInvalid(`压缩包中有重复的文件：${path}`);
    seen.add(path);
    fileCount++;
    if (fileCount > limits.maxFiles) throw skillInvalid(`文件数超过 ${limits.maxFiles} 个`);
    declaredTotal += size;
    if (declaredTotal > limits.maxUnpackedBytes) throw skillInvalid(`解压后超过 ${Math.round(limits.maxUnpackedBytes / 1048576)} MB`);
    entries.push({ path, isDir, method, crc, compSize, size, localOffset });
  }

  const out: PackageFile[] = [];
  let used = 0;
  for (const e of entries) {
    const lh = e.localOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== SIG_LOCAL) throw skillInvalid(`文件头损坏：${e.path}`);
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const end = start + e.compSize;
    if (end > buf.length) throw skillInvalid(`文件数据越界：${e.path}`);
    const raw = buf.subarray(start, end);
    const budget = limits.maxUnpackedBytes - used;
    let data: Buffer;
    if (e.method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
          throw skillInvalid(`解压后超过 ${Math.round(limits.maxUnpackedBytes / 1048576)} MB`);
        }
        throw skillInvalid(`解压失败：${e.path}`);
      }
    }
    if (data.length !== e.size) throw skillInvalid(`文件大小与目录记录不一致：${e.path}`);
    if (crc32(data) >>> 0 !== e.crc) throw skillInvalid(`文件校验失败（已损坏）：${e.path}`);
    used += data.length;
    if (used > limits.maxUnpackedBytes) throw skillInvalid(`解压后超过 ${Math.round(limits.maxUnpackedBytes / 1048576)} MB`);
    out.push({ path: e.path, data });
  }
  return out;
}
