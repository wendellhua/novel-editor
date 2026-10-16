import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { JOB_TYPES } from '../../shared/constants';
import type {
  HubInstallRequest,
  HubSkill,
  HubSkillDetail,
  Id,
  ImportSkillFilesRequest,
  SkillDetail,
  SkillInfo,
  SkillRecord,
  SkillRegistry,
  TaskKind,
  UpdateSkillRequest,
} from '../../shared/types';
import type { AssetReader } from '../assets';
import { invalid, missing } from '../errors';
import { writeJsonAtomic } from '../system/atomic';
import { loadJsonConfig } from '../system/config';
import type { Logger } from '../system/logger';
import { loadBuiltinSkills, type BuiltinSkill } from './builtin';
import { HUB_NAME_RE, HubClient } from './hub-client';
import { isTextFile, packageFromFiles, packageFromZip, type SkillPackage } from './importer';
import { parseSkillMd } from './parser';
import { buildSkillRules } from './prompt';
import { DEFAULT_APPLIES_TO, SKILL_DIR_RE, sanitizeRegistry } from './registry';

export interface SkillsOptions {
  /** 数据目录下的 skills/（registry.json 与各技能目录）。 */
  dir: string;
  /** 内置技能所在的资源读取器（SEA 内嵌资源或 dist/ 目录）。 */
  assets: AssetReader;
  hub: HubClient;
  log: Logger;
  now?: () => number;
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Windows 上目录可能被杀毒软件短暂占用，rename 失败时重试。 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!RETRYABLE.has((err as NodeJS.ErrnoException).code ?? '') || attempt >= 9) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
}

/** 本地导入技能的 slug：取 name 中的 ASCII 字母数字，其余合并为 -；全是中文时为 skill。 */
export function localSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s === '' ? 'skill' : s;
}

function walkText(root: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ path: relative(root, full).split(sep).join('/'), size: st.size });
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * skills 模块门面（ADR-008、§7.5）：内置技能 + 已安装技能（SkillHub / 本地导入）。
 * 技能只是提示词包：只保存和读取 .md / .txt，任何文件都不会被执行（INV-13）。
 */
export class Skills {
  private readonly root: string;
  private readonly registryFile: string;
  private readonly log: Logger;
  private readonly hub: HubClient;
  private readonly now: () => number;
  private readonly builtins: BuiltinSkill[];
  private registry: SkillRegistry;

  constructor(options: SkillsOptions) {
    this.root = resolve(options.dir);
    this.registryFile = join(this.root, 'registry.json');
    this.log = options.log;
    this.hub = options.hub;
    this.now = options.now ?? Date.now;
    this.builtins = loadBuiltinSkills(options.assets);
    mkdirSync(this.root, { recursive: true });
    this.cleanupLeftovers();
    this.registry = loadJsonConfig(this.registryFile, sanitizeRegistry, this.log, '技能注册表');
    const present = this.registry.skills.filter((s) => existsSync(join(this.root, s.dir, 'SKILL.md')));
    if (present.length !== this.registry.skills.length) {
      const lost = this.registry.skills.filter((s) => !present.includes(s)).map((s) => s.name);
      this.log.warn(`以下技能的目录已不存在，已从注册表移除：${lost.join('、')}`);
      this.saveRegistry({ ...this.registry, skills: present });
    }
  }

  // ---------------- 查询 ----------------

  list(): SkillInfo[] {
    return [...this.builtins.map((b) => this.builtinInfo(b)), ...this.registry.skills.map((r) => this.recordInfo(r))];
  }

  find(id: Id): SkillInfo | null {
    return this.list().find((s) => s.id === id) ?? null;
  }

  /** 某类任务的内置技能 id（§6.5 保证每种 TaskKind 恰好一个）。 */
  builtinFor(kind: TaskKind): Id {
    const b = this.builtins.find((x) => x.jobType === kind);
    if (b === undefined) throw new Error(`缺少「${kind}」的内置技能`);
    return b.id;
  }

