import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mockTypoContent } from '../../scripts/lib/mock-typo.ts';
import { isAnchored } from '../../src/shared/anchor';
import type { ApplyIssuesResponse, Chapter, Issue, Job, LlmProfile, RevisionDetail, RevisionMeta, ServerEvent, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, startMockLlm, type MockLlm, type MockReply, type MockRequest } from '../helpers/mock-llm';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

type Handler = (req: MockRequest) => MockReply;
const typoReply: Handler = (req) => completion(mockTypoContent(req.body));
/** 让模型固定返回 issues（与 TypoOutput 结构一致）。 */
const fixed = (issues: object[]): Handler => () => completion(JSON.stringify({ issues }));
const typo = (excerpt: string, target: string, replacement: string, category = 'typo') => ({ excerpt, target, replacement, category, severity: 'error', message: '测试' });

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

async function setup(bodies: string[], handler: Handler = typoReply): Promise<Env> {
  const llm = await startMockLlm(handler);
  const t = await startTestApp();
  opened.push(llm, { close: () => t.cleanup() });
  const profile = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'm', maxConcurrency: 1 });
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '问题测试' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const volumeId = tree.volumes[0]!.id;
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < bodies.length; i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId, title: `第${i + 1}章` })).id);
  for (const [i, id] of ids.entries()) await ok(t, 'PUT', `${W}/chapters/${id}/body`, { body: bodies[i], baseRev: 0 });
  return { t, llm, profile, W, workId: work.id, ids };
}

async function runTypo(env: Env, scope = { kind: 'work', id: env.workId }): Promise<Job> {
  const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'typo', scope, profileId: env.profile.id });
  await env.t.app.services.checks.whenIdle();
  const done = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`);
  expect(done.status).toBe('done');
  return done;
}

const chapter = (env: Env, i: number) => ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[i]}`);
const issues = (env: Env, query = '') => ok<Issue[]>(env.t, 'GET', `${env.W}/issues${query}`);
const save = async (env: Env, i: number, body: string): Promise<void> => {
  const c = await chapter(env, i);
  await ok(env.t, 'PUT', `${env.W}/chapters/${c.id}/body`, { body, baseRev: c.rev });
};
const dbRow = (env: Env, id: string) =>
  env.t.app.services.pool.get(env.workId).prepare('SELECT status, body_hash, start_offset AS s, end_offset AS e, excerpt FROM issue WHERE id = ?').get(id) as {
    status: string;
    body_hash: string;
    s: number;
    e: number;
    excerpt: string;
  };

function collectEvents(t: TestApp, workId: string): { events: ServerEvent[]; close(): void } {
  const events: ServerEvent[] = [];
  let buf = '';
  const req = request({ host: '127.0.0.1', port: t.app.port, path: `/api/events?workId=${workId}`, headers: { Host: `127.0.0.1:${t.app.port}`, Cookie: t.cookie } });
  req.on('response', (res) =>
    res.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line !== undefined) events.push(JSON.parse(line.slice(6)) as ServerEvent);
      }
    }),
  );
  req.on('error', () => undefined);
  req.end();
  return { events, close: () => req.destroy() };
}

describe('读取问题（§7.2）与重新锚定（INV-7）', () => {
  it('DTO、按卷章与位置排序、过滤条件；改稿后读取时自动重新锚定，问题文字被改掉的标为失效', async () => {
    const env = await setup(['【C0】众人迫不急待地围了上来，他在接再厉。', '【C1】一但开始就停不下来。']);
    const job = await runTypo(env);
    const all = await issues(env);
    assertDto('Issue', all, true);
    expect(all.map((i) => i.target)).toEqual(['迫不急待', '在接再厉', '一但']);
    expect(all.map((i) => i.chapterId)).toEqual([env.ids[0], env.ids[0], env.ids[1]]);
    expect(all.every((i) => i.status === 'open' && i.jobId === job.id && i.replacement !== null)).toBe(true);
    expect((await issues(env, `?chapterId=${env.ids[1]}`)).map((i) => i.target)).toEqual(['一但']);
    expect(await issues(env, `?jobId=${job.id}&status=open&category=typo`)).toHaveLength(3);
    expect(await issues(env, '?status=applied')).toEqual([]);
    expect((await env.t.call('GET', `${env.W}/issues?status=bogus`)).status).toBe(400);
    expect((await env.t.call('GET', `${env.W}/issues?category=bogus`)).status).toBe(400);

    await save(env, 0, `新加的开头。\n【C0】众人迫不急待地围了上来，他在接再厉。`);
    const c0 = await chapter(env, 0);
    const moved = await issues(env, `?chapterId=${env.ids[0]}`);
    expect(moved.map((i) => i.start)).toEqual(all.slice(0, 2).map((i) => i.start + 7));
    for (const i of moved) expect(isAnchored(c0.body, i)).toBe(true);
    const hashBefore = dbRow(env, moved[0]!.id).body_hash;

    await save(env, 0, c0.body.replace('迫不急待', '迫不及待'));
    const after = await issues(env, `?chapterId=${env.ids[0]}`);
    expect(after.map((i) => [i.target, i.status])).toEqual([
      ['迫不急待', 'stale'],
      ['在接再厉', 'open'],
    ]);
    expect(dbRow(env, after[1]!.id).body_hash, '重新锚定后更新为当前正文的哈希').not.toBe(hashBefore);
    expect(isAnchored((await chapter(env, 0)).body, after[1]!)).toBe(true);
  });
});

