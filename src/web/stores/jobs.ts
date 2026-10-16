import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { CreateJobRequest, Job, JobEstimate } from '../../shared/types';
import { jobsApi } from '../api/jobs';
import { useSystemStore } from './system';

/** 当前作品的检查任务列表；通过 SSE 的 job.updated 实时更新进度。 */
export const useJobsStore = defineStore('jobs', () => {
  const workId = ref<string | null>(null);
  const jobs = ref<Job[]>([]);
  const loading = ref(false);
  let unsubscribe: (() => void) | null = null;
  const doneListeners = new Set<(job: Job) => void>();

  /** 订阅「任务在本次会话中完成」（由 SSE 推送的状态变化触发，不含打开作品时已完成的任务）。返回取消订阅函数。 */
  function onJobDone(listener: (job: Job) => void): () => void {
    doneListeners.add(listener);
    return () => doneListeners.delete(listener);
  }

  const active = computed(() => jobs.value.filter((j) => j.status === 'queued' || j.status === 'running'));

  function upsert(job: Job): void {
    const i = jobs.value.findIndex((j) => j.id === job.id);
    if (i >= 0) jobs.value.splice(i, 1, job);
    else jobs.value.unshift(job);
  }

  /**
   * 每个任务最近一次收到 SSE 推送的时刻。很快完成的任务，queued → running → done 的推送可能都早于
   * 创建（或暂停、继续）请求的响应到达；这时响应里的状态已经过时，不能覆盖推送来的新状态。
   */
  const pushedAt = new Map<string, number>();
  function upsertResponse(job: Job, sentAt: number): void {
    if ((pushedAt.get(job.id) ?? -1) < sentAt) upsert(job);
  }

  async function open(id: string): Promise<void> {
    if (workId.value !== id) jobs.value = [];
    workId.value = id;
    unsubscribe?.();
    unsubscribe = useSystemStore().onServerEvent((e) => {
      if (e.type !== 'job.updated' || e.workId !== workId.value) return;
      const prev = jobs.value.find((j) => j.id === e.job.id);
      pushedAt.set(e.job.id, performance.now());
      upsert(e.job);
      if (e.job.status === 'done' && prev?.status !== 'done') for (const l of doneListeners) l(e.job);
    });
    loading.value = true;
    try {
      const sentAt = performance.now();
      const list = await jobsApi.list(id);
      // 列表请求期间推送来的状态比列表新，保留推送的
      if (workId.value === id) jobs.value = list.map((j) => ((pushedAt.get(j.id) ?? -1) >= sentAt ? (jobs.value.find((x) => x.id === j.id) ?? j) : j));
    } finally {
      loading.value = false;
    }
  }

  function close(): void {
    unsubscribe?.();
    unsubscribe = null;
    workId.value = null;
    jobs.value = [];
  }

  function requireWork(): string {
    if (workId.value === null) throw new Error('尚未打开作品');
    return workId.value;
  }

  const estimate = (req: CreateJobRequest): Promise<JobEstimate> => jobsApi.estimate(requireWork(), req);

  async function create(req: CreateJobRequest): Promise<Job> {
    const sentAt = performance.now();
    const job = await jobsApi.create(requireWork(), req);
    upsertResponse(job, sentAt);
    return job;
  }

  async function control(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    const sentAt = performance.now();
    upsertResponse(await jobsApi.control(requireWork(), jobId, action), sentAt);
  }

  async function remove(jobId: string): Promise<void> {
    await jobsApi.remove(requireWork(), jobId);
    jobs.value = jobs.value.filter((j) => j.id !== jobId);
  }

  return { workId, jobs, loading, active, open, close, estimate, create, control, remove, onJobDone };
});
