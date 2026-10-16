import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser, launchBrowser, type Browser } from './lib/cdp.ts';
import { PageDriver } from './lib/page-driver.ts';
import { CACHE, DIST, RELEASE } from './lib/project.ts';
import { checksScenario } from './lib/scenarios/checks.ts';
import { editorScenario } from './lib/scenarios/editor.ts';
import { issuesScenario } from './lib/scenarios/issues.ts';
import { reviewScenario } from './lib/scenarios/review.ts';
import { bibleScenario } from './lib/scenarios/bible.ts';
import { creativeScenario } from './lib/scenarios/creative.ts';
import { fixScenario } from './lib/scenarios/fix.ts';
import { m3Scenario } from './lib/scenarios/m3.ts';
import { outlineScenario, type ScenarioContext } from './lib/scenarios/outline.ts';
import { settingsScenario } from './lib/scenarios/settings.ts';
import { exitScenario, shellScenario } from './lib/scenarios/shell.ts';
import { skillsScenario } from './lib/scenarios/skills.ts';

/**
 * 浏览器级冒烟（编码铁律 5）：用本机 Chrome/Edge 走真实用户路径，收集控制台错误、警告与 CSP 拦截。
 * 用法：node scripts/browser-smoke.ts [--win]
 */
const useWin = process.argv.includes('--win');
const command = useWin ? join(RELEASE, 'NovelEditor.exe') : process.execPath;
const baseArgs = useWin ? [] : ['--disable-warning=ExperimentalWarning', join(DIST, 'server.cjs')];
const browserPath = findBrowser();
if (!existsSync(useWin ? command : join(DIST, 'server.cjs'))) throw new Error('找不到构建产物，请先构建');
if (browserPath === null) throw new Error('找不到 Chrome / Edge，可用 NE_BROWSER 指定浏览器路径');

const outDir = join(CACHE, 'browser-smoke');
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'ne-bsmoke-'));
const profileDir = mkdtempSync(join(tmpdir(), 'ne-bprofile-'));
const problems: string[] = [];
const results: string[] = [];
const notes: string[] = [];
/** 服务被强杀期间浏览器必然出现的网络错误，属于预期，不计入问题。 */
let expectNetworkErrors = false;
const allowedNetworkLogs = new Set<RegExp>();

class ServerProcess {
  child: ChildProcess | null = null;
  output = '';
  exited: Promise<number | null> = Promise.resolve(null);

  async start(): Promise<string> {
    this.output = '';
    const child = spawn(command, [...baseArgs, '--data-dir', dataDir, '--no-browser'], { windowsHide: true });
    this.child = child;
    child.stdout?.on('data', (b: Buffer) => (this.output += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (this.output += b.toString('utf8')));
    this.exited = new Promise((r) => child.on('exit', r));
    for (let i = 0; i < 200; i++) {
      const url = /请在浏览器中打开：(\S+)/.exec(this.output)?.[1];
      if (url !== undefined) return url;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`服务未能启动：\n${this.output}`);
  }

  async kill(): Promise<void> {
    if (this.child === null || this.child.exitCode !== null) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }
}

const server = new ServerProcess();
let browser: Browser | null = null;
let failed = false;
const started = Date.now();
try {
  const url = await server.start();
  results.push('✔ 服务启动并给出登录地址');

  browser = await launchBrowser(browserPath, profileDir);
  const { page } = browser;
  page.on('Runtime.consoleAPICalled', (p) => {
    const type = String(p.type);
    if (type === 'error' || type === 'warning' || type === 'assert') {
      const args = (p.args as { value?: unknown; description?: string }[]).map((a) => String(a.value ?? a.description ?? ''));
      problems.push(`console.${type}: ${args.join(' ')}`);
    }
  });
  page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${JSON.stringify(p.exceptionDetails)}`));
  page.on('Log.entryAdded', (p) => {
    const entry = p.entry as { level: string; source: string; text: string; url?: string };
    if (entry.level !== 'error' && entry.level !== 'warning') return;
    if (entry.source === 'network' && (expectNetworkErrors || [...allowedNetworkLogs].some((re) => re.test(entry.text)))) return;
    problems.push(`log.${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
  });
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');

  const d = new PageDriver(page);
  const ctx: ScenarioContext = {
    d,
    origin: new URL(url).origin,
    ok(cond, message) {
      if (!cond) throw new Error(message);
      results.push(`✔ ${message}`);
    },
    note(message) {
      notes.push(message);
    },
    async shot(name) {
      writeFileSync(join(outDir, `${name}.png`), await d.screenshot());
    },
    async killServer() {
      expectNetworkErrors = true;
      await server.kill();
    },
    async startServer() {
      await server.start();
      await new Promise((r) => setTimeout(r, 300));
      expectNetworkErrors = false;
    },
    allowNetworkLog(pattern) {
      allowedNetworkLogs.add(pattern);
      return () => allowedNetworkLogs.delete(pattern);
    },
  };

  await d.navigate(url);
  await shellScenario(ctx, dataDir);
  await outlineScenario(ctx);
  await editorScenario(ctx);
  await settingsScenario(ctx);
  await skillsScenario(ctx);
  await checksScenario(ctx);
  await issuesScenario(ctx);
  await reviewScenario(ctx);
  await bibleScenario(ctx);
  await m3Scenario(ctx);
  await fixScenario(ctx);
  await creativeScenario(ctx);
  await exitScenario(ctx);

  const code = await Promise.race([server.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000))]);
  ctx.ok(code === 0, '服务进程退出码 0');
  ctx.ok(!existsSync(join(dataDir, 'instance.json')), '退出后锁文件已删除');
  ctx.ok(problems.length === 0, '浏览器控制台无错误、无警告、无 CSP 拦截（强杀服务期间的网络错误除外）');
} catch (err) {
  failed = true;
  results.push(`✘ ${err instanceof Error ? err.message : String(err)}`);
  if (browser !== null) writeFileSync(join(outDir, 'failure.png'), await new PageDriver(browser.page).screenshot().catch(() => Buffer.alloc(0)));
} finally {
  await browser?.close();
  await server.kill();
  for (const dir of [dataDir, profileDir]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      console.warn(`临时目录未能删除（浏览器可能仍占用文件）：${dir}`);
    }
  }
}

console.log(results.join('\n'));
if (notes.length > 0) console.log(`\n度量：\n${notes.map((n) => `  ${n}`).join('\n')}`);
if (problems.length > 0) console.log(`\n浏览器问题：\n${problems.join('\n')}`);
if (failed) {
  writeFileSync(join(outDir, 'server.log'), server.output);
  console.log(`\n服务端输出（最后 40 行，完整日志见 ${join(outDir, 'server.log')}）：\n${server.output.split('\n').slice(-40).join('\n')}`);
}
console.log(`\n截图：${outDir}（用时 ${((Date.now() - started) / 1000).toFixed(1)} s）`);
console.log(failed ? '浏览器冒烟失败' : '浏览器冒烟通过');
process.exit(failed ? 1 : 0);
