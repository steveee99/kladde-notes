/**
 * The habits page (`/habits`, #134, opt-in feature `habits`): today's habits to check off, the last seven days to
 * catch up, streaks, the rate of the last 30 days and a heatmap of the last 17 weeks per habit. Habits are set up
 * in a sheet; check-ins land in the daily notes as `- [x] … #habit/<id>` (`data/habits.ts`).
 */
import { useEffect, useMemo, useState } from 'react';
import { habitSlug, habitStats, toDateString, weekStart, type Habit, type HabitTarget } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { habitHistory, habits as loadHabits, loadRecentDailyNotes, saveHabits, setCheckin } from '../data/habits';
import { ArrowDown, ArrowUp, Check, Flame, Pencil, Plus, Trash2 } from '../lib/icons';
import { locale, t, useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { showToast } from '../lib/toast';
import { PageBody, PageHeader } from './PageHeader';
import { Sheet } from './Dialogs';
import { useItemMenu } from './ContextMenu';

const WEEKS = 17;

const shift = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  return toDateString(new Date(y, m - 1, d + n));
};

function targetLabel(target: HabitTarget): string {
  return target.kind === 'daily' ? t('habits.daily') : t('habits.perWeek', { n: target.times });
}

const fail = (err: unknown) => showToast((err as Error).message, 'danger');

/** The check-ins of the last 17 weeks as a grid (weeks as columns, Monday on top) */
function HabitHeatmap({ days, today, label }: { days: ReadonlySet<string>; today: string; label: string }) {
  const lang = useLang();
  const start = shift(weekStart(today), -7 * (WEEKS - 1));
  const cells: { date: string; x: number; y: number; on: boolean; future: boolean }[] = [];
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const date = shift(start, w * 7 + d);
      cells.push({ date, x: w * 12, y: d * 12, on: days.has(date), future: date > today });
    }
  }
  const fmt = new Intl.DateTimeFormat(locale(lang), { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <svg viewBox={`0 0 ${WEEKS * 12} ${7 * 12}`} className="h-auto w-full max-w-[17rem]" role="img" aria-label={label}>
      {cells.map((c) => (
        <rect
          key={c.date}
          x={c.x}
          y={c.y}
          width={10}
          height={10}
          rx={2}
          className={c.future ? 'fill-transparent' : c.on ? 'fill-acc' : 'fill-raised'}
          data-day={c.date}
          data-on={c.on || undefined}
        >
          <title>{`${fmt.format(new Date(`${c.date}T12:00:00`))}${c.on ? ' ✓' : ''}`}</title>
        </rect>
      ))}
    </svg>
  );
}

