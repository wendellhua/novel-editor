import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSmokeReport, runSmoke } from '../../scripts/lib/smoke-runner.ts';
import { TEST_BUILD_DIR } from '../global-setup';
import { makeTempDir } from '../helpers/tmp';

let tmp: ReturnType<typeof makeTempDir>;
beforeAll(() => {
  tmp = makeTempDir('ne-proc-');
});
afterAll(() => tmp.cleanup());

describe('真实进程（构建产物 server.cjs）', () => {
  it('启动、登录、安全校验、SSE、单实例、退出清理、残留锁恢复', async () => {
    const report = await runSmoke({
      target: {
        label: 'test-build/server.cjs',
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', join(TEST_BUILD_DIR, 'server.cjs')],
      },
      dataDir: tmp.dir,
    });
    expect(report.ok, formatSmokeReport(report)).toBe(true);
  }, 120_000);

  it('静态数据被改坏时启动失败：退出码 1，stderr 与日志文件都列出问题，不留锁文件（§6.5）', async () => {
    const app = join(tmp.dir, 'broken-app');
    const data = join(tmp.dir, 'broken-data');
    mkdirSync(app, { recursive: true });
    copyFileSync(join(TEST_BUILD_DIR, 'server.cjs'), join(app, 'server.cjs'));
    cpSync(join(TEST_BUILD_DIR, 'web'), join(app, 'web'), { recursive: true });
    cpSync(join(TEST_BUILD_DIR, 'builtin-skills'), join(app, 'builtin-skills'), { recursive: true });
    writeFileSync(join(app, 'builtin-skills', 'chapter-summary', 'SKILL.md'), '# 没有 frontmatter\n');

    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(app, 'server.cjs'), '--data-dir', data, '--no-browser'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code).toBe(1);
    expect(stderr).toContain('静态数据不合法（共 1 项），程序无法启动');
    expect(stderr).toContain('[builtin-skills] manifest[9] SKILL.md 不合法');
    expect(stderr, '静态数据问题不附堆栈').not.toMatch(/\n\s+at /);
    const logs = readdirSync(join(data, 'logs')).filter((n) => n.endsWith('.log'));
    expect(logs.map((n) => readFileSync(join(data, 'logs', n), 'utf8')).join('')).toContain('静态数据不合法');
    expect(existsSync(join(data, 'instance.json'))).toBe(false);
    expect(existsSync(join(data, 'llm.json')), '校验失败前不写入 llm.json').toBe(false);
  }, 30_000);
});
