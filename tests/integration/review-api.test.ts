import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_OPENINGS, headerOf, mockReviewContent, taskOf, type MockReviewOptions, type MockTask } from '../../scripts/lib/mock-review.ts';
import { REVIEW_PROTOCOL, REVIEW_REDUCE_PROTOCOL, SUMMARY_PROTOCOL } from '../../src/server/checks/protocol';
import { isAnchored } from '../../src/shared/anchor';
import type { Chapter, Issue, Job, JobEstimate, JobReport, LlmProfile, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, startMockLlm, type MockLlm, type MockReply, type MockRequest } from '../helpers/mock-llm';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

type Handler = (req: MockRequest) => MockReply | Promise<MockReply>;
const reviewer =
  (options: MockReviewOptions = {}): Handler =>
  (req) =>
    completion(mockReviewContent(req.body, options));

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

async function setup(bodies: string[], handler: Handler = reviewer(), profile: Record<string, unknown> = {}): Promise<Env> {
  const llm = await startMockLlm(handler);
  const t = await startTestApp();
  opened.push(llm, { close: () => t.cleanup() });
  const p = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock-review', maxConcurrency: 1, ...profile });
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '审稿测试' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const volumeId = tree.volumes[0]!.id;
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < bodies.length; i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId, title: `第${i + 1}章` })).id);
  for (const [i, id] of ids.entries()) await ok(t, 'PUT', `${W}/chapters/${id}/body`, { body: bodies[i], baseRev: 0 });
  return { t, llm, profile: p, W, workId: work.id, ids };
}

