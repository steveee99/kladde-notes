import { useState } from 'react';
import { CUSTOM_TYPE_PREFIX, PANEL_POSITIONS, PROPERTY_TYPES, isNoteTypeName, isTypePropertyName, noteTypeKey, type NoteType, type PanelPosition, type TypeProperty } from '@kladde/shared';
import type { LocalNote } from '../data/db';
import { editableTypeSpaces, saveNoteType } from '../data/noteTypes';
import { useVault, vault } from '../data/vault';
import { t, useLang, type I18nKey } from '../lib/i18n';
import { ArrowDown, ArrowUp, Pencil, Plus, SlidersHorizontal, Trash2 } from '../lib/icons';
import { useReadOnly } from '../lib/readOnly';
import { Dropdown } from './Dropdown';
import { SettingsPage } from './SettingsPage';

const positionLabel = (p: PanelPosition) => t(`types.position.${p}` as I18nKey);

interface Editing {
  space: string;
  /** null: a new type */
  note: LocalNote | null;
  type: NoteType;
}

/** Settings page that models custom note types (`type: custom:<name>`) */
export function NoteTypesView() {
  useVault();
  useLang();
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState<Editing | null>(null);
  const spaces = editableTypeSpaces();

  return (
    <SettingsPage title={t('types.title')}>
      <p className="text-body-m text-muted">{t('types.intro')}</p>
      {editing ? (
        <TypeEditor key={editing.note?.id ?? 'new'} {...editing} onDone={() => setEditing(null)} />
      ) : (
        spaces.map(({ space, label }) => {
          const defs = vault.noteTypeDefinitions(space);
          return (
            <section key={space} className="space-y-2" data-type-space={space}>
              {spaces.length > 1 && <h2 className="section-label px-1">{label}</h2>}
              <div className="card divide-y divide-line">
                {!defs.length && <p className="p-4 text-body-m text-muted">{t('types.empty')}</p>}
                {defs.map(({ note, type }) => (
                  <div key={note.id} className="flex items-center gap-3 p-4" data-note-type={type.name}>
                    <SlidersHorizontal size={18} className="shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-title-s text-strong">{type.name}</div>
                      <div className="truncate font-mono text-caption text-muted">
                        type: {CUSTOM_TYPE_PREFIX}
                        {type.name}
                      </div>
                    </div>
                    <button type="button" className="btn-icon h-8 w-8 shrink-0" disabled={readOnly} title={t('common.edit')} aria-label={`${t('common.edit')}: ${type.name}`} onClick={() => setEditing({ space, note, type })}>
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="btn-icon h-8 w-8 shrink-0"
                      disabled={readOnly}
                      title={t('common.delete')}
                      aria-label={`${t('common.delete')}: ${type.name}`}
                      onClick={() => confirm(t('types.deleteConfirm', { name: type.name })) && void vault.remove(note.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn-outlined"
                disabled={readOnly}
                aria-label={spaces.length > 1 ? `${t('types.new')}: ${label}` : undefined}
                onClick={() => setEditing({ space, note: null, type: { name: '', aliases: [], showFrontmatter: false, position: 'top', properties: [] } })}
              >
                <Plus size={16} /> {t('types.new')}
              </button>
            </section>
          );
        })
      )}
    </SettingsPage>
  );
}

interface DraftProperty extends TypeProperty {
  /** Name before editing; a changed one moves the values in the notes */
  orig: string;
  key: number;
}

let nextKey = 0;

function TypeEditor({ space, note, type, onDone }: Editing & { onDone: () => void }) {
  const [name, setName] = useState(type.name);
  const [showFrontmatter, setShowFrontmatter] = useState(type.showFrontmatter);
  const [position, setPosition] = useState<PanelPosition>(type.position);
  const [props, setProps] = useState<DraftProperty[]>(() => type.properties.map((p) => ({ ...p, orig: p.name, key: nextKey++ })));
  const [busy, setBusy] = useState(false);
  const patch = (i: number, p: Partial<DraftProperty>) => setProps((l) => l.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, by: number) =>
    setProps((l) => {
      const next = [...l];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });
  // Online mode: the device lacks the texts of most notes, so it could not move their values
  const lockNames = vault.online;

  const clean = name.trim();
  const named = props.filter((p) => p.name.trim());
  const keys = named.map((p) => p.name.trim().toLowerCase());
  const taken = vault.noteTypeDefinitions(space).some((d) => d.note.id !== note?.id && noteTypeKey(d.type.name) === noteTypeKey(clean));
  const problem =
    clean && !isNoteTypeName(clean)
      ? t('types.badName')
      : clean && taken
        ? t('types.taken')
        : named.some((p) => !isTypePropertyName(p.name))
          ? t('types.reserved')
          : new Set(keys).size !== keys.length
            ? t('types.duplicateProperty')
            : '';

  const save = async () => {
    if (!clean || problem || busy) return;
    setBusy(true);
    try {
      const renames = new Map(named.filter((p) => p.orig && p.orig !== p.name.trim()).map((p) => [p.orig, p.name.trim()]));
      // Notes that name the type as it was called before keep it
      const aliases = [...type.aliases, ...(type.name && noteTypeKey(type.name) !== noteTypeKey(clean) ? [type.name] : [])].filter((a) => noteTypeKey(a) !== noteTypeKey(clean));
      await saveNoteType(
        space,
        note,
        {
          name: clean,
          aliases,
          showFrontmatter,
          position,
          properties: named.map(({ orig: _orig, key: _key, ...p }) => ({ ...p, name: p.name.trim(), default: p.type === 'link' ? '' : p.default.trim(), options: p.options.map((o) => o.trim()).filter(Boolean) })),
        },
        renames
      );
      onDone();
    } catch (err) {
      alert((err as Error).message);
      setBusy(false);
    }
  };

  const positions = PANEL_POSITIONS.map((p) => ({ value: p as string, label: positionLabel(p) }));
  return (
    <form
      className="card space-y-4 p-5 anim-fade-up"
      data-type-editor
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-title-m text-strong">{note ? t('types.editTitle') : t('types.new')}</h2>
      <label className="block">
        <span className="mb-1 block text-caption text-muted">{t('types.name')}</span>
        <input className="input" autoFocus={!note} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        <span className="mt-1 block font-mono text-caption text-muted">
          type: {CUSTOM_TYPE_PREFIX}
          {clean || '…'}
        </span>
      </label>
      <label className="flex items-center gap-2 text-body-m">
        <input type="checkbox" className="cm-checkbox" checked={showFrontmatter} onChange={(e) => setShowFrontmatter(e.target.checked)} /> {t('types.showFrontmatter')}
      </label>
      <div className="flex flex-col gap-1.5 text-body-m sm:flex-row sm:items-center sm:gap-2">
        <span>{t('types.position')}</span>
        <Dropdown className="sm:w-auto sm:min-w-[12rem]" aria-label={t('types.position')} value={position} options={positions} onChange={(v) => setPosition(v as PanelPosition)} />
      </div>

      <div>
        <h3 className="mb-2 text-title-s">{t('db.properties')}</h3>
        <ul className="mb-2 space-y-3">
          {props.map((p, i) => (
            <li key={p.key} className="rounded-lg border border-line2 p-2" data-type-property={i}>
              <div className="flex gap-1.5">
                <input
                  className="input min-w-0 flex-1"
                  aria-label={t('db.propName')}
                  placeholder={t('db.propName')}
                  value={p.name}
                  readOnly={lockNames && !!p.orig}
                  title={lockNames && p.orig ? t('types.lockedName') : undefined}
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                <button type="button" className="btn-icon shrink-0" disabled={i === 0} title={t('types.up')} aria-label={t('types.up')} onClick={() => move(i, -1)}>
                  <ArrowUp size={16} />
                </button>
                <button type="button" className="btn-icon shrink-0" disabled={i === props.length - 1} title={t('types.down')} aria-label={t('types.down')} onClick={() => move(i, 1)}>
                  <ArrowDown size={16} />
                </button>
                <button type="button" className="btn-icon shrink-0" title={t('common.delete')} aria-label={`${t('common.delete')}: ${p.name}`} onClick={() => setProps((l) => l.filter((_, j) => j !== i))}>
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Dropdown aria-label={t('db.propType')} value={p.type} options={PROPERTY_TYPES.map((ty) => ({ value: ty, label: t(`db.type.${ty}` as I18nKey) }))} onChange={(v) => patch(i, { type: v as TypeProperty['type'] })} />
                <Dropdown
                  aria-label={t('types.propPosition')}
                  value={p.position}
                  options={[{ value: '', label: t('types.position.inherit', { position: positionLabel(position) }) }, ...positions]}
                  onChange={(v) => patch(i, { position: v as TypeProperty['position'] })}
                />
              </div>
              {(p.type === 'select' || p.type === 'multiselect') && (
                <input className="input mt-2" aria-label={t('db.options')} placeholder={t('db.options')} value={p.options.join(', ')} onChange={(e) => patch(i, { options: e.target.value.split(',').map((s) => s.trimStart()) })} />
              )}
              {p.type !== 'link' && <input className="input mt-2" aria-label={t('db.default')} placeholder={t('types.default')} value={p.default} onChange={(e) => patch(i, { default: e.target.value })} />}
            </li>
          ))}
        </ul>
        <button type="button" className="btn-text" onClick={() => setProps((l) => [...l, { name: '', type: 'text', options: [], default: '', position: '', orig: '', key: nextKey++ }])}>
          <Plus size={16} /> {t('db.addProperty')}
        </button>
      </div>

      {problem && (
        <p className="text-caption text-error" role="alert">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn-primary px-5" disabled={!clean || !!problem || busy}>
          {t('common.save')}
        </button>
        <button type="button" className="btn-ghost px-4" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
