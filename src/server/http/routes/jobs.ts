import type { ApplyExpansionRequest, CreateJobRequest } from '../../../shared/types';
import type { Checks } from '../../checks';
import { notFound } from '../errors';
import type { HandlerResult, RequestContext, Router } from '../router';
import { validateBody } from '../validate';

const W = '/api/works/:workId';
const J = `${W}/jobs/:jid`;

function param(ctx: RequestContext, name: string): string {
  const v = ctx.params[name];
  if (v === undefined) throw notFound();
  return v;
}

const json = (value: unknown): HandlerResult => ({ json: value });

/** 检查任务路由（§7.2）。暂停、取消、删除会等运行中的模型请求中止并收尾后才返回。 */
export function registerJobRoutes(router: Router, checks: Checks): void {
  router.post(`${W}/jobs/estimate`, async (ctx) =>
    json(checks.estimate(param(ctx, 'workId'), validateBody<CreateJobRequest>('createJob', await ctx.readJson()))),
  );
  router.post(`${W}/jobs`, async (ctx) => json(checks.create(param(ctx, 'workId'), validateBody<CreateJobRequest>('createJob', await ctx.readJson()))));
  router.get(`${W}/jobs`, (ctx) => json(checks.list(param(ctx, 'workId'))));
  router.get(J, (ctx) => json(checks.get(param(ctx, 'workId'), param(ctx, 'jid'))));
  router.get(`${J}/report`, (ctx) => json(checks.report(param(ctx, 'workId'), param(ctx, 'jid'))));
  router.get(`${J}/expansion`, (ctx) => json(checks.expansion(param(ctx, 'workId'), param(ctx, 'jid'))));
  router.post(`${J}/expansion/apply`, async (ctx) => {
    const body = validateBody<ApplyExpansionRequest>('applyExpansion', await ctx.readJson({ optional: true }) ?? {});
    return json(checks.applyExpansion(param(ctx, 'workId'), param(ctx, 'jid'), body.force === true));
  });
  router.delete(J, async (ctx) => {
    await checks.remove(param(ctx, 'workId'), param(ctx, 'jid'));
    return undefined;
  });
  const control = (action: 'pause' | 'resume' | 'cancel'): void => {
    router.post(`${J}/${action}`, async (ctx) => {
      validateBody('empty', await ctx.readJson({ optional: true }));
      const workId = param(ctx, 'workId');
      const jobId = param(ctx, 'jid');
      if (action === 'pause') return json(await checks.pause(workId, jobId));
      if (action === 'cancel') return json(await checks.cancel(workId, jobId));
      return json(checks.resume(workId, jobId));
    });
  };
  control('pause');
  control('resume');
  control('cancel');
}
