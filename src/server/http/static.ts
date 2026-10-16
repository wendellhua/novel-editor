import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { isSafeRelPath, type AssetReader } from '../assets';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const INDEX = 'web/index.html';

function send(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { ...headers, 'Content-Length': String(buf.length) });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/**
 * 前端静态资源（§7.6）：/assets/* 带哈希，长期缓存；index.html 不缓存；
 * 无扩展名的路径回退到 index.html（前端路由），有扩展名但不存在的返回 404。
 */
export function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, assets: AssetReader): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    send(req, res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
    return;
  }
  const rel = pathname.slice(1);
  const lastSegment = rel.split('/').pop() ?? '';
  const isFileRequest = rel !== '' && lastSegment.includes('.');

  if (isFileRequest) {
    const buf = isSafeRelPath(rel) ? assets.read(`web/${rel}`) : null;
    if (buf === null) {
      send(req, res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
      return;
    }
    const cache = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    send(req, res, 200, { 'Content-Type': MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': cache }, buf);
    return;
  }

  const index = assets.read(INDEX);
  if (index === null) {
    send(req, res, 503, { 'Content-Type': 'text/plain; charset=utf-8' }, '前端资源缺失：请先执行 npm run build');
    return;
  }
  send(req, res, 200, { 'Content-Type': MIME['.html'] ?? 'text/html', 'Cache-Control': 'no-cache' }, index);
}
