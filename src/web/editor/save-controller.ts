import type { SaveBodyResponse } from '../../shared/types';
import { ApiError } from '../api/client';

/** F2 三层防丢稿的时间参数（ADR-004）。 */
export const SAVE_TIMING = {
  draftDebounceMs: 300,
  idleMs: 1500,
  maxIntervalMs: 10_000,
  retryMs: 3000,
  /** 浏览器对 keepalive 请求体限制 64 KB，留出余量。超出时关闭页面只靠草稿兜底。 */
  keepaliveMaxBytes: 60_000,
} as const;

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'unauthorized' | 'error';

export interface DraftRecord {
  body: string;
  baseRev: number;
  updatedAt: number;
}

export interface ConflictInfo {
  mine: string;
  server: { rev: number; body: string; title: string };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface SaveControllerDeps {
  save(body: string, baseRev: number): Promise<SaveBodyResponse>;
  saveKeepalive(body: string, baseRev: number): void;
  putDraft(draft: DraftRecord): Promise<void>;
  removeDraft(): Promise<void>;
  onStatus?(status: SaveStatus, detail: string | null): void;
  onSaved?(res: SaveBodyResponse): void;
  onConflict?(info: ConflictInfo): void;
  timers?: Timers;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
};

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * 单章节的保存调度器（F2 L1 + L2）：
 * - 内容变化后 300 ms 写浏览器草稿；停止输入 1.5 s、或连续输入满 10 s 时提交服务端；
 * - 同一时刻只有一个保存请求，期间的新改动在请求结束后继续保存；
 * - 409 进入冲突状态并暂停自动保存；网络错误 / 5xx 进入离线状态，每 3 s 重试；401 停止重试，内容留在草稿；
 * - 服务端确认的内容与当前内容一致时删除草稿。
 */
export class SaveController {
  private readonly deps: SaveControllerDeps;
  private readonly t: Timers;
  private current: string;
  private saved: string;
  private rev: number;
  private state: SaveStatus = 'saved';
  private firstDirtyAt: number | null = null;
  private lastChangeAt = 0;
  private saveTimer: unknown = null;
  private draftTimer: unknown = null;
  private inflight: Promise<void> | null = null;
  private disposed = false;

  constructor(initial: { body: string; rev: number }, deps: SaveControllerDeps) {
    this.deps = deps;
    this.t = deps.timers ?? realTimers;
    this.current = initial.body;
    this.saved = initial.body;
    this.rev = initial.rev;
  }

  get body(): string {
    return this.current;
  }
  get baseRev(): number {
    return this.rev;
  }
  get status(): SaveStatus {
    return this.state;
  }
  get dirty(): boolean {
    return this.current !== this.saved;
  }

  /** 编辑器内容变化（每次按键调用）。 */
  change(body: string): void {
    if (this.disposed || body === this.current) return;
    this.current = body;
    const now = this.t.now();
    this.lastChangeAt = now;
    this.scheduleDraft();
    if (!this.dirty) {
      this.firstDirtyAt = null;
      this.cancelSave();
      this.cancelDraft();
      void this.deps.removeDraft();
      if (this.state === 'dirty') this.setStatus('saved');
      return;
    }
    this.firstDirtyAt ??= now;
    if (this.state === 'saved' || this.state === 'error') this.setStatus('dirty');
    if (this.state === 'dirty') this.scheduleSave();
  }

  /** 立即保存（失焦、切到后台、切换章节、恢复版本前调用）。等待进行中的保存结束。 */
  async flush(): Promise<void> {
    if (this.inflight !== null) await this.inflight;
    if (this.disposed || !this.dirty || this.state === 'conflict' || this.state === 'unauthorized') return;
    this.cancelSave();
    await this.runSave();
  }

  /** 解决冲突：mine 以当前内容覆盖服务端；theirs 采用服务端内容。返回编辑器应显示的正文。 */
  resolveConflict(choice: 'mine' | 'theirs', server: ConflictInfo['server']): string {
    this.rev = server.rev;
    if (choice === 'theirs') {
      this.current = server.body;
      this.saved = server.body;
      this.firstDirtyAt = null;
      this.cancelDraft();
      void this.deps.removeDraft();
      this.setStatus('saved');
    } else {
      this.saved = server.body;
      this.firstDirtyAt = this.t.now();
      this.setStatus('dirty');
      void this.flush();
    }
    return this.current;
  }

  /** 服务端内容被别处更新且本地没有未保存改动时调用（SSE chapter.updated）。 */
  replaceFromServer(body: string, rev: number): boolean {
    if (this.dirty || rev <= this.rev) return false;
    this.current = body;
    this.saved = body;
    this.rev = rev;
    return true;
  }

