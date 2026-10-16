import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ServerEvent, SystemInfo } from '../../shared/types';
import { ApiError, api } from '../api/client';
import { subscribeServerEvents, type ConnectionState } from '../api/events';

export type SessionStatus = 'loading' | 'ready' | 'unauthorized' | 'offline' | 'stopped';
type EventListener = (event: ServerEvent) => void;

export const useSystemStore = defineStore('system', () => {
  const info = ref<SystemInfo | null>(null);
  const status = ref<SessionStatus>('loading');
  const connection = ref<ConnectionState>('connecting');
  const listeners = new Set<EventListener>();
  let unsubscribe: (() => void) | null = null;

  async function load(): Promise<void> {
    try {
      info.value = await api.get<SystemInfo>('/api/system/info');
      status.value = 'ready';
    } catch (err) {
      status.value = err instanceof ApiError && err.status === 401 ? 'unauthorized' : 'offline';
    }
  }

  let lifecycleBound = false;

  function connect(): void {
    unsubscribe?.();
    if (!lifecycleBound) {
      lifecycleBound = true;
      // 离开页面时主动断开 SSE：浏览器会把页面放进往返缓存（bfcache）并保留这条长连接，每个主机最多 6 条连接，
      // 刷新或前进后退几次之后连接池被占满，新页面的请求要排队几十秒。从缓存恢复时重新连接。
      window.addEventListener('pagehide', () => {
        unsubscribe?.();
        unsubscribe = null;
      });
      window.addEventListener('pageshow', (e) => {
        if (e.persisted && status.value !== 'stopped') connect();
      });
    }
    unsubscribe = subscribeServerEvents(
      (event) => {
        for (const l of listeners) l(event);
      },
      (state) => {
        connection.value = state;
        if (state === 'closed' && status.value !== 'stopped') void load();
      },
    );
  }

  /** 订阅服务端事件（SSE），返回取消订阅函数。组件卸载时必须调用。 */
  function onServerEvent(listener: EventListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function shutdown(): Promise<void> {
    await api.post<void>('/api/system/shutdown');
    unsubscribe?.();
    unsubscribe = null;
    status.value = 'stopped';
  }

  return { info, status, connection, load, connect, onServerEvent, shutdown };
});
