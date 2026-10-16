// 前后端共享的数据契约（docs/ARCHITECTURE.md §6.2 / §6.3）。属性名必须与文档逐字一致。

export type Id = string;
/** 作者在检查面板中可以发起的类型：四类检查 + AI 味检测 + 灵感胶囊 + 智能扩写。 */
export type CheckType = 'typo' | 'review' | 'setting' | 'character' | 'ai_flavor' | 'inspiration' | 'expand';
/** memory（剧情记忆）只由系统自动创建（ADR-011）。 */
export type JobType = CheckType | 'bible_extract' | 'memory';
export type TaskKind = JobType | 'summary';
export type JsonMode = 'json_schema' | 'json_object' | 'prompt';
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type IssueCategory = 'typo' | 'punctuation' | 'grammar' | 'review' | 'setting' | 'character' | 'ai_flavor';
export type Severity = 'error' | 'warning' | 'info';
export type IssueStatus = 'open' | 'applied' | 'ignored' | 'stale';
export type RevisionReason = 'auto' | 'manual' | 'before_fix' | 'before_restore' | 'before_expand';
export type EntryKind = 'character' | 'location' | 'faction' | 'item' | 'rule' | 'other';
export type ThemeMode = 'light' | 'dark' | 'system';

export interface Scope {
  kind: 'work' | 'volume' | 'chapter';
  id: Id;
}

// ---------- §6.2 应用级配置 ----------

export interface AppConfig {
  version: 1;
  port: number;
  authSecret: string;
  hubClientId: string;
  ui: { fontSize: number; theme: ThemeMode };
}

export interface LlmProfileRecord {
  id: Id;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: JsonMode;
  maxConcurrency: number;
  timeoutMs: number;
  maxOutputTokens: number;
  contextTokens: number;
  temperature: number;
  extraBody: Record<string, unknown>;
}

export interface LlmConfig {
  version: 1;
  profiles: LlmProfileRecord[];
  defaults: Record<TaskKind, Id | null>;
}

export interface SkillRecord {
  id: Id;
  source: 'skillhub' | 'local';
  dir: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  appliesTo: JobType[];
  hub: { namespace: string; slug: string } | null;
  installedAt: number;
}

export interface SkillRegistry {
  version: 1;
  skills: SkillRecord[];
}

// ---------- §6.3 API DTO ----------

export interface SystemInfo {
  appVersion: string;
  dataDir: string;
  platform: string;
  nodeVersion: string;
}

export interface SelfcheckResult {
  ok: boolean;
  sqliteVersion: string;
  fts5: boolean;
  trigram: boolean;
  error: string | null;
}

export interface WorkSummary {
  id: Id;
  title: string;
  author: string;
  wordCount: number;
  chapterCount: number;
  updatedAt: number;
}

