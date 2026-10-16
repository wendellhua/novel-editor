import type { BibleCandidate, BibleEntry, BibleFact, CandidateDecision, EntryKind } from '../../shared/types';
import { api } from './client';

const B = (workId: string): string => `/api/works/${encodeURIComponent(workId)}/bible`;
const e = encodeURIComponent;

export type EntryInput = Pick<BibleEntry, 'kind' | 'name'> & Partial<Pick<BibleEntry, 'aliases' | 'summary' | 'firstChapterId'>>;
export type FactInput = Pick<BibleFact, 'attribute' | 'value'> & Partial<Pick<BibleFact, 'mutable' | 'chapterId' | 'quote'>>;

/** 设定库接口（§7.2、F5）的类型化客户端。名称冲突时抛出 ApiError（code = NAME_CONFLICT，details 含 entryId / entryName / candidateId）。 */
export const bibleApi = {
  entries: (workId: string, kind?: EntryKind) => api.get<BibleEntry[]>(kind === undefined ? `${B(workId)}/entries` : `${B(workId)}/entries?kind=${kind}`),
  createEntry: (workId: string, input: EntryInput) => api.post<BibleEntry>(`${B(workId)}/entries`, input),
  updateEntry: (workId: string, id: string, patch: Partial<EntryInput>) => api.patch<BibleEntry>(`${B(workId)}/entries/${e(id)}`, patch),
  deleteEntry: (workId: string, id: string) => api.delete<void>(`${B(workId)}/entries/${e(id)}`),
  facts: (workId: string, entryId: string) => api.get<BibleFact[]>(`${B(workId)}/entries/${e(entryId)}/facts`),
  createFact: (workId: string, entryId: string, input: FactInput) => api.post<BibleFact>(`${B(workId)}/entries/${e(entryId)}/facts`, input),
  updateFact: (workId: string, id: string, patch: Partial<FactInput>) => api.patch<BibleFact>(`${B(workId)}/facts/${e(id)}`, patch),
  deleteFact: (workId: string, id: string) => api.delete<void>(`${B(workId)}/facts/${e(id)}`),
  candidates: (workId: string, status: BibleCandidate['status'] = 'pending') => api.get<BibleCandidate[]>(`${B(workId)}/candidates?status=${status}`),
  decide: (workId: string, decisions: CandidateDecision[]) => api.post<{ accepted: number; rejected: number }>(`${B(workId)}/candidates/decide`, { decisions }),
};
