/**
 * The development cockpit (`/cockpit`, `/cockpit/:id`, opt-in feature `cockpit`): the user's dashboards and those of
 * their groups, each a grid of live widgets (views/CockpitWidget.tsx) that read GitLab and Jira with the user's own
 * connections. Dashboards are hidden notes (data/cockpit.ts); widgets and whole dashboards travel as JSON.
 */
import { useEffect, useMemo, useState } from 'react';
import { defaultDashboard, normalizeDashboard, readShared, shareDashboard, shareWidget, newWidgetId, type CockpitDashboard, type CockpitWidget } from '@kladde/shared';
import {
  createDashboard,
  deleteDashboard,
  loadDashboards,
  refreshConnections,
  runWidget,
  saveDashboard,
  useConnections,
  useDashboards,
  type DashboardRef,
} from '../data/cockpit';
import { useVault, vault } from '../data/vault';
import { ArrowDown, ArrowUp, ClipboardPaste, Copy, KeyRound, LayoutGrid, Pencil, Plus, RefreshCw, Speed, Trash2, Variables } from '../lib/icons';
import { copyText } from '../lib/clipboard';
import { tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useReadOnly } from '../lib/readOnly';
import { showToast } from '../lib/toast';
import { PageBody, PageHeader } from './PageHeader';
import { Sheet } from './Dialogs';
import { MenuButton, useItemMenu, type MenuAction } from './ContextMenu';
import { Dropdown } from './Dropdown';
import { WidgetCard } from './CockpitWidget';
import { WidgetEditor } from './CockpitWidgetEditor';
import { CockpitConnectionsView } from './CockpitConnections';

const fail = (err: unknown) => showToast((err as Error).message, 'danger');

type Dialog =
  | { kind: 'widget'; widget: CockpitWidget | null }
  | { kind: 'paste' }
  | { kind: 'rename' }
  | { kind: 'vars'; focus?: string }
  | { kind: 'connections' }
  | { kind: 'new' };

function WidgetTile({ widget, dashboard, index, canEdit, onEdit, onChange, onConnect, onSetVar }: {
  widget: CockpitWidget;
  dashboard: CockpitDashboard;
  index: number;
  canEdit: boolean;
  onEdit: () => void;
  onChange: (widgets: CockpitWidget[]) => void;
  onConnect: () => void;
  onSetVar: (name: string) => void;
}) {
  const lang = useLang();
  const list = dashboard.widgets;
  const move = (to: number) => {
    const next = [...list];
    next.splice(index, 1);
    next.splice(to, 0, widget);
    onChange(next);
  };
  const actions: MenuAction[] = [
    ...(canEdit ? [{ icon: Pencil, label: tl(lang, 'cockpit.editWidget'), onSelect: onEdit }] : []),
    { icon: Copy, label: tl(lang, 'cockpit.copyJson'), onSelect: () => void copyText(shareWidget(widget)).then((ok) => showToast(tl(lang, ok ? 'cockpit.copied' : 'cockpit.copyFailed'), ok ? 'ok' : 'warn')) },
    ...(canEdit
      ? [
          { icon: LayoutGrid, label: tl(lang, 'cockpit.duplicate'), onSelect: () => onChange([...list.slice(0, index + 1), { ...widget, id: newWidgetId(), title: `${widget.title} (2)` }, ...list.slice(index + 1)]) },
          ...(index > 0 ? [{ icon: ArrowUp, label: tl(lang, 'cockpit.moveUp'), onSelect: () => move(index - 1) }] : []),
          ...(index < list.length - 1 ? [{ icon: ArrowDown, label: tl(lang, 'cockpit.moveDown'), onSelect: () => move(index + 1) }] : []),
          { icon: Trash2, label: tl(lang, 'cockpit.removeWidget'), danger: true, onSelect: () => onChange(list.filter((w) => w.id !== widget.id)) },
        ]
      : []),
  ];
  const { button, menu } = useItemMenu(actions, tl(lang, 'cockpit.widgetMenu', { title: widget.title }), { buttonClass: 'btn-icon h-7 w-7', iconSize: 16 });
  return (
    <WidgetCard
      widget={widget}
      vars={dashboard.vars}
      refreshMinutes={dashboard.refreshMinutes}
      className={widget.width === 2 ? 'lg:col-span-2' : ''}
      onConnect={onConnect}
      onSetVar={onSetVar}
      actions={
        <>
          {button}
          {menu}
        </>
      }
    />
  );
}

