import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** 要高亮的问题（位置已对齐编辑器当前正文）。 */
export interface IssueMark {
  id: string;
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
}

/** 整体替换高亮（问题列表刷新、打开章节时）。 */
export const setIssueMarks = StateEffect.define<IssueMark[]>();
/** 设置当前选中的问题（加深显示）。 */
export const setActiveIssue = StateEffect.define<string | null>();

interface MarkSpec {
  issueId: string;
  severity: IssueMark['severity'];
}

interface FieldValue {
  decos: DecorationSet;
  active: string | null;
}

function markOf(spec: MarkSpec, active: boolean): Decoration {
  return Decoration.mark({
    class: `ne-issue ne-issue-${spec.severity}${active ? ' ne-issue-active' : ''}`,
    attributes: { 'data-issue-id': spec.issueId },
    inclusiveStart: false,
    inclusiveEnd: false,
    issueId: spec.issueId,
    severity: spec.severity,
  });
}

function build(marks: readonly { id: string; from: number; to: number; severity: IssueMark['severity'] }[], active: string | null, docLength: number): DecorationSet {
  const ranges = marks
    .filter((m) => m.from >= 0 && m.to <= docLength && m.from < m.to)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((m) => markOf({ issueId: m.id, severity: m.severity }, m.id === active).range(m.from, m.to));
  return Decoration.set(ranges, true);
}

function marksOf(decos: DecorationSet): IssueMark[] {
  const out: IssueMark[] = [];
  decos.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    const spec = value.spec as MarkSpec;
    out.push({ id: spec.issueId, from, to, severity: spec.severity });
  });
  return out;
}

/**
 * 问题高亮（ADR-005「问题装饰 StateField」）：随编辑映射位置；被整段删除的问题自动消失。
 * 只负责显示与查询，问题数据由外部通过 setIssueMarks 提供。
 */
export const issueField = StateField.define<FieldValue>({
  create: () => ({ decos: Decoration.none, active: null }),
  update(value, tr) {
    let { decos, active } = value;
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setIssueMarks)) decos = build(e.value, active, tr.state.doc.length);
      if (e.is(setActiveIssue)) {
        active = e.value;
        decos = build(marksOf(decos), active, tr.state.doc.length);
      }
    }
    return { decos, active };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** 问题在当前文档中的位置（高亮已随编辑映射）。 */
export function issueRange(state: EditorState, issueId: string): { from: number; to: number } | null {
  let hit: { from: number; to: number } | null = null;
  state.field(issueField).decos.between(0, state.doc.length, (from, to, value) => {
    if ((value.spec as MarkSpec).issueId === issueId) {
      hit = { from, to };
      return false;
    }
    return undefined;
  });
  return hit;
}

/** pos 处的问题（多个重叠时取最短的那个）。 */
export function issueAt(state: EditorState, pos: number): string | null {
  let best: { id: string; len: number } | null = null;
  state.field(issueField).decos.between(pos, pos, (from, to, value) => {
    if (from <= pos && pos <= to && (best === null || to - from < best.len)) best = { id: (value.spec as MarkSpec).issueId, len: to - from };
  });
  return (best as { id: string } | null)?.id ?? null;
}

const issueTheme = EditorView.baseTheme({
  '.ne-issue': { textDecorationLine: 'underline', textDecorationStyle: 'wavy', textDecorationThickness: '1.5px', textUnderlineOffset: '4px', cursor: 'pointer' },
  '.ne-issue-error': { textDecorationColor: '#d03050' },
  '.ne-issue-warning': { textDecorationColor: '#f0a020' },
  '.ne-issue-info': { textDecorationColor: '#2080f0' },
  '.ne-issue-active': { backgroundColor: 'rgba(240, 160, 32, 0.28)', borderRadius: '2px' },
});

/** 编辑器扩展：高亮 + 点击高亮文字时回调问题 id。 */
export function issueMarks(onClick: (issueId: string) => void): Extension {
  return [
    issueField,
    issueTheme,
    EditorView.domEventHandlers({
      click: (event, view) => {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const id = issueAt(view.state, pos);
        if (id !== null) onClick(id);
        return false;
      },
    }),
  ];
}
