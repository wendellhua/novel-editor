import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/shared/constants';
import { countWords } from '../../src/shared/text';
import type { WorkTree } from '../../src/shared/types';
import { DomainError } from '../../src/server/errors';
import { bodyHash, findSeqViolations } from '../../src/server/manuscript/repo';
import { DEFAULT_CHAPTER_TITLE, DEFAULT_VOLUME_TITLE } from '../../src/server/manuscript/works';
import { makeManuscript, worksFile, type ManuscriptFixture } from '../helpers/manuscript';
import { createRandom } from '../helpers/random';

let f: ManuscriptFixture;
beforeEach(() => {
  f = makeManuscript();
});
afterEach(() => f.cleanup());

const titles = (tree: WorkTree): string[][] => tree.volumes.map((v) => [v.title, ...v.chapters.map((c) => c.title)]);
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof DomainError ? err.code : `other:${String(err)}`;
  }
  return 'no-error';
};

describe('作品', () => {
  it('新建作品自带「第一卷 / 第一章」，并出现在列表中', () => {
    const w = f.ms.createWork({ title: '  诛仙  ', author: '萧鼎' });
    expect(w.title).toBe('诛仙');
    expect(titles(f.ms.getTree(w.id))).toEqual([[DEFAULT_VOLUME_TITLE, DEFAULT_CHAPTER_TITLE]]);
    expect(f.ms.listWorks()).toEqual([{ id: w.id, title: '诛仙', author: '萧鼎', wordCount: 0, chapterCount: 1, updatedAt: f.clock.t }]);
  });

  it('标题校验：空标题、超长标题被拒绝', () => {
    expect(codeOf(() => f.ms.createWork({ title: '   ' }))).toBe('VALIDATION');
    expect(codeOf(() => f.ms.createWork({ title: '字'.repeat(101) }))).toBe('VALIDATION');
  });

  it('修改作品信息；列表按更新时间倒序', () => {
    const a = f.ms.createWork({ title: 'A' });
    f.clock.t += 1000;
    const b = f.ms.createWork({ title: 'B' });
    f.clock.t += 1000;
    const updated = f.ms.updateWork(a.id, { synopsis: '简介\r\n第二行', genre: '仙侠' });
    expect(updated).toMatchObject({ title: 'A', synopsis: '简介\n第二行', genre: '仙侠', updatedAt: f.clock.t });
    expect(f.ms.listWorks().map((w) => w.id)).toEqual([a.id, b.id]);
  });

  it('INV-5：删除作品只移入回收站，可恢复，彻底删除才真正删掉文件', () => {
    const w = f.ms.createWork({ title: '要删的书' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    f.ms.saveChapterBody(w.id, ch.id, { body: '重要正文', baseRev: 0 });
    f.ms.deleteWork(w.id);
    expect(existsSync(worksFile(f.paths, w.id))).toBe(false);
    expect(f.ms.listWorks()).toEqual([]);
    const [trashed] = f.ms.listTrashedWorks();
    expect(trashed).toMatchObject({ workId: w.id, title: '要删的书', deletedAt: f.clock.t });

    const restored = f.ms.restoreWork(trashed!.file);
    expect(restored).toMatchObject({ id: w.id, wordCount: 4 });
    expect(f.ms.getChapter(w.id, ch.id).body).toBe('重要正文');
    expect(f.ms.listTrashedWorks()).toEqual([]);

    f.ms.deleteWork(w.id);
    const file = f.ms.listTrashedWorks()[0]!.file;
    f.ms.purgeTrashedWork(file);
    expect(readdirSync(f.paths.trash)).toEqual([]);
  });

  it('回收站文件名非法时视为不存在（防路径穿越）', () => {
    expect(codeOf(() => f.ms.restoreWork('../config.json'))).toBe('NOT_FOUND');
    expect(codeOf(() => f.ms.purgeTrashedWork('..\\..\\x.novel'))).toBe('NOT_FOUND');
  });
});

describe('分卷与章节结构（INV-2）', () => {
  it('在指定位置插入卷和章，排序、移动后顺序正确', () => {
    const w = f.ms.createWork({ title: 'T' });
    const [v1] = f.ms.getTree(w.id).volumes;
    const v3 = f.ms.createVolume(w.id, { title: '第三卷' });
    const v2 = f.ms.createVolume(w.id, { title: '第二卷', afterVolumeId: v1!.id });
    const c2 = f.ms.createChapter(w.id, { volumeId: v1!.id, title: '第二章' });
    f.ms.createChapter(w.id, { volumeId: v1!.id, title: '序章', afterChapterId: null });
    expect(titles(f.ms.getTree(w.id))).toEqual([['第一卷', '第一章', '第二章', '序章'], ['第二卷'], ['第三卷']]);

    f.ms.moveChapter(w.id, c2.id, { volumeId: v2.id, index: 0 });
    f.ms.reorderVolumes(w.id, [v3.id, v1!.id, v2.id]);
    expect(titles(f.ms.getTree(w.id))).toEqual([['第三卷'], ['第一卷', '第一章', '序章'], ['第二卷', '第二章']]);
    expect(f.ms.getChapter(w.id, c2.id).volumeId).toBe(v2.id);

    const ids = f.ms.getTree(w.id).volumes[1]!.chapters.map((c) => c.id);
    f.ms.reorderChapters(w.id, v1!.id, [...ids].reverse());
    expect(titles(f.ms.getTree(w.id))[1]).toEqual(['第一卷', '序章', '第一章']);
    expect(findSeqViolations(f.pool.get(w.id))).toEqual([]);
  });

  it('排序请求必须是完整排列', () => {
    const w = f.ms.createWork({ title: 'T' });
    const [v1] = f.ms.getTree(w.id).volumes;
    const v2 = f.ms.createVolume(w.id, { title: 'B' });
    expect(codeOf(() => f.ms.reorderVolumes(w.id, [v1!.id]))).toBe('VALIDATION');
    expect(codeOf(() => f.ms.reorderVolumes(w.id, [v1!.id, v1!.id]))).toBe('VALIDATION');
    expect(codeOf(() => f.ms.reorderVolumes(w.id, [v1!.id, v2.id, 'x']))).toBe('VALIDATION');
  });

  it('属性：随机 1000 次新增/删除/移动/排序/恢复后 seq 始终连续', () => {
    const w = f.ms.createWork({ title: 'Fuzz' });
    const rand = createRandom(99);
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
    const db = f.pool.get(w.id);
    for (let i = 0; i < 1000; i++) {
      const tree = f.ms.getTree(w.id);
      const vols = tree.volumes;
      const chapters = vols.flatMap((v) => v.chapters);
      const trash = f.ms.getTrash(w.id);
      const r = rand();
      try {
        if (r < 0.1 || vols.length === 0) f.ms.createVolume(w.id, { title: `卷${i}`, afterVolumeId: pick(vols)?.id ?? null });
        else if (r < 0.4) f.ms.createChapter(w.id, { volumeId: pick(vols)!.id, title: `章${i}` });
        else if (r < 0.5 && chapters.length > 0) f.ms.deleteChapter(w.id, pick(chapters)!.id);
        else if (r < 0.55 && vols.length > 1) f.ms.deleteVolume(w.id, pick(vols)!.id);
        else if (r < 0.75 && chapters.length > 0)
          f.ms.moveChapter(w.id, pick(chapters)!.id, { volumeId: pick(vols)!.id, index: Math.floor(rand() * 10) });
        else if (r < 0.8) f.ms.reorderVolumes(w.id, [...vols].sort(() => rand() - 0.5).map((v) => v.id));
        else if (r < 0.95 && trash.chapters.length + trash.volumes.length > 0) {
          const items = [...trash.chapters.map((c) => ({ kind: 'chapter' as const, id: c.id })), ...trash.volumes.map((v) => ({ kind: 'volume' as const, id: v.id }))];
          f.ms.restoreTrash(w.id, pick(items)!);
        } else if (vols.length > 0) {
          const v = pick(vols)!;
          f.ms.reorderChapters(w.id, v.id, [...v.chapters].sort(() => rand() - 0.5).map((c) => c.id));
        }
      } catch (err) {
        throw new Error(`第 ${i} 步出错：${String(err)}`);
      }
      const problems = findSeqViolations(db);
      if (problems.length > 0) throw new Error(`第 ${i} 步后违反 INV-2：${problems.join('; ')}`);
    }
  });

  it('INV-5：删除章节后恢复内容一致；所在分卷也被删除时一并恢复', () => {
    const w = f.ms.createWork({ title: 'T' });
    const v1 = f.ms.getTree(w.id).volumes[0]!;
    const ch = v1.chapters[0]!;
    f.ms.saveChapterBody(w.id, ch.id, { body: '第一段\n第二段', baseRev: 0 });
    const v2 = f.ms.createVolume(w.id, { title: '第二卷' });
    f.ms.deleteChapter(w.id, ch.id);
    f.ms.deleteVolume(w.id, v1.id);
    expect(codeOf(() => f.ms.getChapter(w.id, ch.id))).toBe('NOT_FOUND');
    expect(f.ms.getTrash(w.id)).toMatchObject({ volumes: [{ id: v1.id }], chapters: [{ id: ch.id }] });

    f.ms.restoreTrash(w.id, { kind: 'chapter', id: ch.id });
    expect(f.ms.getChapter(w.id, ch.id)).toMatchObject({ body: '第一段\n第二段', rev: 1 });
    expect(f.ms.getTree(w.id).volumes.map((v) => v.id)).toEqual([v2.id, v1.id]);
    expect(f.ms.getTrash(w.id)).toEqual({ volumes: [], chapters: [] });
  });

  it('彻底删除章节会级联清理版本；只能彻底删除回收站中的条目', () => {
    const w = f.ms.createWork({ title: 'T' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    f.ms.saveChapterBody(w.id, ch.id, { body: 'x', baseRev: 0 });
    expect(codeOf(() => f.ms.purgeTrash(w.id, { kind: 'chapter', id: ch.id }))).toBe('VALIDATION');
    f.ms.deleteChapter(w.id, ch.id);
    f.ms.purgeTrash(w.id, { kind: 'chapter', id: ch.id });
    const db = f.pool.get(w.id);
    expect(db.prepare('SELECT count(*) AS n FROM chapter_revision').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM chapter').get()).toEqual({ n: 0 });
  });

  it('清空回收站', () => {
    const w = f.ms.createWork({ title: 'T' });
    const v1 = f.ms.getTree(w.id).volumes[0]!;
    const c2 = f.ms.createChapter(w.id, { volumeId: v1.id, title: '二' });
    f.ms.deleteChapter(w.id, c2.id);
    f.ms.deleteVolume(w.id, v1.id);
    f.ms.purgeTrash(w.id, 'all');
    expect(f.ms.getTrash(w.id)).toEqual({ volumes: [], chapters: [] });
    expect(f.pool.get(w.id).prepare('SELECT count(*) AS n FROM chapter').get()).toEqual({ n: 0 });
  });
});

describe('正文保存（INV-3 / INV-4）', () => {
  it('换行归一化，字数与哈希同步，rev 恰好加 1，并发出事件', () => {
    const w = f.ms.createWork({ title: 'T' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    const res = f.ms.saveChapterBody(w.id, ch.id, { body: '你好，\r\n世界！\r', baseRev: 0 });
    expect(res).toEqual({ rev: 1, wordCount: 6, updatedAt: f.clock.t });
    const row = f.pool.get(w.id).prepare('SELECT body, word_count, body_hash FROM chapter WHERE id = ?').get(ch.id) as Record<string, unknown>;
    expect(row).toEqual({ body: '你好，\n世界！\n', word_count: countWords('你好，\n世界！\n'), body_hash: bodyHash('你好，\n世界！\n') });
    expect(f.events).toEqual([{ workId: w.id, chapterId: ch.id, rev: 1 }]);
    expect(f.ms.listWorks()[0]?.wordCount).toBe(6);
  });

  it('baseRev 过期时返回冲突（附当前 rev 与正文）且不写入', () => {
    const w = f.ms.createWork({ title: 'T' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    f.ms.saveChapterBody(w.id, ch.id, { body: 'A', baseRev: 0 });
    let caught: DomainError | null = null;
    try {
      f.ms.saveChapterBody(w.id, ch.id, { body: 'B', baseRev: 0 });
    } catch (err) {
      caught = err as DomainError;
    }
    expect(caught?.code).toBe('REV_CONFLICT');
    expect(caught?.extra).toMatchObject({ rev: 1, body: 'A' });
    expect(f.ms.getChapter(w.id, ch.id)).toMatchObject({ body: 'A', rev: 1 });
  });

  it('内容没变时不写入，rev 不变，也不发事件', () => {
    const w = f.ms.createWork({ title: 'T' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    f.ms.saveChapterBody(w.id, ch.id, { body: 'A', baseRev: 0 });
    expect(f.ms.saveChapterBody(w.id, ch.id, { body: 'A', baseRev: 1 }).rev).toBe(1);
    expect(f.events).toHaveLength(1);
  });

  it('超过单章上限被拒绝', () => {
    const w = f.ms.createWork({ title: 'T' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    expect(codeOf(() => f.ms.saveChapterBody(w.id, ch.id, { body: 'a'.repeat(LIMITS.chapterBodyMaxChars + 1), baseRev: 0 }))).toBe('VALIDATION');
  });
});

describe('版本（ADR-004 L3 / INV-6）', () => {
  it('auto 版本每 10 分钟最多一条，每章最多保留 30 条；手动版本不被清理', () => {
    const w = f.ms.createWork({ title: 'T' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    let rev = 0;
    const save = (body: string): void => {
      rev = f.ms.saveChapterBody(w.id, ch.id, { body, baseRev: rev }).rev;
    };
    save('v1');
    f.clock.t += 60_000;
    save('v2');
    expect(f.ms.listRevisions(w.id, ch.id).map((r) => r.reason)).toEqual(['auto']);
    f.ms.createManualRevision(w.id, ch.id);
    f.clock.t += LIMITS.autoRevisionIntervalMs;
    save('v3');
    expect(f.ms.listRevisions(w.id, ch.id).map((r) => [r.reason, r.rev])).toEqual([
      ['auto', 3],
      ['manual', 2],
      ['auto', 1],
    ]);
    for (let i = 0; i < 40; i++) {
      f.clock.t += LIMITS.autoRevisionIntervalMs;
      save(`x${i}`);
    }
    const revs = f.ms.listRevisions(w.id, ch.id);
    expect(revs.filter((r) => r.reason === 'auto')).toHaveLength(LIMITS.autoRevisionKeep);
    expect(revs.filter((r) => r.reason === 'manual')).toHaveLength(1);
    expect(f.ms.getRevision(w.id, ch.id, revs[0]!.id)).toMatchObject({ body: 'x39', title: DEFAULT_CHAPTER_TITLE });
  });

  it('恢复版本：同一事务内先写 before_restore 快照，再覆盖标题与正文', () => {
    const w = f.ms.createWork({ title: 'T' });
    const ch = f.ms.getTree(w.id).volumes[0]!.chapters[0]!;
    f.ms.saveChapterBody(w.id, ch.id, { body: '旧稿', baseRev: 0 });
    const old = f.ms.listRevisions(w.id, ch.id)[0]!;
    f.ms.renameChapter(w.id, ch.id, '新标题');
    f.ms.saveChapterBody(w.id, ch.id, { body: '新稿', baseRev: 1 });

    expect(codeOf(() => f.ms.restoreRevision(w.id, ch.id, old.id, 0))).toBe('REV_CONFLICT');
    expect(f.ms.listRevisions(w.id, ch.id).some((r) => r.reason === 'before_restore')).toBe(false);

    const res = f.ms.restoreRevision(w.id, ch.id, old.id, 2);
    expect(res.rev).toBe(3);
    expect(f.ms.getChapter(w.id, ch.id)).toMatchObject({ body: '旧稿', title: DEFAULT_CHAPTER_TITLE, rev: 3 });
    const snap = f.ms.listRevisions(w.id, ch.id).find((r) => r.reason === 'before_restore')!;
    expect(f.ms.getRevision(w.id, ch.id, snap.id)).toMatchObject({ body: '新稿', title: '新标题', rev: 2 });
  });
});

describe('导出', () => {
  it('TXT 与 Markdown 按卷序、章序输出，不含已删除内容', async () => {
    const w = f.ms.createWork({ title: '书:名?', author: '某人' });
    const v1 = f.ms.getTree(w.id).volumes[0]!;
    const c1 = v1.chapters[0]!;
    f.ms.saveChapterBody(w.id, c1.id, { body: '第一段\n# 不是标题', baseRev: 0 });
    const v2 = f.ms.createVolume(w.id, { title: '第二卷' });
    const c2 = f.ms.createChapter(w.id, { volumeId: v2.id, title: '第二章' });
    f.ms.saveChapterBody(w.id, c2.id, { body: '第二章正文', baseRev: 0 });
    const gone = f.ms.createChapter(w.id, { volumeId: v2.id, title: '删掉的章' });
    f.ms.deleteChapter(w.id, gone.id);

    const txt = await f.ms.exportWork(w.id, 'txt');
    expect(txt.filename).toBe('书_名_.txt');
    expect(txt.content.startsWith('\ufeff书:名?\r\n作者：某人\r\n')).toBe(true);
    const order = ['第一卷', '第一章', '第一段', '第二卷', '第二章', '第二章正文'].map((s) => txt.content.indexOf(s));
    expect(order.every((pos, i) => pos > (order[i - 1] ?? -1))).toBe(true);
    expect(txt.content).not.toContain('删掉的章');

    const md = await f.ms.exportWork(w.id, 'md');
    expect(md.content).toContain('## 第一卷\n\n### 第一章\n\n第一段\n\n\\# 不是标题\n');
    expect(md.content).toContain('### 第二章\n\n第二章正文\n');
  });
});

describe('每日整库备份', () => {
  it('作品当天首次打开时备份一次，最多保留 7 份', async () => {
    f.cleanup();
    f = makeManuscript({ backups: true });
    const w = f.ms.createWork({ title: '备份' });
    await f.backups.whenIdle();
    const dir = join(f.paths.backups, w.id);
    expect(readdirSync(dir)).toEqual(['20261009.novel']);
    f.pool.closeAll();
    f.ms.getTree(w.id);
    await f.backups.whenIdle();
    expect(readdirSync(dir)).toHaveLength(1);
    for (let d = 1; d <= 8; d++) {
      f.pool.closeAll();
      f.clock.t += 24 * 3600 * 1000;
      f.ms.getTree(w.id);
      await f.backups.whenIdle();
    }
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(7);
    expect(files.at(-1)).toBe('20261017.novel');
  });
});
