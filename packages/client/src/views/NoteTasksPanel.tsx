/**
 * The "Tasks" tab of the note's side panel (#45): the tasks of the open note in document order with
 * status and due date. A click jumps to the line; the checkbox and the status menu change the task
 * right in the editor, so the edit is part of the editor's undo history.
 */
import { useEffect, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { bucketOf, parseTasks, type Task } from '@kladde/shared';
import { CalendarClock, Repeat } from '../lib/icons';
import { subscribe } from '../editor/outline';
import { formatDue, openStatusMenu, setLineStatus, toggleLine } from '../editor/widgets';
import { vault } from '../data/vault';
import { t, useLang } from '../lib/i18n';
import { StatusChip } from './TaskParts';

/** Tasks of the note, live from the editor (or from the stored text while no editor is shown) */
export function useNoteTasks(view: EditorView | null, fallback: string, defaultDue: string | null): Task[] {
  const [tasks, setTasks] = useState<Task[]>(() => parseTasks(fallback, undefined, defaultDue));
  useEffect(() => {
    if (!view) {
      setTasks(parseTasks(fallback, undefined, defaultDue));
      return;
    }
    let frame = 0;
    const compute = () => setTasks(parseTasks(view.state.doc.toString(), undefined, defaultDue));
    compute();
    const unsubscribe = subscribe(view, (u) => {
      if (!u.docChanged || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, view ? '' : fallback, defaultDue]);
  return tasks;
}

export function NoteTasksPanel({
  noteId,
  tasks,
  view,
  canEdit,
  onJump,
}: {
  noteId: string;
  tasks: Task[];
  view: EditorView | null;
  canEdit: boolean;
  onJump: (pos: number) => void;
}) {
  const lang = useLang();
  if (tasks.length === 0) return <p className="py-8 text-center text-body-m text-on-surface-variant">{t('note.tasksEmpty')}</p>;
  const done = tasks.filter((tk) => tk.done).length;

  const toggle = (tk: Task) => {
    if (view) toggleLine(view, tk.line);
    else void vault.toggleTask(noteId, tk.line);
  };
  const pick = (anchor: HTMLElement, tk: Task) =>
    openStatusMenu(anchor, tk.status, lang, (status) => {
      if (view) setLineStatus(view, tk.line, status);
      else void vault.setTaskStatus(noteId, tk.line, status);
    });
  const jump = (tk: Task) => {
    if (!view) return;
    const line = view.state.doc.line(Math.min(tk.line + 1, view.state.doc.lines));
    onJump(line.from);
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-3 px-2">
        <span className="text-title-s text-on-surface-variant">{t('note.tasksProgress', { done, n: tasks.length })}</span>
        <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-container-highest" aria-hidden>
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / tasks.length) * 100}%` }} />
        </div>
      </div>
      <ul className="space-y-0.5" aria-label={t('note.tabTasks')}>
        {tasks.map((tk) => {
          const bucket = bucketOf(tk);
          return (
            <li key={`${tk.line}:${tk.text}`} className="state-layer flex items-start gap-3 rounded-lg px-2 py-2" style={{ paddingLeft: `${8 + Math.min(Math.max(0, tk.indent.search(/\S/)), 12) * 4}px` }}>
              <input
                type="checkbox"
                className="cm-checkbox !m-0 mt-0.5 shrink-0"
                data-status={tk.status}
                checked={tk.done}
                disabled={!canEdit}
                title={t(`task.status.${tk.status}`)}
                onChange={() => toggle(tk)}
                onContextMenu={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  pick(e.currentTarget, tk);
                }}
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => jump(tk)}
                title={t('note.tasksJumpHint')}
              >
                <span className={`block break-words text-body-m ${tk.done ? 'text-on-surface-variant line-through' : 'text-on-surface'}`}>{tk.text || t('home.taskEmpty')}</span>
                {(tk.status === 'doing' || tk.status === 'blocked' || tk.due || tk.repeat) && (
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusChip status={tk.status} />
                    {tk.due && !tk.done && (
                      <span className={`cm-due ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}>
                        <CalendarClock size={11} className="mr-1 inline" />
                        {formatDue(tk.due)}
                      </span>
                    )}
                    {tk.repeat && <Repeat size={11} className="text-on-surface-variant" />}
                  </span>
                )}
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="btn-text !h-7 shrink-0 !px-2 text-label-m"
                  onClick={(e) => pick(e.currentTarget, tk)}
                  aria-label={t('home.taskStatusAria')}
                  title={t('home.taskStatusAria')}
                >
                  {t(`task.status.${tk.status}`)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
