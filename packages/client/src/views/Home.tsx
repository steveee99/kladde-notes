import { useEffect, useMemo, useRef, useState } from 'react';
import { AlignJustify, Briefcase, CalendarCheck, CalendarClock, Inbox as InboxIcon, List, Plus, Repeat, X } from 'lucide-react';
import { PARA, Task, TaskBucket, bucketOf, parseTasks, shortcutDate, projectsOf, roleOfPath, splitPath } from '@kladde/shared';
import { openDialog } from '../lib/dialogs';
import { reviewDue } from './Review';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { formatDue } from '../editor/widgets';
import { NoteCollection, ViewSwitch } from './NoteList';

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

const REPEATS = [
  { value: '', label: 'Keine Wiederholung' },
  { value: 'täglich', label: 'Täglich' },
  { value: 'wöchentlich', label: 'Wöchentlich' },
  { value: 'monatlich', label: 'Monatlich' },
  { value: 'jährlich', label: 'Jährlich' },
];

/** Small button next to a task: due date shortcuts, a date picker and the repeat rule */
function TaskMeta({ task }: { task: TaskRow }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const set = (meta: { due?: string | null; repeat?: string | null }) => void vault.setTaskMeta(task.noteId, task.line, meta);
  const shortcuts = [
    ['Heute', 'today'],
    ['Morgen', 'tomorrow'],
    ['Nächste Woche', 'nextWeek'],
  ] as const;
  return (
    <div ref={ref} className="edit-only relative shrink-0">
      <button className="rounded-md p-1 text-faint hover:bg-raised hover:text-accent" title="Datum und Wiederholung" aria-label="Datum und Wiederholung" onClick={() => setOpen(!open)}>
        <CalendarClock size={14} />
      </button>
      {open && (
        <div className="card absolute right-0 z-20 mt-1 w-56 space-y-2 p-2 shadow-lg">
          <div className="flex flex-wrap gap-1">
            {shortcuts.map(([label, kind]) => (
              <button
                key={kind}
                className="chip px-2 py-1 text-xs hover:bg-accent/10"
                onClick={() => {
                  set({ due: shortcutDate(kind) });
                  setOpen(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <input type="date" className="min-w-0 flex-1 rounded-md border border-line bg-transparent px-2 py-1 text-sm" value={task.due ?? ''} onChange={(e) => set({ due: e.target.value || null })} />
            {task.due && (
              <button className="rounded-md p-1 text-faint hover:text-danger" title="Datum entfernen" onClick={() => set({ due: null })}>
                <X size={14} />
              </button>
            )}
          </div>
          <select
            className="w-full rounded-md border border-line bg-transparent px-2 py-1 text-sm"
            value={task.repeat ?? ''}
            onChange={(e) => set({ repeat: e.target.value || null })}
          >
            {REPEATS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
            {task.repeat && !REPEATS.some((r) => r.value === task.repeat) && <option value={task.repeat}>{task.repeat}</option>}
          </select>
        </div>
      )}
    </div>
  );
}

function TaskItem({ task, compact }: { task: TaskRow; compact: boolean }) {
  const [leaving, setLeaving] = useState(false);
  const locked = useReadOnly();
  const bucket = bucketOf(task);
  return (
    <li
      title={task.noteTitle ? 'Doppelklick öffnet die Notiz' : undefined}
      onDoubleClick={(e) => {
        if (!task.noteTitle || (e.target as HTMLElement).closest('input,button,select')) return;
        navigate(`/n/${task.noteId}?line=${task.line + 1}`);
      }}
      className={`group flex items-center gap-3 rounded-xl px-3 transition-all duration-300 hover:bg-raised/60 ${compact ? 'py-1' : 'items-start py-2.5'} ${leaving ? 'translate-x-4 opacity-0' : ''}`}
    >
      <input
        type="checkbox"
        className={`cm-checkbox shrink-0 ${compact ? '' : 'mt-1'}`}
        checked={leaving}
        disabled={locked}
        onChange={() => {
          setLeaving(true);
          setTimeout(() => void vault.toggleTask(task.noteId, task.line), 280);
        }}
      />
      {compact ? (
        <>
          <span className="min-w-0 flex-1 truncate text-sm">{task.text || '(leer)'}</span>
          {task.repeat && <Repeat size={11} className="shrink-0 text-faint" />}
          {task.due && <span className={`cm-due shrink-0 ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>{formatDue(task.due)}</span>}
          <button className="hidden max-w-[30%] shrink-0 truncate text-xs text-faint hover:text-accent sm:block" onClick={() => navigate(`/n/${task.noteId}`)}>
            {task.noteTitle}
          </button>
        </>
      ) : (
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
            {task.noteTitle && (
              <button className="truncate text-xs text-faint hover:text-accent" onClick={() => navigate(`/n/${task.noteId}`)}>
                {task.noteTitle}
              </button>
            )}
          </div>
        </div>
      )}
      {!compact && <TaskMeta task={task} />}
    </li>
  );
}

export function HomeView() {
  const version = useVault();
  const [input, setInput] = useState('');
  const [showSomeday, setShowSomeday] = useState(false);
  const [compact, setCompactState] = useState(() => {
    try {
      return localStorage.getItem('kladde.tasksCompact') === '1';
    } catch {
      return false;
    }
  });
  const setCompact = (v: boolean) => {
    setCompactState(v);
    try {
      localStorage.setItem('kladde.tasksCompact', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const notes = vault.list();

  const tasks = useMemo(() => {
    const out: TaskRow[] = [];
    const free = vault.freeTasksNote();
    if (free) for (const t of parseTasks(free.content)) if (!t.done) out.push({ ...t, noteId: free.id, noteTitle: '' });
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
          void vault.addFreeTask(input.trim());
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

      {tasks.length > 0 && (
        <div className="mb-2 flex justify-end anim-fade-up">
          <button className="btn-ghost text-sm" aria-pressed={compact} onClick={() => setCompact(!compact)} title={compact ? 'Normale Ansicht' : 'Kompakte Ansicht'}>
            {compact ? <List size={15} /> : <AlignJustify size={15} />} {compact ? 'Normal' : 'Kompakt'}
          </button>
        </div>
      )}
      <section className={compact ? 'space-y-3' : 'space-y-5'}>
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
                  <TaskItem key={`${t.noteId}:${t.line}:${t.text}`} task={t} compact={compact} />
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

      <div className="mt-10 mb-3 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">Zuletzt bearbeitet</h2>
        <ViewSwitch />
      </div>
      <NoteCollection notes={recent} cols="sm:grid-cols-2" />
    </div>
  );
}
