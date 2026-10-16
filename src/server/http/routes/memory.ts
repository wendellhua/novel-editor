import type { PlotMemoryService } from '../../memory';
import { notFound } from '../errors';
import type { HandlerResult, RequestContext, Router } from '../router';
import { validateBody } from '../validate';

const W = '/api/works/:workId';

function param(ctx: RequestContext, name: string): string {
  const v = ctx.params[name];
  if (v === undefined) throw notFound();
  return v;
}

const json = (value: unknown): HandlerResult => ({ json: value });

/** 剧情记忆路由（§7.2、ADR-011）：查阅、手动更新、重建。自动更新由正文保存触发，不经过路由。 */
export function registerMemoryRoutes(router: Router, memory: PlotMemoryService): void {
  router.get(`${W}/memory`, (ctx) => json(memory.get(param(ctx, 'workId'))));
  router.post(`${W}/memory/update`, async (ctx) => {
    validateBody('empty', await ctx.readJson({ optional: true }));
    return json(await memory.update(param(ctx, 'workId')));
  });
  router.post(`${W}/memory/rebuild`, async (ctx) => {
    validateBody('empty', await ctx.readJson({ optional: true }));
    return json(await memory.rebuild(param(ctx, 'workId')));
  });
}
