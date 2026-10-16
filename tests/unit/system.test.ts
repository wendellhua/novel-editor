import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT } from '../../src/shared/constants';
import { parseArgs } from '../../src/server/system/args';
import { writeFileAtomic } from '../../src/server/system/atomic';
import { browserCommand } from '../../src/server/system/browser';
import {
  loadAppConfig,
  loadLlmConfig,
  sanitizeAppConfig,
  sanitizeLlmConfig,
} from '../../src/server/system/config';
import { readInstance, removeInstance, requestNonceFromInstance, writeInstance } from '../../src/server/system/instance';
import { createLogger, createSilentLogger, maskSecret, pruneLogs, redact } from '../../src/server/system/logger';
import { dataPaths, ensureDataDirs, resolveDataDir, type DataPaths } from '../../src/server/system/paths';
import { listenWithFallback } from '../../src/server/system/port';
import { makeTempDir } from '../helpers/tmp';

let tmp: { dir: string; cleanup: () => void };
let paths: DataPaths;

beforeEach(() => {
  tmp = makeTempDir();
  paths = dataPaths(tmp.dir);
  ensureDataDirs(paths);
});
afterEach(() => tmp.cleanup());

describe('resolveDataDir（§5.2）', () => {
  const base = { env: {}, homedir: '/home/u', cwd: '/repo', override: null };
  it('Windows 使用 %APPDATA%\\NovelEditor', () => {
    expect(resolveDataDir({ ...base, platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\NovelEditor',
    );
  });
  it('macOS 使用 ~/Library/Application Support/NovelEditor', () => {
    expect(resolveDataDir({ ...base, platform: 'darwin' })).toBe('/home/u/Library/Application Support/NovelEditor');
  });
  it('显式指定优先，并按 cwd 解析相对路径', () => {
    expect(resolveDataDir({ ...base, platform: 'darwin', override: '.devdata', cwd: tmp.dir })).toBe(join(tmp.dir, '.devdata'));
  });
  it('ensureDataDirs 创建全部子目录', () => {
    for (const d of [paths.works, paths.trash, paths.backups, paths.skills, paths.logs]) expect(existsSync(d)).toBe(true);
  });
});

describe('parseArgs', () => {
  it('支持 --data-dir 两种写法与 --no-browser', () => {
    expect(parseArgs(['exe', '--data-dir', 'x', '--no-browser'], {})).toEqual({ dataDir: 'x', noBrowser: true });
    expect(parseArgs(['exe', '--data-dir=y'], {})).toEqual({ dataDir: 'y', noBrowser: false });
  });
  it('环境变量作为默认值，命令行覆盖', () => {
    expect(parseArgs([], { NE_DATA_DIR: 'e', NE_NO_BROWSER: '1' })).toEqual({ dataDir: 'e', noBrowser: true });
    expect(parseArgs(['--data-dir', 'c'], { NE_DATA_DIR: 'e' }).dataDir).toBe('c');
  });
});

describe('writeFileAtomic（INV-16）', () => {
  it('覆盖已有文件且不残留临时文件', () => {
    const file = join(tmp.dir, 'a.json');
    writeFileSync(file, 'old');
    writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(readdirSync(tmp.dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('AppConfig 校验与修复（§6.5）', () => {
  it('首次启动生成默认配置并写盘', () => {
    const log = createSilentLogger();
    const cfg = loadAppConfig(paths, log);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.authSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.hubClientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toEqual(cfg);
  });

  it('再次加载得到相同配置（密钥稳定）', () => {
    const log = createSilentLogger();
    expect(loadAppConfig(paths, log)).toEqual(loadAppConfig(paths, log));
  });

  it('只重置不合法字段，保留其余字段，并备份原文件', () => {
    const log = createSilentLogger();
    const good = loadAppConfig(paths, log);
    writeFileSync(paths.config, JSON.stringify({ ...good, port: 80, ui: { fontSize: 99, theme: 'dark' } }));
    const fixed = loadAppConfig(paths, log);
    expect(fixed.port).toBe(DEFAULT_PORT);
    expect(fixed.ui).toEqual({ fontSize: 18, theme: 'dark' });
    expect(fixed.authSecret).toBe(good.authSecret);
    expect(readdirSync(tmp.dir).some((n) => n.startsWith('config.json.broken-'))).toBe(true);
    expect(log.lines.join('\n')).toContain('port, ui.fontSize');
  });

  it('非法 JSON：备份后重置为默认值', () => {
    writeFileSync(paths.config, '{not json');
    const cfg = loadAppConfig(paths, createSilentLogger());
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(readdirSync(tmp.dir).some((n) => n.startsWith('config.json.broken-'))).toBe(true);
  });

  it('默认值必须能通过自身校验（静态数据约束）', () => {
    const { value } = sanitizeAppConfig({});
    expect(sanitizeAppConfig(value).repaired).toEqual([]);
  });
});

describe('LlmConfig 校验与修复（§6.5）', () => {
  const profile = {
    id: 'p1',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-abcdefghijklmn',
    model: 'deepseek-chat',
    jsonMode: 'json_object',
    maxConcurrency: 3,
    timeoutMs: 180000,
    maxOutputTokens: 4096,
    contextTokens: 64000,
    temperature: 0.2,
    extraBody: {},
  };

  it('合法配置原样保留', () => {
    const raw = { version: 1, profiles: [profile], defaults: { typo: 'p1' } };
    const { value, repaired } = sanitizeLlmConfig(raw);
    expect(repaired).toEqual([]);
    expect(value.profiles).toEqual([profile]);
    expect(value.defaults.typo).toBe('p1');
    expect(value.defaults.summary).toBeNull();
  });

  it('越界字段重置为默认值，其余保留', () => {
    const { value, repaired } = sanitizeLlmConfig({
      version: 1,
      profiles: [{ ...profile, maxConcurrency: 99, temperature: -1 }],
      defaults: {},
    });
    expect(value.profiles[0]?.maxConcurrency).toBe(3);
    expect(value.profiles[0]?.temperature).toBe(0.2);
    expect(value.profiles[0]?.apiKey).toBe(profile.apiKey);
    expect(repaired).toEqual(['profiles[0].maxConcurrency', 'profiles[0].temperature']);
  });

  it('没有 id 或 id 重复的模型配置被丢弃', () => {
    const { value } = sanitizeLlmConfig({ version: 1, profiles: [{ name: 'x' }, profile, { ...profile }], defaults: {} });
    expect(value.profiles.map((p) => p.id)).toEqual(['p1']);
  });

  it('默认模型指向不存在的配置时改为 null', () => {
    const { value, repaired } = sanitizeLlmConfig({ version: 1, profiles: [], defaults: { typo: 'ghost' } });
    expect(value.defaults.typo).toBeNull();
    expect(repaired).toContain('defaults.typo');
  });

  it('输出上限挤占提示词预算时重置两项', () => {
    const { value } = sanitizeLlmConfig({ version: 1, profiles: [{ ...profile, contextTokens: 5000, maxOutputTokens: 4096 }], defaults: {} });
    expect(value.profiles[0]?.contextTokens).toBe(64000);
    expect(value.profiles[0]?.maxOutputTokens).toBe(4096);
  });

  it('首次加载生成空配置文件', () => {
    const cfg = loadLlmConfig(paths, createSilentLogger());
    expect(cfg.profiles).toEqual([]);
    expect(existsSync(paths.llm)).toBe(true);
  });
});

describe('日志脱敏（INV-17）与保留', () => {
  it('maskSecret', () => {
    expect(maskSecret('sk-1234567890abcd')).toBe('sk-****abcd');
    expect(maskSecret('short')).toBe('****');
  });

  it.each([
    ['Authorization: Bearer abcdefghijkl123', 'abcdefghijkl123'],
    ['{"apiKey":"zzzzzzzzzzzz9999"}', 'zzzzzzzzzzzz9999'],
    ['key=sk-THISISSECRETKEY', 'sk-THISISSECRETKEY'],
  ])('%s 中的密钥被遮盖', (text, secret) => {
    const out = redact(text, []);
    expect(out).not.toContain(secret);
    expect(out).toContain('****');
  });

  it('登记过的密钥在日志文件中被遮盖', () => {
    const log = createLogger({ dir: paths.logs, console: false });
    const secret = 'a'.repeat(30) + 'beef';
    log.registerSecret(secret);
    log.info(`secret is ${secret}`);
    const files = readdirSync(paths.logs);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^app-\d{8}\.log$/);
    const content = readFileSync(join(paths.logs, files[0]!), 'utf8');
    expect(content).not.toContain(secret);
    expect(content).toContain('****beef');
  });

  it('只保留最近 7 天的日志', () => {
    for (const day of ['20261001', '20261002', '20261003', '20261008', '20261009']) {
      writeFileSync(join(paths.logs, `app-${day}.log`), 'x');
    }
    writeFileSync(join(paths.logs, 'other.txt'), 'keep');
    const removed = pruneLogs(paths.logs, new Date(2026, 9, 9), 7);
    expect(removed.sort()).toEqual(['app-20261001.log', 'app-20261002.log']);
    expect(readdirSync(paths.logs).sort()).toEqual(['app-20261003.log', 'app-20261008.log', 'app-20261009.log', 'other.txt']);
  });
});

describe('单实例锁（INV-14）', () => {
  it('读写与只删除自己的锁', () => {
    writeInstance(paths.instance, { pid: 111, port: 17321, startedAt: 1 });
    expect(readInstance(paths.instance)).toEqual({ pid: 111, port: 17321, startedAt: 1 });
    expect(removeInstance(paths.instance, 222)).toBe(false);
    expect(existsSync(paths.instance)).toBe(true);
    expect(removeInstance(paths.instance, 111)).toBe(true);
    expect(existsSync(paths.instance)).toBe(false);
  });

  it('损坏的锁文件视为不存在', () => {
    writeFileSync(paths.instance, '{bad');
    expect(readInstance(paths.instance)).toBeNull();
  });

  it('端口上没有本应用时返回 null（不会误判为已有实例）', async () => {
    const other = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const port = (other.address() as AddressInfo).port;
    expect(await requestNonceFromInstance(port, 'x'.repeat(64), 1000)).toBeNull();
    other.close();
    expect(await requestNonceFromInstance(port, 'x'.repeat(64), 1000)).toBeNull();
  });
});

describe('端口回退（INV-15）', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('首选端口可用时使用首选端口', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const free = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const s = createServer();
    servers.push(s);
    expect(await listenWithFallback(s, free)).toEqual({ port: free, fellBack: false });
  });

  it('首选端口被占用时换随机端口', async () => {
    const holder = createServer();
    servers.push(holder);
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const busy = (holder.address() as AddressInfo).port;
    const s = createServer();
    servers.push(s);
    const result = await listenWithFallback(s, busy);
    expect(result.fellBack).toBe(true);
    expect(result.port).not.toBe(busy);
  });
});

describe('browserCommand', () => {
  it('各平台使用系统默认浏览器', () => {
    expect(browserCommand('http://127.0.0.1:1/', 'win32').command).toBe('rundll32.exe');
    expect(browserCommand('http://127.0.0.1:1/', 'darwin')).toEqual({ command: 'open', args: ['http://127.0.0.1:1/'] });
  });
});
