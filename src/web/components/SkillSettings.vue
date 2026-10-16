<script setup lang="ts">
import {
  NButton,
  NCard,
  NDropdown,
  NEmpty,
  NPopconfirm,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  NText,
  useMessage,
} from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { AUTO_JOB_TYPES, JOB_TYPES, LIMITS } from '../../shared/constants';
import type { HubSkill, ImportSkillFilesRequest, JobType, SkillInfo } from '../../shared/types';
import { ApiError } from '../api/client';
import { useSkillsStore } from '../stores/skills';
import { TASK_KIND_LABELS } from '../utils/labels';
import SkillDetailDrawer from './SkillDetailDrawer.vue';
import SkillHubModal from './SkillHubModal.vue';

const store = useSkillsStore();
const message = useMessage();
const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);

onMounted(() => {
  store.load().catch((err: unknown) => message.error(errorText(err, '读取技能列表失败')));
});

const SOURCE_LABELS = { builtin: '内置', skillhub: 'SkillHub', local: '本地导入' } as const;
// 剧情记忆由系统自动更新、固定使用内置技能，不列出
const jobTypeOptions = JOB_TYPES.filter((k) => !AUTO_JOB_TYPES.includes(k)).map((k) => ({ label: TASK_KIND_LABELS[k], value: k }));

// ---------- 详情 ----------
const detailId = ref<string | null>(null);
const showDetail = ref(false);
function openDetail(s: SkillInfo): void {
  detailId.value = s.id;
  showDetail.value = true;
}

// ---------- 修改与删除 ----------
async function toggle(s: SkillInfo, enabled: boolean): Promise<void> {
  try {
    await store.update(s.id, { enabled });
  } catch (err) {
    message.error(errorText(err, '保存失败'));
  }
}

async function setAppliesTo(s: SkillInfo, kinds: JobType[]): Promise<void> {
  if (kinds.length === 0) {
    message.warning('至少选择一种适用的检查类型');
    return;
  }
  try {
    await store.update(s.id, { appliesTo: kinds });
  } catch (err) {
    message.error(errorText(err, '保存失败'));
  }
}

async function remove(s: SkillInfo): Promise<void> {
  try {
    await store.remove(s.id);
    message.success(`已删除「${s.name}」`);
  } catch (err) {
    message.error(errorText(err, '删除失败'));
  }
}

// ---------- 本地导入 ----------
const zipInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importOptions = [
  { label: '导入 zip 压缩包', key: 'zip' },
  { label: '导入文件夹', key: 'folder' },
];

function pickImport(key: string): void {
  (key === 'zip' ? zipInput : folderInput).value?.click();
}

async function runImport(task: () => Promise<SkillInfo>): Promise<void> {
  importing.value = true;
  try {
    const info = await task();
    message.success(`已导入「${info.name}」，默认用于「编辑审稿」，可在列表中修改`);
  } catch (err) {
    message.error(errorText(err, '导入失败'));
  } finally {
    importing.value = false;
  }
}

async function onZipPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file === undefined) return;
  if (file.size > LIMITS.skillZipMaxBytes) {
    message.error(`压缩包超过 ${LIMITS.skillZipMaxBytes / 1048576} MB`);
    return;
  }
  await runImport(() => store.importZip(file));
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 文件夹导入：只上传 .md / .txt（其余文件服务端也不会保存），跳过 macOS 附带的垃圾文件。 */
async function onFolderPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const picked = [...(input.files ?? [])];
  input.value = '';
  const files = picked.filter((f) => /\.(md|txt)$/i.test(f.name) && !f.webkitRelativePath.split('/').some((s) => s.startsWith('._') || s === '__MACOSX'));
  if (files.length === 0) {
    message.error('所选文件夹中没有 .md 或 .txt 文件');
    return;
  }
  if (files.length > LIMITS.skillMaxFiles) {
    message.error(`文件数超过 ${LIMITS.skillMaxFiles} 个`);
    return;
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > LIMITS.skillUnpackedMaxBytes) {
    message.error(`文件总大小超过 ${LIMITS.skillUnpackedMaxBytes / 1048576} MB`);
    return;
  }
  await runImport(async () => {
    const req: ImportSkillFilesRequest = {
      files: await Promise.all(files.map(async (f) => ({ path: f.webkitRelativePath || f.name, contentBase64: toBase64(await f.arrayBuffer()) }))),
    };
    return store.importFiles(req);
  });
}