describe('一键修正（F4）', () => {
  it('逐条采纳：before_fix 版本、rev 加 1、推送 chapter.updated；同章相邻问题随之平移、仍可采纳', async () => {
    const body = '【C0】他在接再厉，迫不急待地出发了。';
    const env = await setup([body]);
    await runTypo(env);
    const [first, second] = await issues(env);
    expect([first?.target, second?.target]).toEqual(['在接再厉', '迫不急待']);
    expect(second!.start - first!.end, '两处相邻，在接再厉的 excerpt 覆盖了迫不急待的一部分').toBeLessThan(4);
    const before = await chapter(env, 0);
    const sse = collectEvents(env.t, env.workId);
    opened.push({ close: async () => sse.close() });
    await new Promise((r) => setTimeout(r, 50));

    const res = await ok<ApplyIssuesResponse>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [second!.id] });
    assertDto('ApplyIssuesResponse', res);
    expect(res).toEqual({ applied: [second!.id], stale: [], chapters: [{ id: env.ids[0], rev: before.rev + 1 }] });
    const fixed1 = await chapter(env, 0);
    expect(fixed1.body).toBe('【C0】他在接再厉，迫不及待地出发了。');
    expect(fixed1.rev).toBe(before.rev + 1);
    const revs = await ok<RevisionMeta[]>(env.t, 'GET', `${env.W}/chapters/${env.ids[0]}/revisions`);
    const bf = revs.find((r) => r.reason === 'before_fix');
    expect(bf).toBeDefined();
    expect((await ok<RevisionDetail>(env.t, 'GET', `${env.W}/chapters/${env.ids[0]}/revisions/${bf!.id}`)).body).toBe(body);
    await new Promise((r) => setTimeout(r, 50));
    expect(sse.events).toContainEqual({ type: 'chapter.updated', workId: env.workId, chapterId: env.ids[0], rev: fixed1.rev });

    const rest = await issues(env);
    expect(rest.map((i) => [i.target, i.status])).toEqual([
      ['在接再厉', 'open'],
      ['迫不急待', 'applied'],
    ]);
    expect(fixed1.body.includes(dbRow(env, first!.id).excerpt), '相邻问题的 excerpt 已按新正文重新截取').toBe(true);
    const res2 = await ok<ApplyIssuesResponse>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [first!.id] });
    expect(res2.applied).toEqual([first!.id]);
    expect((await chapter(env, 0)).body).toBe('【C0】他再接再厉，迫不及待地出发了。');
    expect((await ok<RevisionMeta[]>(env.t, 'GET', `${env.W}/chapters/${env.ids[0]}/revisions`)).filter((r) => r.reason === 'before_fix')).toHaveLength(2);
  });

  it('批量采纳跨章节：每章一个事务、各自 rev 加 1；范围重叠时保留 start 较小的，另一个返回 stale 并保持 open', async () => {
    const env = await setup(['【C0】他在接再厉，终于练成。', '【C1】一但开始就停不下来。'], (req) =>
      /【C0】/.test(JSON.stringify(req.body.messages))
        ? fixed([typo('他在接再厉，', '在接再厉', '再接再厉'), typo('在接再厉，终', '接再厉，', '接再厉。')])(req)
        : typoReply(req),
    );
    await runTypo(env);
    const all = await issues(env);
    expect(all.map((i) => i.target)).toEqual(['在接再厉', '接再厉，', '一但']);
    const revs = await Promise.all([chapter(env, 0), chapter(env, 1)]);
    const res = await ok<ApplyIssuesResponse>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: all.map((i) => i.id) });
    expect(res.applied.sort()).toEqual([all[0]!.id, all[2]!.id].sort());
    expect(res.stale).toEqual([all[1]!.id]);
    expect(res.chapters).toEqual([
      { id: env.ids[0], rev: revs[0].rev + 1 },
      { id: env.ids[1], rev: revs[1].rev + 1 },
    ]);
    expect(dbRow(env, all[1]!.id).status, '重叠的问题在修正时保持 open').toBe('open');
    expect((await chapter(env, 0)).body).toBe('【C0】他再接再厉，终于练成。');
    expect((await chapter(env, 1)).body).toBe('【C1】一旦开始就停不下来。');
    expect((await issues(env)).map((i) => i.status), '下次读取时原文已变，重叠的那条标为失效').toEqual(['applied', 'stale', 'applied']);
  });

  it('检查之后又改过稿：修正前先按当前正文重新锚定；问题文字已被改掉的标为 stale、不写正文', async () => {
    const env = await setup(['【C0】他在接再厉，终于练成。众人迫不急待。']);
    await runTypo(env);
    const [a, b] = await issues(env);
    await save(env, 0, '前面加了一段。\n【C0】他在接再厉，终于练成。众人迫不及待。');
    const rev = (await chapter(env, 0)).rev;
    const res = await ok<ApplyIssuesResponse>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [a!.id, b!.id] });
    expect(res).toEqual({ applied: [a!.id], stale: [b!.id], chapters: [{ id: env.ids[0], rev: rev + 1 }] });
    expect((await chapter(env, 0)).body).toBe('前面加了一段。\n【C0】他再接再厉，终于练成。众人迫不及待。');
    expect(dbRow(env, b!.id).status).toBe('stale');

    const stale = await ok<ApplyIssuesResponse>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [b!.id] });
    expect(stale).toEqual({ applied: [], stale: [b!.id], chapters: [] });
    expect((await chapter(env, 0)).rev, '没有可替换的内容时不写正文').toBe(rev + 1);
  });

  it('章节已删除 → stale 且读取时不再返回；参数校验：不存在的问题 404、空列表与多余字段 400、没有修改建议的问题 400', async () => {
    const env = await setup(['【C0】他在接再厉。', '【C1】一但开始。']);
    await runTypo(env);
    const [a, b] = await issues(env);
    await ok(env.t, 'DELETE', `${env.W}/chapters/${env.ids[1]}`, undefined, 204);
    expect((await issues(env)).map((i) => i.id)).toEqual([a!.id]);
    expect(await ok<ApplyIssuesResponse>(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [b!.id] })).toEqual({ applied: [], stale: [b!.id], chapters: [] });

    expect((await env.t.call('POST', `${env.W}/issues/apply`, { issueIds: ['nope'] })).status).toBe(404);
    expect((await env.t.call('POST', `${env.W}/issues/apply`, { issueIds: [] })).status).toBe(400);
    expect((await env.t.call('POST', `${env.W}/issues/apply`, { issueIds: [a!.id], extra: 1 })).status).toBe(400);
    env.t.app.services.pool.get(env.workId).prepare('UPDATE issue SET replacement = NULL WHERE id = ?').run(a!.id);
    const res = await env.t.call('POST', `${env.W}/issues/apply`, { issueIds: [a!.id] });
    expect(res.status).toBe(400);
    expect(res.body).toContain('没有修改建议');
    expect((await chapter(env, 0)).body).toBe('【C0】他在接再厉。');
  });
});

