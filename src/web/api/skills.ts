import type {
  HubInstallRequest,
  HubSkill,
  HubSkillDetail,
  ImportSkillFilesRequest,
  SkillDetail,
  SkillInfo,
  UpdateSkillRequest,
} from '../../shared/types';
import { api, apiRequestRaw } from './client';

/** 技能 id 含 `:` 与 `/`，放进路径前必须编码。 */
const S = (id: string): string => `/api/skills/${encodeURIComponent(id)}`;

/** 技能接口（§7.2）的类型化客户端。 */
export const skillsApi = {
  list: () => api.get<SkillInfo[]>('/api/skills'),
  detail: (id: string) => api.get<SkillDetail>(S(id)),
  update: (id: string, req: UpdateSkillRequest) => api.patch<SkillInfo>(S(id), req),
  remove: (id: string) => api.delete<void>(S(id)),
  importZip: (zip: Blob) => apiRequestRaw<SkillInfo>('POST', '/api/skills/import', zip, 'application/zip'),
  importFiles: (req: ImportSkillFilesRequest) => api.post<SkillInfo>('/api/skills/import', req),
  hubSearch: (q: string, limit = 20) => api.get<HubSkill[]>(`/api/skills/hub/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  hubDetail: (namespace: string, slug: string) =>
    api.get<HubSkillDetail>(`/api/skills/hub/detail?namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`),
  hubInstall: (req: HubInstallRequest) => api.post<SkillInfo>('/api/skills/hub/install', req),
};
