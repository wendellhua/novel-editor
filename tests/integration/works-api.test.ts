import { request, type IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Chapter, RevisionMeta, TrashedWork, VolumeNode, Work, WorkSummary, WorkTree } from '../../src/shared/types';
import { pendingFtsCount } from '../../src/server/storage/fts';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.cleanup();
});

async function ok<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  expect(res.status, `${method} ${path} → ${res.body}`).toBe(status);
  return res.json as T;
}

async function newWork(title = '测试作品'): Promise<{ work: Work; tree: WorkTree; W: string }> {
  const work = await ok<Work>('POST', '/api/works', { title });
  const W = `/api/works/${work.id}`;
  return { work, tree: await ok<WorkTree>('GET', `${W}/tree`), W };
}

describe('作品与目录树', () => {
  it('新建、列表、修改、删除；响应字段与 DTO 逐字一致', async () => {
    const { work, tree, W } = await newWork('诛仙');
    assertDto('Work', work);
    assertDto('WorkTree', tree);
    expect(tree.volumes).toHaveLength(1);

    const list = await ok<WorkSummary[]>('GET', '/api/works');
    assertDto('WorkSummary', list, true);
    expect(list.find((w) => w.id === work.id)).toMatchObject({ title: '诛仙', chapterCount: 1 });

    assertDto('Work', await ok('PATCH', W, { author: '萧鼎', synopsis: '简介' }));
    await ok('DELETE', W, undefined, 204);
    expect((await t.call('GET', `${W}/tree`)).status).toBe(404);

    const trashed = await ok<TrashedWork[]>('GET', '/api/trash/works');
    assertDto('TrashedWork', trashed, true);
    const file = trashed.find((x) => x.workId === work.id)!.file;
    assertDto('WorkSummary', await ok('POST', '/api/trash/works/restore', { file }));
    expect((await t.call('GET', `${W}/tree`)).status).toBe(200);
    await ok('DELETE', W, undefined, 204);
    const again = (await ok<TrashedWork[]>('GET', '/api/trash/works')).find((x) => x.workId === work.id)!.file;
    expect((await t.call('DELETE', `/api/trash/works/${encodeURIComponent(file)}`)).status, '旧文件名已不存在').toBe(404);
    await ok('DELETE', `/api/trash/works/${encodeURIComponent(again)}`, undefined, 204);
    expect(await ok<TrashedWork[]>('GET', '/api/trash/works')).toEqual([]);
  });

  it('分卷与章节：新增、改名、排序、移动、删除、恢复', async () => {
    const { tree, W } = await newWork();
    const v1 = tree.volumes[0]!;
    const v2 = await ok<VolumeNode>('POST', `${W}/volumes`, { title: '第二卷' });
    assertDto('VolumeNode', v2);
    assertDto('VolumeNode', await ok('PATCH', `${W}/volumes/${v2.id}`, { title: '第二卷·风起' }));
    await ok('PUT', `${W}/volumes/order`, { volumeIds: [v2.id, v1.id] }, 204);

    const c2 = await ok<Chapter>('POST', `${W}/chapters`, { volumeId: v1.id, title: '第二章', afterChapterId: null });
    assertDto('Chapter', c2);
    assertDto('ChapterNode', await ok('PATCH', `${W}/chapters/${c2.id}`, { title: '第二章·改' }));
    await ok('POST', `${W}/chapters/${c2.id}/move`, { volumeId: v2.id, index: 0 }, 204);
    const c1 = v1.chapters[0]!;
    const c3 = await ok<Chapter>('POST', `${W}/chapters`, { volumeId: v2.id, title: '第三章' });
    await ok('PUT', `${W}/volumes/${v2.id}/chapters/order`, { chapterIds: [c3.id, c2.id] }, 204);

    let now = await ok<WorkTree>('GET', `${W}/tree`);
    expect(now.volumes.map((v) => [v.title, ...v.chapters.map((c) => c.title)])).toEqual([
      ['第二卷·风起', '第三章', '第二章·改'],
      ['第一卷', '第一章'],
    ]);

    await ok('DELETE', `${W}/chapters/${c1.id}`, undefined, 204);
    await ok('DELETE', `${W}/volumes/${v1.id}`, undefined, 204);
    const trash = await ok('GET', `${W}/trash`);
    assertDto('TrashList', trash);
    await ok('POST', `${W}/trash/restore`, { kind: 'chapter', id: c1.id }, 204);
    now = await ok<WorkTree>('GET', `${W}/tree`);
    expect(now.volumes.map((v) => v.title)).toEqual(['第二卷·风起', '第一卷']);

    await ok('DELETE', `${W}/chapters/${c3.id}`, undefined, 204);
    await ok('DELETE', `${W}/trash`, { all: true }, 204);
    expect(await ok('GET', `${W}/trash`)).toEqual({ volumes: [], chapters: [] });
  });
});

