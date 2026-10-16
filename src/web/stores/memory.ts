import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type { Job, PlotMemory } from '../../shared/types';
import { memoryApi } from '../api/memory';
import { useSystemStore } from './system';

/**
 * 当前作品的剧情记忆（ADR-011）：打开作品时读取；剧情记忆任务有进展（job.updated）或结束（memory.updated）时节流刷新。
 * 正文保存后服务端会自动判断是否需要更新，这里只负责查阅与手动更新 / 重建。
 */
export const useMemoryStore = defineStore('memory', () => {
  const workId = ref<string | null>(null);
  const data = shallowRef<PlotMemory | null>(null);
  const loading = ref(false);
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  async function refresh(): Promise<void> {
    const id = workId.value;
    if (id === null) return;
    const mine = ++seq;
    loading.value = true;
    try {
      const m = await memoryApi.get(id);
      if (mine === seq && workId.value === id) data.value = m;
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  function scheduleRefresh(delayMs = 500): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh().catch(() => undefined);
    }, delayMs);
  }

  async function openWork(id: string): Promise<void> {
    if (workId.value !== id) data.value = null;
    workId.value = id;
    unsubscribe?.();
    unsubscribe = useSystemStore().onServerEvent((e) => {
      if (!('workId' in e) || e.workId !== workId.value) return;
      if (e.type === 'memory.updated') scheduleRefresh(0);
      else if (e.type === 'job.updated' && e.job.type === 'memory') scheduleRefresh(e.job.status === 'running' ? 800 : 0);
      // 正文保存后待纳入的字数会变化
      else if (e.type === 'chapter.updated') scheduleRefresh(3000);
    });
    await refresh();
  }

  function close(): void {
    unsubscribe?.();
    unsubscribe = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    workId.value = null;
    data.value = null;
  }

  function requireWork(): string {
    if (workId.value === null) throw new Error('尚未打开作品');
    return workId.value;
  }

  async function update(): Promise<Job> {
    const job = await memoryApi.update(requireWork());
    await refresh();
    return job;
  }

  async function rebuild(): Promise<Job> {
    const job = await memoryApi.rebuild(requireWork());
    await refresh();
    return job;
  }

  return { workId, data, loading, refresh, openWork, close, update, rebuild };
});
