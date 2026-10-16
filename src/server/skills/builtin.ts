import { LIMITS, TASK_KINDS } from '../../shared/constants';
import type { TaskKind } from '../../shared/types';
import type { AssetReader } from '../assets';
import { isTextFile } from './importer';
import { parseSkillMd, type ParsedSkill } from './parser';
import { buildSkillRules } from './prompt';

export const BUILTIN_ROOT = 'builtin-skills';

export interface BuiltinManifestItem {
  id: string;
  dir: string;
  jobType: TaskKind;
}

export interface BuiltinSkill extends BuiltinManifestItem {
  parsed: ParsedSkill;
  references: { path: string; text: string }[];
}

const DIR_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * §6.5 内置技能清单约束，返回全部问题：每项 `{ id, dir, jobType }`；id = `builtin:{dir}` 且唯一；
 * dir 下的 SKILL.md 能解析（name、description 非空）；jobType 属于 TaskKind；每种 TaskKind 恰好 1 个内置技能。
 */
export function findManifestProblems(manifest: unknown, readSkillMd: (dir: string) => string | null): string[] {
  if (!Array.isArray(manifest)) return ['manifest.json 必须是数组'];
  const problems: string[] = [];
  const ids = new Set<string>();
  const count = new Map<TaskKind, number>();
  manifest.forEach((raw: unknown, i) => {
    const where = `manifest[${i}]`;
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const keys = Object.keys(item).sort().join(',');
    if (keys !== 'dir,id,jobType') problems.push(`${where} 字段必须恰好是 id、dir、jobType（实际：${keys}）`);
    const { id, dir, jobType } = item;
    if (typeof dir !== 'string' || !DIR_RE.test(dir)) {
      problems.push(`${where} dir 不合法：${String(dir)}`);
      return;
    }
    if (id !== `builtin:${dir}`) problems.push(`${where} id 必须是 builtin:${dir}（实际：${String(id)}）`);
    if (typeof id === 'string') {
      if (ids.has(id)) problems.push(`${where} id 重复：${id}`);
      ids.add(id);
    }
    if (!(TASK_KINDS as readonly unknown[]).includes(jobType)) {
      problems.push(`${where} jobType 不属于 TaskKind：${String(jobType)}`);
    } else {
      count.set(jobType as TaskKind, (count.get(jobType as TaskKind) ?? 0) + 1);
    }
    const text = readSkillMd(dir);
    if (text === null) {
      problems.push(`${where} 缺少 ${BUILTIN_ROOT}/${dir}/SKILL.md`);
    } else {
      try {
        parseSkillMd(text);
      } catch (err) {
        problems.push(`${where} SKILL.md 不合法：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  for (const kind of TASK_KINDS) {
    const n = count.get(kind) ?? 0;
    if (n !== 1) problems.push(`TaskKind「${kind}」应恰好有 1 个内置技能（实际 ${n} 个）`);
  }
  return problems;
}

const readSkillMdFrom =
  (assets: AssetReader) =>
  (dir: string): string | null =>
    assets.read(`${BUILTIN_ROOT}/${dir}/SKILL.md`)?.toString('utf8') ?? null;

function readManifest(assets: AssetReader): { manifest: unknown } | { problem: string } {
  const raw = assets.read(`${BUILTIN_ROOT}/manifest.json`);
  if (raw === null) return { problem: `缺少 ${BUILTIN_ROOT}/manifest.json` };
  try {
    return { manifest: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { problem: `${BUILTIN_ROOT}/manifest.json 不是合法 JSON` };
  }
}

/** 清单已通过校验后读取全部内置技能，顺序与 TASK_KINDS 一致。 */
function readBuiltins(assets: AssetReader, items: BuiltinManifestItem[]): BuiltinSkill[] {
  const readSkillMd = readSkillMdFrom(assets);
  return [...items]
    .sort((a, b) => TASK_KINDS.indexOf(a.jobType) - TASK_KINDS.indexOf(b.jobType))
    .map((item) => {
      const refPrefix = `${BUILTIN_ROOT}/${item.dir}/references/`;
      const references = assets
        .list(refPrefix)
        .filter(isTextFile)
        .map((key) => ({ path: key.slice(`${BUILTIN_ROOT}/${item.dir}/`.length), text: assets.read(key)?.toString('utf8') ?? '' }));
      return { ...item, parsed: parseSkillMd(readSkillMd(item.dir) ?? ''), references };
    });
}

/**
 * 内置技能的全部静态约束（§6.5）：清单能读取并通过 findManifestProblems；
 * 每个内置技能的规则段（正文 + references）不超过 skillPromptMaxChars，即永远不会被截断。
 */
export function findBuiltinProblems(assets: AssetReader, maxRuleChars: number = LIMITS.skillPromptMaxChars): string[] {
  const read = readManifest(assets);
  if ('problem' in read) return [read.problem];
  const problems = findManifestProblems(read.manifest, readSkillMdFrom(assets));
  if (problems.length > 0) return problems;
  for (const b of readBuiltins(assets, read.manifest as BuiltinManifestItem[])) {
    const full = buildSkillRules(b.parsed.name, b.parsed.body, b.references, Number.MAX_SAFE_INTEGER).length;
    if (full > maxRuleChars) problems.push(`${b.id} 的规则段 ${full} 字，超过 skillPromptMaxChars（${maxRuleChars}），会被截断`);
  }
  return problems;
}

/** 读取并校验内置技能（不合法时抛错并列出全部问题；组合根在此之前已由 validateStaticData 统一校验）。 */
export function loadBuiltinSkills(assets: AssetReader): BuiltinSkill[] {
  const problems = findBuiltinProblems(assets);
  if (problems.length > 0) throw new Error(`内置技能不合法：\n${problems.join('\n')}`);
  const read = readManifest(assets);
  return 'manifest' in read ? readBuiltins(assets, read.manifest as BuiltinManifestItem[]) : [];
}
