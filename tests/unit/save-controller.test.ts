import { describe, expect, it } from 'vitest';
import type { SaveBodyResponse } from '../../src/shared/types';
import { ApiError } from '../../src/web/api/client';
import {
  SAVE_TIMING,
  SaveController,
  decideDraftRecovery,
  type ConflictInfo,
  type DraftRecord,
  type SaveStatus,
  type Timers,
} from '../../src/web/editor/save-controller';

class FakeTimers implements Timers {
  t = 0;
  private seq = 0;
  private queue = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.queue.delete(h as number);
  }
  now(): number {
    return this.t;
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flushMicrotasks();
      const next = [...this.queue.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.queue.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

interface Harness {
  c: SaveController;
  timers: FakeTimers;
  saves: { body: string; baseRev: number }[];
  keepalives: { body: string; baseRev: number }[];
  drafts: (DraftRecord | 'removed')[];
  statuses: SaveStatus[];
  conflicts: ConflictInfo[];
  server: { rev: number; body: string };
  failNext: (err: unknown) => void;
  holdNext: () => () => void;
}

function harness(initial = { body: '', rev: 0 }): Harness {
  const timers = new FakeTimers();
  const h = {
    saves: [] as Harness['saves'],
    keepalives: [] as Harness['keepalives'],
    drafts: [] as Harness['drafts'],
    statuses: [] as SaveStatus[],
    conflicts: [] as ConflictInfo[],
    server: { ...initial },
    pendingError: null as unknown,
    hold: null as Promise<void> | null,
  };
  const c = new SaveController(initial, {
    timers,
    save: async (body, baseRev): Promise<SaveBodyResponse> => {
      h.saves.push({ body, baseRev });
      if (h.hold !== null) await h.hold;
      if (h.pendingError !== null) {
        const e = h.pendingError;
        h.pendingError = null;
        throw e;
      }
      if (baseRev !== h.server.rev) {
        throw new ApiError(409, 'REV_CONFLICT', '冲突', { rev: h.server.rev, body: h.server.body, title: 't' });
      }
      h.server = { rev: h.server.rev + 1, body };
      return { rev: h.server.rev, wordCount: body.length, updatedAt: timers.now() };
    },
    saveKeepalive: (body, baseRev) => h.keepalives.push({ body, baseRev }),
    putDraft: async (d) => void h.drafts.push(d),
    removeDraft: async () => void h.drafts.push('removed'),
    onStatus: (s) => h.statuses.push(s),
    onConflict: (info) => h.conflicts.push(info),
  });
  return {
    c,
    timers,
    get saves() {
      return h.saves;
    },
    get keepalives() {
      return h.keepalives;
    },
    get drafts() {
      return h.drafts;
    },
    get statuses() {
      return h.statuses;
    },
    get conflicts() {
      return h.conflicts;
    },
    get server() {
      return h.server;
    },
    set server(v) {
      h.server = v;
    },
    failNext: (err) => (h.pendingError = err),
    holdNext: () => {
      let release!: () => void;
      h.hold = new Promise<void>((r) => (release = r));
      return () => {
        h.hold = null;
        release();
      };
    },
  } as Harness;
}

describe('SaveController 时间规则（F2）', () => {
  it('300 ms 后写草稿；停止输入 1.5 s 后保存；保存成功后删除草稿', async () => {
    const h = harness();
    h.c.change('第一句');
    await h.timers.advance(299);
    expect(h.drafts).toEqual([]);
    await h.timers.advance(1);
    expect(h.drafts).toEqual([{ body: '第一句', baseRev: 0, updatedAt: 300 }]);
    await h.timers.advance(SAVE_TIMING.idleMs - 301);
    expect(h.saves).toEqual([]);
    await h.timers.advance(1);
    expect(h.saves).toEqual([{ body: '第一句', baseRev: 0 }]);
    expect(h.c.baseRev).toBe(1);
    expect(h.c.status).toBe('saved');
    expect(h.drafts.at(-1)).toBe('removed');
    expect(h.statuses).toEqual(['dirty', 'saving', 'saved']);
  });

  it('连续输入时最长每 10 s 保存一次', async () => {
    const h = harness();
    for (let i = 1; i <= 25; i++) {
      h.c.change(`字${i}`);
      await h.timers.advance(500);
    }
    expect(h.saves.map((s) => s.body)).toEqual(['字20']);
    expect(h.saves).toHaveLength(1);
  });

  it('保存进行中的新改动在请求结束后继续保存，不并发', async () => {
    const h = harness();
    h.c.change('A');
    const release = h.holdNext();
    await h.timers.advance(SAVE_TIMING.idleMs);
    expect(h.c.status).toBe('saving');
    h.c.change('AB');
    await h.timers.advance(5000);
    expect(h.saves).toHaveLength(1);
    release();
    await h.timers.advance(0);
    expect(h.statuses.slice(-3), '第一次完成后转为 dirty，空闲期已过，立即开始第二次保存').toEqual(['dirty', 'saving', 'saved']);
    expect(h.saves.map((s) => [s.body, s.baseRev])).toEqual([
      ['A', 0],
      ['AB', 1],
    ]);
    expect(h.server).toEqual({ rev: 2, body: 'AB' });
  });

  it('改回已保存的内容：取消待保存并删除草稿', async () => {
    const h = harness({ body: '原文', rev: 3 });
    h.c.change('原文改');
    await h.timers.advance(400);
    h.c.change('原文');
    await h.timers.advance(20_000);
    expect(h.saves).toEqual([]);
    expect(h.c.status).toBe('saved');
    expect(h.drafts.at(-1)).toBe('removed');
  });

  it('flush 立即保存并等待完成', async () => {
    const h = harness();
    h.c.change('立即');
    await h.c.flush();
    expect(h.saves).toEqual([{ body: '立即', baseRev: 0 }]);
    expect(h.c.status).toBe('saved');
  });
});

describe('SaveController 错误处理', () => {
  it('网络错误进入离线状态，每 3 s 重试直到成功', async () => {
    const h = harness();
    h.failNext(new ApiError(0, 'NETWORK', '无法连接到本地服务'));
    h.c.change('断网时写的');
    await h.timers.advance(SAVE_TIMING.idleMs);
    expect(h.c.status).toBe('offline');
    h.failNext(new ApiError(503, 'INTERNAL', 'x'));
    await h.timers.advance(SAVE_TIMING.retryMs);
    expect(h.c.status).toBe('offline');
    await h.timers.advance(SAVE_TIMING.retryMs);
    expect(h.c.status).toBe('saved');
    expect(h.saves).toHaveLength(3);
    expect(h.server.body).toBe('断网时写的');
  });

  it('409 冲突：暂停自动保存并给出双方内容；选择「保留我的」后以新 rev 覆盖', async () => {
    const h = harness({ body: '共同起点', rev: 1 });
    h.server = { rev: 2, body: '另一个标签页写的' };
    h.c.change('我写的');
    await h.timers.advance(SAVE_TIMING.idleMs);
    expect(h.c.status).toBe('conflict');
    expect(h.conflicts).toEqual([{ mine: '我写的', server: { rev: 2, body: '另一个标签页写的', title: 't' } }]);
    h.c.change('我写的还在继续');
    await h.timers.advance(30_000);
    expect(h.saves).toHaveLength(1);

    const shown = h.c.resolveConflict('mine', h.conflicts[0]!.server);
    expect(shown).toBe('我写的还在继续');
    await h.timers.advance(0);
    expect(h.server).toEqual({ rev: 3, body: '我写的还在继续' });
    expect(h.c.status).toBe('saved');
  });

  it('409 冲突：选择「使用服务器的」后编辑器内容替换为服务端版本，草稿删除', async () => {
    const h = harness({ body: 'a', rev: 1 });
    h.server = { rev: 5, body: '服务端' };
    h.c.change('本地');
    await h.timers.advance(SAVE_TIMING.idleMs);
    const shown = h.c.resolveConflict('theirs', h.conflicts[0]!.server);
    expect(shown).toBe('服务端');
    expect(h.c.baseRev).toBe(5);
    expect(h.c.dirty).toBe(false);
    expect(h.drafts.at(-1)).toBe('removed');
  });

  it('409 但服务端内容与本地相同（例如 keepalive 已提交）：视为已保存', async () => {
    const h = harness({ body: 'a', rev: 1 });
    h.server = { rev: 2, body: '同样的内容' };
    h.c.change('同样的内容');
    await h.timers.advance(SAVE_TIMING.idleMs);
    expect(h.c.status).toBe('saved');
    expect(h.c.baseRev).toBe(2);
    expect(h.conflicts).toEqual([]);
  });

  it('401 会话失效：停止重试，内容留在草稿', async () => {
    const h = harness();
    h.failNext(new ApiError(401, 'UNAUTHORIZED', '会话已失效'));
    h.c.change('写到一半');
    await h.timers.advance(SAVE_TIMING.idleMs + 60_000);
    expect(h.c.status).toBe('unauthorized');
    expect(h.saves).toHaveLength(1);
    expect(h.drafts.filter((d) => d !== 'removed').at(-1)).toMatchObject({ body: '写到一半' });
  });
});

describe('SaveController 页面关闭与外部更新', () => {
  it('pagehide：立即写草稿；正文 ≤ 60 KB 时发送 keepalive，超出则不发', () => {
    const h = harness();
    h.c.change('短正文');
    h.c.pageHide();
    expect(h.drafts.at(-1)).toMatchObject({ body: '短正文' });
    expect(h.keepalives).toEqual([{ body: '短正文', baseRev: 0 }]);

    const big = harness();
    big.c.change('字'.repeat(25_000));
    big.c.pageHide();
    expect(big.drafts).toHaveLength(1);
    expect(big.keepalives).toEqual([]);
  });

  it('replaceFromServer：只有本地无改动且 rev 更新时才替换', () => {
    const h = harness({ body: 'a', rev: 1 });
    expect(h.c.replaceFromServer('别处改的', 1)).toBe(false);
    expect(h.c.replaceFromServer('别处改的', 2)).toBe(true);
    expect(h.c.body).toBe('别处改的');
    h.c.change('本地改动');
    expect(h.c.replaceFromServer('再改', 3)).toBe(false);
    expect(h.c.body).toBe('本地改动');
  });

  it('dispose：立即写草稿并发起最后一次保存', async () => {
    const h = harness();
    h.c.change('切换章节前');
    await h.c.dispose();
    expect(h.drafts[0]).toMatchObject({ body: '切换章节前' });
    expect(h.saves).toEqual([{ body: '切换章节前', baseRev: 0 }]);
    h.c.change('卸载后的改动被忽略');
    expect(h.c.body).toBe('切换章节前');
  });
});

describe('decideDraftRecovery（F2 第 4 步）', () => {
  const server = { rev: 3, body: '服务端' };
  it.each([
    [null, 'none'],
    [{ baseRev: 3, body: '服务端' }, 'discard'],
    [{ baseRev: 1, body: '服务端' }, 'discard'],
    [{ baseRev: 3, body: '草稿' }, 'restore'],
    [{ baseRev: 2, body: '草稿' }, 'ask'],
    [{ baseRev: 9, body: '草稿' }, 'ask'],
  ] as const)('%j → %s', (draft, expected) => {
    expect(decideDraftRecovery(server, draft)).toBe(expected);
  });
});
