import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_OPENINGS, mockReviewContent, taskOf } from '../../scripts/lib/mock-review.ts';
import { targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { entriesInText, mentionBlocks, settingBlocks } from '../../src/server/bible/context';
import { EXTRACT_PROTOCOL } from '../../src/server/checks/protocol';
import { tocChapters } from '../../src/server/manuscript/toc';
import type { BibleCandidate, BibleEntry, BibleFact, Chapter, Job, LlmProfile, NewEntryPayload, WorkTree } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, startMockLlm, type MockLlm, type MockReply, type MockRequest } from '../helpers/mock-llm';

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of opened.splice(0).reverse()) await x.close();
});

type Handler = (req: MockRequest) => MockReply;
const grammar: Handler = (req) => completion(mockReviewContent(req.body));

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

async function setup(bodies: string[], handler: Handler = grammar): Promise<Env> {
  const llm = await startMockLlm(handler);
  const t = await startTestApp();
  opened.push(llm, { close: () => t.cleanup() });
  const profile = await ok<LlmProfile>(t, 'POST', '/api/llm/profiles', { name: 'Mock', baseUrl: llm.baseUrl, model: 'mock-extract', maxConcurrency: 1 });
  const work = await ok<{ id: string }>(t, 'POST', '/api/works', { title: '设定测试' });
  const W = `/api/works/${work.id}`;
  const tree = await ok<WorkTree>(t, 'GET', `${W}/tree`);
  const volumeId = tree.volumes[0]!.id;
  const ids = [tree.volumes[0]!.chapters[0]!.id];
  for (let i = 1; i < bodies.length; i++) ids.push((await ok<Chapter>(t, 'POST', `${W}/chapters`, { volumeId, title: `第${i + 1}章` })).id);
  for (const [i, id] of ids.entries()) await ok(t, 'PUT', `${W}/chapters/${id}/body`, { body: bodies[i], baseRev: 0 });
  return { t, llm, profile, W, B: `${W}/bible`, workId: work.id, ids };
}

async function extract(env: Env): Promise<Job> {
  const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'bible_extract', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });
  await env.t.app.services.checks.whenIdle();
  const done = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`);
  expect(done.status, done.error ?? '').toBe('done');
  return done;
}

const pending = (env: Env) => ok<BibleCandidate[]>(env.t, 'GET', `${env.B}/candidates?status=pending`);
const entries = (env: Env) => ok<BibleEntry[]>(env.t, 'GET', `${env.B}/entries`);
const factsOf = (env: Env, id: string) => ok<BibleFact[]>(env.t, 'GET', `${env.B}/entries/${id}/facts`);
const decide = (env: Env, decisions: object[], status = 200) => ok<{ accepted: number; rejected: number }>(env.t, 'POST', `${env.B}/candidates/decide`, { decisions }, status);
const bodyOf = async (env: Env, id: string): Promise<string> => (await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${id}`)).body;
const extractRequests = (env: Env): MockRequest[] => env.llm.requests.filter((r) => taskOf(r.body) === 'extract');
const userOf = (r: MockRequest): string => r.body.messages?.find((m) => m.role === 'user')?.content ?? '';

describe('mock 与协议一致', () => {
  it('抽取协议开头与 mock 识别用的句子一致', () => {
    expect(EXTRACT_PROTOCOL.startsWith(PROTOCOL_OPENINGS.extract)).toBe(true);
  });
});

