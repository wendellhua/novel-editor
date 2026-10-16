import type { DraftRecord } from '../editor/save-controller';

/** L1 浏览器草稿（ADR-004）：IndexedDB `novel-editor` / `drafts`，键为 `{workId}:{chapterId}`。 */
const DB_NAME = 'novel-editor';
const STORE = 'drafts';
const VERSION = 1;

export interface StoredDraft extends DraftRecord {
  key: string;
  workId: string;
  chapterId: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('workId', 'workId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('无法打开浏览器草稿库'));
    };
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode, { durability: 'strict' });
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error('草稿读写失败'));
        tx.onabort = () => reject(tx.error ?? new Error('草稿读写被中止'));
      }),
  );
}

export const draftKey = (workId: string, chapterId: string): string => `${workId}:${chapterId}`;

export const drafts = {
  get(workId: string, chapterId: string): Promise<StoredDraft | null> {
    return run('readonly', (s) => s.get(draftKey(workId, chapterId)) as IDBRequest<StoredDraft | undefined>).then((d) => d ?? null);
  },
  put(workId: string, chapterId: string, draft: DraftRecord): Promise<void> {
    const record: StoredDraft = { key: draftKey(workId, chapterId), workId, chapterId, ...draft };
    return run('readwrite', (s) => s.put(record)).then(() => undefined);
  },
  remove(workId: string, chapterId: string): Promise<void> {
    return run('readwrite', (s) => s.delete(draftKey(workId, chapterId))).then(() => undefined);
  },
  listByWork(workId: string): Promise<StoredDraft[]> {
    return run('readonly', (s) => s.index('workId').getAll(workId) as IDBRequest<StoredDraft[]>);
  },
};