async function runReview(env: Env, extra: Record<string, unknown> = {}): Promise<Job> {
  const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'review', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id, ...extra });
  await env.t.app.services.checks.whenIdle();
  const done = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`);
  expect(done.status, done.error ?? '').toBe('done');
  return done;
}

/** 按阶段统计 mock 收到的请求；from 之前的请求不计。 */
function requestsOf(env: Env, task: MockTask, from = 0): MockRequest[] {
  return env.llm.requests.slice(from).filter((r) => taskOf(r.body) === task);
}
const userOf = (r: MockRequest): string => r.body.messages?.find((m) => m.role === 'user')?.content ?? '';
const sizeOf = (r: MockRequest): number => (r.body.messages ?? []).reduce((n, m) => n + m.content.length, 0);
/** 请求属于哪一章：正文里的【C数字】标记。 */
const markerOf = (r: MockRequest): string => /## 待查正文[\s\S]*?【(C\d+)】/.exec(userOf(r))?.[1] ?? '?';

const book = (n: number, extra = ''): string[] =>
  Array.from({ length: n }, (_, i) => `【C${i}】第${i + 1}章。林远突然停下脚步，回头望去。${i % 2 === 0 ? '他非常非常紧张。' : ''}${extra}`);

const bodyHashOf = (env: Env, chapterId: string): string =>
  (env.t.app.services.pool.get(env.workId).prepare('SELECT body_hash FROM chapter WHERE id = ?').get(chapterId) as { body_hash: string }).body_hash;
const summaryRow = (env: Env, chapterId: string) =>
  env.t.app.services.pool.get(env.workId).prepare("SELECT body_hash, result FROM chapter_analysis WHERE chapter_id = ? AND kind = 'summary'").get(chapterId) as
    | { body_hash: string; result: string }
    | undefined;

describe('mock 模型与协议一致', () => {
  it('mock 按协议开头识别阶段', () => {
    expect(SUMMARY_PROTOCOL.startsWith(PROTOCOL_OPENINGS.summary)).toBe(true);
    expect(REVIEW_PROTOCOL.startsWith(PROTOCOL_OPENINGS.review)).toBe(true);
    expect(REVIEW_REDUCE_PROTOCOL.startsWith(PROTOCOL_OPENINGS.review_reduce)).toBe(true);
  });
});

describe('章节摘要（summary 阶段）与 chapter_analysis 缓存', () => {
  it('第二次运行命中缓存不再调用模型；某章被修改后只重新生成这一章的摘要；④ 前情提要取前 3 章摘要', async () => {
    const env = await setup(book(5));
    const job1 = await runReview(env);
    // 前 4 章是某一章的「前 3 章」之一，第 5 章不是
    expect(requestsOf(env, 'summary').map(markerOf)).toEqual(['C0', 'C1', 'C2', 'C3']);
    expect(requestsOf(env, 'review').map(markerOf)).toEqual(['C0', 'C1', 'C2', 'C3', 'C4']);
    expect(requestsOf(env, 'review_reduce')).toHaveLength(1);
    expect(job1.totalUnits).toBe(4 + 5 + 1);
    const bodies = book(5);
    for (const [i, id] of env.ids.slice(0, 4).entries()) {
      const row = summaryRow(env, id);
      expect(row?.body_hash).toBe(bodyHashOf(env, id));
      expect(JSON.parse(row!.result)).toEqual({ summary: `摘要：${bodies[i]!.slice(0, 24)}` });
    }
    expect(summaryRow(env, env.ids[4]!)).toBeUndefined();

    const recapOf = (r: MockRequest): string => {
      const u = userOf(r);
      const i = u.indexOf('## 前情提要');
      return i < 0 ? '' : u.slice(i, u.indexOf('## 待查正文'));
    };
    const mains = requestsOf(env, 'review');
    expect(recapOf(mains[0]!), '第一章没有前情提要').toBe('');
    expect(recapOf(mains[1]!)).toMatch(/【第1卷 [^·]+ · 第1章 /);
    const recap4 = recapOf(mains[4]!);
    expect(recap4.match(/【第1卷 [^】]*】摘要：/g)?.length, '第 5 章取前 3 章').toBe(3);
    expect(recap4.indexOf('【C1】') < recap4.indexOf('【C2】') && recap4.indexOf('【C2】') < recap4.indexOf('【C3】')).toBe(true);
    expect(recap4).not.toContain('【C0】');

    // 第二次：摘要全部命中缓存
    const n1 = env.llm.requests.length;
    const est = await ok<JobEstimate>(env.t, 'POST', `${env.W}/jobs/estimate`, { type: 'review', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });
    expect(est.units, '预估不含已缓存的摘要').toBe(5 + 1);
    await runReview(env);
    expect(requestsOf(env, 'summary', n1)).toEqual([]);
    expect(requestsOf(env, 'review', n1)).toHaveLength(5);

    // 改第 2 章：只重新生成它的摘要，第 3 章的前情提要用上新摘要
    const c1 = await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[1]}`);
    await ok(env.t, 'PUT', `${env.W}/chapters/${env.ids[1]}/body`, { body: '【C1】改写后的第二章。', baseRev: c1.rev });
    const n2 = env.llm.requests.length;
    await runReview(env);
    expect(requestsOf(env, 'summary', n2).map(markerOf)).toEqual(['C1']);
    expect(recapOf(requestsOf(env, 'review', n2)[2]!)).toContain('摘要：【C1】改写后的第二章。');
  });

  it('长章节分片生成摘要：片段乱序完成也按顺序合并；未凑齐时不算有效缓存', async () => {
    const para = (k: number): string => `第${k}段。${'风'.repeat(480)}`;
    const long = `【C0】${Array.from({ length: 30 }, (_, k) => para(k)).join('\n')}`;
    // 片段 1 慢、片段 2 快：完成顺序与片段顺序相反
    const env = await setup([long, '【C1】短章。'], async (req) => {
      const header = headerOf(userOf(req));
      return { ...completion(mockReviewContent(req.body)), delayMs: / 1\/[2-9]/.test(header) ? 150 : 0 };
    }, { maxConcurrency: 2 });
    await runReview(env);
    const pieceOf = (r: MockRequest): string => /片段 \d+\/\d+/.exec(headerOf(userOf(r)))?.[0] ?? '';
    expect(requestsOf(env, 'summary').map(pieceOf)).toEqual(['片段 1/2', '片段 2/2']);
    const row = summaryRow(env, env.ids[0]!);
    const merged = (JSON.parse(row!.result) as { summary: string }).summary;
    expect(merged.startsWith('摘要：【C0】第0段。')).toBe(true);
    expect(merged.split(' ')).toHaveLength(2);
    expect(row?.body_hash).toBe(bodyHashOf(env, env.ids[0]!));

    const report = await ok<JobReport>(env.t, 'GET', `${env.W}/jobs/${(await ok<Job[]>(env.t, 'GET', `${env.W}/jobs`))[0]!.id}/report`);
    const md = report.chapters.find((c) => c.chapterId === env.ids[0])!.markdown;
    const reviewChunks = requestsOf(env, 'review').filter((r) => headerOf(userOf(r)).includes(' · 第1章 ')).length;
    expect(reviewChunks).toBe(2);
    const sections = [...md.matchAll(/^\*\*片段 (\d+)\/(\d+)\*\*$/gm)].map((m) => `${m[1]}/${m[2]}`);
    expect(sections, '评语按片段顺序分节').toEqual(Array.from({ length: sections.length }, (_, i) => `${i + 1}/${sections.length}`));
    expect(sections.length).toBe(reviewChunks);
    expect(md.indexOf('片段 1/') < md.lastIndexOf(`片段 ${sections.length}/`)).toBe(true);
  });
});

