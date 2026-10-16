<script setup lang="ts">
import { NDrawer, NDrawerContent, NEmpty, NSpin, NTag, NText, useMessage } from 'naive-ui';
import { ref, watch } from 'vue';
import type { SkillDetail } from '../../shared/types';
import { ApiError } from '../api/client';
import { skillsApi } from '../api/skills';
import { TASK_KIND_LABELS } from '../utils/labels';

const props = defineProps<{ show: boolean; skillId: string | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();
const message = useMessage();
const detail = ref<SkillDetail | null>(null);
const loading = ref(false);

watch(
  () => [props.show, props.skillId] as const,
  async ([show, id]) => {
    if (!show || id === null) return;
    loading.value = true;
    detail.value = null;
    try {
      detail.value = await skillsApi.detail(id);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '读取技能失败');
    } finally {
      loading.value = false;
    }
  },
);

const formatSize = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
</script>

<template>
  <NDrawer :show="show" :width="640" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent :title="detail?.name ?? '技能详情'" closable :native-scrollbar="false">
      <NSpin :show="loading">
        <div v-if="detail" class="detail" data-testid="skill-detail">
          <div class="tags">
            <NTag v-for="k in detail.appliesTo" :key="k" size="small" type="info" :bordered="false">{{ TASK_KIND_LABELS[k] }}</NTag>
            <NTag size="small" :bordered="false">v{{ detail.version }}</NTag>
          </div>
          <NText depth="3" class="desc">{{ detail.description }}</NText>
          <h4>SKILL.md 正文</h4>
          <pre class="body" data-testid="skill-body">{{ detail.body || '（无正文）' }}</pre>
          <h4>参考资料</h4>
          <NEmpty v-if="detail.references.length === 0" size="small" description="没有参考资料" />
          <ul v-else class="refs">
            <li v-for="r in detail.references" :key="r.path">
              <code>{{ r.path }}</code>
              <NText depth="3">{{ formatSize(r.size) }}</NText>
            </li>
          </ul>
          <NText depth="3" class="note">技能只作为提示词使用：正文与 references 下的 .md / .txt 会提供给模型，其他文件不会被保存或执行。</NText>
        </div>
      </NSpin>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.detail h4 {
  margin: 20px 0 8px;
}
.tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.desc {
  display: block;
  font-size: 13px;
  line-height: 1.7;
}
.body {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  padding: 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.08);
  max-height: 60vh;
  overflow: auto;
}
.refs {
  margin: 0;
  padding-left: 18px;
}
.refs li {
  display: flex;
  gap: 12px;
  font-size: 13px;
}
.note {
  display: block;
  margin-top: 20px;
  font-size: 12px;
}
</style>
