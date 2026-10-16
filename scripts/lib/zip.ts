import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  /** 0 = stored，8 = deflate（默认），其他值用于构造不支持的压缩方式。 */
  method?: number;
  /** 原始文件名字节（不设 UTF-8 标志），用于构造 GBK 文件名。 */
  nameBytes?: Buffer;
  /** Unix 文件模式（写入 external attributes 高 16 位），如 0o120777 表示符号链接。 */
  unixMode?: number;
  /** 中央目录中声明的解压后大小（默认为真实大小），用于构造声明造假的 zip 炸弹。 */
  declaredSize?: number;
  crc?: number;
  flags?: number;
}

/** 测试用 zip 构造器：可以精确控制每一项的路径、属性、声明大小与 CRC，用来制造恶意样本（INV-13）。 */
export function makeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : (e.data ?? Buffer.alloc(0));
    const method = e.method ?? (e.name.endsWith('/') ? 0 : 8);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const name = e.nameBytes ?? Buffer.from(e.name, 'utf8');
    const flags = e.flags ?? (e.nameBytes === undefined ? 0x800 : 0);
    const crc = e.crc ?? crc32(data) >>> 0;
    const size = e.declaredSize ?? data.length;
    const mode = e.unixMode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const skillMd = (name: string, description = '测试技能', body = '# 规则\n\n- 第一条'): string =>
  `---\nname: ${name}\ndescription: ${description}\nversion: 1.2.0\n---\n\n${body}\n`;
