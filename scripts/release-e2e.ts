import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { findBrowser, launchBrowser, type Browser } from './lib/cdp.ts';
import { mockTypoContent } from './lib/mock-typo.ts';
import { PageDriver } from './lib/page-driver.ts';
import { CACHE, RELEASE } from './lib/project.ts';

/**
 * T19 发布端到端验收（Windows）：在「干净环境」中运行 release/NovelEditor.exe——
 * 把 exe 复制到含中文与空格的目录、PATH 中没有任何 node.exe、%APPDATA% 指向空的临时目录（使用默认数据目录），
 * 然后全部经由界面完成：新建作品写作 → 配置模型 → 错别字检查 → 一键修正 → 退出 → 重启，数据完好。
 * 用法：npm run package:win && npm run e2e:release
 */
if (process.platform !== 'win32') {
  console.error('本脚本验证 Windows 安装包；macOS 请按 docs/USER_GUIDE.md 手动验证');
  process.exit(1);
}
const exe = join(RELEASE, 'NovelEditor.exe');
if (!existsSync(exe)) throw new Error('找不到 release/NovelEditor.exe，请先执行 npm run package:win');
const browserPath = findBrowser();
if (browserPath === null) throw new Error('找不到 Chrome / Edge，可用 NE_BROWSER 指定浏览器路径');

const root = mkdtempSync(join(tmpdir(), 'ne-release-'));
const installDir = join(root, '我的 软件', 'NovelEditor');
const appData = join(root, 'AppData', 'Roaming');
mkdirSync(installDir, { recursive: true });
mkdirSync(appData, { recursive: true });
const installed = join(installDir, 'NovelEditor.exe');
copyFileSync(exe, installed);
const dataDir = join(appData, 'NovelEditor');
const outDir = join(CACHE, 'release-e2e');
mkdirSync(outDir, { recursive: true });

const sys = process.env.SystemRoot ?? 'C:\\Windows';
const cleanEnv: NodeJS.ProcessEnv = {
  SystemRoot: sys,
  windir: sys,
  TEMP: join(root, 'Temp'),
  TMP: join(root, 'Temp'),
  USERPROFILE: root,
  APPDATA: appData,
  LOCALAPPDATA: join(root, 'AppData', 'Local'),
  PATH: [join(sys, 'System32'), sys, join(sys, 'System32', 'Wbem')].join(delimiter),
};
mkdirSync(cleanEnv.TEMP as string, { recursive: true });

const results: string[] = [];
const problems: string[] = [];
const ok = (cond: boolean, message: string): void => {
  if (!cond) throw new Error(message);
  results.push(`✔ ${message}`);
};

/** 模拟模型：测试连接回 pong，错别字检查按 mock-typo 词表。 */
function startMockLlm(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { messages?: { role: string; content: string }[] };
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      const content = user.includes('## 待查正文') ? mockTypoContent(body) : '{"ok":true,"reply":"pong"}';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      }),
    ),
  );
}

