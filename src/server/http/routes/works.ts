import { BODY_LIMITS } from '../../../shared/constants';
import type {
  CreateChapterRequest,
  CreateVolumeRequest,
  CreateWorkRequest,
  MoveChapterRequest,
  SaveBodyRequest,
  TrashItemRef,
  UpdateWorkRequest,
} from '../../../shared/types';
import type { Manuscript } from '../../manuscript';
import { badRequest, notFound } from '../errors';
import type { HandlerResult, RequestContext, Router } from '../router';
import { validateBody } from '../validate';

const W = '/api/works/:workId';

function param(ctx: RequestContext, name: string): string {
  const v = ctx.params[name];
  if (v === undefined) throw notFound();
  return v;
}

function revisionId(ctx: RequestContext): number {
  const raw = param(ctx, 'rid');
  const n = Number(raw);
  if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) throw notFound('版本不存在');
  return n;
}

const json = (value: unknown): HandlerResult => ({ json: value });

function attachment(filename: string, contentType: string, content: string): HandlerResult {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
    body: content,
  };
}

export interface WorkRouteHooks {
  /** 删除作品之前调用（停下该作品的检查任务、释放连接）。 */
  beforeDeleteWork?: (workId: string) => Promise<void>;
}

/** 作品相关路由（§7.2）。所有路由都需要会话 Cookie；写请求另受 Origin 校验（INV-12）。 */
export function registerWorkRoutes(router: Router, ms: Manuscript, hooks: WorkRouteHooks = {}): void {
  // ---------- 作品 ----------
  router.get('/api/works', () => json(ms.listWorks()));
  router.post('/api/works', async (ctx) => json(ms.createWork(validateBody<CreateWorkRequest>('createWork', await ctx.readJson()))));
  router.patch(W, async (ctx) => json(ms.updateWork(param(ctx, 'workId'), validateBody<UpdateWorkRequest>('updateWork', await ctx.readJson()))));
  router.delete(W, async (ctx) => {
    const workId = param(ctx, 'workId');
    await hooks.beforeDeleteWork?.(workId);
    ms.deleteWork(workId);
    return undefined;
  });

  // ---------- 作品回收站 ----------
  router.get('/api/trash/works', () => json(ms.listTrashedWorks()));
  router.post('/api/trash/works/restore', async (ctx) => {
    const { file } = validateBody<{ file: string }>('restoreWork', await ctx.readJson());
    return json(ms.restoreWork(file));
  });
  router.delete('/api/trash/works/:file', (ctx) => {
    ms.purgeTrashedWork(param(ctx, 'file'));
    return undefined;
  });

  // ---------- 目录树与导出 ----------
  router.get(`${W}/tree`, (ctx) => json(ms.getTree(param(ctx, 'workId'))));
  router.get(`${W}/export`, async (ctx) => {
    const format = ctx.query.get('format') ?? 'txt';
    if (format !== 'txt' && format !== 'md') throw badRequest('format 只能是 txt 或 md');
    const out = await ms.exportWork(param(ctx, 'workId'), format);
    return attachment(out.filename, out.contentType, out.content);
  });

  // ---------- 分卷 ----------
  router.post(`${W}/volumes`, async (ctx) =>
    json(ms.createVolume(param(ctx, 'workId'), validateBody<CreateVolumeRequest>('createVolume', await ctx.readJson()))),
  );
  router.put(`${W}/volumes/order`, async (ctx) => {
    const { volumeIds } = validateBody<{ volumeIds: string[] }>('volumeOrder', await ctx.readJson());
    ms.reorderVolumes(param(ctx, 'workId'), volumeIds);
    return undefined;
  });
  router.patch(`${W}/volumes/:vid`, async (ctx) => {
    const { title } = validateBody<{ title: string }>('renameVolume', await ctx.readJson());
    return json(ms.renameVolume(param(ctx, 'workId'), param(ctx, 'vid'), title));
  });
  router.delete(`${W}/volumes/:vid`, (ctx) => {
    ms.deleteVolume(param(ctx, 'workId'), param(ctx, 'vid'));
    return undefined;
  });
  router.put(`${W}/volumes/:vid/chapters/order`, async (ctx) => {
    const { chapterIds } = validateBody<{ chapterIds: string[] }>('chapterOrder', await ctx.readJson());
    ms.reorderChapters(param(ctx, 'workId'), param(ctx, 'vid'), chapterIds);
    return undefined;
  });

  // ---------- 章节 ----------
  router.post(`${W}/chapters`, async (ctx) =>
    json(ms.createChapter(param(ctx, 'workId'), validateBody<CreateChapterRequest>('createChapter', await ctx.readJson()))),
  );
  router.get(`${W}/chapters/:cid`, (ctx) => json(ms.getChapter(param(ctx, 'workId'), param(ctx, 'cid'))));
  router.patch(`${W}/chapters/:cid`, async (ctx) => {
    const { title } = validateBody<{ title: string }>('renameChapter', await ctx.readJson());
    return json(ms.renameChapter(param(ctx, 'workId'), param(ctx, 'cid'), title));
  });
  router.delete(`${W}/chapters/:cid`, (ctx) => {
    ms.deleteChapter(param(ctx, 'workId'), param(ctx, 'cid'));
    return undefined;
  });
  router.put(
    `${W}/chapters/:cid/body`,
    async (ctx) => json(ms.saveChapterBody(param(ctx, 'workId'), param(ctx, 'cid'), validateBody<SaveBodyRequest>('saveBody', await ctx.readJson()))),
    { bodyLimit: BODY_LIMITS.chapterBody },
  );
  router.post(`${W}/chapters/:cid/move`, async (ctx) => {
    ms.moveChapter(param(ctx, 'workId'), param(ctx, 'cid'), validateBody<MoveChapterRequest>('moveChapter', await ctx.readJson()));
    return undefined;
  });

  // ---------- 版本 ----------
  router.get(`${W}/chapters/:cid/revisions`, (ctx) => json(ms.listRevisions(param(ctx, 'workId'), param(ctx, 'cid'))));
  router.post(`${W}/chapters/:cid/revisions`, async (ctx) => {
    validateBody('empty', await ctx.readJson({ optional: true }));
    return json(ms.createManualRevision(param(ctx, 'workId'), param(ctx, 'cid')));
  });
  router.get(`${W}/chapters/:cid/revisions/:rid`, (ctx) => json(ms.getRevision(param(ctx, 'workId'), param(ctx, 'cid'), revisionId(ctx))));
  router.post(`${W}/chapters/:cid/revisions/:rid/restore`, async (ctx) => {
    const { baseRev } = validateBody<{ baseRev: number }>('restoreRevision', await ctx.readJson());
    return json(ms.restoreRevision(param(ctx, 'workId'), param(ctx, 'cid'), revisionId(ctx), baseRev));
  });

  // ---------- 作品内回收站 ----------
  router.get(`${W}/trash`, (ctx) => json(ms.getTrash(param(ctx, 'workId'))));
  router.post(`${W}/trash/restore`, async (ctx) => {
    ms.restoreTrash(param(ctx, 'workId'), validateBody<TrashItemRef>('trashRef', await ctx.readJson()));
    return undefined;
  });
  router.delete(`${W}/trash`, async (ctx) => {
    const body = validateBody<TrashItemRef | { all: true }>('trashPurge', await ctx.readJson());
    ms.purgeTrash(param(ctx, 'workId'), 'all' in body ? 'all' : body);
    return undefined;
  });
}
