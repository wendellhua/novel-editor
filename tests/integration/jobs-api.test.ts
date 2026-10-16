import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mockTypoContent, targetTextOf } from '../../scripts/lib/mock-typo.ts';
import type { Chapter, Job, JobEstimate, LlmProfile, ServerEvent, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, errorReply, startMockLlm, type MockLlm, type MockReply, type MockRequest } from '../helpers/mock-llm';
import { makeTempDir } from '../helpers/tmp';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

async function ok<T>(t: TestApp, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  return res.json as T;
}

async function fail(t: TestApp, method: string, path: string, body: unknown, status: number, re?: RegExp): Promise<void> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  if (re !== undefined) expect((res.json as { error: { message: string } }).error.message).toMatch(re);
}

/** 每个请求从「待查正文」里取出章节标记（【Cn】），用来判断哪些章节被请求过。 */
const markerOf = (req: MockRequest): string => /【C(\d+)】/.exec(targetTextOf(req.body.messages?.find((m) => m.role === 'user')?.content ?? ''))?.[1] ?? '?';
const typoReply = (req: MockRequest): MockReply => completion(mockTypoContent(req.body), { promptTokens: 100, completionTokens: 20 });

interface Env {
  t: TestApp;
  llm: MockLlm;
  profile: LlmProfile;
  W: string;
  workId: string;
  chapters: Chapter[];
}

/** 一部作品：n 章，每章「【Ck】……在接再厉……」；一个指向 mock 的模型配置。 */
async function setup(options: { chapters?: number; concurrency?: number; handler?: (req: MockRequest, i: number) => MockReply | Promise<MockReply>; dataDir?: string } = {}): Promise<Env> {
  const llm = await startMockLlm(options.handler ?? typoReply);
  const t = await startTestApp({ dataDir: options.dataDir });
  opened.push(llm, { close: () => t.cleanup() });
  const profile = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', {
    name: 'Mock',
    baseUrl: llm.baseUrl,
    model: 'mock-model',
    maxConcurrency: options.concurrency ?? 2,
  });
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '检查测试' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const volumeId = tree.volumes[0]!.id;
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < (options.chapters ?? 4); i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId, title: `第${i + 1}章` })).id);
  const chapters: Chapter[] = [];
  for (const [i, id] of ids.entries()) {
    await ok(t, 'PUT', `${W}/chapters/${id}/body`, { body: `【C${i}】他在接再厉，终于练成了第${i}式。\n第二段没有错误。`, baseRev: 0 });
    chapters.push(await ok<Chapter>(t, 'GET', `${W}/chapters/${id}`));
  }
  return { t, llm, profile, W, workId: work.id, chapters };
}

const typoJob = (env: Env, patch: Record<string, unknown> = {}) => ({
  type: 'typo',
  scope: { kind: 'work', id: env.workId },
  profileId: env.profile.id,
  ...patch,
});