describe('设定条目与事实：INV-9 名称查重、INV-8 引文校验', () => {
  it('条目增删改；名称或别名冲突（含空白、全半角、大小写差异）时 409 NAME_CONFLICT 并给出冲突条目', async () => {
    const env = await setup(['【C0】林远拔剑。']);
    const lin = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'character', name: ' 林远 ', aliases: ['小林', '小林', '林远', ' '], summary: '主角' });
    assertDto('BibleEntry', lin);
    expect([lin.name, lin.aliases, lin.firstChapterId]).toEqual(['林远', ['小林'], null]);
    for (const name of ['小林', '林 远', '小林 ']) {
      const res = await env.t.call('POST', `${env.B}/entries`, { kind: 'character', name });
      expect(res.status, name).toBe(409);
      expect(res.json).toMatchObject({ error: { code: 'NAME_CONFLICT', entryId: lin.id, entryName: '林远' } });
    }
    const ab = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'item', name: 'AB剑' });
    expect((await env.t.call('POST', `${env.B}/entries`, { kind: 'item', name: 'ａｂ剑' })).status, '全角与大小写').toBe(409);
    expect((await env.t.call('PATCH', `${env.B}/entries/${ab.id}`, { aliases: ['小林'] })).status).toBe(409);
    expect((await ok<BibleEntry>(env.t, 'PATCH', `${env.B}/entries/${lin.id}`, { aliases: ['小林', '远哥'], kind: 'character' })).aliases).toEqual(['小林', '远哥']);
    expect((await ok<BibleEntry[]>(env.t, 'GET', `${env.B}/entries?kind=item`)).map((e) => e.name)).toEqual(['AB剑']);
    expect((await entries(env)).map((e) => e.name), '按类型排序').toEqual(['林远', 'AB剑']);
    expect((await env.t.call('GET', `${env.B}/entries?kind=bogus`)).status).toBe(400);
    expect((await env.t.call('POST', `${env.B}/entries`, { kind: 'character', name: '甲', extra: 1 })).status).toBe(400);
    expect((await env.t.call('POST', `${env.B}/entries`, { kind: 'character', name: '甲', firstChapterId: 'nope' })).status).toBe(400);
    await ok(env.t, 'DELETE', `${env.B}/entries/${ab.id}`, undefined, 204);
    expect((await env.t.call('PATCH', `${env.B}/entries/${ab.id}`, { name: 'x' })).status).toBe(404);
  });

  it('事实：引文必须逐字出现在来源章节中；手填事实不能带引文；换来源章节时清掉旧引文；删除条目时事实一并删除', async () => {
    const env = await setup(['【C0】林远的境界是炼气三层。', '【C1】林远突破了。']);
    const lin = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'character', name: '林远' });
    const F = `${env.B}/entries/${lin.id}/facts`;
    const fact = await ok<BibleFact>(env.t, 'POST', F, { attribute: '境界', value: '炼气三层', mutable: true, chapterId: env.ids[0], quote: '林远的境界是炼气三层。' });
    assertDto('BibleFact', fact);
    expect((await env.t.call('POST', F, { attribute: '境界', value: '筑基', chapterId: env.ids[0], quote: '林远的境界是筑基。' })).status, 'INV-8').toBe(400);
    expect((await env.t.call('POST', F, { attribute: '境界', value: '筑基', quote: '林远突破了。' })).status, '手填不能带引文').toBe(400);
    expect((await env.t.call('POST', F, { attribute: '境界', value: '筑基', chapterId: 'nope' })).status).toBe(400);
    expect((await env.t.call('POST', F, { attribute: ' ', value: 'x' })).status).toBe(400);
    const hand = await ok<BibleFact>(env.t, 'POST', F, { attribute: '出身', value: '渔村' });
    expect([hand.mutable, hand.chapterId, hand.quote]).toEqual([false, null, '']);
    const moved = await ok<BibleFact>(env.t, 'PATCH', `${env.B}/facts/${fact.id}`, { chapterId: env.ids[1] });
    expect([moved.chapterId, moved.quote]).toEqual([env.ids[1], '']);
    expect((await env.t.call('PATCH', `${env.B}/facts/${fact.id}`, { quote: '不存在的引文' })).status).toBe(400);
    expect((await ok<BibleFact>(env.t, 'PATCH', `${env.B}/facts/${fact.id}`, { quote: '林远突破了。' })).quote).toBe('林远突破了。');
    expect((await factsOf(env, lin.id)).map((f) => f.attribute)).toEqual(['境界', '出身']);
    await ok(env.t, 'DELETE', `${env.B}/facts/${hand.id}`, undefined, 204);
    await ok(env.t, 'DELETE', `${env.B}/entries/${lin.id}`, undefined, 204);
    const n = env.t.app.services.pool.get(env.workId).prepare('SELECT count(*) AS n FROM bible_fact').get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe('设定抽取任务（F5）', () => {
  it('INV-8：引文不是原文子串的事实、名称没出现在原文中的实体被丢弃；候选的引文都是来源章节的逐字子串', async () => {
    const env = await setup(['【C0】林远的境界是炼气三层。青云门的位置是东荒。', '【C1】林远又名小林。'], (req) => {
      if (taskOf(req.body) !== 'extract') return completion('{}');
      const text = targetTextOf(userOf(req));
      if (!text.includes('【C0】')) return completion(mockReviewContent(req.body));
      return completion(
        JSON.stringify({
          entities: [
            {
              name: '林远',
              kind: 'character',
              aliases: [],
              summary: '主角',
              facts: [
                { attribute: '境界', value: '炼气三层', mutable: true, quote: '林远的境界是炼气三层。' },
                { attribute: '师承', value: '青云门', mutable: false, quote: '林远拜入青云门。' },
              ],
            },
            { name: '幽冥殿', kind: 'faction', aliases: [], summary: '编造的', facts: [] },
            { name: '青云门', kind: 'faction', aliases: ['青云'], summary: '门派', facts: [{ attribute: '位置', value: '东荒', mutable: false, quote: '青云门的位置是东荒' }] },
          ],
        }),
      );
    });
    await extract(env);
    const list = await pending(env);
    assertDto('BibleCandidate', list, true);
    for (const c of list) expect((await bodyOf(env, c.chapterId)).includes(c.quote), c.quote).toBe(true);
    const lin = list.find((c) => c.op === 'new_entry' && (c.payload as NewEntryPayload).name === '林远')!;
    expect((lin.payload as NewEntryPayload).facts.map((f) => f.attribute), '编造的引文被丢弃').toEqual(['境界']);
    expect(list.some((c) => (c.payload as NewEntryPayload).name === '幽冥殿'), '原文中没有的实体被丢弃').toBe(false);
    const qy = list.find((c) => (c.payload as NewEntryPayload).name === '青云门')!;
    expect((qy.payload as NewEntryPayload).facts.map((f) => f.quote)).toEqual(['青云门的位置是东荒']);
    // 第二章：林远又名小林 → 同名新条目，不同章节分别成为候选
    expect(list.filter((c) => (c.payload as NewEntryPayload).name === '林远').map((c) => c.chapterId)).toEqual(env.ids);
    expect(env.t.log.lines.some((l) => /2 条被本地规则过滤/.test(l)), '日志记录丢弃条数').toBe(true);
  });

  it('按名称匹配已有条目：生成新别名与新事实候选（已有的事实不重复）；章节缓存：没改动的不再抽取，改了哪章只抽哪章', async () => {
    const env = await setup(['【C0】林远的境界是炼气三层。林远的出身是渔村。', '【C1】小林的境界是筑基。林远又名小林。', '【C2】苏晴的师承是青云门。']);
    const lin = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'character', name: '林远' });
    await ok(env.t, 'POST', `${env.B}/entries/${lin.id}/facts`, { attribute: '出身', value: '渔村', chapterId: env.ids[0], quote: '林远的出身是渔村。' });
    await extract(env);
    const list = await pending(env);
    const brief = list.map((c) => [c.op, c.targetEntryId === lin.id ? '林远' : c.targetEntryId, JSON.stringify(c.payload)]);
    // 第二章里「小林的境界是筑基」与「林远又名小林」被模型分成两个实体输出，服务端按名称合并后匹配到林远
    expect(brief).toEqual([
      ['new_fact', '林远', JSON.stringify({ attribute: '境界', value: '炼气三层', mutable: true })],
      ['new_alias', '林远', JSON.stringify({ alias: '小林' })],
      ['new_fact', '林远', JSON.stringify({ attribute: '境界', value: '筑基', mutable: true })],
      ['new_entry', null, JSON.stringify({ kind: 'character', name: '苏晴', aliases: [], summary: '苏晴（模拟抽取）', facts: [{ attribute: '师承', value: '青云门', mutable: false, quote: '苏晴的师承是青云门。' }] })],
    ]);
    // ③ 设定上下文列出本片段中出现的已有条目
    const c1 = extractRequests(env).find((r) => userOf(r).includes('【C1】'))!;
    expect(userOf(c1)).toContain('## 设定上下文\n\n【角色】林远');

    const n = extractRequests(env).length;
    expect((await env.t.call('POST', `${env.W}/jobs`, { type: 'bible_extract', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id })).body).toContain('都已抽取过');
    const c2 = await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[2]}`);
    await ok(env.t, 'PUT', `${env.W}/chapters/${env.ids[2]}/body`, { body: '【C2】苏晴的师承是青云门。苏晴的境界是炼气五层。', baseRev: c2.rev });
    await extract(env);
    expect(extractRequests(env).slice(n).map((r) => /【(C\d)】/.exec(targetTextOf(userOf(r)))?.[1])).toEqual(['C2']);
    const su = (await pending(env)).filter((c) => (c.payload as NewEntryPayload).name === '苏晴');
    expect(su, '同一章同名的新条目合并为一个候选').toHaveLength(1);
    expect((su[0]!.payload as NewEntryPayload).facts.map((f) => f.value)).toEqual(['青云门', '炼气五层']);
  });

  it('同一章节的多个片段中同名实体合并为一个候选；有片段失败时该章不算抽取完成', async () => {
    const para = (k: number): string => `第${k}段。${'云'.repeat(480)}`;
    const long = `林远的境界是炼气三层。\n${Array.from({ length: 20 }, (_, k) => para(k)).join('\n')}\n林远的位置是青云山。`;
    // 第二个片段第一次执行时两次都输出不合格（含修复重试）→ 该单元失败
    let failures = 2;
    const env = await setup([long], (req) => {
      const text = targetTextOf(userOf(req));
      if (failures > 0 && text.includes('第19段')) {
        failures--;
        return completion('不是 JSON');
      }
      return completion(mockReviewContent(req.body));
    });
    const job = await ok<Job>(env.t, 'POST', `${env.W}/jobs`, { type: 'bible_extract', scope: { kind: 'work', id: env.workId }, profileId: env.profile.id });
    await env.t.app.services.checks.whenIdle();
    const done = await ok<Job>(env.t, 'GET', `${env.W}/jobs/${job.id}`);
    expect([done.status, done.failedUnits, done.totalUnits]).toEqual(['done', 1, 2]);
    expect((await pending(env)).map((c) => (c.payload as NewEntryPayload).facts.map((f) => f.attribute))).toEqual([['境界']]);
    // 失败的片段没有完成，下次重新抽取整章；已有的候选被合并而不是重复
    await extract(env);
    const list = await pending(env);
    expect(list).toHaveLength(1);
    expect((list[0]!.payload as NewEntryPayload).facts.map((f) => f.attribute)).toEqual(['境界', '位置']);
  });
});

describe('审核候选（F5 第 3 步）', () => {
  const book = ['【C0】林远的境界是炼气三层。', '【C1】林远的位置是青云山。林远又名小林。', '【C2】苏晴的师承是青云门。'];

  it('同名的一组新条目可以一次全部接受（合并为一个条目）；与已有条目冲突时 409 并整批回滚；合并到已有条目；编辑后接受', async () => {
    const env = await setup(book);
    await extract(env);
    const list = await pending(env);
    const lin = list.filter((c) => (c.payload as NewEntryPayload).name === '林远');
    expect(lin).toHaveLength(2);
    expect(await decide(env, lin.map((c) => ({ id: c.id, action: 'accept' })))).toEqual({ accepted: 2, rejected: 0 });
    const [entry] = await entries(env);
    expect([entry!.name, entry!.aliases, entry!.firstChapterId]).toEqual(['林远', ['小林'], env.ids[0]]);
    expect((await factsOf(env, entry!.id)).map((f) => [f.attribute, f.value, f.mutable, f.chapterId, f.quote])).toEqual([
      ['境界', '炼气三层', true, env.ids[0], '林远的境界是炼气三层。'],
      ['位置', '青云山', true, env.ids[1], '林远的位置是青云山。'],
    ]);

    // 苏晴：先建一个同名条目，再接受候选 → 冲突，整批（含另一条拒绝）回滚
    const su = list.find((c) => (c.payload as NewEntryPayload).name === '苏晴')!;
    const manual = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'character', name: '苏晴' });
    const res = await env.t.call('POST', `${env.B}/candidates/decide`, { decisions: [{ id: su.id, action: 'accept' }] });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: { code: 'NAME_CONFLICT', entryId: manual.id, candidateId: su.id } });
    expect((await pending(env)).map((c) => c.id)).toEqual([su.id]);

    // 编辑后合并到已有条目：名称成为别名之外的已有名称（跳过）、事实写入目标
    const edited: NewEntryPayload = { ...(su.payload as NewEntryPayload), aliases: ['晴儿'], summary: '青云门弟子' };
    expect(await decide(env, [{ id: su.id, action: 'merge', mergeIntoEntryId: manual.id, payload: edited }])).toEqual({ accepted: 1, rejected: 0 });
    const merged = (await entries(env)).find((e) => e.id === manual.id)!;
    expect([merged.aliases, merged.summary]).toEqual([['晴儿'], '青云门弟子']);
    expect((await factsOf(env, manual.id)).map((f) => f.value)).toEqual(['青云门']);
    expect(await decide(env, [{ id: su.id, action: 'reject' }]), '已处理的候选跳过').toEqual({ accepted: 0, rejected: 0 });
    expect((await env.t.call('POST', `${env.B}/candidates/decide`, { decisions: [{ id: 'nope', action: 'reject' }] })).status).toBe(404);
  });

  it('新别名与新事实；拒绝是持久的：章节改稿后重新抽取不会再生成同样的候选；载荷格式错误 400；目标条目删除后其候选一并删除', async () => {
    const env = await setup(book);
    const lin = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'character', name: '林远' });
    const other = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'character', name: '远哥' });
    await extract(env);
    const list = await pending(env);
    const alias = list.find((c) => c.op === 'new_alias')!;
    const fact1 = list.find((c) => c.op === 'new_fact' && JSON.stringify(c.payload).includes('炼气三层'))!;
    const fact2 = list.find((c) => c.op === 'new_fact' && JSON.stringify(c.payload).includes('青云山'))!;

    expect((await env.t.call('POST', `${env.B}/candidates/decide`, { decisions: [{ id: fact1.id, action: 'accept', payload: { attribute: '境界' } }] })).status).toBe(400);
    expect((await env.t.call('POST', `${env.B}/candidates/decide`, { decisions: [{ id: alias.id, action: 'accept', payload: { alias: '远哥' } }] })).status, '别名属于其他条目').toBe(409);
    expect(await decide(env, [{ id: alias.id, action: 'accept' }, { id: fact1.id, action: 'accept', payload: { attribute: '境界', value: '炼气四层', mutable: true } }, { id: fact2.id, action: 'reject' }])).toEqual({
      accepted: 2,
      rejected: 1,
    });
    expect((await entries(env)).find((e) => e.id === lin.id)!.aliases).toEqual(['小林']);
    expect((await factsOf(env, lin.id)).map((f) => [f.value, f.quote])).toEqual([['炼气四层', '林远的境界是炼气三层。']]);

    const c1 = await ok<Chapter>(env.t, 'GET', `${env.W}/chapters/${env.ids[1]}`);
    await ok(env.t, 'PUT', `${env.W}/chapters/${env.ids[1]}/body`, { body: `${c1.body}林远的伤势是轻伤。`, baseRev: c1.rev });
    await extract(env);
    const again = (await pending(env)).filter((c) => c.chapterId === env.ids[1]);
    expect(again.map((c) => JSON.stringify(c.payload)), '被拒绝的「位置 = 青云山」不再出现').toEqual([JSON.stringify({ attribute: '伤势', value: '轻伤', mutable: true })]);

    await ok(env.t, 'DELETE', `${env.B}/entries/${lin.id}`, undefined, 204);
    expect((await pending(env)).filter((c) => c.targetEntryId === lin.id)).toEqual([]);
    expect((await env.t.call('GET', `${env.B}/candidates?status=bogus`)).status).toBe(400);
    expect((await ok<BibleCandidate[]>(env.t, 'GET', `${env.B}/candidates?status=rejected`)).map((c) => c.id)).toEqual([fact2.id]);
    expect(other.name).toBe('远哥');
  });
});

describe('③ 设定上下文与 ⑤ 前文提及', () => {
  it('可变事实只取「截至上一章」的最新值；不变事实全部提供；前文提及取最早与最近的两段（3 字走 FTS、2 字走 instr）', async () => {
    const bodies = [
      '【C0】林远拜入青云门。林远的境界是炼气三层。',
      '【C1】林远在青云门修炼，林远的境界是炼气九层。',
      '【C2】林远突破筑基，名动青云门。',
      '【C3】平静的一章。',
      '【C4】林远回到青云门。林',
    ];
    const env = await setup(bodies);
    const lin = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'character', name: '林远', aliases: ['林'], summary: '主角' });
    const qy = await ok<BibleEntry>(env.t, 'POST', `${env.B}/entries`, { kind: 'faction', name: '青云门' });
    const F = `${env.B}/entries/${lin.id}/facts`;
    await ok(env.t, 'POST', F, { attribute: '出身', value: '渔村' });
    await ok(env.t, 'POST', F, { attribute: '境界', value: '凡人', mutable: true });
    await ok(env.t, 'POST', F, { attribute: '境界', value: '炼气三层', mutable: true, chapterId: env.ids[0], quote: '林远的境界是炼气三层。' });
    await ok(env.t, 'POST', F, { attribute: '境界', value: '炼气九层', mutable: true, chapterId: env.ids[1], quote: '林远的境界是炼气九层。' });
    await ok(env.t, 'POST', F, { attribute: '境界', value: '筑基', mutable: true, chapterId: env.ids[2], quote: '林远突破筑基' });

    const db = env.t.app.services.pool.get(env.workId);
    const toc = tocChapters(db);
    const found = entriesInText(db, bodies[4]!);
    expect(found.map((e) => [e.name, e.hits])).toEqual([
      ['林远', ['林远']],
      ['青云门', ['青云门']],
    ]);
    const setting = (i: number) => settingBlocks(db, entriesInText(db, bodies[i]!), env.ids[i]!, toc);
    expect(setting(0).map((b) => b.text)).toEqual(['【角色】林远（别名：林）：主角\n- 出身：渔村', '- 林远 · 境界：凡人（可变，作者设定）', '【势力】青云门']);
    expect(setting(2).find((b) => b.text.includes('境界'))!.text, '本章自己的事实不算').toBe('- 林远 · 境界：炼气九层（可变，截至第1卷第2章）');
    const s4 = setting(4);
    expect(s4.filter((b) => b.text.includes('境界')).map((b) => [b.text, b.trimmable, b.order])).toEqual([['- 林远 · 境界：筑基（可变，截至第1卷第3章）', true, 2]]);
    expect(s4[0]!.trimmable).toBe(false);

    const mentions = mentionBlocks(db, found, env.ids[4]!, toc);
    expect(mentions.map((b) => b.text.slice(0, b.text.indexOf('】') + 1))).toEqual(['【林远 · 第1卷第1章】', '【林远 · 第1卷第3章】', '【青云门 · 第1卷第1章】', '【青云门 · 第1卷第3章】']);
    for (const b of mentions) expect(b.trimmable).toBe(true);
    expect(mentions[0]!.text).toContain('林远拜入青云门');
    expect(mentionBlocks(db, found, env.ids[0]!, toc), '第一章没有前文').toEqual([]);
    // 删除第 3 章后，最近的前文变成第 2 章
    await ok(env.t, 'DELETE', `${env.W}/chapters/${env.ids[2]}`, undefined, 204);
    const toc2 = tocChapters(db);
    expect(mentionBlocks(db, found, env.ids[4]!, toc2).map((b) => b.text.slice(0, b.text.indexOf('】') + 1))).toEqual([
      '【林远 · 第1卷第1章】',
      '【林远 · 第1卷第2章】',
      '【青云门 · 第1卷第1章】',
      '【青云门 · 第1卷第2章】',
    ]);
    expect(qy.kind).toBe('faction');
  });
});
