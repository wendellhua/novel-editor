import type { ApplyIssuesResponse, Issue, IssueCategory, IssueStatus } from '../../shared/types';
import { api } from './client';

const I = (workId: string): string => `/api/works/${encodeURIComponent(workId)}/issues`;

export interface IssueQuery {
  chapterId?: string;
  jobId?: string;
  status?: IssueStatus;
  category?: IssueCategory;
}

/** 问题接口（§7.2）的类型化客户端。读取时服务端会按 INV-7 重新锚定。 */
export const issuesApi = {
  list: (workId: string, q: IssueQuery = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
    return api.get<Issue[]>(qs === '' ? I(workId) : `${I(workId)}?${qs}`);
  },
  apply: (workId: string, issueIds: string[]) => api.post<ApplyIssuesResponse>(`${I(workId)}/apply`, { issueIds }),
  ignore: (workId: string, issueIds: string[]) => api.post<void>(`${I(workId)}/ignore`, { issueIds }),
  /** AI 修复：按意见生成修改建议（写入 replacement，不改正文）；中止请求时服务端随之中止模型调用。 */
  suggest: (workId: string, issueId: string, signal?: AbortSignal) => api.post<Issue>(`${I(workId)}/${encodeURIComponent(issueId)}/suggest`, undefined, signal),
};
