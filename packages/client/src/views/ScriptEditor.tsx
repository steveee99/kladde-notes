/**
 * A code editor for one stage script of a process model (`onEnter`/`onExit`, shared/processScript.ts): highlighting,
 * completion of functions, variables, step ids, templates and people, and the problems of every line while typing.
 * It is only mounted while the user edits a script (views/ProcessesView.tsx, "Add script").
 */
import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { processScriptExtensions, type ScriptHints } from '../editor/processScript';

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'rgb(var(--bg))', color: 'rgb(var(--text))', borderRadius: '6px' },
  '&.cm-focused': { outline: '2px solid rgb(var(--acc-line))', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono, "JetBrains Mono Variable", monospace)', lineHeight: '1.65', minHeight: '9rem', maxHeight: '22rem' },
  '.cm-content': { padding: '8px 0', caretColor: 'rgb(var(--acc))' },
  '.cm-gutters': { backgroundColor: 'rgb(var(--panel))', color: 'rgb(var(--faint))', borderRight: '1px solid rgb(var(--line))', borderRadius: '6px 0 0 6px' },
  '.cm-activeLine': { backgroundColor: 'rgb(var(--line) / 0.35)' },
  '.cm-placeholder': { color: 'rgb(var(--faint))' },
  '.cm-tooltip': { backgroundColor: 'rgb(var(--raised))', border: '1px solid rgb(var(--line2))', borderRadius: '6px', color: 'rgb(var(--text))' },
  '.cm-tooltip-lint': { padding: '0' },
  '.cm-diagnostic': { padding: '4px 8px', fontFamily: 'var(--font-sans)', fontSize: '12.5px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid rgb(var(--red))' },
  '.cm-completionInfo': { padding: '6px 8px', maxWidth: '22rem', fontFamily: 'var(--font-sans)', fontSize: '12.5px' },
});

export function ScriptEditor({ value, onChange, hints, label, placeholderText }: { value: string; onChange: (v: string) => void; hints: ScriptHints; label: string; placeholderText: string }) {
  const host = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onChange);
  const hintsRef = useRef(hints);
  changeRef.current = onChange;
  hintsRef.current = hints;
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          history(),
          keymap.of([...completionKeymap, ...lintKeymap, { key: 'Mod-/', run: toggleComment }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          placeholder(placeholderText),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          theme,
          processScriptExtensions(() => hintsRef.current),
          EditorView.updateListener.of((u) => u.docChanged && changeRef.current(u.state.doc.toString())),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
    // The editor keeps its own text; it is mounted anew for every script
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} className="min-w-0 rounded-md border border-line2" data-script-editor />;
}
