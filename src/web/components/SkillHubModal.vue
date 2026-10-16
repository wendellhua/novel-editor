<script setup lang="ts">
import { NAlert, NButton, NEmpty, NInput, NInputGroup, NModal, NSpin, NTag, NText, useMessage } from 'naive-ui';
import { computed, ref } from 'vue';
import type { HubSkill, HubSkillDetail, SkillInfo } from '../../shared/types';
import { ApiError } from '../api/client';
import { skillsApi } from '../api/skills';

const props = defineProps<{ show: boolean; installed: SkillInfo[] }>();
const emit = defineEmits<{ 'update:show': [boolean]; install: [HubSkill] }>();
const message = useMessage();

const query = ref('小说');
const results = ref<HubSkill[]>([]);
const searching = ref(false);
const searched = ref(false);
const error = ref<string | null>(null);
const selected = ref<HubSkill | null>(null);
const detail = ref<HubSkillDetail | null>(null);
const loadingDetail = ref(false);
const installing = ref<string | null>(null);

const keyOf = (s: { namespace: string; slug: string }): string => `${s.namespace}/${s.slug}`;
const installedKeys = computed(() => new Set(props.installed.filter((s) => s.source === 'skillhub').map((s) => s.id.slice('hub:'.length))));

async function search(): Promise<void> {
  const q = query.value.trim();
  if (q === '') return;
  searching.value = true;
  error.value = null;
  selected.value = null;
  detail.value = null;
  try {
    results.value = await skillsApi.hubSearch(q, 20);
  } catch (err) {
    results.value = [];
    error.value = err instanceof ApiError ? err.message : '搜索失败';
  } finally {
    searching.value = false;
    searched.value = true;
  }
}

async function select(s: HubSkill): Promise<void> {
  selected.value = s;
  detail.value = null;
  loadingDetail.value = true;
  try {
    detail.value = await skillsApi.hubDetail(s.namespace, s.slug);
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '读取详情失败');
  } finally {
    loadingDetail.value = false;
  }
}

function install(s: HubSkill): void {
  installing.value = keyOf(s);
  emit('install', s);
}

/** 由父组件在安装结束（成功或失败）后调用。 */
function done(): void {
  installing.value = null;
}
defineExpose({ done });

function statusType(status: string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'benign') return 'success';
  if (status === 'malicious') return 'error';
  if (status === '') return 'default';
  return 'warning';
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="从 SkillHub 安装技能"
    style="width: 860px"
    data-testid="hub-modal"
    @update:show="emit('update:show', $event)"
    @after-enter="!searched && search()"
  >
    <NInputGroup>
      <NInput v-model:value="query" placeholder="搜索技能，例如：小说、审稿、网文" data-testid="hub-query" @keydown.enter="search" />
      <NButton type="primary" :loading="searching" data-testid="hub-search" @click="search">搜索</NButton>
    </NInputGroup>
    <NAlert v-if="error" type="error" class="gap" :show-icon="true">{{ error }}（SkillHub 暂时不可用不影响写作与本地导入）</NAlert>
    <div class="layout">
      <NSpin :show="searching" class="list">
        <NEmpty v-if="searched && results.length === 0 && !error" description="没有找到相关技能" class="gap" />
        <div
          v-for="s in results"
          :key="keyOf(s)"
          class="item"
          :class="{ active: selected && keyOf(selected) === keyOf(s) }"
          data-testid="hub-item"
          @click="select(s)"
        >
          <div class="item-title">
            <span class="name">{{ s.name }}</span>
            <NTag v-if="installedKeys.has(keyOf(s))" size="tiny" type="success" :bordered="false">已安装</NTag>
          </div>
          <NText depth="3" class="summary">{{ s.summary }}</NText>
        </div>
      </NSpin>
      <div class="side">
        <NEmpty v-if="!selected" description="选择左侧的技能查看详情与安全报告" />
        <NSpin v-else :show="loadingDetail">
          <div class="detail" data-testid="hub-detail">
            <h3>{{ detail?.name ?? selected.name }}</h3>
            <NText depth="3" class="coord">@{{ selected.namespace }}/{{ selected.slug }} · v{{ detail?.version || selected.version || '—' }}</NText>
            <p class="desc">{{ detail?.summary ?? selected.summary }}</p>
            <h4>安全报告</h4>
            <NText v-if="detail && detail.securityReports.length === 0" depth="3">暂无安全报告</NText>
            <div v-for="r in detail?.securityReports ?? []" :key="r.provider" class="report">
              <span>{{ r.provider }}</span>
              <NTag size="small" :type="statusType(r.status)" :bordered="false">{{ r.statusText || r.status || '未知' }}</NTag>
              <a :href="r.reportUrl" target="_blank" rel="noopener noreferrer">查看报告</a>
            </div>
            <NText depth="3" class="note">技能只作为提示词使用，只保存其中的 .md / .txt 文件，任何脚本都不会被执行。</NText>
            <NButton
              type="primary"
              block
              class="install"
              :loading="installing === keyOf(selected)"
              :disabled="installing !== null"
              data-testid="hub-install"
              @click="install(selected)"
            >
              {{ installedKeys.has(keyOf(selected)) ? '重新安装（更新）' : '安装' }}
            </NButton>
          </div>
        </NSpin>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.gap {
  margin-top: 12px;
}
.layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 12px;
  height: 460px;
}
.list {
  overflow: auto;
  border-right: 1px solid rgba(128, 128, 128, 0.15);
  padding-right: 8px;
}
.item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.item:hover {
  background: rgba(128, 128, 128, 0.08);
}
.item.active {
  background: rgba(24, 160, 88, 0.1);
}
.item-title {
  display: flex;
  gap: 8px;
  align-items: center;
}
.name {
  font-weight: 600;
}
.summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  margin-top: 4px;
}
.side {
  overflow: auto;
}
.detail h3 {
  margin: 0 0 4px;
}
.coord {
  font-size: 12px;
}
.desc {
  font-size: 13px;
  line-height: 1.7;
  max-height: 160px;
  overflow: auto;
}
.report {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  margin-bottom: 6px;
}
.note {
  display: block;
  font-size: 12px;
  margin-top: 16px;
}
.install {
  margin-top: 12px;
}
</style>
