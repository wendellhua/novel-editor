import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssetReader } from '../assets';
import type { Logger } from '../system/logger';
import { isAllowedHost, isAllowedOrigin, type Auth } from './auth';
import { HttpError, forbidden, notFound, toHttpError, unauthorized } from './errors';
import { createContext, type HandlerResult, type Router } from './router';
import { serveStatic } from './static';

export const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 日志里只记路径，不记查询串（可能含搜索词等用户输入）。 */
const url = (req: IncomingMessage): string => (req.url ?? '').split('?')[0] ?? '';

export interface HttpDeps {
  router: Router;
  auth: Auth;
  assets: AssetReader;
  log: Logger;
  getPort(): number;
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function writeResult(res: ServerResponse, result: HandlerResult): void {
  if (result === undefined) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (result.handled === true) return;
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...result.headers };
  let body: string | Buffer | undefined = result.body;
  if (result.json !== undefined) {
    body = JSON.stringify(result.json);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  res.writeHead(result.status ?? 200, headers);
  res.end(body);
}

function writeError(res: ServerResponse, err: HttpError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (err.status === 413) headers.Connection = 'close';
  res.writeHead(err.status, headers);
  res.end(JSON.stringify(err.toBody()));
}

/** 请求处理管线：安全响应头 → Host 校验 → 路由（会话 / Origin 校验）→ 静态资源（INV-12）。 */
export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setSecurityHeaders(res);
    const port = deps.getPort();
    if (!isAllowedHost(req.headers.host, port)) throw forbidden('Host 不被允许');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';

    const match = deps.router.match(method, url.pathname);
    if (match !== null) {
      if (match.route.auth === 'session' && !deps.auth.hasValidSession(req.headers.cookie)) throw unauthorized();
      if (WRITE_METHODS.has(method) && !isAllowedOrigin(req.headers.origin, port)) throw forbidden('跨源写请求被拒绝');
      writeResult(res, await match.route.handler(createContext(req, res, url, match)));
      return;
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) throw notFound(`接口不存在：${method} ${url.pathname}`);
    if (method === 'GET' || method === 'HEAD') {
      serveStatic(req, res, url, deps.assets);
      return;
    }
    throw notFound();
  };

  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      const mapped = toHttpError(err);
      if (mapped !== null && mapped.status < 500) {
        writeError(res, mapped);
        return;
      }
      // 外部服务（大模型、SkillHub）的失败不是本程序的缺陷：只记一行警告，不记堆栈
      if (mapped !== null && (mapped.code === 'LLM_ERROR' || mapped.code === 'HUB_ERROR')) {
        deps.log.warn(`外部服务失败：${req.method ?? ''} ${url(req)}：${mapped.message}`);
        writeError(res, mapped);
        return;
      }
      deps.log.error(`处理请求失败：${req.method ?? ''} ${req.url ?? ''}`, err);
      writeError(res, mapped ?? new HttpError(500, 'INTERNAL', '服务器内部错误'));
    });
  };
}
