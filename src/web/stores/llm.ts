import { defineStore } from 'pinia';
import { reactive, ref, watch } from 'vue';
import { LLM_PROBE_DEADLINE_MS, TASK_KINDS } from '../../shared/constants';
import type {
  CreateLlmProfileRequest,
  LlmDefaults,
  LlmPreset,
  LlmProfile,
  LlmProfileStatus,
  ProbeResult,
  TaskKind,
  UpdateLlmProfileRequest,
} from '../../shared/types';
import { ApiError } from '../api/client';
import { llmApi } from '../api/llm';
import { useSystemStore } from './system';

/** 前端兜底：服务端的探测时限再加一点余量，仍没有结果就放弃（例如本地服务卡住）。 */
export const TEST_CLIENT_TIMEOUT_MS = LLM_PROBE_DEADLINE_MS + 15_000;

/** 模型配置、预设、默认模型映射，以及模型运行状态（§7.3「运行状态」，SSE llm.status 实时更新）与进行中的测试连接。 */
export const useLlmStore = defineStore('llm', () => {
  const profiles = ref<LlmProfile[]>([]);
  const presets = ref<LlmPreset[]>([]);
  const defaults = ref<LlmDefaults | null>(null);
  const loading = ref(false);
  const statuses = reactive<Record<string, LlmProfileStatus>>({});
  /** 正在测试连接的配置：开始时间（界面显示已等待的秒数）与用于取消的控制器。 */
  const testing = reactive(new Map<string, { since: number; controller: AbortController }>());

  const system = useSystemStore();
  system.onServerEvent((e) => {
    if (e.type === 'llm.status') statuses[e.profileId] = e.status;
  });
  // 断线期间可能错过推送：重新连上后读一次
  watch(
    () => system.connection,
    (state) => {
      if (state === 'open' && profiles.value.length > 0) void loadStatus().catch(() => undefined);
    },
  );

  async function loadStatus(): Promise<void> {
    const all = await llmApi.status();
    for (const id of Object.keys(statuses)) if (!(id in all)) delete statuses[id];
    Object.assign(statuses, all);
  }

  async function load(): Promise<void> {
    loading.value = true;
    try {
      [profiles.value, presets.value, defaults.value] = await Promise.all([llmApi.list(), llmApi.presets(), llmApi.defaults()]);
      await loadStatus();
    } finally {
      loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    [profiles.value, defaults.value] = await Promise.all([llmApi.list(), llmApi.defaults()]);
    await loadStatus();
  }

  /** 还没有任何默认模型时，新添加的模型自动成为所有任务的默认模型。 */
  async function create(req: CreateLlmProfileRequest): Promise<LlmProfile> {
    const p = await llmApi.create(req);
    await refresh();
    const current = defaults.value;
    if (current !== null && TASK_KINDS.every((k) => current[k] === null)) {
      defaults.value = await llmApi.setDefaults(Object.fromEntries(TASK_KINDS.map((k) => [k, p.id])) as LlmDefaults);
    }
    return p;
  }

  async function update(id: string, req: UpdateLlmProfileRequest): Promise<LlmProfile> {
    const p = await llmApi.update(id, req);
    await refresh();
    return p;
  }

  async function remove(id: string): Promise<void> {
    cancelTest(id);
    await llmApi.remove(id);
    await refresh();
  }

  /**
   * 测试连接。作者取消时返回 null；超过 TEST_CLIENT_TIMEOUT_MS 仍没有结果时中止并抛出 TIMEOUT。
   * 结果由服务端记入运行状态，这里随后读取一次（不等推送）。
   */
  async function test(id: string): Promise<ProbeResult | null> {
    cancelTest(id);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TEST_CLIENT_TIMEOUT_MS);
    testing.set(id, { since: Date.now(), controller });
    try {
      const r = await llmApi.test(id, controller.signal);
      if (r.ok) await refresh();
      else await loadStatus();
      return r;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ABORTED') {
        if (!timedOut) return null;
        throw new ApiError(0, 'TIMEOUT', `测试连接超过 ${Math.round(TEST_CLIENT_TIMEOUT_MS / 1000)} 秒没有结果，已停止。请检查网络与服务地址后重试`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (testing.get(id)?.controller === controller) testing.delete(id);
    }
  }

  function cancelTest(id: string): void {
    testing.get(id)?.controller.abort();
  }

  async function setDefault(kind: TaskKind, profileId: string | null): Promise<void> {
    if (defaults.value === null) return;
    defaults.value = await llmApi.setDefaults({ ...defaults.value, [kind]: profileId });
  }

  return { profiles, presets, defaults, loading, statuses, testing, load, refresh, loadStatus, create, update, remove, test, cancelTest, setDefault };
});
