import type { ServerEvent } from '../../shared/types';

export type ConnectionState = 'connecting' | 'open' | 'closed';

function isServerEvent(v: unknown): v is ServerEvent {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

/** 订阅 GET /api/events。EventSource 断线会自动重连；非 200（如会话失效）时进入 closed。 */
export function subscribeServerEvents(
  onEvent: (event: ServerEvent) => void,
  onState: (state: ConnectionState) => void,
  workId?: string,
): () => void {
  const url = workId === undefined ? '/api/events' : `/api/events?workId=${encodeURIComponent(workId)}`;
  const source = new EventSource(url);
  onState('connecting');
  source.onopen = () => onState('open');
  source.onerror = () => onState(source.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
  source.onmessage = (message: MessageEvent<string>) => {
    try {
      const data: unknown = JSON.parse(message.data);
      if (isServerEvent(data)) onEvent(data);
    } catch {
      // 忽略无法解析的帧
    }
  };
  return () => source.close();
}
