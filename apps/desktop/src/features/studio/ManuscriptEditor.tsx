import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import type { ReviewIssue } from '@the-water/shared';

const external = Annotation.define<boolean>();
const marks = StateEffect.define<Array<{ from: number; to: number }>>();
const reviewMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, tr) => {
    value = value.map(tr.changes);
    for (const effect of tr.effects)
      if (effect.is(marks))
        value = Decoration.set(
          effect.value
            .filter((r) => r.to > r.from && r.to <= tr.newDoc.length)
            .map((r) =>
              Decoration.mark({ class: 'underline decoration-amber-500 decoration-wavy' }).range(
                r.from,
                r.to,
              ),
            ),
          true,
        );
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function ManuscriptEditor(props: {
  value: string;
  onChange: (text: string) => void;
  onSelection?: (range: { from: number; to: number; head: number }) => void;
  issues?: ReviewIssue[];
  label: string;
  readOnly?: boolean;
  focusRange?: { from: number; to: number };
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    latest = useRef(props);
  const editable = useRef(new Compartment());
  latest.current = props;
  const synchronize = useRef<() => void>(() => undefined);
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          editable.current.of(EditorView.editable.of(!latest.current.readOnly)),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          reviewMarks,
          EditorView.domEventHandlers({
            compositionend: () => {
              queueMicrotask(() => synchronize.current());
              return false;
            },
          }),
          EditorView.contentAttributes.of({ 'aria-label': latest.current.label, spellcheck: 'false' }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '17px', backgroundColor: 'transparent' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.95' },
            '.cm-content': { padding: '24px clamp(20px, 4vw, 56px)' },
            '&.cm-focused': { outline: 'none' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((t) => t.annotation(external)))
              latest.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const r = update.state.selection.main;
              latest.current.onSelection?.({ from: r.from, to: r.to, head: r.head });
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);
  synchronize.current = () => {
    const editor = view.current;
    const value = latest.current.value;
    if (!editor || editor.composing || value === editor.state.doc.toString()) return;
    const old = editor.state.doc.toString();
    let from = 0,
      tail = 0;
    while (from < Math.min(old.length, value.length) && old[from] === value[from]) from++;
    while (
      tail < old.length - from &&
      tail < value.length - from &&
      old.at(-1 - tail) === value.at(-1 - tail)
    )
      tail++;
    editor.dispatch({
      changes: { from, to: old.length - tail, insert: value.slice(from, value.length - tail) },
      annotations: external.of(true),
    });
  };
  useEffect(() => synchronize.current(), [props.value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!props.readOnly)),
    });
  }, [props.readOnly]);
  useEffect(() => {
    view.current?.dispatch({ effects: marks.of((props.issues ?? []).map((i) => i.evidence)) });
  }, [props.issues]);
  useEffect(() => {
    const editor = view.current, range = props.focusRange;
    if (!editor || !range || range.from < 0 || range.to <= range.from || range.to > editor.state.doc.length) return;
    editor.dispatch({ selection: { anchor: range.from, head: range.to }, scrollIntoView: true });
    editor.focus();
  }, [props.focusRange?.from, props.focusRange?.to, props.value]);
  return <div ref={host} className="min-h-0 flex-1 overflow-hidden font-serif" />;
}