export interface Work {
  id: Id;
  title: string;
  author: string;
  genre: string;
  synopsis: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChapterNode {
  id: Id;
  volumeId: Id;
  title: string;
  seq: number;
  wordCount: number;
  updatedAt: number;
}

export interface VolumeNode {
  id: Id;
  title: string;
  seq: number;
  chapters: ChapterNode[];
}

export interface WorkTree {
  work: Work;
  volumes: VolumeNode[];
}

export interface Chapter {
  id: Id;
  volumeId: Id;
  title: string;
  seq: number;
  body: string;
  rev: number;
  wordCount: number;
  updatedAt: number;
}

export interface SaveBodyRequest {
  body: string;
  baseRev: number;
}

export interface SaveBodyResponse {
  rev: number;
  wordCount: number;
  updatedAt: number;
}

export interface RevisionMeta {
  id: number;
  chapterId: Id;
  rev: number;
  reason: RevisionReason;
  wordCount: number;
  createdAt: number;
}

export interface RevisionDetail extends RevisionMeta {
  title: string;
  body: string;
}

export interface TrashList {
  volumes: { id: Id; title: string; deletedAt: number }[];
  chapters: { id: Id; volumeId: Id; title: string; deletedAt: number }[];
}

export interface TrashItemRef {
  kind: 'volume' | 'chapter';
  id: Id;
}

/** 回收站中的整部作品（文件名形如 `{workId}-{deletedAt}.novel`）。 */
export interface TrashedWork {
  file: string;
  workId: Id;
  title: string;
  deletedAt: number;
}

export type ExportFormat = 'txt' | 'md';

export interface CreateWorkRequest {
  title: string;
  author?: string;
  genre?: string;
  synopsis?: string;
}

export type UpdateWorkRequest = Partial<Pick<Work, 'title' | 'author' | 'genre' | 'synopsis'>>;

export interface CreateVolumeRequest {
  title: string;
  afterVolumeId?: Id | null;
}

export interface CreateChapterRequest {
  volumeId: Id;
  title: string;
  afterChapterId?: Id | null;
}

export interface MoveChapterRequest {
  volumeId: Id;
  index: number;
}

export interface LlmProfile extends Omit<LlmProfileRecord, 'apiKey'> {
  apiKeyMasked: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  jsonMode: JsonMode;
  error: string | null;
  /** 失败时的处理建议。 */
  hint: string | null;
}

/**
 * 模型的运行状态（§7.3「运行状态」，GET /api/llm/status、SSE llm.status）：本次启动以来最近一次请求的结果与正在进行的请求，
 * 只保存在内存中。state：unknown 还没有结果（或连接配置刚修改过）；ok 最近一次请求成功；error 最近一次请求因连接、鉴权、
 * 额度、地址、超时等原因失败。与请求内容有关的失败（输出不合格、截断、空内容、HTTP 400 / 413 / 422）不改变 state。
 */
export interface LlmProfileStatus {
  state: 'unknown' | 'ok' | 'error';
  /** 最近一次结果的时间；unknown 时为 null。 */
  at: number | null;
  /** 结果来自测试连接还是 AI 任务（检查、创作辅助、AI 修复、剧情记忆）的请求。 */
  source: 'test' | 'task' | null;
  /** 最近一次成功的耗时。 */
  latencyMs: number | null;
  error: string | null;
  hint: string | null;
  /** AI 任务的请求：正在进行 / 排队等待并发名额 / 失败后正在重试的数量（测试连接不计入）。 */
  active: number;
  waiting: number;
  retrying: number;
}

/** 内置服务预设：只预填名称与 baseUrl，modelHint 仅作输入框占位提示（ADR-007）。 */
export interface LlmPreset {
  name: string;
  baseUrl: string;
  modelHint: string;
}

/** 新建模型配置：name、baseUrl、model 必填，其余字段省略时取默认值；apiKey 可为空（本地服务不需要）。 */
export type CreateLlmProfileRequest = Pick<LlmProfileRecord, 'name' | 'baseUrl' | 'model'> &
  Partial<Omit<LlmProfileRecord, 'id' | 'name' | 'baseUrl' | 'model'>>;

/** 修改模型配置：至少一个字段；apiKey 为空或省略表示不修改（但 baseUrl 换了域名时会清空，见 INV-17）。 */
export type UpdateLlmProfileRequest = Partial<Omit<LlmProfileRecord, 'id'>>;

export type LlmDefaults = Record<TaskKind, Id | null>;

export interface SkillInfo {
  id: Id;
  name: string;
  description: string;
  source: 'builtin' | 'skillhub' | 'local';
  version: string;
  enabled: boolean;
  appliesTo: TaskKind[];
  installedAt: number | null;
}

/** 已安装技能可修改的字段（内置技能不可修改）；至少一个字段。 */
export interface UpdateSkillRequest {
  enabled?: boolean;
  appliesTo?: JobType[];
}

/** 文件夹导入：浏览器读取文件夹后只上传 .md / .txt 文件，path 为相对路径（/ 分隔）。 */
export interface ImportSkillFilesRequest {
  files: { path: string; contentBase64: string }[];
}

export interface HubSecurityReport {
  provider: string;
  status: string;
  statusText: string;
  reportUrl: string;
}

export interface HubSkillDetail extends HubSkill {
  securityReports: HubSecurityReport[];
}

export interface HubInstallRequest {
  namespace: string;
  slug: string;
  version?: string;
}

export interface SkillDetail extends SkillInfo {
  body: string;
  references: { path: string; size: number }[];
}

export interface HubSkill {
  namespace: string;
  slug: string;
  name: string;
  summary: string;
  version: string;
}

/** 任务选项：目前只有智能扩写的目标字数（CREATIVE_LIMITS.expandMinChars～expandMaxChars）。 */
export interface JobOptions {
  targetChars?: number;
}

export interface CreateJobRequest {
  type: JobType;
  skillId?: Id;
  scope: Scope;
  profileId?: Id;
  onlyChanged?: boolean;
  options?: JobOptions;
}

/** 预估（§7.2 POST W/jobs/estimate）：chars 为待查正文字数；输入 token 按 1 字 = 1 token 估算（A5），含提示词开销。 */
export interface JobEstimate {
  chapters: number;
  chars: number;
  units: number;
  /** 勾选 onlyChanged 时因未改动而跳过的章节数。 */
  skippedChapters: number;
  estimatedInputTokens: number;
}

export interface Job {
  id: Id;
  type: JobType;
  skillId: Id;
  scope: Scope;
  profileId: Id;
  onlyChanged: boolean;
  options: JobOptions;
  status: JobStatus;
  totalUnits: number;
  doneUnits: number;
  failedUnits: number;
  promptTokens: number;
  completionTokens: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Issue {
  id: Id;
  jobId: Id;
  chapterId: Id;
  category: IssueCategory;
  severity: Severity;
  excerpt: string;
  target: string;
  start: number;
  end: number;
  replacement: string | null;
  message: string;
  evidence: string;
  status: IssueStatus;
  createdAt: number;
}

/** GET W/jobs/:jid/report：审稿报告。overall 为整体报告（Markdown，没有时为 null），chapters 为逐章评语（按目录顺序）。 */
export interface JobReport {
  overall: string | null;
  chapters: { chapterId: Id; markdown: string }[];
}

/**
 * 智能扩写的结果（GET W/jobs/:jid/expansion）。stale：生成之后本章正文有改动（插入时需要确认）；
 * status = applied 表示已插入到章末（不能重复插入）。
 */
export interface Expansion {
  jobId: Id;
  chapterId: Id;
  text: string;
  status: 'ready' | 'applied';
  stale: boolean;
  createdAt: number;
  appliedAt: number | null;
}

export interface ApplyExpansionRequest {
  /** 本章在扩写之后有改动时，需要显式确认才插入。 */
  force?: boolean;
}

export interface ApplyExpansionResponse {
  chapterId: Id;
  rev: number;
  /** 实际插入到章末的文字（可能补了一个换行）。 */
  inserted: string;
}

/** 剧情记忆的当前状态（每次更新后的全书快照，ADR-011）。 */
export interface PlotMemoryState {
  mainline: string;
  characters: { name: string; status: string }[];
  threads: string[];
  emotion: string;
}

/** 一次增量更新：本次纳入的章节范围、字数与新增的剧情事件。 */
export interface PlotMemoryEntry {
  id: Id;
  seq: number;
  label: string;
  chars: number;
  events: string[];
  createdAt: number;
}

/** GET W/memory：剧情记忆与覆盖进度。 */
export interface PlotMemory {
  state: PlotMemoryState | null;
  /** 最新的在前。 */
  entries: PlotMemoryEntry[];
  /** 已纳入剧情记忆的字数 / 尚未纳入的字数（满 thresholdChars 自动更新）。 */
  coveredChars: number;
  pendingChars: number;
  thresholdChars: number;
  /** 尚未纳入的字数超过这个值时不自动更新，需要作者手动开始。 */
  autoMaxChars: number;
  updatedAt: number | null;
  /** 最近一次剧情记忆任务（进行中、暂停或失败时界面显示状态）。 */
  job: Job | null;
  /** 是否有可用的模型（默认模型未设置时不会自动更新）。 */
  hasModel: boolean;
}

export interface ApplyIssuesResponse {
  applied: Id[];
  stale: Id[];
  chapters: { id: Id; rev: number }[];
}

export interface BibleEntry {
  id: Id;
  kind: EntryKind;
  name: string;
  aliases: string[];
  summary: string;
  firstChapterId: Id | null;
  createdAt: number;
  updatedAt: number;
}

export interface BibleFact {
  id: Id;
  entryId: Id;
  attribute: string;
  value: string;
  mutable: boolean;
  chapterId: Id | null;
  quote: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewEntryPayload {
  kind: EntryKind;
  name: string;
  aliases: string[];
  summary: string;
  facts: { attribute: string; value: string; mutable: boolean; quote: string }[];
}

export interface NewFactPayload {
  attribute: string;
  value: string;
  mutable: boolean;
}

export interface NewAliasPayload {
  alias: string;
}

export type CandidatePayload = NewEntryPayload | NewFactPayload | NewAliasPayload;

export interface BibleCandidate {
  id: Id;
  jobId: Id;
  op: 'new_entry' | 'new_fact' | 'new_alias';
  targetEntryId: Id | null;
  payload: CandidatePayload;
  chapterId: Id;
  quote: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export interface CandidateDecision {
  id: Id;
  action: 'accept' | 'reject' | 'merge';
  mergeIntoEntryId?: Id;
  payload?: CandidatePayload;
}

export type ServerEvent =
  | { type: 'job.updated'; workId: Id; job: Job }
  | { type: 'chapter.updated'; workId: Id; chapterId: Id; rev: number }
  | { type: 'candidates.changed'; workId: Id; pending: number }
  | { type: 'memory.updated'; workId: Id }
  /** 不属于某部作品：推送给所有连接。 */
  | { type: 'llm.status'; profileId: Id; status: LlmProfileStatus };

// ---------- §7.1 错误响应 ----------

export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REV_CONFLICT'
  | 'NAME_CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'SKILL_INVALID'
  | 'LLM_ERROR'
  | 'HUB_ERROR'
  | 'INTERNAL';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; [extra: string]: unknown };
}
