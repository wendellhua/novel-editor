import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { HubInstallRequest, ImportSkillFilesRequest, SkillInfo, UpdateSkillRequest } from '../../shared/types';
import { skillsApi } from '../api/skills';

/** 技能列表（内置 + 已安装）与安装操作。 */
export const useSkillsStore = defineStore('skills', () => {
  const skills = ref<SkillInfo[]>([]);
  const loading = ref(false);
  const builtin = computed(() => skills.value.filter((s) => s.source === 'builtin'));
  const installed = computed(() => skills.value.filter((s) => s.source !== 'builtin'));

  async function load(): Promise<void> {
    loading.value = true;
    try {
      skills.value = await skillsApi.list();
    } finally {
      loading.value = false;
    }
  }

  async function update(id: string, req: UpdateSkillRequest): Promise<void> {
    const next = await skillsApi.update(id, req);
    skills.value = skills.value.map((s) => (s.id === id ? next : s));
  }

  async function remove(id: string): Promise<void> {
    await skillsApi.remove(id);
    skills.value = skills.value.filter((s) => s.id !== id);
  }

  async function importZip(zip: Blob): Promise<SkillInfo> {
    const info = await skillsApi.importZip(zip);
    await load();
    return info;
  }

  async function importFiles(req: ImportSkillFilesRequest): Promise<SkillInfo> {
    const info = await skillsApi.importFiles(req);
    await load();
    return info;
  }

  async function hubInstall(req: HubInstallRequest): Promise<SkillInfo> {
    const info = await skillsApi.hubInstall(req);
    await load();
    return info;
  }

  return { skills, loading, builtin, installed, load, update, remove, importZip, importFiles, hubInstall };
});