// ---------- SkillHub ----------
const showHub = ref(false);
const hubModal = ref<InstanceType<typeof SkillHubModal> | null>(null);
async function hubInstall(s: HubSkill): Promise<void> {
  try {
    const info = await store.hubInstall({ namespace: s.namespace, slug: s.slug });
    message.success(`已安装「${info.name}」，默认用于「编辑审稿」，可在列表中修改`);
  } catch (err) {
    message.error(errorText(err, '安装失败'));
  } finally {
    hubModal.value?.done();
  }
}

const installedCount = computed(() => store.installed.length);
</script>

<template>
  <div class="skill-settings">
    <NCard title="已安装的技能" :segmented="{ content: true }">
      <template #header-extra>
        <NSpace :size="8">
          <NDropdown trigger="click" :options="importOptions" @select="pickImport">
            <NButton size="small" :loading="importing" data-testid="skill-import">本地导入</NButton>
          </NDropdown>
          <NButton size="small" type="primary" data-testid="skill-hub-open" @click="showHub = true">从 SkillHub 安装</NButton>
        </NSpace>
      </template>
      <NSpin :show="store.loading">
        <NEmpty
          v-if="installedCount === 0"
          description="还没有安装技能。技能是 SKILL.md 格式的规则包，可以为审稿、错别字等检查补充专门的标准（如「本书禁用词」「起点编辑审稿标准」）。"
          class="empty"
        />
        <div v-else class="rows">
          <div v-for="s in store.installed" :key="s.id" class="row" data-testid="skill-row">
            <NSwitch :value="s.enabled" size="small" @update:value="(v: boolean) => toggle(s, v)" />
            <div class="main">
              <div class="title">
                <a class="name" @click="openDetail(s)">{{ s.name }}</a>
                <NTag size="tiny" :bordered="false">{{ SOURCE_LABELS[s.source] }}</NTag>
                <NText depth="3" class="ver">v{{ s.version }}</NText>
              </div>
              <NText depth="3" class="desc">{{ s.description }}</NText>
              <div class="applies">
                <span class="label">适用于</span>
                <NSelect
                  :value="s.appliesTo as JobType[]"
                  :options="jobTypeOptions"
                  multiple
                  size="small"
                  class="select"
                  data-testid="skill-applies"
                  @update:value="(v: JobType[]) => setAppliesTo(s, v)"
                />
              </div>
            </div>
            <NPopconfirm positive-text="删除" negative-text="取消" @positive-click="remove(s)">
              <template #trigger>
                <NButton size="small" quaternary type="error">删除</NButton>
              </template>
              删除技能「{{ s.name }}」？
            </NPopconfirm>
          </div>
        </div>
      </NSpin>
    </NCard>

    <NCard title="内置技能" :segmented="{ content: true }">
      <NText depth="3" class="hint">每类检查默认使用的技能，不能修改或删除；可以查看正文，作为编写自己技能的参考。</NText>
      <div class="builtins">
        <div v-for="s in store.builtin" :key="s.id" class="builtin" data-testid="skill-builtin" @click="openDetail(s)">
          <div class="title">
            <span class="name">{{ s.name }}</span>
            <NTag size="tiny" type="info" :bordered="false">{{ TASK_KIND_LABELS[s.appliesTo[0]!] }}</NTag>
          </div>
          <NText depth="3" class="desc">{{ s.description }}</NText>
        </div>
      </div>
    </NCard>

    <input ref="zipInput" type="file" accept=".zip,application/zip" hidden data-testid="skill-zip-input" @change="onZipPicked" />
    <input ref="folderInput" type="file" webkitdirectory hidden data-testid="skill-folder-input" @change="onFolderPicked" />
    <SkillDetailDrawer v-model:show="showDetail" :skill-id="detailId" />
    <SkillHubModal ref="hubModal" v-model:show="showHub" :installed="store.installed" @install="hubInstall" />
  </div>
</template>

<style scoped>
.skill-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.empty {
  padding: 24px 0;
}
.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
}
.row:last-child {
  border-bottom: none;
}
.row > :first-child {
  margin-top: 3px;
}
.main {
  flex: 1;
  min-width: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.name {
  font-weight: 600;
  cursor: pointer;
}
a.name:hover {
  text-decoration: underline;
}
.ver {
  font-size: 12px;
}
.desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 13px;
  margin-top: 4px;
}
.applies {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.label {
  font-size: 13px;
  opacity: 0.7;
  flex: none;
}
.select {
  max-width: 420px;
}
.hint {
  display: block;
  font-size: 13px;
  margin-bottom: 12px;
}
.builtins {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
.builtin {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.18);
  cursor: pointer;
  transition: border-color 0.2s;
}
.builtin:hover {
  border-color: rgba(24, 160, 88, 0.6);
}
</style>