  detail(id: Id): SkillDetail {
    const builtin = this.builtins.find((b) => b.id === id);
    if (builtin !== undefined) {
      return {
        ...this.builtinInfo(builtin),
        body: builtin.parsed.body,
        references: builtin.references.map((r) => ({ path: r.path, size: Buffer.byteLength(r.text) })),
      };
    }
    const record = this.record(id);
    return { ...this.recordInfo(record), body: this.readInstalled(record).body, references: this.installedReferences(record) };
  }

  /** §7.4.1 ② 技能规则段（T13 起由提示词组装调用）。 */
  rulesFor(id: Id): string {
    const builtin = this.builtins.find((b) => b.id === id);
    if (builtin !== undefined) return buildSkillRules(builtin.parsed.name, builtin.parsed.body, builtin.references);
    const record = this.record(id);
    const parsed = this.readInstalled(record);
    const refs = this.installedReferences(record).map((r) => ({
      path: r.path,
      text: readFileSync(join(this.root, record.dir, ...r.path.split('/')), 'utf8'),
    }));
    return buildSkillRules(parsed.name, parsed.body, refs);
  }

  // ---------------- 修改 ----------------

  update(id: Id, req: UpdateSkillRequest): SkillInfo {
    if (this.isBuiltin(id)) throw invalid('内置技能不能修改');
    const record = this.record(id);
    const next: SkillRecord = { ...record };
    if (req.enabled !== undefined) next.enabled = req.enabled;
    if (req.appliesTo !== undefined) {
      const kinds = JOB_TYPES.filter((k) => req.appliesTo?.includes(k));
      if (kinds.length === 0) throw invalid('至少选择一种适用的检查类型');
      next.appliesTo = kinds;
    }
    this.saveRegistry({ ...this.registry, skills: this.registry.skills.map((s) => (s.id === id ? next : s)) });
    return this.recordInfo(next);
  }

