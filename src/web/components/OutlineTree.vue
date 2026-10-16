<script setup lang="ts">
import { NDropdown, NTree, useMessage, type DropdownOption, type TreeDropInfo, type TreeOption } from 'naive-ui';
import { computed, h, nextTick, ref, watch } from 'vue';
import { ApiError } from '../api/client';
import { usePrompt } from '../composables/usePrompt';
import { useWorkspaceStore } from '../stores/workspace';
import { formatWords } from '../utils/format';

type OutlineOption = TreeOption & { kind: 'volume' | 'chapter'; id: string; volumeId: string; wordCount: number };

const props = defineProps<{ selectedChapterId: string | null }>();
const emit = defineEmits<{ select: [string] }>();
const ws = useWorkspaceStore();
const message = useMessage();
const { prompt, confirm } = usePrompt();

const vKey = (id: string): string => `v:${id}`;
const cKey = (id: string): string => `c:${id}`;

const data = computed<OutlineOption[]>(() =>
  ws.volumes.map((v) => ({
    key: vKey(v.id),
    label: v.title,
    kind: 'volume',
    id: v.id,
    volumeId: v.id,
    wordCount: v.chapters.reduce((s, c) => s + c.wordCount, 0),
    isLeaf: false,
    children: v.chapters.map((c) => ({
      key: cKey(c.id),
      label: c.title,
      kind: 'chapter',
      id: c.id,
      volumeId: v.id,
      wordCount: c.wordCount,
      isLeaf: true,
    })),
  })),
);

const expandedKeys = ref<string[]>([]);
const knownVolumes = new Set<string>();
watch(
  () => ws.volumes.map((v) => v.id),
  (ids) => {
    const fresh = ids.filter((id) => !knownVolumes.has(id));
    for (const id of fresh) knownVolumes.add(id);
    if (fresh.length > 0) expandedKeys.value = [...expandedKeys.value, ...fresh.map(vKey)];
  },
  { immediate: true },
);
watch(
  () => props.selectedChapterId,
  (id) => {
    const loc = id === null ? null : ws.locate(id);
    if (loc !== null && !expandedKeys.value.includes(vKey(loc.volume.id))) expandedKeys.value = [...expandedKeys.value, vKey(loc.volume.id)];
  },
  { immediate: true },
);

const selectedKeys = computed(() => (props.selectedChapterId === null ? [] : [cKey(props.selectedChapterId)]));

const errorText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);
async function run(action: () => Promise<unknown>, fallback: string): Promise<void> {
  try {
    await action();
  } catch (e) {
    message.error(errorText(e, fallback));
  }
}

// ---------------- 拖拽 ----------------
const dragging = ref<OutlineOption | null>(null);

function allowDrop({ dropPosition, node }: { dropPosition: 'before' | 'inside' | 'after'; node: TreeOption }): boolean {
  const target = node as OutlineOption;
  const dragged = dragging.value;
  if (dragged === null || target.key === dragged.key) return false;
  if (dragged.kind === 'volume') return target.kind === 'volume' && dropPosition !== 'inside';
  return target.kind === 'volume' ? dropPosition === 'inside' : dropPosition !== 'inside';
}

async function onDrop({ node, dragNode, dropPosition }: TreeDropInfo): Promise<void> {
  const target = node as OutlineOption;
  const dragged = dragNode as OutlineOption;
  dragging.value = null;
  if (!allowDropFor(dragged, target, dropPosition)) return;
  if (dragged.kind === 'volume') {
    const ids = ws.volumes.map((v) => v.id).filter((id) => id !== dragged.id);
    ids.splice(ids.indexOf(target.id) + (dropPosition === 'after' ? 1 : 0), 0, dragged.id);
    await run(() => ws.reorderVolumes(ids), '调整分卷顺序失败');
    return;
  }
  const volume = ws.volumes.find((v) => v.id === target.volumeId);
  if (volume === undefined) return;
  const ids = volume.chapters.map((c) => c.id).filter((id) => id !== dragged.id);
  const index = target.kind === 'volume' ? ids.length : ids.indexOf(target.id) + (dropPosition === 'after' ? 1 : 0);
  await run(() => ws.moveChapter(dragged.id, volume.id, index), '移动章节失败');
}

function allowDropFor(dragged: OutlineOption, target: OutlineOption, dropPosition: 'before' | 'inside' | 'after'): boolean {
  const prev = dragging.value;
  dragging.value = dragged;
  const ok = allowDrop({ dropPosition, node: target });
  dragging.value = prev;
  return ok;
}

// ---------------- 右键菜单 ----------------
const menu = ref<{ show: boolean; x: number; y: number; node: OutlineOption | null }>({ show: false, x: 0, y: 0, node: null });

