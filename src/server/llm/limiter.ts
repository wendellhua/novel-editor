import { abortError } from './errors';

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** 计数信号量（§7.3「每个 profile 一个信号量」）。调小 size 不会打断已在运行的任务，只影响后续放行。 */
export class Semaphore {
  private size: number;
  private running = 0;
  private readonly queue: Waiter[] = [];
  private readonly onChange: () => void;

  /** onChange：进行中或排队数变化后调用（用于推送模型运行状态）。 */
  constructor(size: number, onChange: () => void = () => undefined) {
    this.size = Math.max(1, Math.floor(size));
    this.onChange = onChange;
  }

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  setSize(size: number): void {
    this.size = Math.max(1, Math.floor(size));
    if (this.drain()) this.onChange();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.running--;
      this.drain();
      this.onChange();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    if (this.running < this.size && this.queue.length === 0) {
      this.running++;
      this.onChange();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = (): void => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        this.onChange();
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
      this.onChange();
    });
  }

  /** 按空出的名额放行排队者；返回是否放行了。 */
  private drain(): boolean {
    let moved = false;
    while (this.running < this.size && this.queue.length > 0) {
      this.running++;
      this.queue.shift()?.resolve();
      moved = true;
    }
    return moved;
  }
}

/** 按模型配置 id 管理信号量；每次取用时同步最新的 maxConcurrency。 */
export class LimiterRegistry {
  private readonly map = new Map<string, Semaphore>();
  private readonly onChange: (profileId: string) => void;

  constructor(onChange: (profileId: string) => void = () => undefined) {
    this.onChange = onChange;
  }

  get(profileId: string, size: number): Semaphore {
    let sem = this.map.get(profileId);
    if (sem === undefined) {
      sem = new Semaphore(size, () => this.onChange(profileId));
      this.map.set(profileId, sem);
    } else {
      sem.setSize(size);
    }
    return sem;
  }

  /** 进行中与排队的数量（不创建信号量）。 */
  activity(profileId: string): { active: number; waiting: number } {
    const sem = this.map.get(profileId);
    return { active: sem?.active ?? 0, waiting: sem?.waiting ?? 0 };
  }

  delete(profileId: string): void {
    this.map.delete(profileId);
  }
}
