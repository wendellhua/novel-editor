import type { SqliteDatabase } from '../sqlite';

export interface Migration {
  version: number;
  name: string;
  /**
   * 迁移要重建被外键引用的表（修改 CHECK 约束只能重建）：执行前关闭外键、提交前做 foreign_key_check。
   * 否则 DROP TABLE 会触发 ON DELETE CASCADE，删掉子表的数据（SQLite 文档「Making Other Kinds Of Table Schema Changes」）。
   */
  rebuildsTables?: boolean;
  up(db: SqliteDatabase): void;
}
