<script setup lang="ts">
import { NButton, NDrawer, NDrawerContent, NEmpty, NList, NListItem, NSpace, NTag, NThing, useMessage } from 'naive-ui';
import { ref, watch } from 'vue';
import type { RevisionDetail, RevisionMeta, RevisionReason } from '../../shared/types';
import { ApiError } from '../api/client';
import { worksApi } from '../api/works';
import { usePrompt } from '../composables/usePrompt';
import { formatTime, formatWords } from '../utils/format';

const props = defineProps<{ show: boolean; workId: string; chapterId: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; restore: [number]; snapshot: [] }>();
const message = useMessage();
const { confirm } = usePrompt();

const list = ref<RevisionMeta[]>([]);
const preview = ref<RevisionDetail | null>(null);

const REASON: Record<RevisionReason, { label: string; type: 'default' | 'info' | 'warning' | 'success' }> = {
  auto: { label: '自动', type: 'default' },
  manual: { label: '手动', type: 'success' },
  before_fix: { label: 'AI 修正前', type: 'warning' },
  before_restore: { label: '恢复前', type: 'info' },
  before_expand: { label: 'AI 扩写前', type: 'warning' },
};

async function reload(): Promise<void> {
  try {
    list.value = await worksApi.listRevisions(props.workId, props.chapterId);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '读取历史版本失败');
  }
}

watch(
  () => props.show,
  (show) => {
    preview.value = null;
    if (show) void reload();
  },
);

async function open(r: RevisionMeta): Promise<void> {
  try {
    preview.value = await worksApi.getRevision(props.workId, props.chapterId, r.id);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '读取版本失败');
  }
}

async function restore(): Promise<void> {
  const p = preview.value;
  if (p === null) return;
  const ok = await confirm({ title: '恢复版本', content: `用 ${formatTime(p.createdAt)} 的版本替换当前内容？当前内容会先自动存为「恢复前」版本。`, positiveText: '恢复' });
  if (ok) emit('restore', p.id);
}

defineExpose({ reload });
</script>

<template>
  <NDrawer :show="show" :width="preview ? 760 : 380" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent closable>
      <template #header>
        <NSpace align="center" size="large">
          <span>历史版本</span>
          <NButton size="small" secondary data-testid="snapshot" @click="emit('snapshot')">存为版本</NButton>
        </NSpace>
      </template>
      <div class="wrap">
        <div class="list">
          <NEmpty v-if="list.length === 0" description="还没有历史版本" />
          <NList v-else hoverable clickable>
            <NListItem v-for="r in list" :key="r.id" :class="{ active: preview?.id === r.id }" data-testid="revision-item" @click="open(r)">
              <NThing :title="formatTime(r.createdAt)" :description="`第 ${r.rev} 版 · ${formatWords(r.wordCount)}`">
                <template #header-extra>
                  <NTag size="small" :bordered="false" :type="REASON[r.reason].type">{{ REASON[r.reason].label }}</NTag>
                </template>
              </NThing>
            </NListItem>
          </NList>
        </div>
        <div v-if="preview" class="preview">
          <NSpace justify="space-between" align="center" class="preview-head">
            <strong>{{ preview.title }}</strong>
            <NButton size="small" type="primary" data-testid="revision-restore" @click="restore">恢复此版本</NButton>
          </NSpace>
          <pre data-testid="revision-preview">{{ preview.body }}</pre>
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.wrap {
  display: flex;
  gap: 16px;
  height: 100%;
}
.list {
  width: 330px;
  flex: none;
}
.active {
  background: rgba(24, 160, 88, 0.08);
}
.preview {
  flex: 1;
  min-width: 0;
}
.preview-head {
  margin-bottom: 8px;
}
pre {
  white-space: pre-wrap;
  font-family: inherit;
  line-height: 1.7;
  margin: 0;
}
</style>
