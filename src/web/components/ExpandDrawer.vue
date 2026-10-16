<script setup lang="ts">
import { NAlert, NButton, NDrawer, NDrawerContent, NEmpty, NSpace, NSpin, NTag, NText, useDialog, useMessage } from 'naive-ui';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { countWords } from '../../shared/text';
import type { Expansion } from '../../shared/types';
import { ApiError } from '../api/client';
import { jobsApi } from '../api/jobs';
import { worksApi } from '../api/works';
import { useIssuesStore } from '../stores/issues';
import { useJobsStore } from '../stores/jobs';
import { useWorkspaceStore } from '../stores/workspace';
import { formatTime } from '../utils/format';

/**
 * 智能扩写的结果（F7）：只读预览续写的正文；作者确认后「插入到章末」（存「扩写前」版本，可在编辑器中撤销），
 * 也可以复制或重新扩写。插入后不能重复插入。
 */
const props = defineProps<{ show: boolean; workId: string; jobId: string | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();

const jobs = useJobsStore();
const issues = useIssuesStore();
const ws = useWorkspaceStore();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const expansion = ref<Expansion | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

const job = computed(() => jobs.jobs.find((j) => j.id === props.jobId) ?? null);
const where = computed(() => {
  const id = expansion.value?.chapterId ?? (job.value?.scope.kind === 'chapter' ? job.value.scope.id : null);
  const c = id === null ? null : ws.locate(id);
  return c === null ? '' : `${c.volume.title} · ${c.chapter.title}`;
});
const words = computed(() => countWords(expansion.value?.text ?? ''));

async function load(): Promise<void> {
  const id = props.jobId;
  if (id === null) return;
  loading.value = true;
  error.value = null;
  try {
    const e = await jobsApi.expansion(props.workId, id);
    if (props.jobId === id) expansion.value = e;
  } catch (err) {
    expansion.value = null;
    error.value = err instanceof ApiError && err.status === 404 ? null : err instanceof ApiError ? err.message : '读取扩写结果失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.show, props.jobId] as const,
  ([show]) => {
    if (!show) return;
    expansion.value = null;
    void load();
  },
  { immediate: true },
);
watch(
  () => job.value?.status,
  (s, prev) => {
    if (props.show && s === 'done' && prev !== undefined && prev !== 'done') void load();
  },
);

const confirmStale = (): Promise<boolean> =>
  new Promise((resolve) => {
    dialog.warning({
      title: '本章在扩写之后有改动',
      content: '续写是按扩写时的正文写的，现在插入到章末可能衔接不上。仍然插入吗？',
      positiveText: '仍然插入',
      negativeText: '取消',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    });
  });

async function apply(force = false): Promise<void> {
  const e = expansion.value;
  if (e === null || props.jobId === null) return;
  busy.value = true;
  try {
    const out = await issues.serverEdit(e.chapterId, () => jobsApi.applyExpansion(props.workId, e.jobId, force));
    if (out.blocked) {
      message.error('当前章节还有没保存成功的内容，请先处理保存问题再插入');
      return;
    }
    const fresh = await worksApi.getChapter(props.workId, e.chapterId);
    ws.patchChapter(e.chapterId, { wordCount: fresh.wordCount, updatedAt: fresh.updatedAt });
    message.success('已插入到章末，可在编辑器中撤销；插入前的内容已存为历史版本「AI 扩写前」');
    await load();
    // 扩写所在的章节没有打开时跳过去，让作者看到插入的内容
    if (router.currentRoute.value.params.chapterId !== e.chapterId) {
      void router.push({ name: 'workspace', params: { workId: props.workId, chapterId: e.chapterId } });
    }
  } catch (err) {
    if (err instanceof ApiError && err.details.stale === true && !force) {
      busy.value = false;
      if (await confirmStale()) await apply(true);
      return;
    }
    message.error(err instanceof ApiError ? err.message : '插入失败');
  } finally {
    busy.value = false;
  }
}

async function copy(): Promise<void> {
  const text = expansion.value?.text ?? '';
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch {
    message.error('复制失败：浏览器不允许访问剪贴板');
  }
}

/** 用同样的章节、篇幅、技能和模型再扩写一次（新任务，完成后重新打开这里）。 */
async function again(): Promise<void> {
  const j = job.value;
  if (j === null) return;
  busy.value = true;
  try {
    await jobs.create({ type: 'expand', scope: j.scope, skillId: j.skillId, profileId: j.profileId, options: j.options });
    message.success('已重新开始扩写，完成后会打开新的结果');
    emit('update:show', false);
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '重新扩写失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <NDrawer :show="show" :width="620" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent closable :native-scrollbar="false" data-testid="expand-drawer">
      <template #header>
        <span>智能扩写</span>
        <NText v-if="job" depth="3" class="sub">
          {{ formatTime(job.createdAt) }}<template v-if="where"> · {{ where }}</template><template v-if="job.options.targetChars"> · 目标约 {{ job.options.targetChars }} 字</template>
        </NText>
      </template>
      <NAlert v-if="job && job.status !== 'done' && job.status !== 'failed'" type="info" class="gap" :show-icon="false">正在续写，完成后自动显示。</NAlert>
      <NAlert v-if="job?.status === 'failed'" type="error" class="gap" :show-icon="false">扩写失败：{{ job.error }}</NAlert>
      <NAlert v-if="error" type="error" class="gap" :show-icon="false">{{ error }}</NAlert>
      <NSpin v-if="loading && expansion === null" class="spin" />
      <template v-else-if="expansion">
        <NAlert v-if="expansion.status === 'ready' && expansion.stale" type="warning" class="gap" :show-icon="false" data-testid="expansion-stale">
          本章在扩写之后有改动，插入时会再次确认。
        </NAlert>
        <div class="meta">
          <NTag v-if="expansion.status === 'applied'" size="small" type="success" :bordered="false" data-testid="expansion-applied">已插入到章末</NTag>
          <NText depth="3">{{ words }} 字 · 只根据前文续写，插入前请通读一遍</NText>
        </div>
        <div class="text" data-testid="expansion-text">{{ expansion.text }}</div>
      </template>
      <NEmpty v-else-if="!loading && job?.status === 'done'" description="这次扩写没有结果" class="empty" />
      <template #footer>
        <NSpace>
          <NButton
            type="primary"
            :disabled="expansion === null || expansion.status !== 'ready'"
            :loading="busy"
            data-testid="expansion-apply"
            @click="apply()"
          >
            插入到章末
          </NButton>
          <NButton :disabled="expansion === null" data-testid="expansion-copy" @click="copy">复制</NButton>
          <NButton quaternary :disabled="job === null || busy" data-testid="expansion-again" @click="again">重新扩写</NButton>
        </NSpace>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.sub {
  margin-left: 10px;
  font-size: 12px;
  font-weight: normal;
}
.gap {
  margin-bottom: 12px;
}
.spin,
.empty {
  margin-top: 48px;
  display: flex;
  justify-content: center;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12px;
}
.text {
  white-space: pre-wrap;
  font-size: 15px;
  line-height: 1.9;
  padding: 12px 16px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.06);
}
</style>