async function waitJob(env: Env, id: string, pred: (j: Job) => boolean, timeoutMs = 10_000): Promise<Job> {
  const t0 = Date.now();
  for (;;) {
    const job = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${id}`);
    if (pred(job)) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待任务超时：${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const dbOf = (env: Env) => env.t.app.services.pool.get(env.workId);
const issuesOf = (env: Env, jobId: string) =>
  dbOf(env).prepare('SELECT chapter_id, target, replacement, start_offset AS s, end_offset AS e, body_hash FROM issue WHERE job_id = ? ORDER BY chapter_id').all(jobId) as {
    chapter_id: string;
    target: string;
    replacement: string;
    s: number;
    e: number;
    body_hash: string;
  }[];

/** 订阅 SSE，收集 ServerEvent。 */
function collectEvents(t: TestApp, workId: string): { events: ServerEvent[]; close(): void } {
  const events: ServerEvent[] = [];
  let buf = '';
  const req = request({
    host: '127.0.0.1',
    port: t.app.port,
    path: `/api/events?workId=${workId}`,
    headers: { Host: `127.0.0.1:${t.app.port}`, Cookie: t.cookie },
  });
  req.on('response', (res) => {
    res.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line !== undefined) events.push(JSON.parse(line.slice(6)) as ServerEvent);
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return { events, close: () => req.destroy() };
}

describe('检查任务：校验与预估（§7.2）', () => {
  it('预估：章节数、字数、单元数与输入 token；不写入任何任务', async () => {
    const env = await setup();
    const e = await ok<JobEstimate>(env.t, 'POST', `${env.W}/jobs/estimate`, typoJob(env));
    assertDto('JobEstimate', e);
    expect(e).toMatchObject({ chapters: 4, units: 4, skippedChapters: 0 });
    expect(e.chars).toBe(env.chapters.reduce((n, c) => n + c.body.length, 0));
    expect(e.estimatedInputTokens).toBeGreaterThan(e.chars + 4 * 1000);
    expect(await ok<Job[]>(env.t, 'GET', `${env.W}/jobs`)).toEqual([]);
    expect(env.llm.requests).toHaveLength(0);
  });

  it('各类不合法请求：400 / 404，且不创建任务', async () => {
    const env = await setup();
    const P = `${env.W}/jobs`;
    await fail(env.t, 'POST', P, typoJob(env, { profileId: undefined }), 400, /尚未为这类任务选择模型/);
    await fail(env.t, 'POST', P, typoJob(env, { profileId: 'ghost' }), 400, /所选模型配置不存在/);
    await fail(env.t, 'POST', P, typoJob(env, { skillId: 'builtin:editorial-review' }), 400, /不适用于「错别字与标点」/);
    await fail(env.t, 'POST', P, typoJob(env, { skillId: 'local:none' }), 400, /所选技能不存在/);
    await fail(env.t, 'POST', P, typoJob(env, { scope: { kind: 'chapter', id: 'nope' } }), 404);
    await fail(env.t, 'POST', P, typoJob(env, { scope: { kind: 'work', id: 'other' } }), 404);
    await fail(env.t, 'POST', P, typoJob(env, { extra: 1 }), 400, /不支持的字段/);
    const empty = await ok<Chapter>(env.t, 'POST', `${env.W}/chapters`, { volumeId: env.chapters[0]!.volumeId, title: '空章' });
    await fail(env.t, 'POST', P, typoJob(env, { scope: { kind: 'chapter', id: empty.id } }), 400, /没有需要检查的正文/);
    const small = await ok<LlmProfile>(env.t, 'POST', '/api/llm/profiles', {
      name: '小上下文',
      baseUrl: env.llm.baseUrl,
      model: 'm',
      contextTokens: 6000,
      maxOutputTokens: 1000,
    });
    await fail(env.t, 'POST', P, typoJob(env, { profileId: small.id }), 400, /上下文长度不足/);
    expect(await ok<Job[]>(env.t, 'GET', P)).toEqual([]);
    // 设置默认模型后可以省略 profileId
    const defaults = await ok<Record<string, string | null>>(env.t, 'GET', '/api/llm/defaults');
    await ok(env.t, 'PUT', '/api/llm/defaults', { ...defaults, typo: env.profile.id });
    const job = await ok<Job>(env.t, 'POST', P, typoJob(env, { profileId: undefined }));
    expect(job.profileId).toBe(env.profile.id);
    expect(job.skillId).toBe('builtin:typo-check');
  });
});

describe('检查任务：执行（F3）', () => {
  it('作品级错别字检查：完成、问题逐字锚定（INV-7）、用量累计、SSE 推送 job.updated', async () => {
    const env = await setup();
    const sse = collectEvents(env.t, env.workId);
    opened.push({ close: async () => sse.close() });
    await new Promise((r) => setTimeout(r, 50));
    const created = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    assertDto('Job', created);
    const done = await waitJob(env, created.id, (j) => j.status === 'done');
    assertDto('Job', done);
    expect(done).toMatchObject({ totalUnits: 4, doneUnits: 4, failedUnits: 0, promptTokens: 400, completionTokens: 80, error: null });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();

    const issues = issuesOf(env, created.id);
    expect(issues).toHaveLength(4);
    for (const i of issues) {
      const ch = env.chapters.find((c) => c.id === i.chapter_id)!;
      expect(ch.body.slice(i.s, i.e)).toBe('在接再厉');
      expect(i).toMatchObject({ target: '在接再厉', replacement: '再接再厉' });
    }
    // 提示词：system = ① + ②，user 含 ⑥ 片段标题；json_object 档带 response_format
    const first = env.llm.requests[0]!;
    expect(first.body.response_format).toEqual({ type: 'json_object' });
    expect(first.body.messages?.[0]?.content).toContain('## 检查规则（技能：错别字与标点检查）');
    expect(first.body.messages?.[1]?.content).toMatch(/## 待查正文\n\n【第1卷 第一卷 · 第\d+章 .+ · 片段 1\/1】\n【C\d】/);

    await new Promise((r) => setTimeout(r, 50));
    const statuses = sse.events.filter((e) => e.type === 'job.updated').map((e) => (e as { job: Job }).job.status);
    expect(statuses[0]).toBe('queued');
    expect(statuses).toContain('running');
    expect(statuses.at(-1)).toBe('done');
    expect(await ok<Job[]>(env.t, 'GET', `${env.W}/jobs`)).toHaveLength(1);
  });

  it('INV-11：模型两次输出都不合格（坏 JSON / 违反 Schema）时，该单元失败且不写入任何问题；其他单元正常', async () => {
    const env = await setup({
      chapters: 3,
      handler: (req) => {
        const m = markerOf(req);
        if (m === '1') return completion('{"issues": [{"excerpt": "未闭合');
        if (m === '2') return completion(JSON.stringify({ issues: [{ excerpt: '他在接再厉，终于', target: '在接再厉', replacement: '再接再厉', category: 'spelling', severity: 'error', message: 'x' }] }));
        return typoReply(req);
      },
    });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    const done = await waitJob(env, job.id, (j) => j.status === 'done');
    expect(done).toMatchObject({ totalUnits: 3, doneUnits: 1, failedUnits: 2 });
    expect(new Set(issuesOf(env, job.id).map((i) => i.chapter_id))).toEqual(new Set([env.chapters[0]!.id]));
    expect(env.llm.requests.filter((r) => markerOf(r) === '1'), '修复重试 1 次').toHaveLength(2);
    const units = dbOf(env).prepare("SELECT chapter_id, status, attempts, error FROM job_unit WHERE job_id = ? AND status = 'failed'").all(job.id) as {
      error: string;
      attempts: number;
    }[];
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.attempts === 1 && /修复重试后仍不符合要求/.test(u.error))).toBe(true);
  });

  it('onlyChanged：只为改动过的章节生成单元', async () => {
    const env = await setup();
    const first = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    await waitJob(env, first.id, (j) => j.status === 'done');
    const changed = env.chapters[2]!;
    await ok(env.t, 'PUT', `${env.W}/chapters/${changed.id}/body`, { body: `${changed.body}\n新加的一但段落。`, baseRev: changed.rev });
    const e = await ok<JobEstimate>(env.t, 'POST', `${env.W}/jobs/estimate`, typoJob(env, { onlyChanged: true }));
    expect(e).toMatchObject({ chapters: 1, units: 1, skippedChapters: 3 });
    env.llm.requests.length = 0;
    const second = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env, { onlyChanged: true }));
    await waitJob(env, second.id, (j) => j.status === 'done');
    expect(env.llm.requests.map(markerOf)).toEqual(['2']);
    // 「在接再厉」在第一个任务里仍待处理（重新锚定后位置一致），不再重复列出（§7.4.3 第 5 步）
    expect(issuesOf(env, second.id).map((i) => i.target)).toEqual(['一但']);
    await fail(env.t, 'POST', `${env.W}/jobs`, typoJob(env, { onlyChanged: true }), 400, /都没有改动/);
  });

  it('暂停 → 恢复：中止进行中的请求；恢复后跳过已完成单元，最终每章恰好完成一次（INV-18）', async () => {
    const env = await setup({ chapters: 6, concurrency: 1, handler: (req) => ({ ...typoReply(req), delayMs: 120 }) });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    await waitJob(env, job.id, (j) => j.doneUnits >= 2);
    const paused = await ok<Job>(env.t, 'POST', `${env.W}/jobs/${job.id}/pause`);
    expect(paused.status).toBe('paused');
    expect(paused.doneUnits + paused.failedUnits).toBeLessThan(paused.totalUnits);
    const doneBefore = new Set(
      (dbOf(env).prepare("SELECT chapter_id FROM job_unit WHERE job_id = ? AND status = 'done'").all(job.id) as { chapter_id: string }[]).map((r) => r.chapter_id),
    );
    const before = env.llm.requests.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(env.llm.requests.length, '暂停后不再发请求').toBe(before);
    expect((await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`)).status).toBe('paused');

    await ok<Job>(env.t, 'POST', `${env.W}/jobs/${job.id}/resume`);
    const done = await waitJob(env, job.id, (j) => j.status === 'done');
    expect(done).toMatchObject({ totalUnits: 6, doneUnits: 6, failedUnits: 0 });
    const afterResume = env.llm.requests.slice(before).map(markerOf);
    const doneMarkers = env.chapters.filter((c) => doneBefore.has(c.id)).map((c) => /【C(\d+)】/.exec(c.body)?.[1]);
    for (const m of doneMarkers) expect(afterResume, `已完成的 C${m} 不应重复执行`).not.toContain(m);
    expect(issuesOf(env, job.id)).toHaveLength(6);
    await fail(env.t, 'POST', `${env.W}/jobs/${job.id}/resume`, undefined, 400, /已结束/);
    await fail(env.t, 'POST', `${env.W}/jobs/${job.id}/pause`, undefined, 400, /已结束/);
  });

  it('取消与删除：取消后不再执行；删除任务同时删除其问题', async () => {
    const env = await setup({ chapters: 5, concurrency: 1, handler: (req) => ({ ...typoReply(req), delayMs: 100 }) });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    await waitJob(env, job.id, (j) => j.doneUnits >= 1);
    const cancelled = await ok<Job>(env.t, 'POST', `${env.W}/jobs/${job.id}/cancel`);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();
    await fail(env.t, 'POST', `${env.W}/jobs/${job.id}/resume`, undefined, 400);
    expect(issuesOf(env, job.id).length).toBeGreaterThan(0);
    await ok(env.t, 'DELETE', `${env.W}/jobs/${job.id}`, undefined, 204);
    expect(issuesOf(env, job.id)).toHaveLength(0);
    await fail(env.t, 'GET', `${env.W}/jobs/${job.id}`, undefined, 404);
  });

  it('排队：一次只运行一个任务（FIFO）；排队中的任务可以直接暂停', async () => {
    const env = await setup({ chapters: 3, concurrency: 1, handler: (req) => ({ ...typoReply(req), delayMs: 60 }) });
    const a = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    const b = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    const c = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    expect(a.status).toBe('running');
    expect([b.status, c.status]).toEqual(['queued', 'queued']);
    expect((await ok<Job>(env.t, 'POST', `${env.W}/jobs/${c.id}/pause`)).status).toBe('paused');
    await waitJob(env, b.id, (j) => j.status === 'done');
    const ja = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${a.id}`);
    const jb = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${b.id}`);
    expect(ja.finishedAt ?? 0).toBeLessThanOrEqual(jb.startedAt ?? 0);
    expect((await ok<Job>(env.t, 'GET', `${env.W}/jobs/${c.id}`)).status).toBe('paused');
  });
});

