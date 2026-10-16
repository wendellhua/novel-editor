import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ChapterNode, TrashItemRef, TrashList, VolumeNode, WorkTree } from '../../shared/types';
import { worksApi } from '../api/works';

export interface ChapterLocation {
  volume: VolumeNode;
  chapter: ChapterNode;
  index: number;
}

/** 写作工作区：当前作品的目录树与结构操作。每次结构变更后以服务端目录树为准重新加载。 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const workId = ref<string | null>(null);
  const tree = ref<WorkTree | null>(null);
  const trash = ref<TrashList>({ volumes: [], chapters: [] });
  const loading = ref(false);

  const volumes = computed(() => tree.value?.volumes ?? []);
  const totalWords = computed(() => volumes.value.reduce((s, v) => s + v.chapters.reduce((a, c) => a + c.wordCount, 0), 0));

  function requireWork(): string {
    if (workId.value === null) throw new Error('尚未打开作品');
    return workId.value;
  }

  async function open(id: string): Promise<void> {
    if (workId.value !== id) {
      tree.value = null;
      trash.value = { volumes: [], chapters: [] };
    }
    workId.value = id;
    await reload();
  }

  function close(): void {
    workId.value = null;
    tree.value = null;
  }

  async function reload(): Promise<void> {
    const id = requireWork();
    loading.value = true;
    try {
      const next = await worksApi.tree(id);
      if (workId.value === id) tree.value = next;
    } finally {
      loading.value = false;
    }
  }

  async function reloadTrash(): Promise<void> {
    trash.value = await worksApi.trash(requireWork());
  }

  function locate(chapterId: string): ChapterLocation | null {
    for (const volume of volumes.value) {
      const index = volume.chapters.findIndex((c) => c.id === chapterId);
      if (index >= 0) return { volume, chapter: volume.chapters[index]!, index };
    }
    return null;
  }

  /** 正文保存后只更新本地字数，避免每次保存都重载目录树。 */
  function patchChapter(chapterId: string, patch: Partial<Pick<ChapterNode, 'title' | 'wordCount' | 'updatedAt'>>): void {
    const loc = locate(chapterId);
    if (loc !== null) Object.assign(loc.chapter, patch);
  }

  async function mutate<T>(fn: (id: string) => Promise<T>, opts: { trash?: boolean } = {}): Promise<T> {
    const id = requireWork();
    try {
      return await fn(id);
    } finally {
      await Promise.all([reload(), opts.trash === true ? reloadTrash() : Promise.resolve()]);
    }
  }

  const createVolume = (title: string, afterVolumeId?: string) =>
    mutate((id) => worksApi.createVolume(id, { title, afterVolumeId: afterVolumeId ?? null }));
  const renameVolume = (volumeId: string, title: string) => mutate((id) => worksApi.renameVolume(id, volumeId, title));
  const deleteVolume = (volumeId: string) => mutate((id) => worksApi.deleteVolume(id, volumeId), { trash: true });
  const reorderVolumes = (ids: string[]) => mutate((id) => worksApi.reorderVolumes(id, ids));

  const createChapter = (volumeId: string, title: string, afterChapterId?: string | null) =>
    mutate((id) => worksApi.createChapter(id, { volumeId, title, afterChapterId: afterChapterId ?? null }));
  const renameChapter = (chapterId: string, title: string) => mutate((id) => worksApi.renameChapter(id, chapterId, title));
  const deleteChapter = (chapterId: string) => mutate((id) => worksApi.deleteChapter(id, chapterId), { trash: true });
  const moveChapter = (chapterId: string, volumeId: string, index: number) =>
    mutate((id) => worksApi.moveChapter(id, chapterId, { volumeId, index }));

  async function moveVolumeBy(volumeId: string, delta: number): Promise<void> {
    const ids = volumes.value.map((v) => v.id);
    const from = ids.indexOf(volumeId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, volumeId);
    await reorderVolumes(ids);
  }

  async function moveChapterBy(chapterId: string, delta: number): Promise<void> {
    const loc = locate(chapterId);
    if (loc === null) return;
    const to = loc.index + delta;
    if (to < 0 || to >= loc.volume.chapters.length) return;
    await moveChapter(chapterId, loc.volume.id, to);
  }

  /** 只发送契约字段（kind / id）：服务端 Schema 拒绝多余字段。 */
  const toRef = (r: TrashItemRef): TrashItemRef => ({ kind: r.kind, id: r.id });
  const restoreTrash = (ref: TrashItemRef) => mutate((id) => worksApi.restoreTrash(id, toRef(ref)), { trash: true });
  const purgeTrash = (ref: TrashItemRef | { all: true }) =>
    mutate((id) => worksApi.purgeTrash(id, 'all' in ref ? { all: true } : toRef(ref)), { trash: true });

  return {
    workId,
    tree,
    trash,
    loading,
    volumes,
    totalWords,
    open,
    close,
    reload,
    reloadTrash,
    locate,
    patchChapter,
    createVolume,
    renameVolume,
    deleteVolume,
    reorderVolumes,
    moveVolumeBy,
    createChapter,
    renameChapter,
    deleteChapter,
    moveChapter,
    moveChapterBy,
    restoreTrash,
    purgeTrash,
  };
});
