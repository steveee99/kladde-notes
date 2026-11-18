import { useState } from 'react';
import {
  FILTER_OPS,
  PROPERTY_TYPES,
  VIEW_TYPES,
  applyView,
  boardLanes,
  databaseRows,
  defaultView,
  formatDbValue,
  linkTarget,
  newDatabaseNoteContent,
  parseDatabase,
  readFrontmatterYaml,
  setCell,
  setFrontmatterValues,
  writeDatabase,
  type Database,
  type DbProperty,
  type DbRow,
  type DbValue,
  type DbView,
} from '@kladde/shared';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { useReadOnly } from '../lib/readOnly';
import { navigate } from '../lib/router';
import { Plus, Settings, Trash2 } from '../lib/icons';
import { t, useLang, type I18nKey } from '../lib/i18n';
import { Sheet } from './Dialogs';
import { ChipSelect } from './ChipSelect';
import { Dropdown, type DropdownOption } from './Dropdown';

const typeKey = (type: string) => `db.type.${type}` as I18nKey;
const viewKey = (type: string) => `db.view.${type}` as I18nKey;
const opKey = (op: string) => `db.op.${op}` as I18nKey;
const NONE: DropdownOption = { value: '', label: '—' };
const asOptions = (values: string[]): DropdownOption[] => values.map((v) => ({ value: v, label: v }));

