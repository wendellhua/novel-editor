import type { ApplyExpansionResponse, CreateJobRequest, Expansion, Job, JobEstimate, JobReport } from '../../shared/types';
import { api } from './client';

const J = (workId: string): string => `/api/works/${encodeURIComponent(workId)}/jobs`;

/** 检查任务接口（§7.2）的类型化客户端。 */
export const jobsApi = {
  estimate: (workId: string, req: CreateJobRequest) => api.post<JobEstimate>(`${J(workId)}/estimate`, req),
  create: (workId: string, req: CreateJobRequest) => api.post<Job>(J(workId), req),
  list: (workId: string) => api.get<Job[]>(J(workId)),
  get: (workId: string, jobId: string) => api.get<Job>(`${J(workId)}/${encodeURIComponent(jobId)}`),
  remove: (workId: string, jobId: string) => api.delete<void>(`${J(workId)}/${encodeURIComponent(jobId)}`),
  report: (workId: string, jobId: string) => api.get<JobReport>(`${J(workId)}/${encodeURIComponent(jobId)}/report`),
  expansion: (workId: string, jobId: string) => api.get<Expansion>(`${J(workId)}/${encodeURIComponent(jobId)}/expansion`),
  /** 插入章末；本章在扩写后有改动时返回 400（details.stale = true），确认后带 force 重试。 */
  applyExpansion: (workId: string, jobId: string, force = false) =>
    api.post<ApplyExpansionResponse>(`${J(workId)}/${encodeURIComponent(jobId)}/expansion/apply`, force ? { force: true } : {}),
  control: (workId: string, jobId: string, action: 'pause' | 'resume' | 'cancel') =>
    api.post<Job>(`${J(workId)}/${encodeURIComponent(jobId)}/${action}`, {}),
};