  remove(id: Id): void {
    if (this.isBuiltin(id)) throw invalid('内置技能不能删除');
    const record = this.record(id);
    this.saveRegistry({ ...this.registry, skills: this.registry.skills.filter((s) => s.id !== id) });
    rmSync(join(this.root, record.dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    this.log.info(`已删除技能「${record.name}」`);
  }

  // ---------------- 安装 ----------------

  importZip(zip: Buffer): SkillInfo {
    return this.installLocal(packageFromZip(zip));
  }

  importFiles(req: ImportSkillFilesRequest): SkillInfo {
    return this.installLocal(packageFromFiles(req));
  }

  hubSearch(q: string, limit?: number): Promise<HubSkill[]> {
    return this.hub.search(q, limit);
  }

  hubDetail(namespace: string, slug: string): Promise<HubSkillDetail> {
    return this.hub.detail(namespace, slug);
  }

  /**
   * 从 SkillHub 安装；已安装同一技能时原地更新，保留启用状态与适用类型。
   * 名称优先用 SkillHub 的 displayName（作者在搜索结果里看到并选择的名字，SKILL.md 的 name 常是英文标识符），
   * 取详情失败时回退到 SKILL.md 的 name。
   */
  async hubInstall(req: HubInstallRequest): Promise<SkillInfo> {
    if (!HUB_NAME_RE.test(req.namespace) || !HUB_NAME_RE.test(req.slug)) throw invalid('namespace 或 slug 不合法');
    const zip = await this.hub.download(req.namespace, req.slug, req.version ?? '');
    const pkg = packageFromZip(zip);
    const displayName = await this.hub
      .detail(req.namespace, req.slug)
      .then((d) => (d.name !== req.slug ? d.name.slice(0, 100) : ''))
      .catch(() => '');
    const id = `hub:${req.namespace}/${req.slug}`;
    const dir = `${req.namespace}__${req.slug}`;
    const existing = this.registry.skills.find((s) => s.id === id);
    this.writePackage(pkg, dir);
    const record: SkillRecord = {
      id,
      source: 'skillhub',
      dir,
      name: displayName || pkg.parsed.name,
      description: pkg.parsed.description,
      version: req.version !== undefined && req.version !== '' ? req.version : pkg.parsed.version,
      enabled: existing?.enabled ?? true,
      appliesTo: existing?.appliesTo ?? [...DEFAULT_APPLIES_TO],
      hub: { namespace: req.namespace, slug: req.slug },
      installedAt: this.now(),
    };
    const skills = existing === undefined ? [...this.registry.skills, record] : this.registry.skills.map((s) => (s.id === id ? record : s));
    this.saveRegistry({ ...this.registry, skills });
    this.log.info(`已从 SkillHub ${existing === undefined ? '安装' : '更新'}技能「${record.name}」（${id}，${record.version}）`);
    return this.recordInfo(record);
  }

  // ---------------- 内部 ----------------

  private installLocal(pkg: SkillPackage): SkillInfo {
    const suffix = `${localSlug(pkg.parsed.name)}-${randomBytes(3).toString('hex')}`;
    const record: SkillRecord = {
      id: `local:${suffix}`,
      source: 'local',
      dir: `local__${suffix}`,
      name: pkg.parsed.name,
      description: pkg.parsed.description,
      version: pkg.parsed.version,
      enabled: true,
      appliesTo: [...DEFAULT_APPLIES_TO],
      hub: null,
      installedAt: this.now(),
    };
    this.writePackage(pkg, record.dir);
    try {
      this.saveRegistry({ ...this.registry, skills: [...this.registry.skills, record] });
    } catch (err) {
      rmSync(join(this.root, record.dir), { recursive: true, force: true });
      throw err;
    }
    this.log.info(`已导入技能「${record.name}」（${record.id}，${pkg.files.length} 个文本文件，丢弃 ${pkg.skipped} 个非文本文件）`);
    return this.recordInfo(record);
  }

  /** 先完整写入临时目录，再整体 rename 到目标位置（§7.5）；覆盖安装时旧目录先挪开，失败则还原。 */
  private writePackage(pkg: SkillPackage, dir: string): void {
    if (!SKILL_DIR_RE.test(dir)) throw invalid(`技能目录名不合法：${dir}`);
    const tmp = join(this.root, `.tmp-${randomBytes(6).toString('hex')}`);
    try {
      for (const f of pkg.files) {
        const full = resolve(tmp, ...f.path.split('/'));
        if (!full.startsWith(tmp + sep)) throw invalid(`文件路径不合法：${f.path}`);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, f.data);
      }
      const target = join(this.root, dir);
      if (existsSync(target)) {
        const old = join(this.root, `.old-${randomBytes(6).toString('hex')}`);
        renameWithRetry(target, old);
        try {
          renameWithRetry(tmp, target);
        } catch (err) {
          renameWithRetry(old, target);
          throw err;
        }
        rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } else {
        renameWithRetry(tmp, target);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  private cleanupLeftovers(): void {
    for (const name of readdirSync(this.root)) {
      if (name.startsWith('.tmp-') || name.startsWith('.old-')) {
        rmSync(join(this.root, name), { recursive: true, force: true });
        this.log.warn(`已清理上次未完成安装留下的临时目录：${name}`);
      }
    }
  }

  private saveRegistry(next: SkillRegistry): void {
    writeJsonAtomic(this.registryFile, next);
    this.registry = next;
  }

  private isBuiltin(id: Id): boolean {
    return this.builtins.some((b) => b.id === id);
  }

  private record(id: Id): SkillRecord {
    const r = this.registry.skills.find((s) => s.id === id);
    if (r === undefined) throw missing('技能不存在');
    return r;
  }

  private readInstalled(record: SkillRecord): ReturnType<typeof parseSkillMd> {
    return parseSkillMd(readFileSync(join(this.root, record.dir, 'SKILL.md'), 'utf8'));
  }

  private installedReferences(record: SkillRecord): { path: string; size: number }[] {
    return walkText(join(this.root, record.dir, 'references'))
      .filter((r) => isTextFile(r.path))
      .map((r) => ({ path: `references/${r.path}`, size: r.size }));
  }

  private builtinInfo(b: BuiltinSkill): SkillInfo {
    return {
      id: b.id,
      name: b.parsed.name,
      description: b.parsed.description,
      source: 'builtin',
      version: b.parsed.version,
      enabled: true,
      appliesTo: [b.jobType],
      installedAt: null,
    };
  }

  private recordInfo(r: SkillRecord): SkillInfo {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      version: r.version,
      enabled: r.enabled,
      appliesTo: [...r.appliesTo],
      installedAt: r.installedAt,
    };
  }
}
