import type { Job, PlotMemory } from '../../shared/types';
import { api } from './client';

const M = (workId: string): string => `/api/works/${encodeURIComponent(workId)}/memory`;

/** 剧情记忆接口（§7.2、ADR-011）。 */
export const memoryApi = {
  get: (workId: string) => api.get<PlotMemory>(M(workId)),
  /** 手动更新：把尚未纳入的正文全部纳入（不受 3000 字阈值与自动上限限制）。 */
  update: (workId: string) => api.post<Job>(`${M(workId)}/update`, {}),
  /** 重建：清空后从头建立。 */
  rebuild: (workId: string) => api.post<Job>(`${M(workId)}/rebuild`, {}),
};
