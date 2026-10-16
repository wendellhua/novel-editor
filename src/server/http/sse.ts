import type { ServerResponse } from 'node:http';
import type { ServerEvent } from '../../shared/types';
import type { HandlerResult, RequestContext } from './router';

interface Client {
  res: ServerResponse;
  workId: string | null;
}

export interface EventHub {
  handle(ctx: RequestContext): HandlerResult;
  publish(event: ServerEvent): void;
  closeAll(): void;
  size(): number;
}

/** GET /api/events：SSE 推送 ServerEvent，可用 ?workId= 过滤（不属于某部作品的事件如 llm.status 推送给所有连接），定时发送心跳注释（§7.2）。 */
export function createEventHub(heartbeatMs = 15_000): EventHub {
  const clients = new Set<Client>();
  let timer: NodeJS.Timeout | null = null;

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      for (const c of clients) c.res.write(': ping\n\n');
    }, heartbeatMs);
    timer.unref();
  };
  const stopTimerIfIdle = (): void => {
    if (clients.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    handle(ctx) {
      const { req, res } = ctx;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n: connected\n\n');
      const client: Client = { res, workId: ctx.query.get('workId') };
      clients.add(client);
      ensureTimer();
      req.on('close', () => {
        clients.delete(client);
        stopTimerIfIdle();
      });
      return { handled: true };
    },
    publish(event) {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      const workId = 'workId' in event ? event.workId : null;
      for (const c of clients) {
        if (c.workId === null || workId === null || c.workId === workId) c.res.write(frame);
      }
    },
    closeAll() {
      for (const c of clients) c.res.end();
      clients.clear();
      stopTimerIfIdle();
    },
    size: () => clients.size,
  };
}
