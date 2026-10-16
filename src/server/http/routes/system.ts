import type { SystemInfo } from '../../../shared/types';
import { runSelfcheck } from '../../system/selfcheck';
import type { DataPaths } from '../../system/paths';
import type { Auth } from '../auth';
import { unauthorized } from '../errors';
import type { HandlerResult, Router } from '../router';
import type { EventHub } from '../sse';

export interface SystemRouteDeps {
  auth: Auth;
  events: EventHub;
  paths: DataPaths;
  requestShutdown: () => void;
}

const AUTH_EXPIRED_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>NovelEditor</title></head>
<body style="font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif;max-width:560px;margin:15vh auto;padding:0 24px;line-height:1.7">
<h2>登录链接已失效</h2><p>出于安全考虑，打开链接只能使用一次，且 60 秒内有效。</p>
<p>请重新双击 <b>NovelEditor</b> 程序，它会自动打开新的页面。</p></body></html>`;

export function registerSystemRoutes(router: Router, deps: SystemRouteDeps): void {
  router.post(
    '/api/system/nonce',
    (ctx) => {
      const header = ctx.req.headers['x-auth-secret'];
      if (!deps.auth.verifySecret(typeof header === 'string' ? header : undefined)) throw unauthorized('密钥不正确');
      return { json: { nonce: deps.auth.issueNonce() } };
    },
    { auth: 'none' },
  );

  router.get(
    '/auth',
    (ctx): HandlerResult => {
      if (deps.auth.consumeNonce(ctx.query.get('n') ?? '')) {
        return { status: 302, headers: { 'Set-Cookie': deps.auth.sessionCookie(), Location: '/' } };
      }
      if (deps.auth.hasValidSession(ctx.req.headers.cookie)) return { status: 302, headers: { Location: '/' } };
      return { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: AUTH_EXPIRED_HTML };
    },
    { auth: 'none' },
  );

  router.get('/api/system/info', () => {
    const info: SystemInfo = {
      appVersion: __APP_VERSION__,
      dataDir: deps.paths.root,
      platform: process.platform,
      nodeVersion: process.version,
    };
    return { json: info };
  });

  router.get('/api/system/selfcheck', () => ({ json: runSelfcheck(deps.paths.works) }));

  router.post('/api/system/shutdown', (ctx) => {
    ctx.res.once('finish', deps.requestShutdown);
    return undefined;
  });

  router.get('/api/events', (ctx) => deps.events.handle(ctx));
}
