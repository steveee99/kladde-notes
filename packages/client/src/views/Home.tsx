import { useMemo, useState } from 'react';
import { CalendarClock, Plus, Repeat } from 'lucide-react';
import { Task, TaskBucket, bucketOf, parseTasks, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { formatDue } from '../editor/widgets';
import { NoteCard } from './NoteList';

interface TaskRow extends Task {
  noteId: string;
  noteTitle: string;
}

const BUCKETS: { id: TaskBucket; label: string; tone: string }[] = [
  { id: 'overdue', label: 'Überfällig', tone: 'text-danger' },
  { id: 'today', label: 'Heute', tone: 'text-warn' },
  { id: 'upcoming', label: 'Demnächst', tone: 'text-accent' },
  { id: 'someday', label: 'Ohne Datum', tone: 'text-muted' },
];

function TaskItem({ task }: { task: TaskRow }) {
  const [leaving, setLeaving] = useState(false);
  const bucket = bucketOf(task);
  return (
    <li className={`group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-all duration-300 hover:bg-raised/60 ${leaving ? 'translate-x-4 opacity-0' : ''}`}>
      <input
        type="checkbox"
        className="cm-checkbox mt-1 shrink-0"
        checked={leaving}
        onChange={() => {
          setLeaving(true);
          setTimeout(() => void vault.toggleTask(task.noteId, task.line), 280);
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] leading-snug">{task.text || '(leer)'}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {task.due && (
            <span className={`cm-due ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>
              <CalendarClock size={11} className="mr-1 inline" />
              {formatDue(task.due)}
            </span>
          )}
          {task.repeat && (
            <span className="cm-due">
              <Repeat size={11} className="mr-1 inline" />
              {task.repeat}
            </span>
          )}
          <button className="truncate text-xs text-faint hover:text-accent" onClick={() => navigate(`/n/${task.noteId}`)}>
            {task.noteTitle}
          </button>
        </div>
      </div>
    </li>
  );
}

export function HomeView() {
  const version = useVault();
  const [input, setInput] = useState('');
  const [showSomeday, setShowSomeday] = useState(false);
  const notes = vault.list();

  const tasks = useMemo(() => {
    const out: TaskRow[] = [];
    for (const n of notes) {
      for (const t of parseTasks(n.content)) if (!t.done) out.push({ ...t, noteId: n.id, noteTitle: splitPath(n.path).name });
    }
    return out.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Hallo' : 'Guten Abend';
  const openCount = tasks.filter((t) => bucketOf(t) === 'overdue' || bucketOf(t) === 'today').length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-6 anim-fade-up">
        <p className="text-sm text-muted">{new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1 className="text-3xl font-bold tracking-tight">{greeting} 👋</h1>
        <p className="mt-1 text-muted">{openCount ? `${openCount} Aufgabe${openCount === 1 ? '' : 'n'} für heute.` : 'Für heute ist alles erledigt. ✨'}</p>
      </header>

      <form
        className="card mb-6 flex items-center gap-2 p-1.5 pl-3 anim-fade-up"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          void vault.capture(input.trim(), true);
          setInput('');
        }}
      >
        <Plus size={18} className="text-faint" />
        <input
          className="min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-faint"
          placeholder="Neue Aufgabe … due:morgen every:week"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn-primary" disabled={!input.trim()}>
          Hinzufügen
        </button>
      </form>

      <section className="space-y-5">
        {BUCKETS.map((b) => {
          const list = tasks.filter((t) => bucketOf(t) === b.id);
          if (!list.length) return null;
          if (b.id === 'someday' && !showSomeday) {
            return (
              <button key={b.id} className="btn-ghost text-sm" onClick={() => setShowSomeday(true)}>
                {list.length} Aufgaben ohne Datum anzeigen
              </button>
            );
          }
          return (
            <div key={b.id} className="anim-fade-up">
              <h2 className={`mb-1 px-3 text-xs font-semibold uppercase tracking-wider ${b.tone}`}>
                {b.label} <span className="text-faint">· {list.length}</span>
              </h2>
              <ul className="card stagger divide-y divide-line/60 p-1">
                {list.map((t) => (
                  <TaskItem key={`${t.noteId}:${t.line}:${t.text}`} task={t} />
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      <h2 className="mt-10 mb-3 px-1 text-xs font-semibold uppercase tracking-wider text-faint">Zuletzt bearbeitet</h2>
      <div className="stagger grid gap-3 sm:grid-cols-2">
        {recent.map((n) => (
          <NoteCard key={n.id} note={n} />
        ))}
      </div>
    </div>
  );
}
