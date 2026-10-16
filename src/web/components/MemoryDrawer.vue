<script setup lang="ts">
import { NAlert, NButton, NCollapse, NCollapseItem, NDrawer, NDrawerContent, NEmpty, NPopconfirm, NProgress, NSpace, NSpin, NTag, NText, useMessage } from 'naive-ui';
import { computed, watch } from 'vue';
import { ApiError } from '../api/client';
import { useJobsStore } from '../stores/jobs';
import { useMemoryStore } from '../stores/memory';
import { formatTime, formatTokens, formatWords } from '../utils/format';
import { JOB_STATUS_LABELS } from '../utils/labels';

/**
 * 剧情记忆（ADR-011）：查阅当前的全书状态（主线、人物、未解决的冲突与伏笔、情绪走势）与每次增量更新的记录；
 * 满 3000 字自动更新，也可以立即更新或重建。
 */
const props = defineProps<{ show: boolean; workId: string }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();

const memory = useMemoryStore();
const jobs = useJobsStore();
const message = useMessage();
const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);

watch(
  () => props.show,
  (show) => {
    if (show) void memory.refresh().catch((err: unknown) => message.error(errorText(err, '读取剧情记忆失败')));
  },
);

const m = computed(() => memory.data);
/** 最近的剧情记忆任务：优先用任务列表中实时推送的状态。 */
const job = computed(() => {
  const j = m.value?.job ?? null;
  return j === null ? null : (jobs.jobs.find((x) => x.id === j.id) ?? j);
});
const active = computed(() => job.value !== null && (job.value.status === 'queued' || job.value.status === 'running'));
const tooMuch = computed(() => m.value !== null && m.value.pendingChars > m.value.autoMaxChars);
const progress = computed(() => {
  const j = job.value;
  return j === null || j.totalUnits === 0 ? 0 : Math.round(((j.doneUnits + j.failedUnits) / j.totalUnits) * 100);
});
const untilNext = computed(() => (m.value === null ? 0 : Math.max(0, m.value.thresholdChars - m.value.pendingChars)));

async function update(): Promise<void> {
  try {
    await memory.update();
    message.success('已开始更新剧情记忆');
  } catch (err) {
    message.error(errorText(err, '更新失败'));
  }
}

async function rebuild(): Promise<void> {
  try {
    await memory.rebuild();
    message.success('已开始重建剧情记忆');
  } catch (err) {
    message.error(errorText(err, '重建失败'));
  }
}

async function resume(): Promise<void> {
  const j = job.value;
  if (j === null) return;
  try {
    await jobs.control(j.id, 'resume');
    await memory.refresh();
  } catch (err) {
    message.error(errorText(err, '重试失败'));
  }
}
</script>

