<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent, NEmpty, NList, NListItem, NSpace, NTag, NThing, useMessage } from 'naive-ui';
import { computed, watch } from 'vue';
import type { TrashItemRef } from '../../shared/types';
import { ApiError } from '../api/client';
import { usePrompt } from '../composables/usePrompt';
import { useWorkspaceStore } from '../stores/workspace';
import { formatTime } from '../utils/format';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const ws = useWorkspaceStore();
const message = useMessage();
const { confirm } = usePrompt();

interface Row extends TrashItemRef {
  title: string;
  deletedAt: number;
}

const rows = computed<Row[]>(() =>
  [
    ...ws.trash.volumes.map((v) => ({ kind: 'volume' as const, id: v.id, title: v.title, deletedAt: v.deletedAt })),
    ...ws.trash.chapters.map((c) => ({ kind: 'chapter' as const, id: c.id, title: c.title, deletedAt: c.deletedAt })),
  ].sort((a, b) => b.deletedAt - a.deletedAt),
);

watch(
  () => props.show,
  (show) => {
    if (show) void ws.reloadTrash().catch((e: unknown) => message.error(e instanceof ApiError ? e.message : '读取回收站失败'));
  },
);

async function act(fn: () => Promise<unknown>, ok: string): Promise<void> {
  try {
    await fn();
    message.success(ok);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '操作失败');
  }
}

async function purge(row: Row): Promise<void> {
  if (await confirm({ title: '彻底删除', content: `「${row.title}」将被永久删除，无法恢复。`, positiveText: '彻底删除', danger: true })) {
    await act(() => ws.purgeTrash({ kind: row.kind, id: row.id }), '已彻底删除');
  }
}

async function emptyAll(): Promise<void> {
  if (await confirm({ title: '清空回收站', content: '回收站中的全部分卷和章节将被永久删除，无法恢复。', positiveText: '清空', danger: true })) {
    await act(() => ws.purgeTrash({ all: true }), '回收站已清空');
  }
}
</script>

<template>
  <NDrawer :show="show" :width="400" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent title="回收站" closable>
      <NEmpty v-if="rows.length === 0" description="回收站是空的" />
      <NList v-else hoverable>
        <NListItem v-for="row in rows" :key="`${row.kind}:${row.id}`" data-testid="trash-item">
          <NThing :description="`删除于 ${formatTime(row.deletedAt)}`">
            <template #header>
              <NTag size="small" :bordered="false" :type="row.kind === 'volume' ? 'info' : 'default'">{{ row.kind === 'volume' ? '分卷' : '章节' }}</NTag>
              <span class="title">{{ row.title }}</span>
            </template>
          </NThing>
          <template #suffix>
            <NSpace :wrap="false">
              <NButton
                size="small"
                type="primary"
                secondary
                data-testid="trash-restore"
                @click="act(() => ws.restoreTrash({ kind: row.kind, id: row.id }), '已恢复')"
              >
                恢复
              </NButton>
              <NButton size="small" type="error" quaternary @click="purge(row)">彻底删除</NButton>
            </NSpace>
          </template>
        </NListItem>
      </NList>
      <template #footer>
        <NButton type="error" quaternary :disabled="rows.length === 0" @click="emptyAll">清空回收站</NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.title {
  margin-left: 8px;
}
</style>
