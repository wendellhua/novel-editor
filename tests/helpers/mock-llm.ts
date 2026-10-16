import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> & { messages?: { role: string; content: string }[]; response_format?: { type: string } };
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  /** 延迟多久才响应（用于超时、并发测试）。 */
  delayMs?: number;
  /** 不响应，直接断开连接（模拟网络错误）。 */
  destroy?: boolean;
}

export type MockHandler = (req: MockRequest, index: number) => MockReply | Promise<MockReply>;

export interface MockLlm {
  baseUrl: string;
  requests: MockRequest[];
  /** 当前同时在处理的请求数的历史最大值。 */
  maxInFlight: number;
  handle: MockHandler;
  close(): Promise<void>;
}

/** chat/completions 成功响应。content 为 null 模拟空内容。 */
export function completion(
  content: string | null,
  options: { finishReason?: string; promptTokens?: number; completionTokens?: number } = {},
): MockReply {
  return {
    json: {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: options.finishReason ?? 'stop' }],
      usage: { prompt_tokens: options.promptTokens ?? 10, completion_tokens: options.completionTokens ?? 5 },
    },
  };
}

export const errorReply = (status: number, message: string, headers: Record<string, string> = {}): MockReply => ({
  status,
  headers,
  json: { error: { message, type: 'mock_error' } },
});

/** 本地 OpenAI 兼容服务（只实现 POST /v1/chat/completions），记录每个请求。 */
export async function startMockLlm(handle: MockHandler = () => completion('{"ok":true,"reply":"pong"}')): Promise<MockLlm> {
  let inFlight = 0;
  const state: MockLlm = {
    baseUrl: '',
    requests: [],
    maxInFlight: 0,
    handle,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, inFlight);
        // 响应结束或客户端放弃（超时/取消）时都会触发 close：只统计客户端仍在等待的请求
        let counted = true;
        res.on('close', () => {
          if (counted) inFlight--;
          counted = false;
        });
        let body: MockRequest['body'] = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MockRequest['body'];
        } catch {
          body = {};
        }
        const request: MockRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
        const index = state.requests.push(request) - 1;
        const reply =
          req.method === 'POST' && req.url === '/v1/chat/completions'
            ? await state.handle(request, index)
            : errorReply(404, `no route ${req.method ?? ''} ${req.url ?? ''}`);
        if (reply.delayMs !== undefined) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (reply.destroy === true) {
          req.socket.destroy();
          return;
        }
        if (res.destroyed) return;
        const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
        res.writeHead(reply.status ?? 200, {
          'Content-Type': reply.text !== undefined ? 'text/html' : 'application/json',
          ...reply.headers,
        });
        res.end(text);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return state;
}
