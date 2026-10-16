import type {
  Chapter,
  ChapterNode,
  CreateChapterRequest,
  CreateVolumeRequest,
  CreateWorkRequest,
  ExportFormat,
  MoveChapterRequest,
  RevisionDetail,
  RevisionMeta,
  SaveBodyRequest,
  SaveBodyResponse,
  TrashItemRef,
  TrashList,
  TrashedWork,
  UpdateWorkRequest,
  VolumeNode,
  Work,
  WorkSummary,
  WorkTree,
} from '../../shared/types';
import { api } from './client';

const W = (workId: string): string => `/api/works/${encodeURIComponent(workId)}`;
const C = (workId: string, chapterId: string): string => `${W(workId)}/chapters/${encodeURIComponent(chapterId)}`;

/** 作品相关接口（§7.2）的类型化客户端。路径与服务端路由逐一对应。 */
export const worksApi = {
  list: () => api.get<WorkSummary[]>('/api/works'),
  create: (req: CreateWorkRequest) => api.post<Work>('/api/works', req),
  update: (workId: string, patch: UpdateWorkRequest) => api.patch<Work>(W(workId), patch),
  remove: (workId: string) => api.delete<void>(W(workId)),

  listTrashed: () => api.get<TrashedWork[]>('/api/trash/works'),
  restoreTrashed: (file: string) => api.post<WorkSummary>('/api/trash/works/restore', { file }),
  purgeTrashed: (file: string) => api.delete<void>(`/api/trash/works/${encodeURIComponent(file)}`),

  tree: (workId: string) => api.get<WorkTree>(`${W(workId)}/tree`),
  exportUrl: (workId: string, format: ExportFormat) => `${W(workId)}/export?format=${format}`,

  createVolume: (workId: string, req: CreateVolumeRequest) => api.post<VolumeNode>(`${W(workId)}/volumes`, req),
  renameVolume: (workId: string, volumeId: string, title: string) =>
    api.patch<VolumeNode>(`${W(workId)}/volumes/${encodeURIComponent(volumeId)}`, { title }),
  deleteVolume: (workId: string, volumeId: string) => api.delete<void>(`${W(workId)}/volumes/${encodeURIComponent(volumeId)}`),
  reorderVolumes: (workId: string, volumeIds: string[]) => api.put<void>(`${W(workId)}/volumes/order`, { volumeIds }),
  reorderChapters: (workId: string, volumeId: string, chapterIds: string[]) =>
    api.put<void>(`${W(workId)}/volumes/${encodeURIComponent(volumeId)}/chapters/order`, { chapterIds }),

  createChapter: (workId: string, req: CreateChapterRequest) => api.post<Chapter>(`${W(workId)}/chapters`, req),
  getChapter: (workId: string, chapterId: string) => api.get<Chapter>(C(workId, chapterId)),
  renameChapter: (workId: string, chapterId: string, title: string) => api.patch<ChapterNode>(C(workId, chapterId), { title }),
  deleteChapter: (workId: string, chapterId: string) => api.delete<void>(C(workId, chapterId)),
  saveBody: (workId: string, chapterId: string, req: SaveBodyRequest) => api.put<SaveBodyResponse>(`${C(workId, chapterId)}/body`, req),
  moveChapter: (workId: string, chapterId: string, req: MoveChapterRequest) => api.post<void>(`${C(workId, chapterId)}/move`, req),

  listRevisions: (workId: string, chapterId: string) => api.get<RevisionMeta[]>(`${C(workId, chapterId)}/revisions`),
  createRevision: (workId: string, chapterId: string) => api.post<RevisionMeta>(`${C(workId, chapterId)}/revisions`, {}),
  getRevision: (workId: string, chapterId: string, revisionId: number) =>
    api.get<RevisionDetail>(`${C(workId, chapterId)}/revisions/${revisionId}`),
  restoreRevision: (workId: string, chapterId: string, revisionId: number, baseRev: number) =>
    api.post<SaveBodyResponse>(`${C(workId, chapterId)}/revisions/${revisionId}/restore`, { baseRev }),

  trash: (workId: string) => api.get<TrashList>(`${W(workId)}/trash`),
  restoreTrash: (workId: string, ref: TrashItemRef) => api.post<void>(`${W(workId)}/trash/restore`, ref),
  purgeTrash: (workId: string, ref: TrashItemRef | { all: true }) => api.delete<void>(`${W(workId)}/trash`, ref),
};