describe('编辑审稿（main + reduce）与报告接口', () => {
  it('意见锚定为 review 类问题（可为不可修正），评语进入逐章报告，汇总生成整体报告；报告按目录顺序', async () => {
    const env = await setup(book(3));
    const job = await runReview(env);
    const report = await ok<JobReport>(env.t, 'GET', `${env.W}/jobs/${job.id}/report`);
    assertDto('JobReport', report);
    expect(report.overall).toContain('## 总体评价');
    expect(report.overall).toContain('共审读 3 章');
    expect(report.chapters.map((c) => c.chapterId)).toEqual(env.ids);
    expect(report.chapters[1]!.markdown).toMatch(/^评语：【第1卷 [^·]+ · 第2章 第2章 · 片段 1\/1】 本片段冲突清楚/);

    const issues = await ok<Issue[]>(env.t, 'GET', `${env.W}/issues?jobId=${job.id}`);
    expect(issues.every((i) => i.category === 'review')).toBe(true);
    expect(issues.map((i) => [i.target, i.replacement, i.severity])).toEqual([
      ['突然', null, 'info'],
      ['非常非常', '非常', 'warning'],
      ['突然', null, 'info'],
      ['突然', null, 'info'],
      ['非常非常', '非常', 'warning'],
    ]);
    for (const i of issues) expect(isAnchored((await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${i.chapterId}`)).body, i)).toBe(true);

    // 汇总的输入：各章标题、评语、问题与摘要
    const reduce = requestsOf(env, 'review_reduce')[0]!;
    const u = userOf(reduce);
    expect(u).toContain('【审稿汇总 · 共 3 章】');
    expect(u.match(/^### 第1卷 [^·]+ · 第\d章 /gm)).toHaveLength(3);
    expect(u).toContain('问题（2 处）：\n- 「突然」');
    expect(u).toContain('摘要：摘要：【C0】');

    // 有修改建议的审稿意见可以一键修正
    const fixable = issues.find((i) => i.replacement !== null)!;
    await ok(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [fixable.id] });
    expect((await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${fixable.chapterId}`)).body).toContain('他非常紧张。');

    // 已删除的章节不出现在报告中；其他类型的任务报告为空；任务不存在 404
    await ok(env.t, 'DELETE', `${env.W}/chapters/${env.ids[1]}`, undefined, 204);
    expect((await ok<JobReport>(env.t, 'GET', `${env.W}/jobs/${job.id}/report`)).chapters.map((c) => c.chapterId)).toEqual([env.ids[0], env.ids[2]]);
    const typo = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'typo', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });
    await env.t.app.services.checks.whenIdle();
    expect(await ok<JobReport>(env.t, 'GET', `${env.W}/jobs/${typo.id}/report`)).toEqual({ overall: null, chapters: [] });
    expect((await env.t.call('GET', `${env.W}/jobs/nope/report`)).status).toBe(404);

    // 删除任务时报告随之删除
    await ok(env.t, 'DELETE', `${env.W}/jobs/${job.id}`, undefined, 204);
    const left = env.t.app.services.pool.get(env.workId).prepare('SELECT count(*) AS n FROM job_report WHERE job_id = ?').get(job.id) as { n: number };
    expect(left.n).toBe(0);
  });

  it('汇总输入超过预算时按章均匀截断，提示词不超过预算', async () => {
    const env = await setup(book(40), reviewer({ commentPadding: '细节'.repeat(400) }), { contextTokens: 16_000, maxOutputTokens: 2000 });
    await runReview(env);
    const budget = 16_000 - 2000 - 1000;
    const reduce = requestsOf(env, 'review_reduce')[0]!;
    expect(sizeOf(reduce)).toBeLessThanOrEqual(budget);
    expect(sizeOf(reduce), '尽量用满预算').toBeGreaterThan(budget * 0.9);
    const u = userOf(reduce);
    expect(u.match(/^### /gm), '40 章都在').toHaveLength(40);
    expect(u.match(/…$/gm)?.length, '每章都被截断').toBe(40);
    for (const r of requestsOf(env, 'review')) expect(sizeOf(r)).toBeLessThanOrEqual(budget);
  });

  it('没有任何意见与评语时跳过汇总、不调用模型，整体报告为空', async () => {
    const env = await setup(book(2), reviewer({ silent: true }));
    const job = await runReview(env);
    expect(requestsOf(env, 'review_reduce')).toEqual([]);
    expect(job.doneUnits).toBe(job.totalUnits);
    expect(await ok<JobReport>(env.t, 'GET', `${env.W}/jobs/${job.id}/report`)).toEqual({ overall: null, chapters: [] });
  });

  it('摘要失败不影响审稿：前情提要省略该章，任务完成并记录失败的片段', async () => {
    const env = await setup(book(3), (req) => (taskOf(req.body) === 'summary' && markerOf(req) === 'C0' ? completion('不是 JSON') : completion(mockReviewContent(req.body))));
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'review', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });
    await env.t.app.services.checks.whenIdle();
    const done = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`);
    expect([done.status, done.failedUnits]).toEqual(['done', 1]);
    const mains = requestsOf(env, 'review');
    expect(userOf(mains[1]!)).not.toContain('## 前情提要');
    expect(userOf(mains[2]!)).toContain('【C1】');
    expect((await ok<JobReport>(env.t, 'GET', `${env.W}/jobs/${job.id}/report`)).overall).not.toBeNull();
  });
});
