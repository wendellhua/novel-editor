import type {
  CreateLlmProfileRequest,
  LlmDefaults,
  LlmPreset,
  LlmProfile,
  LlmProfileStatus,
  ProbeResult,
  UpdateLlmProfileRequest,
} from '../../shared/types';
import { api } from './client';

const P = (id: string): string => `/api/llm/profiles/${encodeURIComponent(id)}`;

/** 模型配置接口（§7.2）的类型化客户端。响应中只有掩码 Key（INV-17）。 */
export const llmApi = {
  presets: () => api.get<LlmPreset[]>('/api/llm/presets'),
  list: () => api.get<LlmProfile[]>('/api/llm/profiles'),
  create: (req: CreateLlmProfileRequest) => api.post<LlmProfile>('/api/llm/profiles', req),
  update: (id: string, req: UpdateLlmProfileRequest) => api.patch<LlmProfile>(P(id), req),
  remove: (id: string) => api.delete<void>(P(id)),
  /** 中止请求时服务端随之中止测试。 */
  test: (id: string, signal?: AbortSignal) => api.post<ProbeResult>(`${P(id)}/test`, undefined, signal),
  /** 全部模型配置的运行状态（之后的变化通过 SSE llm.status 推送）。 */
  status: () => api.get<Record<string, LlmProfileStatus>>('/api/llm/status'),
  defaults: () => api.get<LlmDefaults>('/api/llm/defaults'),
  setDefaults: (map: LlmDefaults) => api.put<LlmDefaults>('/api/llm/defaults', map),
};
