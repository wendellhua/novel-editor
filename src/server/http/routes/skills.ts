import { BODY_LIMITS } from '../../../shared/constants';
import type { HubInstallRequest, ImportSkillFilesRequest, UpdateSkillRequest } from '../../../shared/types';
import type { Skills } from '../../skills';
import { badRequest, notFound } from '../errors';
import type { HandlerResult, RequestContext, Router } from '../router';
import { validateBody } from '../validate';

const json = (value: unknown): HandlerResult => ({ json: value });

function skillId(ctx: RequestContext): string {
  const id = ctx.params.id;
  if (id === undefined) throw notFound('技能不存在');
  return id;
}

function requiredQuery(ctx: RequestContext, name: string): string {
  const v = ctx.query.get(name)?.trim() ?? '';
  if (v === '') throw badRequest(`缺少参数 ${name}`);
  return v;
}

/** 技能路由（§7.2）。技能 id 含 `:` 与 `/`，前端必须 encodeURIComponent 后放进路径。 */
export function registerSkillRoutes(router: Router, skills: Skills): void {
  router.get('/api/skills', () => json(skills.list()));
  router.get('/api/skills/:id', (ctx) => json(skills.detail(skillId(ctx))));
  router.patch('/api/skills/:id', async (ctx) =>
    json(skills.update(skillId(ctx), validateBody<UpdateSkillRequest>('updateSkill', await ctx.readJson()))),
  );
  router.delete('/api/skills/:id', (ctx) => {
    skills.remove(skillId(ctx));
    return undefined;
  });

  router.post(
    '/api/skills/import',
    async (ctx) => {
      const type = ctx.req.headers['content-type'] ?? '';
      if (/^application\/(zip|x-zip-compressed|octet-stream)\b/i.test(type)) return json(skills.importZip(await ctx.readBody()));
      return json(skills.importFiles(validateBody<ImportSkillFilesRequest>('importSkillFiles', await ctx.readJson())));
    },
    { bodyLimit: BODY_LIMITS.skillImport },
  );

  router.get('/api/skills/hub/search', async (ctx) => {
    const q = requiredQuery(ctx, 'q');
    const limit = Number(ctx.query.get('limit') ?? '20');
    return json(await skills.hubSearch(q.slice(0, 100), Number.isFinite(limit) ? limit : 20));
  });
  router.get('/api/skills/hub/detail', async (ctx) =>
    json(await skills.hubDetail(requiredQuery(ctx, 'namespace'), requiredQuery(ctx, 'slug'))),
  );
  router.post('/api/skills/hub/install', async (ctx) =>
    json(await skills.hubInstall(validateBody<HubInstallRequest>('hubInstall', await ctx.readJson()))),
  );
}