function PasteSheet({ onClose, onWidgets, onDashboard }: { onClose: () => void; onWidgets: (w: CockpitWidget[]) => void; onDashboard: (d: CockpitDashboard) => void }) {
  const lang = useLang();
  const [text, setText] = useState('');
  const shared = useMemo(() => (text.trim() ? readShared(text) : null), [text]);
  return (
    <Sheet title={tl(lang, 'cockpit.paste')} onClose={onClose}>
      <form
        className="space-y-3 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (shared?.kind === 'widgets') onWidgets(shared.widgets);
          else if (shared?.kind === 'dashboard') onDashboard(shared.dashboard);
        }}
      >
        <p className="text-body-s text-muted">{tl(lang, 'cockpit.pasteHint')}</p>
        <textarea className="input min-h-48 w-full py-2 font-mono text-body-s" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-label={tl(lang, 'cockpit.json')} autoFocus data-cockpit-paste />
        <p className={`text-body-s ${text.trim() && !shared ? 'text-red' : 'text-muted'}`} role="status">
          {!text.trim()
            ? ''
            : !shared
              ? tl(lang, 'cockpit.jsonInvalid')
              : shared.kind === 'dashboard'
                ? tl(lang, 'cockpit.pasteDashboard', { title: shared.dashboard.title, n: shared.dashboard.widgets.length })
                : tl(lang, 'cockpit.pasteWidgets', { n: shared.widgets.length })}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {tl(lang, 'common.cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={!shared}>
            {tl(lang, 'cockpit.add')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function VarsSheet({ dashboard, focus, onClose, onSave }: { dashboard: CockpitDashboard; focus?: string; onClose: () => void; onSave: (vars: Record<string, string>) => void }) {
  const lang = useLang();
  const used = useMemo(() => {
    const names = new Set(Object.keys(dashboard.vars));
    for (const w of dashboard.widgets) for (const v of Object.values(w.source.params)) for (const s of Array.isArray(v) ? v : [String(v)]) for (const m of s.matchAll(/\{\{\s*var:\s*([\p{L}\p{N}_.-]{1,60})/gu)) names.add(m[1]);
    if (focus) names.add(focus);
    return [...names];
  }, [dashboard, focus]);
  const [rows, setRows] = useState<[string, string][]>(() => used.map((n) => [n, dashboard.vars[n] ?? '']));
  return (
    <Sheet title={tl(lang, 'cockpit.vars')} onClose={onClose}>
      <form
        className="space-y-3 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(Object.fromEntries(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])));
        }}
      >
        <p className="text-body-s text-muted">{tl(lang, 'cockpit.varsIntro')}</p>
        {rows.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-2" data-cockpit-var={k}>
            <input className="input w-40 font-mono text-body-s" aria-label={tl(lang, 'cockpit.varName')} value={k} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value.replace(/[^\p{L}\p{N}_.-]/gu, ''), r[1]] : r)))} />
            <input className="input min-w-0 flex-1" aria-label={tl(lang, 'cockpit.varValue', { name: k })} value={v} autoFocus={k === focus} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
            <button type="button" className="btn-icon h-8 w-8" aria-label={tl(lang, 'common.delete')} title={tl(lang, 'common.delete')} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        <button type="button" className="btn-text" onClick={() => setRows([...rows, ['', '']])}>
          <Plus size={16} /> {tl(lang, 'cockpit.addVar')}
        </button>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {tl(lang, 'common.cancel')}
          </button>
          <button type="submit" className="btn-primary">
            {tl(lang, 'common.save')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function RenameSheet({ dashboard, onClose, onSave }: { dashboard: CockpitDashboard; onClose: () => void; onSave: (title: string, refreshMinutes: number) => void }) {
  const lang = useLang();
  const [title, setTitle] = useState(dashboard.title);
  const [refresh, setRefresh] = useState(String(dashboard.refreshMinutes));
  return (
    <Sheet title={tl(lang, 'cockpit.dashboardSettings')} onClose={onClose}>
      <form
        className="space-y-3 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) onSave(title.trim(), Number(refresh));
        }}
      >
        <label className="block">
          <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.title')}</span>
          <input className="input" value={title} maxLength={120} required autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.refreshEvery')}</span>
          <Dropdown
            aria-label={tl(lang, 'cockpit.refreshEvery')}
            value={refresh}
            onChange={setRefresh}
            options={[0, 2, 5, 15, 30, 60].map((m) => ({ value: String(m), label: m ? tl(lang, 'cockpit.minutes', { n: m }) : tl(lang, 'cockpit.manual') }))}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {tl(lang, 'common.cancel')}
          </button>
          <button type="submit" className="btn-primary">
            {tl(lang, 'common.save')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function NewDashboardSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (d: CockpitDashboard, group?: string) => void }) {
  const lang = useLang();
  const groups = vault.groups.filter((g) => g.role === 'owner' || g.role === 'editor');
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState<'empty' | 'default'>('empty');
  const [space, setSpace] = useState('');
  return (
    <Sheet title={tl(lang, 'cockpit.newDashboard')} onClose={onClose}>
      <form
        className="space-y-3 pb-1"
        onSubmit={(e) => {
          e.preventDefault();
          const base = template === 'default' ? defaultDashboard(lang) : normalizeDashboard({ title: '', widgets: [] });
          onCreate({ ...base, title: title.trim() || base.title }, space || undefined);
        }}
      >
        <label className="block">
          <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.title')}</span>
          <input className="input" value={title} maxLength={120} autoFocus placeholder={template === 'default' ? defaultDashboard(lang).title : 'Dashboard'} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="segmented" role="group" aria-label={tl(lang, 'cockpit.template')}>
          <button type="button" aria-pressed={template === 'empty'} onClick={() => setTemplate('empty')}>
            {tl(lang, 'cockpit.templateEmpty')}
          </button>
          <button type="button" aria-pressed={template === 'default'} onClick={() => setTemplate('default')}>
            {tl(lang, 'cockpit.templateDefault')}
          </button>
        </div>
        {groups.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.space')}</span>
            <Dropdown aria-label={tl(lang, 'cockpit.space')} value={space} onChange={setSpace} options={[{ value: '', label: tl(lang, 'cockpit.ownSpace') }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-text" onClick={onClose}>
            {tl(lang, 'common.cancel')}
          </button>
          <button type="submit" className="btn-primary">
            {tl(lang, 'cockpit.create')}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function CockpitView({ id }: { id?: string }) {
  useVault();
  const lang = useLang();
  const locked = useReadOnly();
  const list = useDashboards();
  const { connections } = useConnections();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [loaded, setLoaded] = useState(false);
  const enabled = vault.features().cockpit.enabled;

  useEffect(() => {
    void loadDashboards().finally(() => setLoaded(true));
    void refreshConnections();
  }, []);

  const current: DashboardRef | undefined = list.find((d) => d.noteId === id) ?? list[0];
  const d = current?.dashboard;
  const canEdit = !!current?.canEdit && !locked;

  const save = (next: CockpitDashboard) => current && void saveDashboard(current.noteId, next).catch(fail);
  const create = async (next: CockpitDashboard, group?: string) => {
    try {
      const noteId = await createDashboard(next, group);
      setDialog(null);
      navigate(`/cockpit/${noteId}`);
    } catch (err) {
      fail(err);
    }
  };

  if (!enabled)
    return (
      <>
        <PageHeader title={tl(lang, 'cockpit.title')} />
        <PageBody>
          <div className="card flex flex-col items-start gap-3 p-6">
            <Speed size={28} className="text-muted" />
            <p className="text-body-m text-muted">{tl(lang, 'cockpit.off')}</p>
            <button type="button" className="btn-primary" disabled={locked} onClick={() => void vault.updateFeatures({ ...vault.features(), cockpit: { enabled: true } }).catch(fail)}>
              {tl(lang, 'cockpit.turnOn')}
            </button>
          </div>
        </PageBody>
      </>
    );

  const noConnection = connections && !connections.gitlab && !connections.jira;
  const menu: MenuAction[] = [
    { icon: Plus, label: tl(lang, 'cockpit.newDashboard'), onSelect: () => setDialog({ kind: 'new' }) },
    { icon: ClipboardPaste, label: tl(lang, 'cockpit.paste'), onSelect: () => setDialog({ kind: 'paste' }) },
    ...(d
      ? [
          { icon: Copy, label: tl(lang, 'cockpit.copyDashboard'), onSelect: () => void copyText(shareDashboard(d)).then((ok) => showToast(tl(lang, ok ? 'cockpit.copied' : 'cockpit.copyFailed'), ok ? 'ok' : 'warn')) },
          ...(canEdit
            ? [
                { icon: Pencil, label: tl(lang, 'cockpit.dashboardSettings'), onSelect: () => setDialog({ kind: 'rename' }) },
                { icon: Variables, label: tl(lang, 'cockpit.vars'), onSelect: () => setDialog({ kind: 'vars' }) },
              ]
            : []),
        ]
      : []),
    { icon: KeyRound, label: tl(lang, 'cockpit.connections'), onSelect: () => setDialog({ kind: 'connections' }) },
    ...(d && canEdit
      ? [
          {
            icon: Trash2,
            label: tl(lang, 'cockpit.deleteDashboard'),
            danger: true,
            onSelect: () => {
              if (current && confirm(tl(lang, 'cockpit.deleteConfirm', { title: d.title }))) void deleteDashboard(current.noteId).then(() => navigate('/cockpit', true)).catch(fail);
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={d?.title ?? tl(lang, 'cockpit.title')}
        subtitle={d ? tl(lang, 'cockpit.subtitle', { n: d.widgets.length }) : tl(lang, 'cockpit.intro')}
        actions={
          <>
            {list.length > 1 && (
              <Dropdown
                variant="chip"
                aria-label={tl(lang, 'cockpit.dashboards')}
                value={current?.noteId ?? ''}
                onChange={(noteId) => navigate(`/cockpit/${noteId}`)}
                options={list.map((x) => ({ value: x.noteId, label: x.group ? `${x.dashboard.title} · ${vault.group(x.group)?.name ?? ''}` : x.dashboard.title }))}
              />
            )}
            {d && (
              <button
                type="button"
                className="btn-icon"
                title={tl(lang, 'cockpit.refreshAll')}
                aria-label={tl(lang, 'cockpit.refreshAll')}
                onClick={() => d.widgets.forEach((w) => void runWidget(w, d.vars, true))}
              >
                <RefreshCw size={18} />
              </button>
            )}
            {d && canEdit && (
              <button type="button" className="btn-primary" onClick={() => setDialog({ kind: 'widget', widget: null })} data-cockpit-add>
                <Plus size={16} /> {tl(lang, 'cockpit.addWidget')}
              </button>
            )}
            <MenuButton actions={menu} label={tl(lang, 'cockpit.menu')} id="cockpit-menu" />
          </>
        }
      />
      <PageBody className="space-y-4">
        {noConnection && (
          <div className="card flex flex-wrap items-center gap-3 p-4" data-cockpit-connect-hint>
            <KeyRound size={20} className="text-acc" />
            <p className="min-w-0 flex-1 text-body-m text-body">{tl(lang, 'cockpit.connectHint')}</p>
            <button type="button" className="btn-tonal" onClick={() => setDialog({ kind: 'connections' })}>
              {tl(lang, 'cockpit.connections')}
            </button>
          </div>
        )}
        {!d && loaded && (
          <div className="card flex flex-col items-start gap-3 p-6" data-cockpit-empty>
            <Speed size={28} className="text-muted" />
            <p className="text-body-m text-muted">{tl(lang, 'cockpit.noDashboards')}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={locked} onClick={() => void create(defaultDashboard(lang))}>
                {tl(lang, 'cockpit.createDefault')}
              </button>
              <button type="button" className="btn-outlined" disabled={locked} onClick={() => setDialog({ kind: 'paste' })}>
                <ClipboardPaste size={16} /> {tl(lang, 'cockpit.paste')}
              </button>
            </div>
          </div>
        )}
        {d && d.widgets.length === 0 && <p className="card p-6 text-body-m text-muted">{tl(lang, 'cockpit.noWidgets')}</p>}
        {d && current && (
          <div className="grid gap-4 lg:grid-cols-2" data-cockpit-grid>
            {d.widgets.map((w, i) => (
              <WidgetTile
                key={`${current.noteId}-${w.id}`}
                widget={w}
                dashboard={d}
                index={i}
                canEdit={canEdit}
                onEdit={() => setDialog({ kind: 'widget', widget: w })}
                onChange={(widgets) => save({ ...d, widgets })}
                onConnect={() => setDialog({ kind: 'connections' })}
                onSetVar={(name) => (canEdit ? setDialog({ kind: 'vars', focus: name }) : undefined)}
              />
            ))}
          </div>
        )}
      </PageBody>

      {dialog?.kind === 'widget' && d && (
        <WidgetEditor
          widget={dialog.widget}
          vars={d.vars}
          onClose={() => setDialog(null)}
          onSave={(w) => {
            const exists = d.widgets.some((x) => x.id === w.id);
            save({ ...d, widgets: exists ? d.widgets.map((x) => (x.id === w.id ? w : x)) : [...d.widgets, w] });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'paste' && (
        <PasteSheet
          onClose={() => setDialog(null)}
          onDashboard={(next) => void create(next)}
          onWidgets={(widgets) => {
            if (d && canEdit) {
              save({ ...d, widgets: [...d.widgets, ...widgets] });
              setDialog(null);
            } else void create(normalizeDashboard({ title: 'Dashboard', widgets }));
          }}
        />
      )}
      {dialog?.kind === 'rename' && d && (
        <RenameSheet
          dashboard={d}
          onClose={() => setDialog(null)}
          onSave={(title, refreshMinutes) => {
            save({ ...d, title, refreshMinutes });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'vars' && d && (
        <VarsSheet
          dashboard={d}
          focus={dialog.focus}
          onClose={() => setDialog(null)}
          onSave={(vars) => {
            save({ ...d, vars });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'new' && <NewDashboardSheet onClose={() => setDialog(null)} onCreate={(next, group) => void create(next, group)} />}
      {dialog?.kind === 'connections' && (
        <Sheet title={tl(lang, 'cockpit.connections')} onClose={() => setDialog(null)}>
          <div className="pb-4">
            <CockpitConnectionsView />
          </div>
        </Sheet>
      )}
    </>
  );
}