describe('忽略与重复检查', () => {
  it('忽略后状态为 ignored；再查一次时已忽略的不会复活、待处理的不会重复列出；已采纳的不能再忽略', async () => {
    const env = await setup(['【C0】他在接再厉。众人迫不急待。', '【C1】一但开始。']);
    const job1 = await runTypo(env);
    const all = await issues(env);
    await ok(env.t, 'POST', `${env.W}/issues/ignore`, { issueIds: [all[2]!.id] }, 204);
    await ok(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [all[0]!.id] });
    await ok(env.t, 'POST', `${env.W}/issues/ignore`, { issueIds: [all[0]!.id] }, 204);
    expect((await issues(env)).map((i) => i.status)).toEqual(['applied', 'open', 'ignored']);

    // 作者在已忽略问题前面加了字：重新锚定仍能对上，第二次检查不会把它重新列出来
    await save(env, 1, '加字。【C1】一但开始。');
    const job2 = await runTypo(env);
    const after = await issues(env);
    expect(after.filter((i) => i.jobId === job2.id), '第二次检查没有新增任何重复问题').toEqual([]);
    expect(after.map((i) => [i.jobId, i.target, i.status])).toEqual([
      [job1.id, '在接再厉', 'applied'],
      [job1.id, '迫不急待', 'open'],
      [job1.id, '一但', 'ignored'],
    ]);
    expect(isAnchored('加字。【C1】一但开始。', after[2]!), '已忽略的问题也随正文重新锚定').toBe(true);
    expect((await env.t.call('POST', `${env.W}/issues/ignore`, { issueIds: ['nope'] })).status).toBe(404);
  });
});

describe('INV-10：写入前的本地过滤', () => {
  it('与原文相同的修改、命中设定专名的丢弃；过长或字数差过大的改为语病', async () => {
    const env = await setup(['【C0】林惊羽在接再厉地修炼。'], fixed([
      typo('林惊羽在接', '惊羽', '惊雨'),
      typo('羽在接再厉地', '在接再厉', '在接再厉'),
      typo('羽在接再厉地', '在接再厉', '再接再厉'),
      typo('厉地修炼。', '修炼。', '修炼了很久很久。'),
    ]));
    const db = env.t.app.services.pool.get(env.workId);
    db.prepare("INSERT INTO bible_entry (id, kind, name, aliases, created_at, updated_at) VALUES ('e1', 'character', '林惊羽', '[\"小林\"]', 1, 1)").run();
    await runTypo(env);
    expect((await issues(env)).map((i) => [i.target, i.replacement, i.category])).toEqual([
      ['在接再厉', '再接再厉', 'typo'],
      ['修炼。', '修炼了很久很久。', 'grammar'],
    ]);
    expect(env.t.log.lines.some((l) => l.includes('2 条被本地规则过滤')), '任务日志记录过滤条数').toBe(true);
  });
});
