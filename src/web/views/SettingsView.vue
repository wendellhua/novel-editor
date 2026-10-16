<script setup lang="ts">
import { NButton, NCard, NDescriptions, NDescriptionsItem, NPopconfirm, NTabPane, NTabs, useMessage } from 'naive-ui';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import LlmSettings from '../components/LlmSettings.vue';
import SkillSettings from '../components/SkillSettings.vue';
import { useSystemStore } from '../stores/system';

const system = useSystemStore();
const message = useMessage();
const stopping = ref(false);

const TABS = ['models', 'skills', 'about'] as const;
type Tab = (typeof TABS)[number];
const route = useRoute();
const router = useRouter();
const tab = computed<Tab>(() => {
  const q = route.query.tab;
  return TABS.includes(q as Tab) ? (q as Tab) : 'models';
});
function switchTab(value: Tab): void {
  void router.replace({ query: { ...route.query, tab: value } });
}

async function shutdown(): Promise<void> {
  stopping.value = true;
  try {
    await system.shutdown();
  } catch (err) {
    message.error(err instanceof ApiError ? err.message : '退出失败');
    stopping.value = false;
  }
}
</script>

<template>
  <div class="settings">
    <NTabs :value="tab" type="line" animated @update:value="switchTab">
      <NTabPane name="models" tab="模型">
        <LlmSettings />
      </NTabPane>
      <NTabPane name="skills" tab="技能">
        <SkillSettings />
      </NTabPane>
      <NTabPane name="about" tab="关于">
        <div class="stack">
          <NCard title="关于">
            <NDescriptions :column="1" label-placement="left">
              <NDescriptionsItem label="版本">{{ system.info?.appVersion }}</NDescriptionsItem>
              <NDescriptionsItem label="数据目录">{{ system.info?.dataDir }}</NDescriptionsItem>
              <NDescriptionsItem label="运行环境">{{ system.info?.platform }} · Node {{ system.info?.nodeVersion }}</NDescriptionsItem>
            </NDescriptions>
          </NCard>
          <NCard title="程序">
            <NPopconfirm positive-text="退出" negative-text="取消" @positive-click="shutdown">
              <template #trigger>
                <NButton type="error" secondary :loading="stopping">退出程序</NButton>
              </template>
              确定退出 NovelEditor 吗？
            </NPopconfirm>
          </NCard>
        </div>
      </NTabPane>
    </NTabs>
  </div>
</template>

<style scoped>
.settings {
  max-width: 880px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
