<script setup lang="ts">
import { NButton, NCard, NDropdown, NEmpty, NGrid, NGridItem, NSpace, NSpin, NText, useMessage, type DropdownOption } from 'naive-ui';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { CreateWorkRequest, Work, WorkSummary } from '../../shared/types';
import { ApiError } from '../api/client';
import { worksApi } from '../api/works';
import WorkFormModal from '../components/WorkFormModal.vue';
import WorkTrashDrawer from '../components/WorkTrashDrawer.vue';
import { usePrompt } from '../composables/usePrompt';
import { useLibraryStore } from '../stores/library';
import { formatTime, formatWords } from '../utils/format';

const library = useLibraryStore();
const router = useRouter();
const message = useMessage();
const { confirm } = usePrompt();

const formOpen = ref(false);
const editing = ref<Work | null>(null);
const submitting = ref(false);
const trashOpen = ref(false);

const errorText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : fallback);

onMounted(() => {
  void library.refresh().catch((e: unknown) => message.error(errorText(e, '读取作品列表失败')));
});

function openCreate(): void {
  editing.value = null;
  formOpen.value = true;
}

async function submit(req: CreateWorkRequest): Promise<void> {
  submitting.value = true;
  try {
    if (editing.value === null) {
      const work = await library.create(req);
      formOpen.value = false;
      void router.push({ name: 'workspace', params: { workId: work.id } });
    } else {
      await library.update(editing.value.id, req);
      formOpen.value = false;
      message.success('已保存');
    }
  } catch (e) {
    message.error(errorText(e, '保存失败'));
  } finally {
    submitting.value = false;
  }
}

const cardMenu: DropdownOption[] = [
  { label: '编辑信息', key: 'edit' },
  { label: '导出 TXT', key: 'txt' },
  { label: '导出 Markdown', key: 'md' },
  { type: 'divider', key: 'd' },
  { label: '删除', key: 'delete' },
];

async function onCardMenu(key: string, w: WorkSummary): Promise<void> {
  if (key === 'edit') {
    try {
      editing.value = (await worksApi.tree(w.id)).work;
      formOpen.value = true;
    } catch (e) {
      message.error(errorText(e, '读取作品失败'));
    }
  } else if (key === 'txt' || key === 'md') {
    window.location.href = worksApi.exportUrl(w.id, key);
  } else if (key === 'delete') {
    const ok = await confirm({
      title: '删除作品',
      content: `「${w.title}」会移到作品回收站，随时可以恢复。`,
      positiveText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await library.remove(w.id);
      message.success('已移到回收站');
    } catch (e) {
      message.error(errorText(e, '删除失败'));
    }
  }
}
</script>

<template>
  <section class="library">
    <header class="library-head">
      <h2>我的作品</h2>
      <NSpace>
        <NButton quaternary data-testid="open-work-trash" @click="trashOpen = true">作品回收站</NButton>
        <NButton type="primary" data-testid="new-work" @click="openCreate">新建作品</NButton>
      </NSpace>
    </header>

    <div v-if="library.loading && library.works.length === 0" class="empty"><NSpin /></div>
    <NEmpty v-else-if="library.works.length === 0" description="还没有作品" class="empty">
      <template #extra>
        <NButton type="primary" @click="openCreate">新建作品</NButton>
      </template>
    </NEmpty>
    <NGrid v-else cols="1 640:2 960:3 1280:4" :x-gap="16" :y-gap="16" responsive="self">
      <NGridItem v-for="w in library.works" :key="w.id">
        <NCard hoverable class="work-card" data-testid="work-card" @click="router.push({ name: 'workspace', params: { workId: w.id } })">
          <template #header>
            <span class="work-title">{{ w.title }}</span>
          </template>
          <template #header-extra>
            <NDropdown trigger="click" :options="cardMenu" @select="(k: string) => onCardMenu(k, w)">
              <NButton quaternary circle size="small" data-testid="work-menu" @click.stop>⋯</NButton>
            </NDropdown>
          </template>
          <NText depth="3">{{ w.author || '未署名' }}</NText>
          <template #footer>
            <div class="work-meta">
              <span>{{ formatWords(w.wordCount) }} · {{ w.chapterCount }} 章</span>
              <span>{{ formatTime(w.updatedAt) }}</span>
            </div>
          </template>
        </NCard>
      </NGridItem>
    </NGrid>

    <WorkFormModal v-model:show="formOpen" :work="editing" :submitting="submitting" @submit="submit" />
    <WorkTrashDrawer v-model:show="trashOpen" />
  </section>
</template>

<style scoped>
.library {
  max-width: 1280px;
  margin: 0 auto;
}
.library-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.library-head h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.empty {
  padding: 80px 0;
}
.work-card {
  cursor: pointer;
}
.work-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.work-meta {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  opacity: 0.7;
}
</style>
