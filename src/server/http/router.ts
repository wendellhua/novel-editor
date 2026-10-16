import type { IncomingMessage, ServerResponse } from 'node:http';
import { BODY_LIMITS } from '../../shared/constants';
import { readBody, readJson } from './body-parser';

export type AuthMode = 'session' | 'none';

export interface RouteOptions {
  auth?: AuthMode;
  bodyLimit?: number;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  readJson<T = unknown>(options?: { optional?: boolean }): Promise<T>;
  readBody(): Promise<Buffer>;
}

/** undefined → 204；handled → 处理器已自行写响应（如 SSE）。 */
export type HandlerResult =
  | undefined
  | {
      status?: number;
      headers?: Record<string, string>;
      json?: unknown;
      body?: string | Buffer;
      handled?: true;
    };

export type Handler = (ctx: RequestContext) => HandlerResult | Promise<HandlerResult>;

export interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
  auth: AuthMode;
  bodyLimit: number;
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

export class Router {
  readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, options: RouteOptions = {}): this {
    const segments = splitPath(pattern);
    const duplicate = this.routes.some((r) => r.method === method && r.segments.join('/') === segments.join('/'));
    if (duplicate) throw new Error(`路由重复：${method} ${pattern}`);
    this.routes.push({
      method,
      pattern,
      segments,
      handler,
      auth: options.auth ?? 'session',
      bodyLimit: options.bodyLimit ?? BODY_LIMITS.default,
    });
    return this;
  }

  get(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('GET', pattern, handler, options);
  }
  post(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('POST', pattern, handler, options);
  }
  put(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('PUT', pattern, handler, options);
  }
  patch(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('PATCH', pattern, handler, options);
  }
  delete(pattern: string, handler: Handler, options?: RouteOptions): this {
    return this.add('DELETE', pattern, handler, options);
  }

  match(method: string, pathname: string): RouteMatch | null {
    const parts = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const seg = route.segments[i] ?? '';
        const part = parts[i] ?? '';
        if (seg.startsWith(':')) {
          try {
            params[seg.slice(1)] = decodeURIComponent(part);
          } catch {
            ok = false;
          }
        } else if (seg !== part) {
          ok = false;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

export function createContext(req: IncomingMessage, res: ServerResponse, url: URL, match: RouteMatch): RequestContext {
  const limit = match.route.bodyLimit;
  return {
    req,
    res,
    url,
    params: match.params,
    query: url.searchParams,
    readJson: <T>(options?: { optional?: boolean }) => readJson(req, limit, options?.optional ?? false) as Promise<T>,
    readBody: () => readBody(req, limit),
  };
}