  /** 页面关闭（pagehide）：立即写草稿；正文不超过 keepalive 上限时尽力提交一次。 */
  pageHide(): void {
    if (!this.dirty) return;
    this.cancelDraft();
    void this.deps.putDraft({ body: this.current, baseRev: this.rev, updatedAt: this.t.now() });
    if (this.state !== 'conflict' && this.state !== 'unauthorized' && byteLength(this.current) <= SAVE_TIMING.keepaliveMaxBytes) {
      this.deps.saveKeepalive(this.current, this.rev);
    }
  }

  /** 卸载编辑器：有未保存内容时立即写草稿并发起最后一次保存。 */
  dispose(): Promise<void> {
    const pending = this.dirty ? this.deps.putDraft({ body: this.current, baseRev: this.rev, updatedAt: this.t.now() }) : Promise.resolve();
    this.cancelDraft();
    const finalSave = this.flush();
    this.disposed = true;
    this.cancelSave();
    return Promise.all([pending, finalSave]).then(() => undefined);
  }

  // ---------------- 内部 ----------------

  private setStatus(status: SaveStatus, detail: string | null = null): void {
    this.state = status;
    this.deps.onStatus?.(status, detail);
  }

  private scheduleDraft(): void {
    this.cancelDraft();
    this.draftTimer = this.t.setTimeout(() => {
      this.draftTimer = null;
      if (this.dirty) void this.deps.putDraft({ body: this.current, baseRev: this.rev, updatedAt: this.t.now() });
    }, SAVE_TIMING.draftDebounceMs);
  }

  private cancelDraft(): void {
    if (this.draftTimer !== null) this.t.clearTimeout(this.draftTimer);
    this.draftTimer = null;
  }

  private scheduleSave(delayOverride?: number): void {
    if (this.disposed || this.inflight !== null) return;
    this.cancelSave();
    const now = this.t.now();
    const idleAt = this.lastChangeAt + SAVE_TIMING.idleMs;
    const maxAt = (this.firstDirtyAt ?? now) + SAVE_TIMING.maxIntervalMs;
    const delay = delayOverride ?? Math.max(0, Math.min(idleAt, maxAt) - now);
    this.saveTimer = this.t.setTimeout(() => {
      this.saveTimer = null;
      void this.runSave();
    }, delay);
  }

  private cancelSave(): void {
    if (this.saveTimer !== null) this.t.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private runSave(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    if (!this.dirty) return Promise.resolve();
    const body = this.current;
    const baseRev = this.rev;
    this.setStatus('saving');
    this.firstDirtyAt = null;
    this.inflight = this.deps
      .save(body, baseRev)
      .then((res) => {
        this.rev = res.rev;
        this.saved = body;
        this.deps.onSaved?.(res);
        if (this.dirty) {
          this.firstDirtyAt ??= this.t.now();
          this.setStatus('dirty');
        } else {
          this.cancelDraft();
          void this.deps.removeDraft();
          this.setStatus('saved');
        }
      })
      .catch((err: unknown) => this.handleError(err))
      .finally(() => {
        this.inflight = null;
        if (this.state === 'dirty') this.scheduleSave();
        else if (this.state === 'offline') this.scheduleSave(SAVE_TIMING.retryMs);
      });
    return this.inflight;
  }

  private handleError(err: unknown): void {
    if (this.dirty) this.firstDirtyAt ??= this.t.now();
    if (err instanceof ApiError && err.code === 'REV_CONFLICT') {
      const d = err.details;
      const server = { rev: Number(d.rev), body: String(d.body ?? ''), title: String(d.title ?? '') };
      if (server.body === this.current) {
        this.rev = server.rev;
        this.saved = server.body;
        this.setStatus('saved');
        return;
      }
      this.setStatus('conflict');
      this.deps.onConflict?.({ mine: this.current, server });
      return;
    }
    if (err instanceof ApiError && err.status === 401) {
      this.setStatus('unauthorized', err.message);
      return;
    }
    if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) {
      this.setStatus('offline', err instanceof Error ? err.message : String(err));
      return;
    }
    this.setStatus('error', err.message);
  }
}

export type DraftDecision = 'none' | 'discard' | 'restore' | 'ask';

/**
 * 打开章节时的草稿恢复规则（F2 第 4 步）：
 * 无草稿 → none；草稿与服务端一致 → discard；草稿基于当前版本 → restore（自动恢复并立即保存）；
 * 服务端在草稿之后又被修改过（或版本对不上）→ ask（让作者选择）。
 */
export function decideDraftRecovery(server: { rev: number; body: string }, draft: Pick<DraftRecord, 'baseRev' | 'body'> | null): DraftDecision {
  if (draft === null) return 'none';
  if (draft.body === server.body) return 'discard';
  if (draft.baseRev === server.rev) return 'restore';
  return 'ask';
}