let child: ChildProcess | null = null;
let output = '';
async function launch(): Promise<{ url: string; exited: Promise<number | null> }> {
  output = '';
  const c = spawn(installed, ['--no-browser'], { cwd: installDir, env: cleanEnv, windowsHide: true });
  child = c;
  c.stdout?.on('data', (b: Buffer) => (output += b.toString('utf8')));
  c.stderr?.on('data', (b: Buffer) => (output += b.toString('utf8')));
  const exited = new Promise<number | null>((r) => c.on('exit', r));
  for (let i = 0; i < 200; i++) {
    const url = /请在浏览器中打开：(\S+)/.exec(output)?.[1];
    if (url !== undefined) return { url, exited };
    if (c.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`程序未能启动：\n${output}`);
}

const BODY = '他在接再厉，终于突破了瓶颈。\n众人迫不急待地围了上来。';
const FIXED = '他再接再厉，终于突破了瓶颈。\n众人迫不及待地围了上来。';
const inputOf = (testId: string): string => `[data-testid="${testId}"] input`;

let browser: Browser | null = null;
let failed = false;
const llm = await startMockLlm();
const started = Date.now();
try {
  ok(
    cleanEnv.PATH?.split(delimiter).every((d) => !existsSync(join(d, 'node.exe'))) === true,
    `干净环境：PATH 中没有 node.exe；程序位于「${installDir}」，数据目录用默认位置 %APPDATA%\\NovelEditor`,
  );
  const first = await launch();
  ok(true, '双击运行（无 Node 环境）后给出登录地址');

  browser = await launchBrowser(browserPath, join(root, 'browser'));
  const { page } = browser;
  page.on('Runtime.consoleAPICalled', (p) => {
    if (['error', 'warning', 'assert'].includes(String(p.type))) problems.push(`console.${String(p.type)}: ${JSON.stringify(p.args)}`);
  });
  page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${JSON.stringify(p.exceptionDetails)}`));
  page.on('Log.entryAdded', (p) => {
    const e = p.entry as { level: string; source: string; text: string };
    if (e.level === 'error' || e.level === 'warning') problems.push(`log.${e.source}: ${e.text}`);
  });
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  const d = new PageDriver(page);
  const shot = async (name: string): Promise<void> => writeFileSync(join(outDir, `${name}.png`), await d.screenshot());

  // 1. 新建作品并写作
  await d.navigate(first.url);
  await d.waitText('还没有作品');
  await d.clickTestId('new-work');
  await d.focus(inputOf('work-title'));
  await d.insertText('发布验收');
  await d.clickTestId('work-submit');
  await d.waitFor(`document.querySelector('.cm-content')`, '进入工作区并打开第一章');
  await d.focusEditorEnd();
  await d.insertText(BODY);
  await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved' && document.querySelector('.cm-content').innerText.includes('迫不急待')`, '自动保存', 10_000);
  const workPath = await d.eval<string>('location.pathname');
  ok(existsSync(join(dataDir, 'works')) && readdirSync(join(dataDir, 'works')).some((f) => f.endsWith('.novel')), '新建作品并写作，自动保存到默认数据目录');

  // 2. 配置模型（界面：预设 → 改地址 → Key → 模型名 → 测试连接）
  await d.clickText('.n-menu-item-content', '设置');
  await d.waitText('尚未配置模型');
  await d.clickTestId('llm-add');
  await d.eval(`document.querySelector('[data-testid="llm-preset"] .n-base-selection').click()`);
  await d.clickText('.n-base-select-option', 'DeepSeek');
  await d.focus(inputOf('llm-baseurl'));
  await d.eval(`document.querySelector(${JSON.stringify(inputOf('llm-baseurl'))}).select()`);
  await d.insertText(llm.baseUrl);
  await d.focus(inputOf('llm-apikey'));
  await d.insertText('sk-release-e2e-0000');
  await d.focus(inputOf('llm-model'));
  await d.insertText('mock-model');
  await d.clickTestId('llm-submit');
  await d.waitFor(`document.querySelectorAll('[data-testid="llm-row"]').length === 1`, '模型列表');
  await d.clickTestId('llm-test');
  await d.waitFor(`document.querySelector('[data-testid="llm-probe"]')?.innerText.includes('连接正常')`, '测试连接', 15_000);
  ok(true, '在设置中添加模型并测试连接成功');

  // 3. 错别字检查 → 一键修正
  await d.navigate(`${new URL(first.url).origin}${workPath}`);
  await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('迫不急待')`, '回到正文');
  await d.clickTestId('check-open');
  await d.waitFor(`document.querySelector('[data-testid="check-start"]') && !document.querySelector('[data-testid="check-start"]').disabled`, '可以开始检查', 10_000);
  await d.clickTestId('check-start');
  await d.waitText('检查完成：发现 2 处问题', 20_000);
  await d.eval(`document.querySelector('[data-testid="check-panel"]').closest('.n-drawer').querySelector('.n-base-close').click()`);
  await d.waitFor(`document.querySelector('[data-testid="issue-apply-all"]')`, '问题面板');
  await shot('issues');
  await d.clickTestId('issue-apply-all');
  await d.clickText('.n-popconfirm__action button', '全部修正');
  await d.waitFor(`document.querySelector('.cm-content').innerText.includes('再接再厉') && document.querySelector('.cm-content').innerText.includes('迫不及待')`, '修正写入编辑器');
  await d.waitFor(`document.querySelector('[data-testid="save-status"]')?.dataset.status === 'saved'`, '已保存');
  ok(true, '错别字检查发现 2 处问题，「采纳全部」后正文已修正');

  // 4. 退出 → 重启
  await d.clickText('.n-menu-item-content', '设置');
  await d.clickText('.n-tabs-tab', '关于');
  await d.clickText('button', '退出程序');
  await d.clickText('button', '退出');
  await d.waitText('程序已退出');
  const code = await Promise.race([first.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000))]);
  ok(code === 0 && !existsSync(join(dataDir, 'instance.json')), '「退出程序」后进程正常退出（退出码 0），锁文件已删除');

  const second = await launch();
  await d.navigate(second.url);
  await d.waitFor(`[...document.querySelectorAll('[data-testid="work-card"]')].some((e) => e.innerText.includes('发布验收'))`, '作品库中有作品');
  await d.eval(`[...document.querySelectorAll('[data-testid="work-card"]')].find((e) => e.innerText.includes('发布验收')).click()`);
  await d.waitFor(`document.querySelector('.cm-content')?.innerText.includes('再接再厉')`, '重启后打开作品');
  const text = await d.eval<string>(`document.querySelector('.cm-content').innerText`);
  const workId = workPath.split('/')[2] ?? '';
  const chapterId = workPath.split('/')[3] ?? (await d.eval<string>('location.pathname')).split('/')[3];
  const revs = await d.eval<{ reason: string }[]>(`fetch('/api/works/${workId}/chapters/${chapterId}/revisions').then((r) => r.json())`);
  const profiles = await d.eval<{ name: string; apiKey: string }[]>(`fetch('/api/llm/profiles').then((r) => r.json())`);
  ok(
    text.replace(/\n+/g, '\n').trim() === FIXED && revs.some((r) => r.reason === 'before_fix') && profiles.length === 1 && !JSON.stringify(profiles).includes('sk-release-e2e-0000'),
    '重启后数据完好：正文为修正后的内容、有「修正前」历史版本、模型配置仍在（接口只返回掩码 Key）',
  );
  await shot('after-restart');
  ok(problems.length === 0, '浏览器控制台无错误、无警告');
} catch (err) {
  failed = true;
  results.push(`✘ ${err instanceof Error ? err.message : String(err)}`);
  if (browser !== null) writeFileSync(join(outDir, 'failure.png'), await new PageDriver(browser.page).screenshot().catch(() => Buffer.alloc(0)));
  writeFileSync(join(outDir, 'app.log'), output);
} finally {
  await browser?.close();
  if (child !== null && (child as ChildProcess).exitCode === null) (child as ChildProcess).kill();
  await llm.close();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch {
    console.warn(`临时目录未能删除：${root}`);
  }
}

console.log(results.join('\n'));
if (problems.length > 0) console.log(`\n浏览器问题：\n${problems.join('\n')}`);
console.log(`\n截图：${outDir}（用时 ${((Date.now() - started) / 1000).toFixed(1)} s）`);
console.log(failed ? '发布验收失败' : '发布验收通过');
process.exit(failed ? 1 : 0);
