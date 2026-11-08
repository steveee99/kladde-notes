import { useMemo, useState } from 'react';
import { Briefcase, CalendarCheck, CalendarClock, Inbox as InboxIcon, Plus, Repeat } from 'lucide-react';
import { PARA, Task, TaskBucket, bucketOf, parseTasks, projectsOf, roleOfPath, splitPath } from '@kladde/shared';
import { openDialog } from '../lib/dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
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
  const locked = useReadOnly();
  const bucket = bucketOf(task);
  return (
    <li className={`group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-all duration-300 hover:bg-raised/60 ${leaving ? 'translate-x-4 opacity-0' : ''}`}>
      <input
        type="checkbox"
        className="cm-checkbox mt-1 shrink-0"
        checked={leaving}
        disabled={locked}
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

  const own = notes.filter((n) => n.access === 'owner');
  const projects = projectsOf(own).sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'aktiv' ? -1 : 1));
  const inboxCount = own.filter((n) => roleOfPath(n.path) === 'inbox').length;
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

      {(inboxCount > 0 || reviewDue()) && (
        <div className="mb-6 flex flex-wrap gap-2 anim-fade-up">
          {inboxCount > 0 && (
            <button className="chip px-3 py-1.5 text-sm text-warn hover:bg-warn/10" onClick={() => navigate('/inbox')}>
              <InboxIcon size={14} /> {inboxCount} in der Inbox
            </button>
          )}
          {reviewDue() && (
            <button className="chip px-3 py-1.5 text-sm text-accent hover:bg-accent/10" onClick={() => navigate('/review')}>
              <CalendarCheck size={14} /> Wochenrückblick fällig
            </button>
          )}
        </div>
      )}

      <form
        className="edit-only card mb-6 flex items-center gap-2 p-1.5 pl-3 anim-fade-up"
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

      {projects.length > 0 && (
        <>
          <h2 className="mt-10 mb-3 flex items-center px-1 text-xs font-semibold uppercase tracking-wider text-faint">
            Aktive Projekte
            <button className="edit-only ml-auto normal-case tracking-normal hover:text-accent" onClick={() => openDialog({ kind: 'note', folder: PARA.projects })}>
              + Projekt
            </button>
          </h2>
          <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <button key={p.id} onClick={() => navigate(`/n/${p.id}`)} className="card min-w-0 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40">
                <div className="flex items-center gap-2">
                  <Briefcase size={15} className="shrink-0 text-accent" />
                  <span className="truncate font-medium">{p.title}</span>
                  {p.status === 'pausiert' && <span className="chip text-warn">pausiert</span>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {p.openTasks ? (
                    <span className="chip">{p.openTasks} offen</span>
                  ) : (
                    <span className="chip text-warn">kein nächster Schritt</span>
                  )}
                  {p.nextDue && <span className="cm-due">📅 {formatDue(p.nextDue)}</span>}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <h2 className="mt-10 mb-3 px-1 text-xs font-semibold uppercase tracking-wider text-faint">Zuletzt bearbeitet</h2>
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2">
        {recent.map((n) => (
          <NoteCard key={n.id} note={n} />
        ))}
      </div>
    </div>
  );
}
