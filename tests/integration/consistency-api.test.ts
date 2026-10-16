import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_OPENINGS, mockReviewContent, taskOf } from '../../scripts/lib/mock-review.ts';
import { targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { CHARACTER_PROTOCOL, SETTING_PROTOCOL } from '../../src/server/checks/protocol';
import { ENABLED_JOB_TYPES, JOB_TYPES } from '../../src/shared/constants';
import type { BibleEntry, Chapter, Issue, Job, LlmProfile, WorkTree } from '../../src/shared/types';
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
  B: string;
  workId: string;
  ids: string[];
}

async function ok<T>(t: TestApp, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  return res.json as T;
}

const BOOK = [
  '【C0】林远离开落霞镇，走了三日才到青云山。林远的境界是炼气三层。',
  '【C1】苏晴是林远的师姐。林远突破了，境界是炼气九层。',
  '【C2】林远在青云山修炼。',
  '【C3】林远只用了半日就从青云山赶回落霞镇，见到苏师妹在镇口等他。',
];

async function setup(): Promise<Env> {
  const llm = await startMockLlm((req) => completion(mockReviewContent(req.body)));
  const t = await startTestApp();
  opened.push(llm, { close: () => t.cleanup() });
  const profile = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock-consistency', maxConcurrency: 1 });
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '一致性测试' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < BOOK.length; i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId: tree.volumes[0]!.id, title: `第${i + 1}章` })).id);
  for (const [i, id] of ids.entries()) await ok(t, 'PUT', `${W}/chapters/${id}/body`, { body: BOOK[i], baseRev: 0 });
  const B = `${W}/bible`;
  const lin = await ok<BibleEntry>(t, 'POST', `${B}/entries`, { kind: 'character', name: '林远', summary: '主角' });
  await ok(t, 'POST', `${B}/entries/${lin.id}/facts`, { attribute: '境界', value: '炼气三层', mutable: true, chapterId: ids[0], quote: '林远的境界是炼气三层。' });
  await ok(t, 'POST', `${B}/entries/${lin.id}/facts`, { attribute: '境界', value: '炼气九层', mutable: true, chapterId: ids[1], quote: '境界是炼气九层。' });
  const su = await ok<BibleEntry>(t, 'POST', `${B}/entries`, { kind: 'character', name: '苏晴', aliases: ['苏师姐'] });
  await ok(t, 'POST', `${B}/entries/${su.id}/facts`, { attribute: '身份', value: '林远的师姐', chapterId: ids[1], quote: '苏晴是林远的师姐。' });
  const town = await ok<BibleEntry>(t, 'POST', `${B}/entries`, { kind: 'location', name: '落霞镇' });
  await ok(t, 'POST', `${B}/entries/${town.id}/facts`, { attribute: '到青云山的路程', value: '三日', chapterId: ids[0], quote: '走了三日才到青云山。' });
  return { t, llm, profile, W, B, workId: work.id, ids };
}

