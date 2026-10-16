import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_EXPANSION, PROTOCOL_OPENINGS, mockReviewContent, taskOf } from '../../scripts/lib/mock-review.ts';
import { targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { AI_FLAVOR_PROTOCOL, EXPAND_PROTOCOL, INSPIRATION_PROTOCOL } from '../../src/server/checks/protocol';
import { TASK_KINDS } from '../../src/shared/constants';
import type { Chapter, Expansion, Issue, Job, JobReport, LlmProfile, RevisionMeta, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, startMockLlm, type MockLlm, type MockRequest } from '../helpers/mock-llm';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

interface Env {
  t: TestApp;
  llm: MockLlm;
  profile: LlmProfile;
  W: string;
  workId: string;
  ids: string[];
}

async function ok<T>(t: TestApp, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  return res.json as T;
}

async function fail(t: TestApp, method: string, path: string, body: unknown, re: RegExp): Promise<Record<string, unknown>> {
  const res = await t.call(method, path, body);
  expect(res.status, res.body).toBe(400);
  const err = (res.json as { error: Record<string, unknown> }).error;
  expect(String(err.message)).toMatch(re);
  return err;
}

async function setup(bodies: string[]): Promise<Env> {
  const llm = await startMockLlm((req) => completion(mockReviewContent(req.body)));
  const t = await startTestApp();
  opened.push(llm, { close: () => t.cleanup() });
  const profile = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock-creative', maxConcurrency: 2 });
  await ok(t, 'PUT', '/api/llm/defaults', Object.fromEntries(TASK_KINDS.map((k) => [k, profile.id])));
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '青云志' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < bodies.length; i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: `第${i + 1}章` })).id);
  for (const [i, id] of ids.entries()) if (bodies[i] !== '') await ok(t, 'PUT', `${W}/chapters/${id}/body`, { body: bodies[i], baseRev: 0 });
  return { t, llm, profile, W, workId: work.id, ids };
}

async function run(env: Env, req: Record<string, unknown>): Promise<Job> {
  const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { profileId: env.profile.id, ...req });
  await env.t.app.services.checks.whenIdle();
  const done = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`);
  expect(done.status, done.error ?? '').toBe('done');
  return done;
}

const userOf = (r: MockRequest): string => r.body.messages?.find((m) => m.role === 'user')?.content ?? '';
const requestOf = (env: Env, task: string): MockRequest => {
  const r = env.llm.requests.filter((x) => taskOf(x.body) === task).at(-1);
  expect(r, `${task} 的请求`).toBeDefined();
  return r!;
};
const chapter = (env: Env, i: number) => ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[i]}`);
const chapterScope = (env: Env, i: number) => ({ kind: 'chapter', id: env.ids[i] });

const LONG = Array.from({ length: 30 }, (_, i) => `第${i + 1}段：林远在青云山修炼，山风吹过竹林，雾气在石阶上慢慢散开。`).join('\n');

