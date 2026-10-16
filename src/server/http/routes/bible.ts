import { ENTRY_KINDS } from '../../../shared/constants';
import type { BibleCandidate, CandidateDecision, EntryKind } from '../../../shared/types';
import type { Bible, EntryInput, FactInput } from '../../bible';
import { badRequest, notFound } from '../errors';
import type { HandlerResult, RequestContext, Router } from '../router';
import { validateBody } from '../validate';

const W = '/api/works/:workId';
const B = `${W}/bible`;

function param(ctx: RequestContext, name: string): string {
  const v = ctx.params[name];
  if (v === undefined) throw notFound();
  return v;
}

const json = (value: unknown): HandlerResult => ({ json: value });

const STATUSES: readonly BibleCandidate['status'][] = ['pending', 'accepted', 'rejected'];

/** 设定库路由（§7.2、F5）。名称或别名与已有条目冲突时 409 NAME_CONFLICT（INV-9），引文不在来源章节中时 400（INV-8）。 */
export function registerBibleRoutes(router: Router, bible: Bible): void {
  router.get(`${B}/entries`, (ctx) => {
    const kind = ctx.query.get('kind');
    if (kind !== null && kind !== '' && !ENTRY_KINDS.includes(kind as EntryKind)) throw badRequest('kind 不合法');
    return json(bible.listEntries(param(ctx, 'workId'), kind === null || kind === '' ? undefined : (kind as EntryKind)));
  });
  router.post(`${B}/entries`, async (ctx) => json(bible.createEntry(param(ctx, 'workId'), validateBody<EntryInput>('createEntry', await ctx.readJson()))));
  router.patch(`${B}/entries/:eid`, async (ctx) =>
    json(bible.updateEntry(param(ctx, 'workId'), param(ctx, 'eid'), validateBody<Partial<EntryInput>>('updateEntry', await ctx.readJson()))),
  );
  router.delete(`${B}/entries/:eid`, (ctx) => {
    bible.deleteEntry(param(ctx, 'workId'), param(ctx, 'eid'));
    return undefined;
  });

  router.get(`${B}/entries/:eid/facts`, (ctx) => json(bible.listFacts(param(ctx, 'workId'), param(ctx, 'eid'))));
  router.post(`${B}/entries/:eid/facts`, async (ctx) =>
    json(bible.createFact(param(ctx, 'workId'), param(ctx, 'eid'), validateBody<FactInput>('createFact', await ctx.readJson()))),
  );
  router.patch(`${B}/facts/:fid`, async (ctx) =>
    json(bible.updateFact(param(ctx, 'workId'), param(ctx, 'fid'), validateBody<Partial<FactInput>>('updateFact', await ctx.readJson()))),
  );
  router.delete(`${B}/facts/:fid`, (ctx) => {
    bible.deleteFact(param(ctx, 'workId'), param(ctx, 'fid'));
    return undefined;
  });

  router.get(`${B}/candidates`, (ctx) => {
    const status = ctx.query.get('status');
    if (status !== null && status !== '' && !STATUSES.includes(status as BibleCandidate['status'])) throw badRequest('status 不合法');
    return json(bible.listCandidates(param(ctx, 'workId'), status === null || status === '' ? undefined : (status as BibleCandidate['status'])));
  });
  router.post(`${B}/candidates/decide`, async (ctx) => {
    const { decisions } = validateBody<{ decisions: CandidateDecision[] }>('decideCandidates', await ctx.readJson());
    return json(bible.decide(param(ctx, 'workId'), decisions));
  });
}