describe('正文保存与版本', () => {
  it('保存 → 冲突 409（带 rev/body/title）→ 版本列表 → 恢复', async () => {
    const { tree, W } = await newWork();
    const C = `${W}/chapters/${tree.volumes[0]!.chapters[0]!.id}`;
    const saved = await ok('PUT', `${C}/body`, { body: '第一稿', baseRev: 0 });
    assertDto('SaveBodyResponse', saved);
    expect(saved).toMatchObject({ rev: 1, wordCount: 3 });

    const conflict = await t.call('PUT', `${C}/body`, { body: '旧标签页的稿子', baseRev: 0 });
    expect(conflict.status).toBe(409);
    assertDto('RevConflict', conflict.json);
    expect(conflict.json).toMatchObject({ error: { rev: 1, body: '第一稿' } });

    await ok('PUT', `${C}/body`, { body: '第二稿', baseRev: 1 });
    const manual = await ok<RevisionMeta>('POST', `${C}/revisions`, {});
    assertDto('RevisionMeta', manual);
    const revs = await ok<RevisionMeta[]>('GET', `${C}/revisions`);
    assertDto('RevisionMeta', revs, true);
    const first = revs.find((r) => r.rev === 1)!;
    assertDto('RevisionDetail', await ok('GET', `${C}/revisions/${first.id}`));

    expect((await t.call('POST', `${C}/revisions/${first.id}/restore`, { baseRev: 1 })).status).toBe(409);
    assertDto('SaveBodyResponse', await ok('POST', `${C}/revisions/${first.id}/restore`, { baseRev: 2 }));
    expect(await ok<Chapter>('GET', C)).toMatchObject({ body: '第一稿', rev: 3 });
    expect((await t.call('GET', `${C}/revisions/abc`)).status).toBe(404);
  });

  it('保存后推送 chapter.updated，并在防抖后重建全文索引', async () => {
    const { work, tree, W } = await newWork();
    const ch = tree.volumes[0]!.chapters[0]!;
    const frames: string[] = [];
    const sse = await new Promise<{ close(): void }>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port: t.app.port, path: `/api/events?workId=${work.id}`, headers: { Cookie: t.cookie, Host: `127.0.0.1:${t.app.port}` } },
        (res: IncomingMessage) => {
          res.on('data', (c: Buffer) => frames.push(c.toString()));
          resolve({ close: () => req.destroy() });
        },
      );
      req.on('error', () => undefined);
      req.end();
    });
    await ok('PUT', `${W}/chapters/${ch.id}/body`, { body: '张小凡拿起了烧火棍', baseRev: 0 });
    await expect.poll(() => frames.join('')).toContain(`"type":"chapter.updated","workId":"${work.id}","chapterId":"${ch.id}","rev":1`);
    sse.close();
    const indexed = (): number =>
      (t.app.services.pool.get(work.id).prepare(`SELECT count(*) AS n FROM chapter_fts WHERE chapter_fts MATCH '"烧火棍"'`).get() as { n: number }).n;
    await expect.poll(indexed, { timeout: 2000 }).toBe(1);
    expect(pendingFtsCount(t.app.services.pool.get(work.id))).toBe(0);
  });
});

describe('导出', () => {
  it('以附件形式下载，文件名支持中文', async () => {
    const { work, W } = await newWork('剑来');
    const res = await t.call('GET', `${W}/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="__.md"; filename*=UTF-8''${encodeURIComponent('剑来.md')}`);
    expect(res.body.startsWith('# 剑来\n')).toBe(true);
    expect((await t.call('GET', `${W}/export?format=pdf`)).status).toBe(400);
    expect(work.title).toBe('剑来');
  });
});

describe('请求校验与错误格式（§7.1）', () => {
  it('缺字段、多余字段、类型错误都返回 400 VALIDATION', async () => {
    for (const body of [{}, { title: 'x', hack: 1 }, { title: 123 }, '{bad json']) {
      const res = await t.call('POST', '/api/works', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      assertDto('Error', res.json);
      expect(res.json).toMatchObject({ error: { code: 'VALIDATION' } });
    }
    const missing = await t.call('POST', '/api/works', {});
    expect((missing.json as { error: { message: string } }).error.message).toContain('title');
  });

  it('业务校验错误（空标题、非完整排列）返回 400', async () => {
    const { W } = await newWork();
    expect((await t.call('POST', '/api/works', { title: '   ' })).status).toBe(400);
    expect((await t.call('PUT', `${W}/volumes/order`, { volumeIds: [] })).status).toBe(400);
  });

  it('不存在或非法的 workId / chapterId 返回 404', async () => {
    const { W } = await newWork();
    for (const path of ['/api/works/not-a-uuid/tree', '/api/works/00000000-0000-4000-8000-000000000000/tree', `${W}/chapters/nope`]) {
      const res = await t.call('GET', path);
      expect(res.status, path).toBe(404);
      expect(res.json).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('正文请求体上限 2 MB，其他接口 1 MB（413）', async () => {
    const { tree, W } = await newWork();
    const C = `${W}/chapters/${tree.volumes[0]!.chapters[0]!.id}`;
    const big = 'a'.repeat(1_500_000);
    expect((await t.call('PUT', `${C}/body`, { body: big, baseRev: 0 })).status).toBe(400);
    expect((await t.call('PATCH', W, { synopsis: big })).status).toBe(413);
    const huge = await t.call('PUT', `${C}/body`, { body: 'a'.repeat(2_200_000), baseRev: 0 });
    expect(huge.status).toBe(413);
    expect(huge.json).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('作品接口同样受会话与 Origin 保护（INV-12）', async () => {
    expect((await t.call('GET', '/api/works', undefined, { Cookie: '' })).status).toBe(401);
    expect((await t.call('POST', '/api/works', { title: 'x' }, { Origin: 'http://evil.test' })).status).toBe(403);
  });
});
