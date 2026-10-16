import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 本机 Chromium 内核浏览器（零依赖浏览器冒烟用）。可用 NE_BROWSER 指定路径。 */
export function findBrowser(): string | null {
  const candidates = [
    process.env.NE_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return candidates.find((p): p is string => typeof p === 'string' && existsSync(p)) ?? null;
}

type Listener = (params: Record<string, unknown>) => void;

export interface CdpPage {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(method: string, listener: Listener): void;
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

export interface Browser {
  process: ChildProcess;
  page: CdpPage;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function connectPage(wsUrl: string): Promise<CdpPage> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`无法连接 CDP：${wsUrl}`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Listener[]>();
  ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    } else if (msg.method !== undefined) {
      for (const l of listeners.get(msg.method) ?? []) l(msg.params ?? {});
    }
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    async evaluate<T>(expression: string) {
      const r = await send<{ result: { value?: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.text}`);
      return r.result.value as T;
    },
    close: () => ws.close(),
  };
}

export async function launchBrowser(executable: string, userDataDir: string): Promise<Browser> {
  const proc = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
  if (!existsSync(portFile)) throw new Error('浏览器未能启动远程调试端口');
  const port = readFileSync(portFile, 'utf8').split('\n')[0]?.trim();
  let wsUrl: string | undefined;
  for (let i = 0; i < 100 && wsUrl === undefined; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      // 浏览器尚未就绪
    }
    if (wsUrl === undefined) await sleep(50);
  }
  if (wsUrl === undefined) throw new Error('找不到浏览器页面目标');
  const page = await connectPage(wsUrl);
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  return {
    process: proc,
    page,
    async close() {
      const exited = new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('exit', r)));
      try {
        const browserSession = await connectPage(version.webSocketDebuggerUrl);
        void browserSession.send('Browser.close').catch(() => undefined);
      } catch {
        proc.kill();
      }
      page.close();
      const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
      if (timedOut) proc.kill();
      await sleep(500);
    },
  };
}

/** 轮询直到表达式为真。表达式可以返回 Promise（先 await 再判断真假，避免 Promise 对象恒为真）。 */
export async function waitForPage(page: CdpPage, expression: string, timeoutMs = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate<boolean>(`(async () => Boolean(await (${expression})))()`).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