describe('三个创作辅助子功能', () => {
  it('mock 按协议开头识别三段新协议', () => {
    expect(AI_FLAVOR_PROTOCOL.startsWith(PROTOCOL_OPENINGS.ai_flavor)).toBe(true);
    expect(INSPIRATION_PROTOCOL.startsWith(PROTOCOL_OPENINGS.inspiration)).toBe(true);
    expect(EXPAND_PROTOCOL.startsWith(PROTOCOL_OPENINGS.expand)).toBe(true);
  });

  it('AI 味检测：问题都带改写（category = ai_flavor），可以一键优化；③ 专名白名单', async () => {
    const body = '赵峰看着他，嘴角勾起一抹弧度。林远眼中闪过一丝冷意，没有说话。';
    const env = await setup([body]);
    await ok(env.t, 'POST', `${env.W}/bible/entries`, { kind: 'character', name: '林远' });
    await run(env, { type: 'ai_flavor', scope: { kind: 'work', id: env.workId } });
    expect(userOf(requestOf(env, 'ai_flavor'))).toContain('一律视为正确写法');
    const issues = (await ok<Issue[]>(env.t, 'GET', `${env.W}/issues`)).filter((i) => i.category === 'ai_flavor');
    assertDto('Issue', issues, true);
    expect(issues.map((i) => [i.target, i.replacement])).toEqual([
      ['嘴角勾起一抹弧度', '笑了笑'],
      ['眼中闪过一丝冷意', '眯起了眼'],
    ]);
    const res = await ok<{ applied: string[] }>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: issues.map((i) => i.id) });
    expect(res.applied).toHaveLength(2);
    expect((await chapter(env, 0)).body).toBe('赵峰看着他，笑了笑。林远眯起了眼，没有说话。');
  });

  it('灵感胶囊：只能针对当前章节；参考作品信息、上一章结尾与剧情记忆；报告含五条路线', async () => {
    const env = await setup([LONG, '林远回到山门，看见师姐站在台阶上。', '']);
    await ok(env.t, 'PATCH', env.W, { genre: '玄幻', synopsis: '少年林远拜入青云门，一步步揭开身世之谜。' });
    await fail(env.t, 'POST', `${env.W}/jobs`, { type: 'inspiration', scope: { kind: 'work', id: env.workId } }, /只能针对当前章节/);
    await fail(env.t, 'POST', `${env.W}/jobs`, { type: 'inspiration', scope: chapterScope(env, 1), options: { targetChars: 1000 } }, /只有智能扩写可以设置目标字数/);

    const job = await run(env, { type: 'inspiration', scope: chapterScope(env, 1) });
    const user = userOf(requestOf(env, 'inspiration'));
    expect(user).toContain('【作品】《青云志》（类型：玄幻）');
    expect(user).toContain('简介：少年林远拜入青云门');
    expect(user, '本章很短时附上一章结尾').toContain('【上一章结尾 · 第1卷第1章');
    expect(user).toContain('本章已写 17 字');
    const report = await ok<JobReport>(env.t, 'GET', `${env.W}/jobs/${job.id}/report`);
    assertDto('JobReport', report);
    const overall = report.overall ?? '';
    expect(overall).toContain('## 当前局势');
    expect(overall).toContain('## 情绪曲线');
    expect(overall).toContain('## 5 条剧情发展路线（接在第1卷第2章《第2章》之后）');
    for (const [i, title] of ['一：宗门危机', '二：师姐的秘密', '三：旧敌来访', '四：两难抉择', '五：玉佩之谜'].entries()) {
      expect(overall, `第 ${i + 1} 条路线`).toContain(`### 路线${title}`);
    }
    expect(overall).toContain('**剧情走向**：\n1. 节拍一\n2. 节拍二\n3. 节拍三');

    // 本章还没有正文：参考前文从头构思
    await run(env, { type: 'inspiration', scope: chapterScope(env, 2) });
    expect(userOf(requestOf(env, 'inspiration'))).toContain('（本章还没有正文）');
  });

  it('本章与前文都没有正文时不能发起', async () => {
    const env = await setup(['', '']);
    await fail(env.t, 'POST', `${env.W}/jobs`, { type: 'expand', scope: chapterScope(env, 1) }, /没有可以参考的前文/);
    await fail(env.t, 'POST', `${env.W}/jobs`, { type: 'inspiration', scope: chapterScope(env, 0) }, /没有可以参考的前文/);
  });

  it('智能扩写：只能针对当前章节；按目标字数续写；插入章末另起一段、存「扩写前」版本、不能重复插入', async () => {
    const env = await setup([LONG, '林远回到山门，看见师姐站在台阶上。']);
    await fail(env.t, 'POST', `${env.W}/jobs`, { type: 'expand', scope: { kind: 'volume', id: (await ok<WorkTree>(env.t, 'GET', `${env.W}/tree`)).volumes[0]!.id } }, /只根据前文完成当前这一章/);
    const bad = await env.t.call('POST', `${env.W}/jobs`, { type: 'expand', scope: chapterScope(env, 1), options: { targetChars: 100 } });
    expect(bad.status, '目标字数低于下限').toBe(400);

    const job = await run(env, { type: 'expand', scope: chapterScope(env, 1), options: { targetChars: 1000 } });
    expect(job.options).toEqual({ targetChars: 1000 });
    const req = requestOf(env, 'expand');
    expect(req.body.messages?.[0]?.content.startsWith(EXPAND_PROTOCOL)).toBe(true);
    expect(userOf(req)).toContain('续写约 1000 字');
    expect(targetTextOf(userOf(req))).toBe('林远回到山门，看见师姐站在台阶上。');

    const exp = await ok<Expansion>(env.t, 'GET', `${env.W}/jobs/${job.id}/expansion`);
    assertDto('Expansion', exp);
    expect(exp).toMatchObject({ chapterId: env.ids[1], text: MOCK_EXPANSION, status: 'ready', stale: false, appliedAt: null });

    const applied = await ok<{ inserted: string; rev: number }>(env.t, 'POST', `${env.W}/jobs/${job.id}/expansion/apply`, {});
    assertDto('ApplyExpansionResponse', applied);
    expect(applied.inserted, '上一句已写完：另起一段').toBe(`\n${MOCK_EXPANSION}`);
    const c = await chapter(env, 1);
    expect(c.body).toBe(`林远回到山门，看见师姐站在台阶上。\n${MOCK_EXPANSION}`);
    expect(c.rev).toBe(applied.rev);
    const revs = await ok<RevisionMeta[]>(env.t, 'GET', `${env.W}/chapters/${env.ids[1]}/revisions`);
    expect(revs.some((r) => r.reason === 'before_expand')).toBe(true);
    expect((await ok<Expansion>(env.t, 'GET', `${env.W}/jobs/${job.id}/expansion`)).status).toBe('applied');
    await fail(env.t, 'POST', `${env.W}/jobs/${job.id}/expansion/apply`, {}, /已经插入过/);
  });

  it('扩写之后本章有改动：标为 stale，插入需要确认（force）；最大输出不够时不能发起', async () => {
    const env = await setup([LONG, '林远回到山门']);
    const job = await run(env, { type: 'expand', scope: chapterScope(env, 1) });
    expect(job.options).toEqual({ targetChars: 2000 });
    const c = await chapter(env, 1);
    await ok(env.t, 'PUT', `${env.W}/chapters/${env.ids[1]}/body`, { body: '林远回到山门，天已经黑了', baseRev: c.rev });
    expect((await ok<Expansion>(env.t, 'GET', `${env.W}/jobs/${job.id}/expansion`)).stale).toBe(true);
    const err = await fail(env.t, 'POST', `${env.W}/jobs/${job.id}/expansion/apply`, {}, /扩写之后有改动/);
    expect(err.stale).toBe(true);
    const applied = await ok<{ inserted: string }>(env.t, 'POST', `${env.W}/jobs/${job.id}/expansion/apply`, { force: true });
    expect(applied.inserted, '上一句没写完：直接接上').toBe(MOCK_EXPANSION);

    const small = await ok<LlmProfile>(env.t, 'POST', '/api/llm/profiles', { name: '小输出', baseUrl: env.llm.baseUrl, model: 'm', maxOutputTokens: 1000 });
    await fail(env.t, 'POST', `${env.W}/jobs`, { type: 'expand', scope: chapterScope(env, 1), profileId: small.id, options: { targetChars: 3000 } }, /最大输出/);
    await fail(env.t, 'POST', `${env.W}/jobs/${job.id}/expansion/apply`, { force: true }, /已经插入过/);
    const other = await run(env, { type: 'ai_flavor', scope: chapterScope(env, 1) });
    expect((await env.t.call('GET', `${env.W}/jobs/${other.id}/expansion`)).status, '其他类型的任务没有扩写结果').toBe(404);
  });
});
