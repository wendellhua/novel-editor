import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { CreateWorkRequest, TrashedWork, UpdateWorkRequest, Work, WorkSummary } from '../../shared/types';
import { worksApi } from '../api/works';

/** 作品库：作品列表与作品回收站。 */
export const useLibraryStore = defineStore('library', () => {
  const works = ref<WorkSummary[]>([]);
  const trashed = ref<TrashedWork[]>([]);
  const loading = ref(false);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      works.value = await worksApi.list();
    } finally {
      loading.value = false;
    }
  }

  async function refreshTrash(): Promise<void> {
    trashed.value = await worksApi.listTrashed();
  }

  async function create(req: CreateWorkRequest): Promise<Work> {
    const work = await worksApi.create(req);
    await refresh();
    return work;
  }

  async function update(workId: string, patch: UpdateWorkRequest): Promise<Work> {
    const work = await worksApi.update(workId, patch);
    await refresh();
    return work;
  }

  async function remove(workId: string): Promise<void> {
    await worksApi.remove(workId);
    await Promise.all([refresh(), refreshTrash()]);
  }

  async function restore(file: string): Promise<void> {
    await worksApi.restoreTrashed(file);
    await Promise.all([refresh(), refreshTrash()]);
  }

  async function purge(file: string): Promise<void> {
    await worksApi.purgeTrashed(file);
    await refreshTrash();
  }

  return { works, trashed, loading, refresh, refreshTrash, create, update, remove, restore, purge };
});
