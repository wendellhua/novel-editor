<script setup lang="ts">
import {
  NConfigProvider,
  NDialogProvider,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NMenu,
  NMessageProvider,
  NResult,
  NSpin,
  NTag,
  NTooltip,
  darkTheme,
  dateZhCN,
  useOsTheme,
  zhCN,
  type MenuOption,
} from 'naive-ui';
import { computed, onMounted } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { useSystemStore } from './stores/system';

const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === 'dark' ? darkTheme : null));

const system = useSystemStore();
onMounted(() => {
  void system.load();
  system.connect();
});

const route = useRoute();
const router = useRouter();
const menuOptions: MenuOption[] = [
  { label: '作品库', key: 'library' },
  { label: '设置', key: 'settings' },
];
const activeKey = computed(() => (route.name === 'settings' ? 'settings' : 'library'));
const fullBleed = computed(() => route.meta.fullBleed === true);
function navigate(key: string): void {
  void router.push({ name: key });
}

/** 页面与本机 NovelEditor 服务的连接（SSE），与大模型是否可用无关——模型状态在「设置 → 模型」中显示。 */
const connectionTag = computed(() => {
  switch (system.connection) {
    case 'open':
      return { type: 'success' as const, text: '本地服务已连接' };
    case 'connecting':
      return { type: 'warning' as const, text: '正在连接本地服务' };
    default:
      return { type: 'error' as const, text: '本地服务未连接' };
  }
});
</script>

<template>
  <NConfigProvider class="app-root" :theme="theme" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <NDialogProvider>
        <NLayout class="app-shell">
          <NLayoutHeader bordered class="app-header">
            <span class="brand">NovelEditor</span>
            <NMenu
              v-if="system.status === 'ready'"
              mode="horizontal"
              :value="activeKey"
              :options="menuOptions"
              @update:value="navigate"
            />
            <span class="spacer" />
            <NTooltip v-if="system.status === 'ready'" placement="bottom-end">
              <template #trigger>
                <NTag :type="connectionTag.type" size="small" round data-testid="service-connection">{{ connectionTag.text }}</NTag>
              </template>
              页面与本机 NovelEditor 服务的连接状态，不代表大模型是否可用。<br />模型是否可用见「设置 → 模型」。
            </NTooltip>
          </NLayoutHeader>
          <NLayoutContent class="app-content" :class="{ 'full-bleed': fullBleed }">
            <div v-if="system.status === 'loading'" class="center"><NSpin size="large" /></div>
            <NResult
              v-else-if="system.status === 'unauthorized'"
              status="403"
              title="会话已失效"
              description="出于安全考虑，请重新双击 NovelEditor 程序打开页面。"
            />
            <NResult
              v-else-if="system.status === 'offline'"
              status="error"
              title="无法连接到本地服务"
              description="NovelEditor 程序可能已经退出。请重新双击程序启动。"
            />
            <NResult
              v-else-if="system.status === 'stopped'"
              status="success"
              title="程序已退出"
              description="所有内容都已保存，可以关闭此页面。"
            />
            <RouterView v-else />
          </NLayoutContent>
        </NLayout>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
.app-root,
.app-shell {
  height: 100%;
}
.app-shell :deep(> .n-layout-scroll-container) {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.app-header {
  flex: none;
}
.app-header {
  display: flex;
  align-items: center;
  gap: 24px;
  height: 56px;
  padding: 0 20px;
}
.brand {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.spacer {
  flex: 1;
}
.app-content {
  padding: 24px;
  flex: 1;
  min-height: 0;
}
.app-content.full-bleed {
  padding: 0;
  overflow: hidden;
  position: relative;
}
.app-content.full-bleed :deep(> .n-layout-scroll-container) {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.center {
  display: flex;
  justify-content: center;
  padding-top: 120px;
}
</style>
