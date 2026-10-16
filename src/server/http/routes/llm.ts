import type { CreateLlmProfileRequest, LlmDefaults, UpdateLlmProfileRequest } from '../../../shared/types';
import type { Llm } from '../../llm';
import { notFound } from '../errors';
import type { HandlerResult, RequestContext, Router } from '../router';
import { validateBody } from '../validate';

const json = (value: unknown): HandlerResult => ({ json: value });

function profileId(ctx: RequestContext): string {
  const id = ctx.params.id;
  if (id === undefined) throw notFound('模型配置不存在');
  return id;
}

/** 模型配置路由（§7.2）。所有响应只含掩码 Key（INV-17）。 */
export function registerLlmRoutes(router: Router, llm: Llm): void {
  router.get('/api/llm/presets', () => json(llm.presets()));

  router.get('/api/llm/profiles', () => json(llm.profiles.list()));
  router.post('/api/llm/profiles', async (ctx) => json(llm.createProfile(validateBody<CreateLlmProfileRequest>('createLlmProfile', await ctx.readJson()))));
  router.patch('/api/llm/profiles/:id', async (ctx) =>
    json(llm.updateProfile(profileId(ctx), validateBody<UpdateLlmProfileRequest>('updateLlmProfile', await ctx.readJson()))),
  );
  router.delete('/api/llm/profiles/:id', (ctx) => {
    llm.removeProfile(profileId(ctx));
    return undefined;
  });
  // 客户端断开（界面上「取消」或关闭页面）时中止测试，不再等模型响应
  router.post('/api/llm/profiles/:id/test', async (ctx) => {
    const controller = new AbortController();
    ctx.res.on('close', () => {
      if (!ctx.res.writableFinished) controller.abort();
    });
    return json(await llm.test(profileId(ctx), controller.signal));
  });
  router.get('/api/llm/status', () => json(llm.statuses()));

  router.get('/api/llm/defaults', () => json(llm.profiles.getDefaults()));
  router.put('/api/llm/defaults', async (ctx) =>
    json(llm.profiles.setDefaults(validateBody<LlmDefaults>('llmDefaults', await ctx.readJson()))),
  );
}
