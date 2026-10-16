<script setup lang="ts">
import { NBadge, NButton, NDropdown, type DropdownOption } from 'naive-ui';
import { computed } from 'vue';
import { AUTO_JOB_TYPES } from '../../shared/constants';
import { worksApi } from '../api/works';
import { useJobsStore } from '../stores/jobs';

/** 作品级操作（编辑器顶栏右侧）：AI 检查（运行中任务数徽标）、回收站、导出。 */
const props = defineProps<{ workId: string }>();
const emit = defineEmits<{ check: []; trash: [] }>();
const jobs = useJobsStore();
/** 「AI 检查」上的数字只算作者发起的任务（剧情记忆在后台自动更新，入口在左侧「剧情记忆」）。 */
const running = computed(() => jobs.active.filter((j) => !AUTO_JOB_TYPES.includes(j.type)).length);

const exportOptions: DropdownOption[] = [
  { label: '导出 TXT', key: 'txt' },
  { label: '导出 Markdown', key: 'md' },
];
function exportWork(format: 'txt' | 'md'): void {
  window.location.href = worksApi.exportUrl(props.workId, format);
}
</script>

<template>
  <div class="work-actions" data-testid="work-actions">
    <NBadge :value="running" :show="running > 0" processing>
      <NButton size="small" type="primary" secondary data-testid="check-open" @click="emit('check')">AI 检查</NButton>
    </NBadge>
    <NButton size="small" quaternary data-testid="open-trash" @click="emit('trash')">回收站</NButton>
    <NDropdown :options="exportOptions" @select="exportWork">
      <NButton size="small" quaternary data-testid="export-open">导出</NButton>
    </NDropdown>
  </div>
</template>

<style scoped>
.work-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
</style>
