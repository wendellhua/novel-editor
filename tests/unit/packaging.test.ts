import { describe, expect, it } from 'vitest';
import { LAUNCHER_SCRIPT, MAC_MIN_SYSTEM, infoPlist } from '../../scripts/lib/mac-bundle.ts';
import { NODE_RUNTIME_VERSION, expectedHash, sha256 } from '../../scripts/lib/node-runtime.ts';
import { readTar, readTarGz, writeTar, writeTarGz } from '../../scripts/lib/tar.ts';

describe('tar 读写（Mac 包权限位）', () => {
  it('写入后能读回，权限位、类型、内容一致', () => {
    const entries = readTarGz(
      writeTarGz([
        { name: 'App.app', type: 'dir', mode: 0o755 },
        { name: 'App.app/run', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\n') },
        { name: 'App.app/readme.txt', type: 'file', mode: 0o644, data: Buffer.from('你好') },
      ]),
    );
    expect(entries.map((e) => [e.name, e.type, e.mode.toString(8)])).toEqual([
      ['App.app/', 'dir', '755'],
      ['App.app/run', 'file', '755'],
      ['App.app/readme.txt', 'file', '644'],
    ]);
    expect(entries[2]?.data.toString('utf8')).toBe('你好');
  });

  it('超过 100 字节的路径用 ustar prefix 存放', () => {
    const long = `${'a'.repeat(60)}/${'b'.repeat(60)}/file.js`;
    const [entry] = readTar(writeTar([{ name: long, type: 'file', mode: 0o644, data: Buffer.from('x') }]));
    expect(entry?.name).toBe(long);
  });

  it('数据按 512 字节对齐，跨块内容完整', () => {
    const data = Buffer.alloc(1300, 7);
    const [a, b] = readTar(
      writeTar([
        { name: 'a.bin', type: 'file', mode: 0o644, data },
        { name: 'b.txt', type: 'file', mode: 0o644, data: Buffer.from('end') },
      ]),
    );
    expect(a?.data.equals(data)).toBe(true);
    expect(b?.data.toString()).toBe('end');
  });

  it('校验和错误时报错', () => {
    const buf = writeTar([{ name: 'x', type: 'file', mode: 0o644, data: Buffer.from('1') }]);
    buf[0] = 'y'.charCodeAt(0);
    expect(() => readTar(buf)).toThrow('校验和');
  });

  it('读取 pax 扩展头中的长路径', () => {
    const path = `pkg/${'d'.repeat(120)}/node`;
    const record = ` path=${path}\n`;
    let len = record.length + 1;
    while (String(len).length + record.length !== len) len = String(len).length + record.length;
    const pax = Buffer.from(`${len}${record}`);
    const header = writeTar([{ name: 'PaxHeader', type: 'file', mode: 0o644, data: pax }]).subarray(0, 512);
    header[156] = 'x'.charCodeAt(0);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    const paxBlock = Buffer.concat([header, pax, Buffer.alloc(512 - pax.length)]);
    const body = writeTar([{ name: 'short', type: 'file', mode: 0o755, data: Buffer.from('bin') }]);
    const [entry] = readTar(Buffer.concat([paxBlock, body]));
    expect(entry?.name).toBe(path);
    expect(entry?.mode).toBe(0o755);
  });
});

describe('Node 运行时下载校验', () => {
  it('版本号格式固定为 v26.x.y', () => {
    expect(NODE_RUNTIME_VERSION).toMatch(/^v26\.\d+\.\d+$/);
  });

  it('从 SHASUMS256.txt 取出对应文件的哈希', () => {
    const sums = `${'a'.repeat(64)}  node-v26.11.1-win-x64.zip\n${'b'.repeat(64)}  node-v26.11.1-darwin-arm64.tar.gz\n`;
    expect(expectedHash(sums, 'node-v26.11.1-darwin-arm64.tar.gz')).toBe('b'.repeat(64));
    expect(() => expectedHash(sums, 'node-v26.11.1-linux-x64.tar.xz')).toThrow();
  });

  it('sha256', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Mac .app 外壳（§5.3 静态数据约束）', () => {
  it('启动脚本使用 LF、带 shebang、后台启动内置 node 后退出', () => {
    expect(LAUNCHER_SCRIPT.includes('\r')).toBe(false);
    expect(LAUNCHER_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true);
    expect(LAUNCHER_SCRIPT).toContain('nohup "$RES/node"');
    expect(LAUNCHER_SCRIPT).toContain('"$RES/app/server.cjs"');
    expect(LAUNCHER_SCRIPT.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('Info.plist 关键字段', () => {
    const plist = infoPlist('1.2.3');
    expect(plist).toContain('<key>CFBundleExecutable</key><string>NovelEditor</string>');
    expect(plist).toContain('<key>LSUIElement</key><true/>');
    expect(plist).toContain(`<key>LSMinimumSystemVersion</key><string>${MAC_MIN_SYSTEM}</string>`);
    expect(plist).toContain('<string>1.2.3</string>');
  });
});
