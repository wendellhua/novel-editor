import { JOB_TYPES } from '../../shared/constants';
import type { JobType, SkillRecord, SkillRegistry } from '../../shared/types';
import { ajv } from '../system/ajv';
import type { Sanitized } from '../system/config';

/** 已安装技能目录名：`{namespace}__{slug}` 或 `local__{slug}-{rand}`（§7.5），只含安全字符。 */
export const SKILL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*$/;

const recordSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 300 },
    source: { enum: ['skillhub', 'local'] },
    dir: { type: 'string', pattern: SKILL_DIR_RE.source, maxLength: 220 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 5000 },
    version: { type: 'string', maxLength: 50 },
    enabled: { type: 'boolean' },
    appliesTo: { type: 'array', items: { enum: [...JOB_TYPES] }, minItems: 1, uniqueItems: true },
    hub: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: { namespace: { type: 'string', minLength: 1 }, slug: { type: 'string', minLength: 1 } },
          required: ['namespace', 'slug'],
          additionalProperties: false,
        },
      ],
    },
    installedAt: { type: 'integer', minimum: 0 },
  },
  required: ['id', 'source', 'dir', 'name', 'description', 'version', 'enabled', 'appliesTo', 'hub', 'installedAt'],
  additionalProperties: false,
} as const;

const checkRecord = ajv.compile<SkillRecord>(recordSchema);

/**
 * 校验 skills/registry.json：不合法的记录整条丢弃（技能目录仍在磁盘上，可重新导入）；id 或目录重复时保留第一条。
 * 与其他配置文件一样，有修复时由 loadJsonConfig 先备份原文件。
 */
export function sanitizeRegistry(raw: unknown): Sanitized<SkillRegistry> {
  const repaired: string[] = [];
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (obj.version !== 1) repaired.push('version');
  if (!Array.isArray(obj.skills)) repaired.push('skills');
  const list = Array.isArray(obj.skills) ? obj.skills : [];
  const ids = new Set<string>();
  const dirs = new Set<string>();
  const skills: SkillRecord[] = [];
  list.forEach((r, i) => {
    if (!checkRecord(r) || ids.has(r.id) || dirs.has(r.dir) || r.id.startsWith('builtin:')) {
      repaired.push(`skills[${i}]`);
      return;
    }
    ids.add(r.id);
    dirs.add(r.dir);
    skills.push(r);
  });
  return { value: { version: 1, skills }, repaired };
}

export const DEFAULT_APPLIES_TO: JobType[] = ['review'];
