import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';

export interface SmokeTarget {
  label: string;
  command: string;
  args: string[];
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface SmokeReport {
  ok: boolean;
  steps: SmokeStep[];
}

export interface SmokeOptions {
  target: SmokeTarget;
  dataDir: string;
  expectVersion?: string;
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RawRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** 收到第一块数据就返回并断开（用于 SSE）。 */
  firstChunkOnly?: boolean;
  timeoutMs?: number;
}

/** 用 node:http 发请求：可以自定义 Host / Origin（fetch 会丢弃 Host 头）。 */
export function rawRequest(port: number, opts: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...opts.headers };
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        if (opts.firstChunkOnly === true) {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
          req.destroy();
        }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs ?? 10_000, () => req.destroy(new Error(`请求超时：${opts.path}`)));
    req.on('error', (err) => {
      if (opts.firstChunkOnly === true && (err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(err);
    });
    req.end(opts.body);
  });
}

interface Proc {
  child: ChildProcess;
  output(): string;
  exited: Promise<number | null>;
  alive(): boolean;
}

function startProc(target: SmokeTarget, dataDir: string): Proc {
  const child = spawn(target.command, [...target.args, '--data-dir', dataDir, '--no-browser'], {
    env: { ...process.env, NE_NO_BROWSER: '1' },
    windowsHide: true,
  });
  let out = '';
  let exited = false;
  child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const exitPromise = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      exited = true;
      resolve(code);
    }),
  );
  return { child, output: () => out, exited: exitPromise, alive: () => !exited };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function check(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 真实进程级冒烟（编码铁律 5）：启动 → 登录 → 首屏与资源 → 系统接口与 SQLite 自检 → 安全校验 →
 * SSE → 第二实例 → 退出清理 → 强杀后残留锁恢复。
 */
export async function runSmoke({ target, dataDir, expectVersion }: SmokeOptions): Promise<SmokeReport> {
  const steps: SmokeStep[] = [];
  const procs: Proc[] = [];
  const instanceFile = join(dataDir, 'instance.json');
  let port = 0;
  let cookie = '';

  const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
    const t0 = Date.now();
    try {
      steps.push({ name, ok: true, detail: await fn(), ms: Date.now() - t0 });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 });
      throw err;
    }
  };

  const launch = (): Proc => {
    const p = startProc(target, dataDir);
    procs.push(p);
    return p;
  };

  const waitReady = async (p: Proc): Promise<number> => {
    const ready = await waitFor(() => readJson(instanceFile)?.pid === p.child.pid || !p.alive(), 15_000);
    check(ready && p.alive(), `进程未就绪。输出：\n${p.output()}`);
    const inst = readJson(instanceFile);
    check(typeof inst?.port === 'number', 'instance.json 缺少端口');
    return inst.port;
  };

  const shutdown = async (p: Proc): Promise<void> => {
    const res = await rawRequest(port, {
      method: 'POST',
      path: '/api/system/shutdown',
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
    });
    check(res.status === 204, `退出接口返回 ${res.status}`);
    const code = await withTimeout(p.exited, 10_000, '进程 10 秒内未退出');
    check(code === 0, `退出码 ${String(code)}`);
  };

  const login = async (): Promise<void> => {
    const secret = readJson(join(dataDir, 'config.json'))?.authSecret;
    check(typeof secret === 'string', 'config.json 缺少 authSecret');
    const nonceRes = await rawRequest(port, { method: 'POST', path: '/api/system/nonce', headers: { 'X-Auth-Secret': secret } });
    check(nonceRes.status === 200, `申请 nonce 返回 ${nonceRes.status}`);
    const nonce = (JSON.parse(nonceRes.body) as { nonce: string }).nonce;
    const authRes = await rawRequest(port, { path: `/auth?n=${nonce}` });
    check(authRes.status === 302, `/auth 返回 ${authRes.status}`);
    const setCookie = authRes.headers['set-cookie']?.[0] ?? '';
    check(/HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), `Cookie 属性不正确：${setCookie}`);
    cookie = setCookie.split(';')[0] ?? '';
  };

  try {
    let a: Proc | null = null;
    await step(`启动 ${target.label} 并写入锁文件`, async () => {
      const t0 = Date.now();
      a = launch();
      port = await waitReady(a);
      return `端口 ${port}，${Date.now() - t0} ms`;
    });

    await step('一次性 nonce 换取会话 Cookie', async () => {
      await login();
      const reuse = await rawRequest(port, { path: '/auth?n=0000' });
      check(reuse.status === 401, `无效 nonce 返回 ${reuse.status}`);
      return 'HttpOnly + SameSite=Strict；无效 nonce 返回 401';
    });

    await step('首屏与前端资源', async () => {
      const index = await rawRequest(port, { path: '/' });
      check(index.status === 200 && index.body.includes('<div id="app">'), `首页返回 ${index.status}`);
      check(String(index.headers['content-security-policy']).includes("default-src 'self'"), '缺少 CSP 头');
      const src = /<script[^>]+src="([^"]+)"/.exec(index.body)?.[1];
      check(src !== undefined, '首页中没有脚本');
      const js = await rawRequest(port, { path: src });
      check(js.status === 200 && String(js.headers['content-type']).includes('javascript'), `脚本 ${src} 返回 ${js.status}`);
      const spa = await rawRequest(port, { path: '/settings' });
      check(spa.status === 200 && spa.body.includes('<div id="app">'), '前端路由回退失败');
      return `首页 + ${src}（${js.body.length} 字节）+ 前端路由回退`;
    });

    await step('系统信息与 SQLite 自检', async () => {
      const info = await rawRequest(port, { path: '/api/system/info', headers: { Cookie: cookie } });
      check(info.status === 200, `/api/system/info 返回 ${info.status}`);
      const body = JSON.parse(info.body) as Record<string, unknown>;
      check(['appVersion', 'dataDir', 'platform', 'nodeVersion'].every((k) => typeof body[k] === 'string'), `字段不全：${info.body}`);
      if (expectVersion !== undefined) check(body.appVersion === expectVersion, `版本 ${String(body.appVersion)} ≠ ${expectVersion}`);
      const self = await rawRequest(port, { path: '/api/system/selfcheck', headers: { Cookie: cookie } });
      const sc = JSON.parse(self.body) as Record<string, unknown>;
      check(sc.ok === true, `自检失败：${self.body}`);
      return `v${String(body.appVersion)}，Node ${String(body.nodeVersion)}，SQLite ${String(sc.sqliteVersion)}（FTS5 + trigram 可用）`;
    });

    await step('安全校验（INV-12）', async () => {
      const noCookie = await rawRequest(port, { path: '/api/system/info' });
      check(noCookie.status === 401, `无 Cookie 返回 ${noCookie.status}`);
      const badHost = await rawRequest(port, { path: '/api/system/info', headers: { Cookie: cookie, Host: 'evil.example:80' } });
      check(badHost.status === 403, `错误 Host 返回 ${badHost.status}`);
      const crossOrigin = await rawRequest(port, {
        method: 'POST',
        path: '/api/system/shutdown',
        headers: { Cookie: cookie, Origin: 'http://evil.example' },
      });
      check(crossOrigin.status === 403, `跨源写请求返回 ${crossOrigin.status}`);
      const still = await rawRequest(port, { path: '/api/system/info', headers: { Cookie: cookie } });
      check(still.status === 200, '跨源请求后服务不应退出');
      return '无 Cookie 401；错误 Host 403；跨源写请求 403 且服务未退出';
    });

    await step('SSE 连接', async () => {
      const sse = await rawRequest(port, { path: '/api/events', headers: { Cookie: cookie }, firstChunkOnly: true });
      check(sse.status === 200 && sse.body.includes(': connected'), `SSE 返回 ${sse.status}：${sse.body}`);
      return '收到 connected 帧';
    });

    await step('第二个实例只重新打开浏览器（INV-14）', async () => {
      const b = launch();
      const code = await withTimeout(b.exited, 10_000, '第二个实例 10 秒内未退出');
      check(code === 0, `第二个实例退出码 ${String(code)}`);
      check(/\/auth\?n=[0-9a-f]{32}/.test(b.output()), `第二个实例未给出登录地址：\n${b.output()}`);
      check(readJson(instanceFile)?.pid === a?.child.pid, '锁文件被第二个实例改写');
      return '第二个实例退出码 0，锁文件不变';
    });

    await step('退出接口：进程退出并删除锁文件', async () => {
      if (a === null) throw new Error('实例 A 不存在');
      await shutdown(a);
      check(readJson(instanceFile) === null, '退出后锁文件仍存在');
      return '退出码 0，instance.json 已删除';
    });

    await step('强杀后残留锁恢复', async () => {
      const c = launch();
      port = await waitReady(c);
      c.child.kill('SIGKILL');
      await withTimeout(c.exited, 10_000, '强杀后进程未退出');
      check(readJson(instanceFile)?.pid === c.child.pid, '强杀后应残留锁文件');
      const d = launch();
      port = await waitReady(d);
      check(/发现残留的 instance\.json/.test(d.output()), '未识别残留锁');
      await login();
      await shutdown(d);
      return '残留锁被识别并正常启动，退出后锁文件已删除';
    });
  } catch {
    // 失败信息已记录在 steps 中
  } finally {
    for (const p of procs) if (p.alive()) p.child.kill('SIGKILL');
    await Promise.all(procs.map((p) => withTimeout(p.exited, 5000, '').catch(() => null)));
  }
  return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
}

export function formatSmokeReport(report: SmokeReport): string {
  const lines = report.steps.map((s) => `${s.ok ? '✔' : '✘'} ${s.name}（${s.ms} ms）：${s.detail}`);
  lines.push(report.ok ? '冒烟验证通过' : '冒烟验证失败');
  return lines.join('\n');
}
