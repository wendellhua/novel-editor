# ADR-003：数据存储——node:sqlite，每部作品一个 .novel 库
- **状态**：已采纳
- **日期**：2026-10-09

## 背景 (Context)
- 规模：百万字（假设上限 300 万字）、几千章。
- 要求：保存必须原子化；章节历史、AI 任务状态、问题记录和设定库都需要持久化；要能做中文全文检索，用来给一致性检查找「前文提及」。
- 打包限制：禁止原生模块（ADR-002）。

## 候选选项 (Options)
1. **`node:sqlite`，每部作品一个库文件**
   - 优点：内置、无需原生模块；支持事务、WAL 和 FTS5；单个文件就能备份或迁移。
   - 缺点：模块还处于 RC 阶段；没有现成的事务封装。
2. **`node:sqlite`，所有作品共用一个库**
   - 优点：跨作品查询方便。
   - 缺点：一个文件损坏会影响全部作品；删除、备份、迁移单部作品都不方便。
3. **纯文件存储（每章一个 md 文件 + JSON 索引）**
   - 优点：人可以直接阅读，便于用 git 管理。
   - 缺点：多个文件的更新做不到原子性；检索、缓存、任务状态都要自己实现。
4. **`better-sqlite3`**
   - 优点：成熟。
   - 缺点：是原生模块，和 SEA 单文件打包冲突。

## 决定 (Decision)
采用选项 1。
- **文件**：每部作品一个 `works/{workId}.novel` 文件。
- **PRAGMA**：`journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`，busy timeout 设为 5 s。
- **连接**：用 LRU 连接池，最多同时打开 8 个库。
- **事务**：自己实现 `tx(db, fn)` 封装：执行 `BEGIN IMMEDIATE`，成功则 `COMMIT`，异常时检查 `isTransaction` 后 `ROLLBACK`。
- **全文检索**：`chapter_fts` 用 FTS5 trigram 分词，**延迟构建**（见下方「修订 1」）。
  - 查询词 ≥ 3 字：用 `MATCH`；
  - 不足 3 字：回退到 `instr(body, ?)` 全表扫描（本机 PoC 结论）。
- **兼容**：Node 26 中 `Database` 是新名，旧名 `DatabaseSync` 已弃用。代码写成 `sqlite.Database ?? sqlite.DatabaseSync`，同时兼容两种。
- **迁移**：`meta.schema_version` 加 `storage/migrations/NNN.ts`，按版本号顺序执行，每个迁移在一个事务里完成。

## 理由 (Rationale)
- 「每次写入都是一次事务提交」是不丢稿最可靠的基础，配合 `synchronous=FULL`，掉电也不会丢已提交的数据。
- 一部作品一个文件，复制即备份，删除即移动，故障影响范围只限这一部作品。
- 本机 PoC 已验证 FTS5 trigram 可用、事务回滚正常（调研 F3、F4）。

## 后果 (Consequences)
- **正面**
  - 正文、版本、设定和 AI 结果都放在同一个库里，引用关系由外键保证。
  - 每日备份可以直接用 `sqlite.backup()` 在线完成。
- **负面 / 代价**
  - 全部是同步 API，大查询会阻塞事件循环。缓解措施：
    - 目录树查询不读取正文 `body`；
    - 导出时逐章读取，每 50 章让出一次事件循环（`setImmediate`）。
  - 没有跨作品搜索（v1 不需要）。
  - FTS 会让库体积增加约 3 倍，可以接受。
  - 如果 `node:sqlite` 的 API 改名，需要跟进修改（已做兼容封装）。

## 修订 1（2026-10-09，T6）：全文索引改为延迟构建

**问题**：最初的设计用外部内容表 + `AFTER UPDATE OF body` 触发器，每次保存都在同一事务里重建该章的 trigram 索引。T6 性能测试（300 万字、3000 章合成库）中，保存一章 5 万字的正文中位数为 **51.4 ms**，超过 §1.1「单次保存 < 50 ms」的目标。剖析结果：哈希 0.2 ms、字数统计 0.9 ms、不带 FTS 的 UPDATE 8～17 ms，FTS 重建占 20～30 ms，并随索引规模增长。

**决定**：
- `chapter_fts` 改为 `content='', contentless_delete=1`（SQLite ≥ 3.43，Node 25 内置 3.50.4、Node 26 内置 3.53.4），删除旧索引只需 rowid，不需要旧正文。
- 新增章节、彻底删除章节仍由触发器即时维护索引；**正文修改只往 `chapter_fts_dirty(rid)` 登记脏行**。
- `storage/fts.ts`：`flushFtsIndex(db)` 在一个事务里把脏行重建进索引；`FtsIndexer` 在作品有正文写入后防抖 3 s 在后台冲刷，退出前 `flushAll()`；`searchChapterRids()` 查询前一定先冲刷，所以检索结果永远与正文一致。

**结果**：保存 5 万字章节 **3.0 ms**；索引重建移到后台，单次约 64 ms（同步执行，会短暂占用事件循环，但不在保存请求路径上，连续输入时也会被防抖合并）。

**代价**：contentless 表无法用 `snippet()` / `highlight()` 取原文，需要时从 `chapter.body` 自行截取（§7.4.1 ⑤ 本来就是自行截取前后 80 字）。
