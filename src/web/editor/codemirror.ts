import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { issueMarks, setActiveIssue } from './issue-marks';

export interface WriterEditorOptions {
  doc: string;
  onChange(doc: string): void;
  onBlur?(): void;
  /** 点击了高亮的问题文字。 */
  onIssueClick?(issueId: string): void;
  indent?: boolean;
  fontSize?: number;
}

export interface WriterEditor {
  view: EditorView;
  setIndent(on: boolean): void;
  destroy(): void;
}

/** 写作主题（ADR-005）：每个逻辑行是一个段落，可选首行缩进 2 字，正文居中限宽。 */
function writerTheme(fontSize: number) {
  return EditorView.theme({
    '&': { height: '100%', fontSize: `${fontSize}px` },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', serif",
      lineHeight: '1.9',
      padding: '24px 0 40vh',
    },
    '.cm-content': { maxWidth: '46em', margin: '0 auto', padding: '0 32px', caretColor: 'currentColor' },
    '.cm-line': { padding: '0 0 0.55em' },
    '&.ne-indent .cm-line': { textIndent: '2em' },
    '.cm-placeholder': { opacity: 0.45 },
  });
}

const indentClass = (on: boolean) => EditorView.editorAttributes.of(on ? { class: 'ne-indent' } : {});

export function createWriterEditor(parent: HTMLElement, opts: WriterEditorOptions): WriterEditor {
  const indent = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        history(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', lang: 'zh-CN', 'data-testid': 'editor-content' }),
        placeholder('从这里开始写……'),
        writerTheme(opts.fontSize ?? 18),
        indent.of(indentClass(opts.indent ?? true)),
        issueMarks((id) => opts.onIssueClick?.(id)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          blur: () => {
            opts.onBlur?.();
            return false;
          },
        }),
      ],
    }),
  });
  return {
    view,
    setIndent: (on) => view.dispatch({ effects: indent.reconfigure(indentClass(on)) }),
    destroy: () => view.destroy(),
  };
}

/** old → text 的最小单段差异（公共前后缀不动）。 */
function minimalChange(old: string, text: string): { from: number; to: number; insert: string } {
  let start = 0;
  const minLen = Math.min(old.length, text.length);
  while (start < minLen && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  let endOld = old.length;
  let endNew = text.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: text.slice(start, endNew) };
}

/** 用最小差异把文档替换为 text（公共前后缀不动），光标随之映射，尽量留在原处。不进入撤销历史以外的副作用。 */
export function replaceDocMinimal(view: EditorView, text: string): void {
  const old = view.state.doc.toString();
  if (old === text) return;
  view.dispatch({ changes: minimalChange(old, text) });
}

/** 选中 [from, to) 并滚动到视口中部，同时把该问题设为当前问题。 */
export function revealRange(view: EditorView, from: number, to: number, issueId: string | null = null): void {
  view.dispatch({
    selection: EditorSelection.range(from, to),
    effects: [EditorView.scrollIntoView(from, { y: 'center' }), setActiveIssue.of(issueId)],
  });
  view.focus();
}

/**
 * 把一键修正写入编辑器：作为单独的一步历史记录（Ctrl/Cmd+Z 恰好撤销这次修正，不与之前的输入合并）。
 * changes 基于当前文档且互不重叠；结果与 expected 不一致时（例如位置没对上）改用最小差异替换，同样可撤销。
 */
export function applyFixToEditor(view: EditorView, changes: { from: number; to: number; insert: string }[], expected: string): void {
  const spec = { annotations: isolateHistory.of('full'), userEvent: 'input.fix' } as const;
  const tr = view.state.update({ changes, ...spec });
  if (tr.newDoc.toString() === expected) {
    view.dispatch(tr);
    return;
  }
  const old = view.state.doc.toString();
  if (old !== expected) view.dispatch({ changes: minimalChange(old, expected), ...spec });
}