<template>
  <NDrawer :show="show" :width="560" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent closable :native-scrollbar="false" data-testid="memory-drawer">
      <template #header>
        <span>剧情记忆</span>
        <NText v-if="m?.updatedAt" depth="3" class="sub">最近更新 {{ formatTime(m.updatedAt) }}</NText>
      </template>
      <NSpin v-if="m === null" class="spin" />
      <template v-else>
        <div class="status" data-testid="memory-status">
          <div>
            已纳入 {{ formatWords(m.coveredChars) }} · 待纳入 <strong data-testid="memory-pending">{{ formatWords(m.pendingChars) }}</strong>
          </div>
          <NText depth="3" class="hint">
            <template v-if="!m.hasModel">尚未选择模型，不会自动更新。请在「设置 → 模型 → 默认模型」中为剧情记忆（或编辑审稿）选择模型。</template>
            <template v-else-if="tooMuch">待纳入的正文较多（超过 {{ formatWords(m.autoMaxChars) }}），不会自动开始；点「立即更新」开始，约需 {{ formatTokens(m.pendingChars) }} token 以上。</template>
            <template v-else-if="m.pendingChars > 0 && untilNext > 0">再写约 {{ untilNext }} 字自动更新；只会把新写的内容发给模型，已纳入的不会重复发送。</template>
            <template v-else>每新写满 {{ m.thresholdChars }} 字自动更新一次，只发送新写的内容。</template>
          </NText>
          <div v-if="job && job.status !== 'done' && job.status !== 'cancelled'" class="job" data-testid="memory-job" :data-status="job.status">
            <NTag size="small" :type="JOB_STATUS_LABELS[job.status].type" :bordered="false">{{ JOB_STATUS_LABELS[job.status].text }}</NTag>
            <NProgress type="line" :percentage="progress" :processing="job.status === 'running'" :show-indicator="false" :height="6" class="bar" />
            <NButton v-if="job.status === 'failed' || job.status === 'paused'" size="tiny" type="primary" data-testid="memory-resume" @click="resume">
              {{ job.status === 'failed' ? '重试' : '继续' }}
            </NButton>
          </div>
          <NText v-if="job?.status === 'failed' && job.error" type="error" class="hint">{{ job.error }}</NText>
          <NSpace size="small" class="actions">
            <NButton size="small" type="primary" secondary :disabled="m.pendingChars === 0 || active" data-testid="memory-update" @click="update">立即更新</NButton>
            <NPopconfirm positive-text="重建" negative-text="取消" @positive-click="rebuild">
              <template #trigger>
                <NButton size="small" quaternary :disabled="m.coveredChars + m.pendingChars === 0" data-testid="memory-rebuild">重建</NButton>
              </template>
              <div class="confirm">
                清空现有的剧情记忆，按当前正文从头重新建立（约 {{ formatWords(m.coveredChars + m.pendingChars) }}，会重新消耗 token）。正文改动很大时使用。
              </div>
            </NPopconfirm>
          </NSpace>
        </div>

        <NEmpty v-if="m.state === null" description="还没有剧情记忆：写满 3000 字后自动建立" class="empty" />
        <template v-else>
          <section class="block" data-testid="memory-state">
            <h4>主线进展</h4>
            <p class="para">{{ m.state.mainline || '（暂无）' }}</p>
            <h4>人物现状</h4>
            <ul v-if="m.state.characters.length > 0" class="list">
              <li v-for="c in m.state.characters" :key="c.name"><strong>{{ c.name }}</strong>：{{ c.status }}</li>
            </ul>
            <p v-else class="para">（暂无）</p>
            <h4>未解决的冲突与伏笔</h4>
            <ul v-if="m.state.threads.length > 0" class="list">
              <li v-for="(t, i) in m.state.threads" :key="i">{{ t }}</li>
            </ul>
            <p v-else class="para">（暂无）</p>
            <h4>情绪走势</h4>
            <p class="para">{{ m.state.emotion || '（暂无）' }}</p>
          </section>

          <h4 class="timeline-title">更新记录（{{ m.entries.length }} 次）</h4>
          <NCollapse :default-expanded-names="m.entries.slice(0, 1).map((e) => e.id)">
            <NCollapseItem v-for="e in m.entries" :key="e.id" :name="e.id" data-testid="memory-entry">
              <template #header>
                <span class="entry-head">{{ e.label }} · {{ formatWords(e.chars) }}</span>
              </template>
              <template #header-extra>
                <NText depth="3" class="hint">{{ formatTime(e.createdAt) }}</NText>
              </template>
              <ul v-if="e.events.length > 0" class="list">
                <li v-for="(ev, i) in e.events" :key="i">{{ ev }}</li>
              </ul>
              <NText v-else depth="3" class="hint">这段正文没有记录到关键事件</NText>
            </NCollapseItem>
          </NCollapse>
        </template>
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
.spin,
.empty {
  margin-top: 40px;
  display: flex;
  justify-content: center;
}
.status {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.07);
  font-size: 13px;
  line-height: 1.7;
}
.hint {
  display: block;
  font-size: 12px;
}
.job {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.bar {
  flex: 1;
}
.actions {
  margin-top: 8px;
}
.confirm {
  max-width: 280px;
}
.block h4,
.timeline-title {
  margin: 16px 0 4px;
  font-size: 14px;
}
.para {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
}
.list {
  margin: 2px 0;
  padding-left: 1.4em;
  font-size: 13px;
  line-height: 1.8;
}
.entry-head {
  font-size: 13px;
}
</style>