describe('检查任务：失败与恢复', () => {
  it('鉴权失败（401）让整个任务失败并保留进度；修好后恢复即完成', async () => {
    let broken = true;
    const env = await setup({ handler: (req) => (broken ? errorReply(401, 'invalid api key') : typoReply(req)) });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    const failed = await waitJob(env, job.id, (j) => j.status === 'failed');
    expect(failed.error).toMatch(/401/);
    expect(failed.doneUnits + failed.failedUnits).toBe(0);
    broken = false;
    await ok<Job>(env.t, 'POST', `${env.W}/jobs/${job.id}/resume`);
    const done = await waitJob(env, job.id, (j) => j.status === 'done');
    expect(done).toMatchObject({ doneUnits: 4, failedUnits: 0, error: null });
  });

  it('连续 3 个片段失败且没有任何成功（如模型名错误返回 400）→ 任务失败；恢复时失败的单元重新执行', async () => {
    let broken = true;
    const env = await setup({ chapters: 5, concurrency: 1, handler: (req) => (broken ? errorReply(400, 'Model Not Exist') : typoReply(req)) });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    const failed = await waitJob(env, job.id, (j) => j.status === 'failed');
    expect(failed.error).toMatch(/连续 3 个片段失败.*Model Not Exist/);
    expect(failed.failedUnits).toBe(3);
    broken = false;
    await ok(env.t, 'POST', `${env.W}/jobs/${job.id}/resume`);
    const done = await waitJob(env, job.id, (j) => j.status === 'done');
    expect(done).toMatchObject({ totalUnits: 5, doneUnits: 5, failedUnits: 0 });
  });

  it('检查期间改稿与删章：改过的章节按当前正文重新切分，删除的章节移出任务，问题按执行时的正文锚定', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const env = await setup({
      chapters: 4,
      concurrency: 1,
      handler: async (req) => {
        if (markerOf(req) === '0') await gate;
        return typoReply(req);
      },
    });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    await new Promise((r) => setTimeout(r, 100));
    const edited = env.chapters[2]!;
    const newBody = `新的开头。\n${edited.body.replace('【C2】', '【C2】迫不急待地')}`;
    await ok(env.t, 'PUT', `${env.W}/chapters/${edited.id}/body`, { body: newBody, baseRev: edited.rev });
    await ok(env.t, 'DELETE', `${env.W}/chapters/${env.chapters[3]!.id}`, undefined, 204);
    release();
    const done = await waitJob(env, job.id, (j) => j.status === 'done');
    expect(done).toMatchObject({ totalUnits: 3, doneUnits: 3, failedUnits: 0 });
    const issues = issuesOf(env, job.id).filter((i) => i.chapter_id === edited.id);
    expect(issues.map((i) => i.target).sort()).toEqual(['在接再厉', '迫不急待']);
    for (const i of issues) expect(newBody.slice(i.s, i.e)).toBe(i.target);
    expect(env.llm.requests.map(markerOf)).not.toContain('3');
  });

  it('退出程序时运行中的任务转为暂停；重启后恢复完成，不重复执行已完成单元', async () => {
    const tmp = makeTempDir('ne-jobs-restart-');
    opened.push({ close: async () => tmp.cleanup() });
    const env = await setup({ chapters: 5, concurrency: 1, dataDir: tmp.dir, handler: (req) => ({ ...typoReply(req), delayMs: 80 }) });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    await waitJob(env, job.id, (j) => j.doneUnits >= 2);
    // 正常退出流程（重复调用 close 是安全的，afterEach 还会再调一次）
    await env.t.app.close();
    const firstRun = env.llm.requests.map(markerOf);

    const t2 = await startTestApp({ dataDir: tmp.dir });
    opened.push({ close: () => t2.cleanup() });
    const W = `/api/works/${env.workId}`;
    const after = await ok<Job>(t2, 'GET', `${W}/jobs/${job.id}`);
    expect(after.status).toBe('paused');
    const doneBefore = after.doneUnits;
    env.llm.requests.length = 0;
    await ok(t2, 'POST', `${W}/jobs/${job.id}/resume`);
    await t2.app.services.checks.whenIdle();
    const final = await ok<Job>(t2, 'GET', `${W}/jobs/${job.id}`);
    expect(final).toMatchObject({ status: 'done', totalUnits: 5, doneUnits: 5 });
    expect(env.llm.requests.length).toBe(5 - doneBefore);
    expect(new Set([...firstRun.slice(0, doneBefore), ...env.llm.requests.map(markerOf)]).size).toBe(5);
  });

  it('删除作品时正在运行的任务先暂停并释放连接，作品正常进入回收站', async () => {
    const env = await setup({ chapters: 4, concurrency: 1, handler: (req) => ({ ...typoReply(req), delayMs: 100 }) });
    await ok<Job>(env.t, 'POST', `${env.W}/jobs`, typoJob(env));
    await new Promise((r) => setTimeout(r, 50));
    await ok(env.t, 'DELETE', env.W, undefined, 204);
    const trash = await ok<{ workId: string }[]>(env.t, 'GET', '/api/trash/works');
    expect(trash.map((x) => x.workId)).toContain(env.workId);
    await env.t.app.services.checks.whenIdle();
  });
});