function HabitCard({ habit, index, total, days, today, onEdit, onMove, onDelete }: {
  habit: Habit;
  index: number;
  total: number;
  days: ReadonlySet<string>;
  today: string;
  onEdit: () => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const lang = useLang();
  const locked = useReadOnly();
  const [busy, setBusy] = useState<string | null>(null);
  const stats = habitStats(habit, days, today);
  const toggle = (date: string) => {
    if (locked || busy) return;
    setBusy(date);
    setCheckin(habit, date, !days.has(date))
      .catch(fail)
      .finally(() => setBusy(null));
  };
  const menu = useItemMenu(
    locked
      ? []
      : [
          { icon: Pencil, label: t('habits.edit'), onSelect: onEdit },
          ...(index > 0 ? [{ icon: ArrowUp, label: t('saved.moveUp'), onSelect: () => onMove(-1) }] : []),
          ...(index < total - 1 ? [{ icon: ArrowDown, label: t('saved.moveDown'), onSelect: () => onMove(1) }] : []),
          { icon: Trash2, label: t('habits.delete'), danger: true, onSelect: onDelete },
        ],
    t('habits.actions', { name: habit.name }),
    { buttonClass: 'btn-icon shrink-0' }
  );
  const week = Array.from({ length: 7 }, (_, i) => shift(today, i - 6));
  const dayFmt = new Intl.DateTimeFormat(locale(lang), { weekday: 'narrow' });
  const longFmt = new Intl.DateTimeFormat(locale(lang), { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <li className="card p-4" data-habit={habit.id} onContextMenu={menu.rowProps.onContextMenu}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 text-xl transition-colors ${stats.doneToday ? 'border-acc bg-acc text-on-acc' : 'border-line2 hover:border-acc'}`}
          aria-pressed={stats.doneToday}
          aria-label={t('habits.checkToday', { name: habit.name })}
          title={t('habits.checkToday', { name: habit.name })}
          disabled={locked || busy !== null}
          onClick={() => toggle(today)}
          data-habit-today
        >
          {stats.doneToday ? <Check size={22} /> : habit.icon || <Check size={20} className="text-muted" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-title-m text-strong">
              {habit.icon && stats.doneToday ? `${habit.icon} ` : ''}
              {habit.name}
            </h2>
            {menu.button}
            {menu.menu}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-muted">
            <span className="pill bg-raised">{targetLabel(habit.target)}</span>
            {habit.target.kind === 'weekly' && (
              <span className="pill bg-raised font-mono" data-habit-week>
                {t('habits.thisWeek', { n: stats.thisWeek, of: habit.target.times })}
              </span>
            )}
            <span className={`pill font-mono ${stats.current ? 'bg-amber-bg text-amber' : 'bg-raised'}`} data-habit-streak title={t('habits.streakTitle')}>
              <Flame size={12} className="mr-0.5 inline" />
              {habit.target.kind === 'daily' ? t('habits.streakDays', { n: stats.current }) : t('habits.streakWeeks', { n: stats.current })}
            </span>
            <span className="pill bg-raised font-mono" title={t('habits.bestTitle')}>
              {t('habits.best', { n: stats.longest })}
            </span>
            <span className="pill bg-raised font-mono" title={t('habits.rateTitle')} data-habit-rate>
              {Math.round(stats.rate30 * 100)} %
            </span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div role="group" aria-label={t('habits.lastWeek')} className="flex gap-1">
          {week.map((date) => {
            const on = days.has(date);
            return (
              <button
                key={date}
                type="button"
                className={`flex h-9 w-8 flex-col items-center justify-center rounded-md border text-[11px] transition-colors ${on ? 'border-acc-line bg-acc-bg text-acc-hi' : 'border-line text-muted hover:border-line2'} ${date === today ? 'font-semibold' : ''}`}
                aria-pressed={on}
                aria-label={longFmt.format(new Date(`${date}T12:00:00`))}
                title={longFmt.format(new Date(`${date}T12:00:00`))}
                disabled={locked || busy !== null}
                onClick={() => toggle(date)}
              >
                <span>{dayFmt.format(new Date(`${date}T12:00:00`))}</span>
                <span className="font-mono">{on ? '✓' : Number(date.slice(8))}</span>
              </button>
            );
          })}
        </div>
        <HabitHeatmap days={days} today={today} label={t('habits.heatmapLabel', { name: habit.name })} />
      </div>
    </li>
  );
}

/** Sets up a habit or changes one: name, icon and target */
function HabitSheet({ habit, taken, onSave, onClose }: { habit: Habit | null; taken: ReadonlySet<string>; onSave: (h: Habit) => void; onClose: () => void }) {
  const [name, setName] = useState(habit?.name ?? '');
  const [icon, setIcon] = useState(habit?.icon ?? '');
  const [weekly, setWeekly] = useState(habit?.target.kind === 'weekly');
  const [times, setTimes] = useState(habit?.target.kind === 'weekly' ? habit.target.times : 3);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    let id = habit?.id ?? habitSlug(clean);
    if (!habit) for (let n = 2; taken.has(id); n++) id = `${habitSlug(clean)}-${n}`;
    onSave({ id, name: clean, icon: [...icon.trim()].slice(0, 4).join(''), target: weekly ? { kind: 'weekly', times } : { kind: 'daily' } });
  };
  return (
    <Sheet title={habit ? t('habits.edit') : t('habits.new')} onClose={onClose}>
      <form className="space-y-4 pb-1" onSubmit={submit} data-habit-form>
        <div className="flex gap-3">
          <label className="w-20 shrink-0">
            <span className="mb-1 block text-label-m text-muted">{t('habits.icon')}</span>
            <input className="input text-center text-lg" value={icon} maxLength={8} placeholder="🏃" onChange={(e) => setIcon(e.target.value)} aria-describedby="habit-icon-hint" />
          </label>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-label-m text-muted">{t('habits.name')}</span>
            <input className="input" value={name} autoFocus required maxLength={60} placeholder={t('habits.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <p id="habit-icon-hint" className="-mt-2 text-caption text-muted">
          {t('habits.iconHint')}
        </p>
        <div>
          <span className="mb-1 block text-label-m text-muted">{t('habits.target')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t('habits.target')} className="segmented">
              <button type="button" aria-pressed={!weekly} onClick={() => setWeekly(false)}>
                {t('habits.daily')}
              </button>
              <button type="button" aria-pressed={weekly} onClick={() => setWeekly(true)}>
                {t('habits.weekly')}
              </button>
            </div>
            {weekly && (
              <label className="flex items-center gap-2 text-body-m">
                <input className="input w-16 text-center" type="number" min={1} max={6} value={times} onChange={(e) => setTimes(Math.min(6, Math.max(1, Number(e.target.value) || 1)))} />
                {t('habits.timesPerWeek')}
              </label>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-text" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={!name.trim()}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function HabitsView() {
  const version = useVault();
  useLang();
  const locked = useReadOnly();
  const [editing, setEditing] = useState<Habit | 'new' | null>(null);
  const today = toDateString(new Date());
  const list = useMemo(() => loadHabits(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => habitHistory(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void loadRecentDailyNotes().catch(() => {});
  }, []);
  const done = list.filter((h) => history.get(h.id)?.has(today)).length;
  const write = (next: Habit[]) => saveHabits(next).catch(fail);
  const empty = new Set<string>();
  return (
    <div>
      <PageHeader
        title={t('habits.title')}
        subtitle={list.length ? <span className="font-mono text-[11.5px]">{t('habits.todayCount', { done, n: list.length })}</span> : undefined}
        actions={
          !locked && (
            <button type="button" className="btn-tonal" onClick={() => setEditing('new')} data-new-habit>
              <Plus size={18} /> {t('habits.new')}
            </button>
          )
        }
      />
      <PageBody>
        {!vault.features().habits.enabled && (
          <p className="mb-4 rounded-lg border border-line bg-panel px-4 py-3 text-body-m text-muted" role="note">
            {t('habits.featureOff')}
          </p>
        )}
        {list.length === 0 ? (
          <div className="empty-sheet anim-fade-in">
            <p className="empty-title">{t('habits.emptyTitle')}</p>
            <p className="mt-1 text-body-m text-muted">{t('habits.emptyDesc')}</p>
          </div>
        ) : (
          <ul className="stagger grid grid-cols-1 gap-3 lg:grid-cols-2">
            {list.map((h, i) => (
              <HabitCard
                key={h.id}
                habit={h}
                index={i}
                total={list.length}
                days={history.get(h.id) ?? empty}
                today={today}
                onEdit={() => setEditing(h)}
                onMove={(dir) => {
                  const next = [...list];
                  [next[i], next[i + dir]] = [next[i + dir], next[i]];
                  void write(next);
                }}
                onDelete={() => {
                  if (confirm(t('habits.deleteConfirm', { name: h.name }))) void write(list.filter((x) => x.id !== h.id));
                }}
              />
            ))}
          </ul>
        )}
      </PageBody>
      {editing && (
        <HabitSheet
          habit={editing === 'new' ? null : editing}
          taken={new Set(list.map((h) => h.id))}
          onClose={() => setEditing(null)}
          onSave={(h) => {
            setEditing(null);
            void write(editing === 'new' ? [...list, h] : list.map((x) => (x.id === h.id ? h : x)));
          }}
        />
      )}
    </div>
  );
}
