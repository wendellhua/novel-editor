import type { EntryKind, IssueCategory, IssueStatus, JobStatus, JsonMode, Severity, TaskKind } from '../../shared/types';

export const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  typo: '错别字',
  punctuation: '标点',
  grammar: '语病',
  review: '审稿',
  setting: '设定',
  character: '角色',
  ai_flavor: 'AI 味',
};

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待处理',
  applied: '已采纳',
  ignored: '已忽略',
  stale: '已失效',
};

export const SEVERITY_TAG_TYPES: Record<Severity, 'error' | 'warning' | 'info'> = { error: 'error', warning: 'warning', info: 'info' };

export const ENTRY_KIND_LABELS: Record<EntryKind, string> = { character: '角色', location: '地点', faction: '势力', item: '物品', rule: '规则', other: '其他' };

export const CANDIDATE_OP_LABELS: Record<'new_entry' | 'new_fact' | 'new_alias', string> = { new_entry: '新条目', new_fact: '新事实', new_alias: '新别名' };

/** 任务状态的界面名称与标签颜色。 */
export const JOB_STATUS_LABELS: Record<JobStatus, { text: string; type: 'default' | 'info' | 'success' | 'warning' | 'error' }> = {
  queued: { text: '排队中', type: 'default' },
  running: { text: '进行中', type: 'info' },
  paused: { text: '已暂停', type: 'warning' },
  done: { text: '已完成', type: 'success' },
  failed: { text: '失败', type: 'error' },
  cancelled: { text: '已取消', type: 'default' },
};

/** 界面上的任务类型名称。 */
export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  typo: '错别字与标点',
  review: '编辑审稿',
  setting: '设定一致性',
  character: '角色一致性',
  ai_flavor: 'AI 味检测',
  inspiration: '灵感胶囊',
  expand: '智能扩写',
  bible_extract: '设定抽取',
  memory: '剧情记忆',
  summary: '章节摘要',
};


/** 结构化输出档位（ADR-007），从稳到宽松。 */
export const JSON_MODE_LABELS: Record<JsonMode, string> = {
  json_schema: 'JSON Schema',
  json_object: 'JSON 模式',
  prompt: '提示词约束',
};
