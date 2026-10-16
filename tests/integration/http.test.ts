import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROOT } from '../../scripts/lib/project.ts';
import { rawRequest } from '../../scripts/lib/smoke-runner.ts';
import { startApp, type RunningApp } from '../../src/server/app';
import { createAssetReader } from '../../src/server/assets';
import { sanitizeAppConfig } from '../../src/server/system/config';
import { createSilentLogger } from '../../src/server/system/logger';
import { dataPaths, ensureDataDirs } from '../../src/server/system/paths';
import { makeTempDir } from '../helpers/tmp';

let tmp: ReturnType<typeof makeTempDir>;
let app: RunningApp;
let cookie = '';
const onShutdownRequested = vi.fn();

const get = (path: string, headers: Record<string, string> = {}) => rawRequest(app.port, { path, headers });

beforeAll(async () => {
  tmp = makeTempDir();
  const paths = dataPaths(tmp.dir);
  ensureDataDirs(paths);
  const config = { ...sanitizeAppConfig({}).value, port: 0 };
  app = await startApp({
    paths,
    config,
    log: createSilentLogger(),
    assets: createAssetReader(join(ROOT, 'tests', 'fixtures')),
    builtinAssets: createAssetReader(ROOT),
    hub: { baseUrl: 'http://127.0.0.1:1' },
    onShutdownRequested,
    heartbeatMs: 50,
  });
  const nonce = new URL(app.launchUrl()).searchParams.get('n') ?? '';
  const auth = await get(`/auth?n=${nonce}`);
  cookie = auth.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
});

afterAll(async () => {
  await app.close();
  tmp.cleanup();
});

describe('鉴权与安全校验（INV-12）', () => {
  it('登录后拿到会话 Cookie', () => {
    expect(cookie).toMatch(/^ne_session=[0-9a-f]{64}$/);
  });

  it('无 Cookie 访问接口返回 401 与统一错误格式', async () => {
    const res = await get('/api/system/info');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('nonce 用过一次后再用，返回失效页面', async () => {
    const nonce = new URL(app.launchUrl()).searchParams.get('n') ?? '';
    expect((await get(`/auth?n=${nonce}`)).status).toBe(302);
    const again = await get(`/auth?n=${nonce}`);
    expect(again.status).toBe(401);
    expect(again.body).toContain('登录链接已失效');
  });

  it('已登录时访问失效链接直接回首页', async () => {
    const res = await get('/auth?n=expired', { Cookie: cookie });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('错误 Host 一律 403（含静态资源）', async () => {
    for (const path of ['/api/system/info', '/', '/auth?n=x']) {
      const res = await get(path, { Cookie: cookie, Host: 'attacker.test:80' });
      expect(res.status, path).toBe(403);
    }
    expect((await get('/api/system/info', { Cookie: cookie, Host: `localhost:${app.port}` })).status).toBe(200);
  });

  it('跨源写请求 403，不会触发退出', async () => {
    const res = await rawRequest(app.port, {
      method: 'POST',
      path: '/api/system/shutdown',
      headers: { Cookie: cookie, Origin: 'http://attacker.test' },
    });
    expect(res.status).toBe(403);
    expect(onShutdownRequested).not.toHaveBeenCalled();
  });

  it('申请 nonce 需要正确的密钥', async () => {
    const res = await rawRequest(app.port, { method: 'POST', path: '/api/system/nonce', headers: { 'X-Auth-Secret': 'wrong' } });
    expect(res.status).toBe(401);
  });

  it('所有响应带安全头', async () => {
    const res = await get('/');
    expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('系统接口', () => {
  it('GET /api/system/info 字段与 SystemInfo 一致', async () => {
    const res = await get('/api/system/info', { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['appVersion', 'dataDir', 'nodeVersion', 'platform']);
    expect(body.dataDir).toBe(tmp.dir);
  });

  it('GET /api/system/selfcheck：SQLite + FTS5 trigram 可用', async () => {
    const res = await get('/api/system/selfcheck', { Cookie: cookie });
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, fts5: true, trigram: true, error: null });
  });

  it('未知接口返回 404 NOT_FOUND', async () => {
    const res = await get('/api/nope', { Cookie: cookie });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('SSE：连接帧、心跳与按作品过滤的事件', async () => {
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: app.port, path: '/api/events?workId=w1', headers: { Cookie: cookie, Host: `127.0.0.1:${app.port}` } },
        (res: IncomingMessage) => {
          expect(res.headers['content-type']).toContain('text/event-stream');
          res.on('data', (c: Buffer) => {
            chunks.push(c.toString());
            const all = chunks.join('');
            if (all.includes(': connected') && all.includes(': ping') && all.includes('"chapterId":"c1"')) {
              req.destroy();
              resolve();
            }
          });
        },
      );
      req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
      req.end();
    });
    await new Promise((r) => setTimeout(r, 120));
    app.events.publish({ type: 'chapter.updated', workId: 'other', chapterId: 'c0', rev: 1 });
    app.events.publish({ type: 'chapter.updated', workId: 'w1', chapterId: 'c1', rev: 2 });
    await done;
    const all = chunks.join('');
    expect(all).not.toContain('"chapterId":"c0"');
  });

  it('POST /api/system/shutdown：先返回 204 再触发退出', async () => {
    const res = await rawRequest(app.port, {
      method: 'POST',
      path: '/api/system/shutdown',
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${app.port}` },
    });
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(onShutdownRequested).toHaveBeenCalledTimes(1));
  });
});

describe('静态资源（§7.6）', () => {
  it('首页不缓存，无需 Cookie', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<div id="app">');
  });

  it('/assets/* 长期缓存且类型正确', async () => {
    const res = await get('/assets/app-fixture.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('前端路由回退到首页；不存在的文件 404', async () => {
    expect((await get('/works/abc/chapters/1')).body).toContain('<div id="app">');
    expect((await get('/assets/missing.js')).status).toBe(404);
  });

  it('路径穿越被拒绝', async () => {
    for (const path of ['/..%2f..%2fconfig.json', '/%2e%2e/%2e%2e/package.json', '/web/..%5c..%5cpackage.json']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });
});
