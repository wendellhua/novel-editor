<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent, NEmpty, NList, NListItem, NSpace, NThing, useMessage } from 'naive-ui';
import { watch } from 'vue';
import { ApiError } from '../api/client';
import { usePrompt } from '../composables/usePrompt';
import { useLibraryStore } from '../stores/library';
import { formatTime } from '../utils/format';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const library = useLibraryStore();
const message = useMessage();
const { confirm } = usePrompt();

watch(
  () => props.show,
  (show) => {
    if (show) void library.refreshTrash().catch((e: unknown) => message.error(e instanceof ApiError ? e.message : '读取回收站失败'));
  },
);

async function restore(file: string): Promise<void> {
  try {
    await library.restore(file);
    message.success('已恢复');
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '恢复失败');
  }
}

async function purge(file: string, title: string): Promise<void> {
  const ok = await confirm({ title: '彻底删除', content: `「${title}」将被永久删除，无法恢复。确定吗？`, positiveText: '彻底删除', danger: true });
  if (!ok) return;
  try {
    await library.purge(file);
    message.success('已彻底删除');
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '删除失败');
  }
}
</script>

<template>
  <NDrawer :show="show" :width="420" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent title="作品回收站" closable>
      <NEmpty v-if="library.trashed.length === 0" description="回收站是空的" />
      <NList v-else hoverable>
        <NListItem v-for="item in library.trashed" :key="item.file" data-testid="trashed-work">
          <NThing :title="item.title" :description="`删除于 ${formatTime(item.deletedAt)}`" />
          <template #suffix>
            <NSpace :wrap="false">
              <NButton size="small" type="primary" secondary @click="restore(item.file)">恢复</NButton>
              <NButton size="small" type="error" quaternary @click="purge(item.file, item.title)">彻底删除</NButton>
            </NSpace>
          </template>
        </NListItem>
      </NList>
    </NDrawerContent>
  </NDrawer>
</template>