/** One typed, editable cell; changes go straight into the note's frontmatter */
function Cell({ row, prop, canEdit }: { row: DbRow; prop: DbProperty; canEdit: boolean }) {
  const value = row.values[prop.name];
  const save = (v: DbValue) => {
    const note = vault.get(row.noteId);
    if (note) void vault.update(note.id, { content: setCell(note.content, prop, v) });
  };
  const label = `${prop.name}: ${row.title}`;
  if (prop.type === 'checkbox') {
    return <input type="checkbox" className="cm-checkbox" aria-label={label} checked={value === true} disabled={!canEdit} onChange={(e) => save(e.target.checked)} />;
  }
  if (prop.type === 'select') {
    if (!canEdit) return <span>{formatDbValue(prop.type, value)}</span>;
    const current = typeof value === 'string' ? value : '';
    const opts = current && !prop.options.includes(current) ? [...prop.options, current] : prop.options;
    return (
<Dropdown className="!min-h-0 !py-1" aria-label={label} value={current} options={[NONE, ...asOptions(opts)]} onChange={(v) => save(v || null)} />
    );
  }
  if (prop.type === 'multiselect') {
    const chosen = Array.isArray(value) ? value : [];
    const free = prop.options.filter((o) => !chosen.includes(o));
    return (
      <span className="flex flex-wrap items-center gap-1">
        {chosen.map((c) => (
          <button key={c} type="button" className="chip" disabled={!canEdit} aria-label={`${t('common.delete')} ${c}`} onClick={() => save(chosen.filter((x) => x !== c))}>
            {c}
          </button>
        ))}
        {canEdit && free.length > 0 && (
          <Dropdown variant="chip" placeholder="+" aria-label={label} value="" options={asOptions(free)} onChange={(v) => save([...chosen, v])} />
        )}
      </span>
    );
  }
  const inputType = prop.type === 'number' ? 'number' : prop.type === 'date' ? 'date' : 'text';
  const shown = prop.type === 'link' ? linkTarget(value) : value === null ? '' : String(value);
  if (!canEdit) {
    if (prop.type === 'link' && shown) {
      const target = vault.findByTitle(shown);
      return target ? (
        <a className="cm-link cursor-pointer" onClick={() => navigate(`/n/${target.id}`)}>
          {shown}
        </a>
      ) : (
        <span>{shown}</span>
      );
    }
    return <span>{shown}</span>;
  }
  return (
    <input
      key={shown}
      type={inputType}
      step={prop.type === 'number' ? 'any' : undefined}
      className="input !min-h-0 !py-1"
      aria-label={label}
      defaultValue={shown}
      list={prop.type === 'link' ? 'db-link-targets' : undefined}
      onBlur={(e) => e.target.value !== shown && save(e.target.value === '' ? null : prop.type === 'number' ? Number(e.target.value) : e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function TableView({ db, view, rows, canEdit }: { db: Database; view: DbView; rows: DbRow[]; canEdit: boolean }) {
  const cols = (view.columns.length ? view.columns : db.properties.map((p) => p.name)).map((c) => db.properties.find((p) => p.name.toLowerCase() === c.toLowerCase())).filter((p): p is DbProperty => !!p);
  return (
    <div className="card overflow-x-auto p-0 anim-fade-up">
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-outline-variant/60 text-left text-label-m text-on-surface-variant">
            <th className="px-3 py-2 font-medium">{t('list.colTitle')}</th>
            {db.subfolders && <th className="px-3 py-2 font-medium">{t('db.colPath')}</th>}
            {cols.map((p) => (
              <th key={p.name} className="px-3 py-2 font-medium">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.noteId} className="border-b border-outline-variant/40 last:border-0">
              <td className="px-3 py-1.5">
                <a className="cursor-pointer font-medium hover:underline" onClick={() => navigate(`/n/${r.noteId}`)}>
                  {r.title}
                </a>
              </td>
              {db.subfolders && <td className="px-3 py-1.5 text-on-surface-variant">{r.folder}</td>}
              {cols.map((p) => (
                <td key={p.name} className="px-3 py-1.5">
                  <Cell row={r} prop={p} canEdit={canEdit} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Card({ row, shownProps, children }: { row: DbRow; shownProps: DbProperty[]; children?: React.ReactNode }) {
  return (
    <div className="card cursor-pointer p-3" onClick={() => navigate(`/n/${row.noteId}`)}>
      {children}
      <div className="font-medium">{row.title}</div>
      {row.folder && <div className="truncate text-xs text-on-surface-variant">{row.folder}</div>}
      {shownProps.map((p) => {
        const text = formatDbValue(p.type, row.values[p.name]);
        return text ? (
          <div key={p.name} className="truncate text-xs text-on-surface-variant">
            {p.name}: {text}
          </div>
        ) : null;
      })}
    </div>
  );
}

function BoardView({ db, view, rows, canEdit }: { db: Database; view: DbView; rows: DbRow[]; canEdit: boolean }) {
  const group = db.properties.find((p) => p.name.toLowerCase() === view.group.toLowerCase());
  if (!group || group.type !== 'select') return <div className="py-10 text-center text-on-surface-variant">{t('db.boardNeedsSelect')}</div>;
  const shown = db.properties.filter((p) => p !== group).slice(0, 3);
  return (
    <div className="wz-kanban scrollbar-thin flex gap-3 overflow-x-auto anim-fade-up">
      {boardLanes(db, view, rows).map((lane) => (
        <div
          key={lane.value}
          className="wz-lane min-w-[14rem] flex-1 space-y-2"
          onDragOver={(e) => canEdit && e.dataTransfer.types.includes('application/x-kladde-card') && e.preventDefault()}
          onDrop={(e) => {
            const id = e.dataTransfer.getData('application/x-kladde-card');
            const note = id ? vault.get(id) : undefined;
            if (!note || !canEdit) return;
            e.preventDefault();
            void vault.update(id, { content: setCell(note.content, group, lane.value || null) });
          }}
        >
          <div className="wz-lane-head">
            {lane.value || t('db.noValue')}
            <span>{lane.rows.length}</span>
          </div>
          {lane.rows.map((r) => (
            <div key={r.noteId} draggable={canEdit} onDragStart={(e) => e.dataTransfer.setData('application/x-kladde-card', r.noteId)}>
              <Card row={r} shownProps={shown} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function GalleryView({ db, view, rows }: { db: Database; view: DbView; rows: DbRow[] }) {
  const shown = (view.columns.length ? view.columns : db.properties.map((p) => p.name)).map((c) => db.properties.find((p) => p.name.toLowerCase() === c.toLowerCase())).filter((p): p is DbProperty => !!p).slice(0, 3);
  return (
    <div className="grid grid-cols-2 gap-3 anim-fade-up sm:grid-cols-3 lg:grid-cols-4">
      {rows.map((r) => (
        <Card key={r.noteId} row={r} shownProps={shown}>
          {r.cover ? <img src={r.cover} alt="" loading="lazy" className="mb-2 aspect-video w-full rounded-lg object-cover" /> : <div className="mb-2 aspect-video w-full rounded-lg bg-surface-container-high" />}
        </Card>
      ))}
    </div>
  );
}

interface DraftProp extends DbProperty {
  /** Name before this editing session; a changed name moves the values in the notes */
  orig: string;
}

/** Schema and views editor */
function SchemaSheet({ db, dbNote, folder, onClose }: { db: Database; dbNote: LocalNote; folder: string; onClose: () => void }) {
  const [props, setProps] = useState<DraftProp[]>(db.properties.map((p) => ({ ...p, orig: p.name })));
  const [views, setViews] = useState<DbView[]>(db.views.map((v) => ({ ...v, filter: v.filter.map((f) => ({ ...f })) })));
  const patchProp = (i: number, p: Partial<DraftProp>) => setProps((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const patchView = (i: number, p: Partial<DbView>) => setViews((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const [subfolders, setSubfolders] = useState(db.subfolders);
  const names = props.map((p) => p.name.trim()).filter(Boolean);
  /** Fields besides the properties that views can sort and filter by */
  const builtin: DropdownOption[] = [{ value: 'title', label: t('list.colTitle') }, ...(subfolders ? [{ value: 'path', label: t('db.colPath') }] : [])];

  const save = async () => {
    const clean = props.filter((p) => p.name.trim());
    const renames = new Map<string, string>();
    for (const p of clean) if (p.orig && p.orig !== p.name.trim()) renames.set(p.orig, p.name.trim());
    const rename = (n: string) => renames.get(n) ?? n;
    // Values follow a renamed property in the notes of the folder
    if (renames.size) {
      for (const n of vault.list()) {
        if (n.access === 'read' || n.path.slice(0, n.path.lastIndexOf('/')) !== folder || n.id === dbNote.id) continue;
        const fm = readFrontmatterYaml(n.content);
        if (!fm) continue;
        const updates: Record<string, never | (typeof fm.data)[string] | undefined> = {};
        for (const [from, to] of renames) {
          const key = Object.keys(fm.data).find((k) => k.toLowerCase() === from.toLowerCase());
          if (key && !(to.toLowerCase() in Object.fromEntries(Object.keys(fm.data).map((k) => [k.toLowerCase(), 1])))) {
            updates[to] = fm.data[key];
            updates[key] = undefined;
          }
        }
        if (Object.keys(updates).length) await vault.update(n.id, { content: setFrontmatterValues(n.content, updates) });
      }
    }
    const next: Database = {
      subfolders,
      properties: clean.map(({ orig: _orig, ...p }) => ({
        ...p,
        name: p.name.trim(),
        options: p.options.map((o) => o.trim()).filter(Boolean),
      })),
      views: views.map((v) => ({
        ...v,
        name: v.name.trim() || t('db.viewDefault'),
        columns: v.columns.map(rename),
        group: rename(v.group),
        sort: rename(v.sort),
        filter: v.filter.map((f) => ({ ...f, property: rename(f.property) })).filter((f) => f.property),
      })),
    };
    if (!next.views.length) next.views.push(defaultView(t('db.viewDefault')));
    await vault.update(dbNote.id, { content: writeDatabase(dbNote.content, next) });
    onClose();
  };

  return (
    <Sheet title={t('db.editTitle')} onClose={onClose}>
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={subfolders} onChange={(e) => setSubfolders(e.target.checked)} /> {t('db.subfolders')}
      </label>
      <h3 className="mb-2 text-title-s">{t('db.properties')}</h3>
      <ul className="mb-2 space-y-3">
        {props.map((p, i) => (
          <li key={i} className="rounded-xl border border-outline-variant/60 p-2">
            <div className="flex gap-2">
              <input className="input min-w-0 flex-1" aria-label={t('db.propName')} placeholder={t('db.propName')} value={p.name} onChange={(e) => patchProp(i, { name: e.target.value })} />
              <Dropdown className="w-auto" aria-label={t('db.propType')} value={p.type} options={PROPERTY_TYPES.map((ty) => ({ value: ty, label: t(typeKey(ty)) }))} onChange={(v) => patchProp(i, { type: v as DbProperty['type'] })} />
              <button className="btn-icon" aria-label={t('common.delete')} title={t('common.delete')} onClick={() => setProps((l) => l.filter((_, j) => j !== i))}>
                <Trash2 size={16} />
              </button>
            </div>
            {(p.type === 'select' || p.type === 'multiselect') && (
              <input
                className="input mt-2"
                aria-label={t('db.options')}
                placeholder={t('db.options')}
                value={p.options.join(', ')}
                onChange={(e) => patchProp(i, { options: e.target.value.split(',').map((s) => s.trimStart()) })}
              />
            )}
            {p.type !== 'link' && (
              <input className="input mt-2" aria-label={t('db.default')} placeholder={t('db.default')} value={p.default} onChange={(e) => patchProp(i, { default: e.target.value })} />
            )}
          </li>
        ))}
      </ul>
      <button className="btn-text mb-5" onClick={() => setProps((l) => [...l, { name: '', type: 'text', options: [], default: '', orig: '' }])}>
        <Plus size={16} /> {t('db.addProperty')}
      </button>

      <h3 className="mb-2 text-title-s">{t('db.views')}</h3>
      <ul className="mb-2 space-y-3">
        {views.map((v, i) => (
          <li key={i} className="rounded-xl border border-outline-variant/60 p-2">
            <div className="flex gap-2">
              <input className="input min-w-0 flex-1" aria-label={t('db.viewName')} value={v.name} onChange={(e) => patchView(i, { name: e.target.value })} />
              <Dropdown className="w-auto" aria-label={t('db.viewType')} value={v.type} options={VIEW_TYPES.map((ty) => ({ value: ty, label: t(viewKey(ty)) }))} onChange={(x) => patchView(i, { type: x as DbView['type'] })} />
              <button className="btn-icon" aria-label={t('common.delete')} title={t('common.delete')} onClick={() => setViews((l) => l.filter((_, j) => j !== i))}>
                <Trash2 size={16} />
              </button>
            </div>
            {v.type === 'board' && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                {t('db.groupBy')}
                <Dropdown className="w-auto" aria-label={t('db.groupBy')} value={v.group} options={[NONE, ...asOptions(props.filter((p) => p.type === 'select' && p.name.trim()).map((p) => p.name.trim()))]} onChange={(x) => patchView(i, { group: x })} />
              </label>
            )}
            <label className="mt-2 flex items-center gap-2 text-sm">
              {t('db.sortBy')}
              <Dropdown className="w-auto" aria-label={t('db.sortBy')} value={v.sort} options={[NONE, ...builtin, ...asOptions(names)]} onChange={(x) => patchView(i, { sort: x })} />
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={v.desc} onChange={(e) => patchView(i, { desc: e.target.checked })} /> {t('db.descending')}
              </label>
            </label>
            {v.filter.map((f, fi) => (
              <div key={fi} className="mt-2 flex flex-wrap items-center gap-2">
                <Dropdown className="w-auto" aria-label={t('db.filterProperty')} value={f.property} options={[...builtin, ...asOptions(names)]} onChange={(x) => patchView(i, { filter: v.filter.map((y, j) => (j === fi ? { ...y, property: x } : y)) })} />
                <Dropdown className="w-auto" aria-label={t('db.filterOp')} value={f.op} options={FILTER_OPS.map((op) => ({ value: op, label: t(opKey(op)) }))} onChange={(x) => patchView(i, { filter: v.filter.map((y, j) => (j === fi ? { ...y, op: x as typeof f.op } : y)) })} />
                {f.op !== 'empty' && f.op !== 'notempty' && (
                  <input className="input min-w-0 flex-1" aria-label={t('db.filterValue')} value={f.value} onChange={(e) => patchView(i, { filter: v.filter.map((x, j) => (j === fi ? { ...x, value: e.target.value } : x)) })} />
                )}
                <button className="btn-icon" aria-label={t('common.delete')} onClick={() => patchView(i, { filter: v.filter.filter((_, j) => j !== fi) })}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <button className="btn-text mt-1" onClick={() => patchView(i, { filter: [...v.filter, { property: 'title', op: 'contains', value: '' }] })}>
              <Plus size={16} /> {t('db.addFilter')}
            </button>
          </li>
        ))}
      </ul>
      <button className="btn-text mb-5" onClick={() => setViews((l) => [...l, defaultView(t('db.viewDefault'))])}>
        <Plus size={16} /> {t('db.addView')}
      </button>

      <div className="flex justify-end gap-2 pb-2">
        <button className="btn-text" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn-primary" onClick={() => void save()}>
          {t('common.save')}
        </button>
      </div>
    </Sheet>
  );
}

/** A folder with a `_database-<uuid>.md` as a database (#76): views over its notes without writing a query */
export function DatabaseView({ folder, dbNote }: { folder: string; dbNote: LocalNote }) {
  useLang();
  const db = parseDatabase(dbNote.content);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(false);
  const readOnly = useReadOnly();
  if (!db) return null;
  const canEdit = dbNote.access !== 'read' && !readOnly;
  const view = db.views[Math.min(active, db.views.length - 1)];
  const all = vault.list().filter((n) => n.access === 'owner' || n.id === dbNote.id || n.path.startsWith(`${folder}/`));
  const rows = applyView(db, view, databaseRows(db, folder, all));
  const hasLink = db.properties.some((p) => p.type === 'link');

  const addRow = async () => {
    try {
      const title = t('db.newRow');
      const note = await vault.create(folder, title, newDatabaseNoteContent(db, title));
      navigate(`/n/${note.id}`);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <section className="mb-6" aria-label={t('db.title')} data-database>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ChipSelect
          aria-label={t('db.views')}
          value={String(Math.min(active, db.views.length - 1))}
          options={db.views.map((v, i) => ({ value: String(i), label: v.name }))}
          onChange={(x) => setActive(Number(x))}
          className="!h-10 !px-4"
        />
        <span className="flex-1" />
        {canEdit && (
          <>
            <button className="btn-text" onClick={() => setEditing(true)} data-database-edit>
              <Settings size={16} /> <span className="hidden sm:inline">{t('db.editBtn')}</span>
            </button>
            <button className="btn-tonal" onClick={() => void addRow()} data-database-add>
              <Plus size={16} /> {t('db.newRow')}
            </button>
          </>
        )}
      </div>
      {hasLink && (
        <datalist id="db-link-targets">
          {vault.list().map((n) => (
            <option key={n.id} value={n.path.replace(/^.*\//, '').replace(/\.md$/, '')} />
          ))}
        </datalist>
      )}
      {rows.length === 0 ? (
        <div className="py-10 text-center text-on-surface-variant">{t('db.empty')}</div>
      ) : view.type === 'board' ? (
        <BoardView db={db} view={view} rows={rows} canEdit={canEdit} />
      ) : view.type === 'gallery' ? (
        <GalleryView db={db} view={view} rows={rows} />
      ) : (
        <TableView db={db} view={view} rows={rows} canEdit={canEdit} />
      )}
      {editing && <SchemaSheet db={db} dbNote={dbNote} folder={folder} onClose={() => setEditing(false)} />}
    </section>
  );
}
