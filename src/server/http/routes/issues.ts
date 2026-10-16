import type { IssueFixer } from '../../checks/fix';
import type { Issues, IssueQuery } from '../../checks/issues';
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

/** 问题路由（§7.2）：读取时按 INV-7 重新锚定；采纳即一键修正（F4）；忽略；AI 修复生成修改建议。 */
export function registerIssueRoutes(router: Router, issues: Issues, fixer: IssueFixer): void {
  // 客户端断开（界面上「停止」或关闭页面）时中止模型请求
  router.post(`${W}/issues/:issueId/suggest`, async (ctx) => {
    const controller = new AbortController();
    ctx.res.on('close', () => {
      if (!ctx.res.writableFinished) controller.abort();
    });
    return json(await fixer.suggest(param(ctx, 'workId'), param(ctx, 'issueId'), controller.signal));
  });
  router.get(`${W}/issues`, (ctx) => {
    const q: IssueQuery = {};
    for (const key of ['chapterId', 'jobId', 'status', 'category'] as const) {
      const v = ctx.query.get(key);
      if (v !== null && v !== '') q[key] = v;
    }
    return json(issues.list(param(ctx, 'workId'), q));
  });
  router.post(`${W}/issues/apply`, async (ctx) => {
    const { issueIds } = validateBody<{ issueIds: string[] }>('issueIds', await ctx.readJson());
    return json(issues.apply(param(ctx, 'workId'), issueIds));
  });
  router.post(`${W}/issues/ignore`, async (ctx) => {
    const { issueIds } = validateBody<{ issueIds: string[] }>('issueIds', await ctx.readJson());
    issues.ignore(param(ctx, 'workId'), issueIds);
    return undefined;
  });
}
