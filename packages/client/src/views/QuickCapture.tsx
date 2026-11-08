import { useState } from 'react';
import { CheckSquare, FileText, Send } from 'lucide-react';
import { vault } from '../data/vault';
import { newNote } from './Shell';

/** Bottom sheet for one-handed input on the phone: a thought or a task into the inbox, in two taps */
export function QuickCapture({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [asTask, setAsTask] = useState(true);
  const save = async () => {
    if (text.trim()) await vault.capture(text.trim(), asTask);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40 anim-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-t-3xl bg-surface px-4 pt-4 shadow-soft anim-sheet [--pad-bottom:1rem] safe-bottom sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line sm:hidden" />
        <textarea
          autoFocus
          rows={3}
          className="input resize-none text-base"
          placeholder={asTask ? 'Aufgabe … (z. B. „Arzt anrufen due:morgen“)' : 'Gedanke, Idee, Link …'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <div className="mt-3 flex items-center gap-2">
          <button className={`btn ${asTask ? 'bg-accent/15 text-accent' : 'text-muted'}`} onClick={() => setAsTask(!asTask)}>
            <CheckSquare size={16} /> Aufgabe
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              onClose();
              void newNote();
            }}
          >
            <FileText size={16} /> Ganze Notiz
          </button>
          <button className="btn-primary ml-auto" onClick={save}>
            <Send size={16} /> Ablegen
          </button>
        </div>
        <p className="mt-2 text-xs text-faint">{asTask ? 'Aufgaben landen in „0 Inbox/Eingang“.' : 'Wird eine eigene Notiz in der Inbox – zum späteren Einsortieren.'}</p>
      </div>
    </div>
  );
}