async function run(env: Env, type: string): Promise<Job> {
  const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type, scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });
  await env.t.app.services.checks.whenIdle();
  const done = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`);
  expect(done.status, done.error ?? '').toBe('done');
  return done;
}

const userOf = (r: MockRequest): string => r.body.messages?.find((m) => m.role === 'user')?.content ?? '';
const section = (u: string, heading: string): string => {
  const i = u.indexOf(heading);
  if (i < 0) return '';
  const next = u.indexOf('\n## ', i + heading.length);
  return u.slice(i, next < 0 ? undefined : next);
};
const mainOf = (env: Env, task: 'setting' | 'character' | 'typo', marker: string): MockRequest =>
  env.llm.requests.find((r) => taskOf(r.body) === task && targetTextOf(userOf(r)).includes(marker))!;

describe('四类检查全部启用', () => {
  it('ENABLED_JOB_TYPES 覆盖全部任务类型；mock 识别两段一致性协议', () => {
    expect([...ENABLED_JOB_TYPES].sort()).toEqual([...JOB_TYPES].sort());
    expect(SETTING_PROTOCOL.startsWith(PROTOCOL_OPENINGS.setting)).toBe(true);
    expect(CHARACTER_PROTOCOL.startsWith(PROTOCOL_OPENINGS.character)).toBe(true);
  });
});

describe('设定一致性与角色一致性（T17）', () => {
  it('设定检查：③ 列出本片段中的全部条目（可变事实截至上一章）、④ 前情提要、⑤ 前文提及；矛盾写成 setting 类问题并带依据，可一键修正', async () => {
    const env = await setup();
    const job = await run(env, 'setting');
    expect(job.totalUnits, '3 个摘要（前 3 章）+ 4 个检查片段').toBe(3 + 4);
    const u = userOf(mainOf(env, 'setting', '【C3】'));
    const setting = section(u, '## 设定上下文');
    expect(setting).toContain('【角色】林远：主角');
    expect(setting).toContain('- 林远 · 境界：炼气九层（可变，截至第1卷第2章）');
    expect(setting).not.toContain('炼气三层');
    expect(setting).toContain('【地点】落霞镇\n- 到青云山的路程：三日');
    expect(setting, '本片段没有出现「苏晴」（只有「苏师妹」）').not.toContain('苏晴');
    expect(section(u, '## 前情提要').match(/】摘要：/g)).toHaveLength(3);
    const mentions = section(u, '## 前文提及');
    expect(mentions).toContain('【落霞镇 · 第1卷第1章】');
    expect(mentions).toContain('【林远 · 第1卷第1章】');
    expect(mentions).toContain('【林远 · 第1卷第3章】');
    expect(section(userOf(mainOf(env, 'setting', '【C0】')), '## 前文提及'), '第一章没有前文').toBe('');

    const issues = await ok<Issue[]>(env.t, 'GET', `${env.W}/issues?jobId=${job.id}`);
    assertDto('Issue', issues, true);
    expect(issues.map((i) => [i.category, i.target, i.replacement, i.severity, i.evidence])).toEqual([['setting', '半日', '三日', 'error', '【落霞镇】青云山到落霞镇的路程是三日']]);
    await ok(env.t, 'POST', `${env.W}/issues/apply`, { issueIds: [issues[0]!.id] });
    expect((await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[3]}`)).body).toContain('只用了三日');
  });

  it('角色检查：③ 只列人物条目（含别名匹配）；称谓矛盾写成 character 类问题', async () => {
    const env = await setup();
    // 让「苏师妹」所在片段能匹配到苏晴：加上别名
    const su = (await ok<BibleEntry[]>(env.t, 'GET', `${env.B}/entries`)).find((e) => e.name === '苏晴')!;
    await ok(env.t, 'PATCH', `${env.B}/entries/${su.id}`, { aliases: ['苏师姐', '苏师妹'] });
    const job = await run(env, 'character');
    const setting = section(userOf(mainOf(env, 'character', '【C3】')), '## 设定上下文');
    expect(setting).toContain('【角色】林远');
    expect(setting).toContain('【角色】苏晴（别名：苏师姐、苏师妹）\n- 身份：林远的师姐');
    expect(setting, '角色检查不列地点条目').not.toContain('落霞镇');
    const issues = await ok<Issue[]>(env.t, 'GET', `${env.W}/issues?jobId=${job.id}`);
    expect(issues.map((i) => [i.category, i.target, i.replacement, i.evidence])).toEqual([['character', '苏师妹', '师姐', '【苏晴】苏晴是林远的师姐']]);
  });

  it('错别字检查的 ③ 专名白名单：只列本片段中出现的设定库名称与别名；设定库为空时没有设定上下文', async () => {
    const env = await setup();
    await run(env, 'typo');
    const c3 = section(userOf(mainOf(env, 'typo', '【C3】')), '## 设定上下文');
    expect(c3).toContain('一律视为正确写法');
    expect(c3).toContain('林远');
    expect(c3).toContain('落霞镇');
    expect(c3, '「苏晴」没在本片段出现').not.toContain('苏晴');
    const db = env.t.app.services.pool.get(env.workId);
    db.exec('DELETE FROM bible_entry');
    const c = await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[2]}`);
    await ok(env.t, 'PUT', `${env.W}/chapters/${env.ids[2]}/body`, { body: `${c.body}又过了一日。`, baseRev: c.rev });
    const n = env.llm.requests.length;
    await ok(env.t, 'POST', `${env.W}/jobs`, { type: 'typo', scope: { kind: 'chapter', id: env.ids[2] }, profileId: env.profile.id });
    await env.t.app.services.checks.whenIdle();
    expect(env.llm.requests.slice(n).every((r) => !userOf(r).includes('## 设定上下文'))).toBe(true);
  });
});