const menuOptions = computed<DropdownOption[]>(() => {
  const node = menu.value.node;
  if (node === null) return [];
  if (node.kind === 'volume') {
    const i = ws.volumes.findIndex((v) => v.id === node.id);
    return [
      { label: '新建章节', key: 'new-chapter' },
      { label: '在后面新建分卷', key: 'new-volume-after' },
      { label: '重命名', key: 'rename' },
      { label: '上移', key: 'up', disabled: i <= 0 },
      { label: '下移', key: 'down', disabled: i >= ws.volumes.length - 1 },
      { type: 'divider', key: 'd' },
      { label: '删除分卷', key: 'delete' },
    ];
  }
  const loc = ws.locate(node.id);
  const others = ws.volumes.filter((v) => v.id !== node.volumeId);
  return [
    { label: '在后面新建章节', key: 'new-chapter-after' },
    { label: '重命名', key: 'rename' },
    { label: '上移', key: 'up', disabled: loc === null || loc.index <= 0 },
    { label: '下移', key: 'down', disabled: loc === null || loc.index >= loc.volume.chapters.length - 1 },
    { label: '移动到', key: 'move', disabled: others.length === 0, children: others.map((v) => ({ label: v.title, key: `move:${v.id}` })) },
    { type: 'divider', key: 'd' },
    { label: '删除章节', key: 'delete' },
  ];
});

function nodeProps({ option }: { option: TreeOption }) {
  const node = option as OutlineOption;
  return {
    'data-testid': node.kind === 'volume' ? 'outline-volume' : 'outline-chapter',
    'data-id': node.id,
    onClick: () => {
      if (node.kind === 'chapter') emit('select', node.id);
    },
    onContextmenu: (e: MouseEvent) => {
      e.preventDefault();
      menu.value = { show: false, x: e.clientX, y: e.clientY, node };
      void nextTick(() => (menu.value.show = true));
    },
  };
}

function nextChapterTitle(): string {
  return `第${ws.volumes.reduce((s, v) => s + v.chapters.length, 0) + 1}章`;
}

async function newChapter(volumeId: string, afterChapterId: string | null): Promise<void> {
  const title = await prompt({ title: '新建章节', initial: nextChapterTitle() });
  if (title === null) return;
  await run(async () => emit('select', (await ws.createChapter(volumeId, title, afterChapterId)).id), '新建章节失败');
}

async function onMenuSelect(key: string): Promise<void> {
  const node = menu.value.node;
  menu.value.show = false;
  if (node === null) return;
  if (key.startsWith('move:')) {
    const volumeId = key.slice(5);
    const target = ws.volumes.find((v) => v.id === volumeId);
    await run(() => ws.moveChapter(node.id, volumeId, target?.chapters.length ?? 0), '移动章节失败');
    return;
  }
  switch (key) {
    case 'new-chapter':
      await newChapter(node.id, ws.volumes.find((v) => v.id === node.id)?.chapters.at(-1)?.id ?? null);
      return;
    case 'new-chapter-after':
      await newChapter(node.volumeId, node.id);
      return;
    case 'new-volume-after': {
      const title = await prompt({ title: '新建分卷', initial: `第${ws.volumes.length + 1}卷` });
      if (title !== null) await run(() => ws.createVolume(title, node.id), '新建分卷失败');
      return;
    }
    case 'rename': {
      const title = await prompt({ title: node.kind === 'volume' ? '重命名分卷' : '重命名章节', initial: String(node.label ?? '') });
      if (title === null) return;
      await run(() => (node.kind === 'volume' ? ws.renameVolume(node.id, title) : ws.renameChapter(node.id, title)), '重命名失败');
      return;
    }
    case 'up':
    case 'down': {
      const delta = key === 'up' ? -1 : 1;
      await run(() => (node.kind === 'volume' ? ws.moveVolumeBy(node.id, delta) : ws.moveChapterBy(node.id, delta)), '调整顺序失败');
      return;
    }
    case 'delete': {
      const what = node.kind === 'volume' ? `分卷「${node.label}」及其中所有章节` : `章节「${node.label}」`;
      const ok = await confirm({ title: '删除', content: `${what}会移到回收站，随时可以恢复。`, positiveText: '删除', danger: true });
      if (!ok) return;
      await run(() => (node.kind === 'volume' ? ws.deleteVolume(node.id) : ws.deleteChapter(node.id)), '删除失败');
      return;
    }
  }
}

function renderSuffix({ option }: { option: TreeOption }) {
  const node = option as OutlineOption;
  const text = node.kind === 'volume' ? `${node.children?.length ?? 0} 章` : formatWords(node.wordCount);
  return h('span', { class: 'outline-suffix' }, text);
}

defineExpose({ newChapter });
</script>

<template>
  <div class="outline">
    <NTree
      block-line
      draggable
      virtual-scroll
      :data="data"
      :expanded-keys="expandedKeys"
      :selected-keys="selectedKeys"
      :allow-drop="allowDrop"
      :node-props="nodeProps"
      :render-suffix="renderSuffix"
      :cancelable="false"
      expand-on-click
      style="height: 100%"
      @update:expanded-keys="(keys: string[]) => (expandedKeys = keys)"
      @dragstart="({ node }: { node: TreeOption }) => (dragging = node as OutlineOption)"
      @dragend="() => (dragging = null)"
      @drop="onDrop"
    />
    <NDropdown
      trigger="manual"
      placement="bottom-start"
      :show="menu.show"
      :x="menu.x"
      :y="menu.y"
      :options="menuOptions"
      @select="onMenuSelect"
      @clickoutside="menu.show = false"
    />
  </div>
</template>

<style scoped>
.outline {
  height: 100%;
}
.outline :deep(.outline-suffix) {
  font-size: 12px;
  opacity: 0.55;
  padding-right: 8px;
  white-space: nowrap;
}
</style>
