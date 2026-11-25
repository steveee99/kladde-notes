import { propertiesAt, setCell, typeValues, type NoteType, type PanelPosition } from '@kladde/shared';
import { noteTypeChoices } from '../data/noteTypes';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate } from '../lib/router';
import { t, useLang } from '../lib/i18n';
import { Check, SlidersHorizontal } from '../lib/icons';
import { Sheet } from './Dialogs';
import { LinkTargets, PropertyField } from './PropertyField';

/** The modelled properties of a note with a custom type (shared/noteTypes.ts) that show at one position; `noteId` null: read-only without a vault (public link) */
export function NoteTypePanel({ type, where, content, noteId, canEdit, fill }: { type: NoteType; where: PanelPosition; content: string; noteId: string | null; canEdit: boolean; fill?: (text: string) => string }) {
  useLang();
  const props = propertiesAt(type, where);
  if (!props.length) return null;
  const values = typeValues(type, content);
  const editable = canEdit && noteId !== null;
  return (
    <section className={`no-print rounded-lg border border-line bg-panel p-3 anim-fade-in ${where === 'bottom' ? 'mb-12' : 'mb-3'}`} data-note-type-panel={where} aria-label={`${t('types.label')}: ${type.name}`}>
      <div className="mb-2 flex items-center gap-1.5 text-caption text-muted">
        <SlidersHorizontal size={14} /> {type.name}
      </div>
      <div className={`grid gap-x-4 gap-y-2 ${where === 'right' ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
        {props.map((p) => (
          <div key={p.name} className="min-w-0" data-note-type-property={p.name}>
            <div className="mb-0.5 truncate text-caption text-muted" title={p.name}>
              {p.name}
            </div>
            <div className="min-w-0 text-body-m">
              <PropertyField
                prop={p}
                value={values[p.name]}
                label={p.name}
                canEdit={editable}
                fill={fill}
                onSave={(v) => {
                  const note = noteId === null ? undefined : vault.get(noteId);
                  if (note) void vault.update(note.id, { content: setCell(note.content, p, v) });
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {editable && props.some((p) => p.type === 'link') && <LinkTargets />}
    </section>
  );
}

/** Says that a note's `type: custom:<name>` is not modelled here; its frontmatter shows as usual */
export function UnknownNoteType({ name }: { name: string }) {
  return (
    <p className="no-print mb-3 text-caption text-muted" data-note-type-unknown>
      {t('types.unknown', { name })}{' '}
      <button type="button" className="underline hover:text-text" onClick={() => navigate('/settings/types')}>
        {t('types.title')}
      </button>
    </p>
  );
}

/** Chooses the custom type of a note */
export function NoteTypeSheet({ note, current, onClose }: { note: LocalNote; current: NoteType | null; onClose: () => void }) {
  useLang();
  const pick = (name: string | null) => {
    void vault.setNoteType(note.id, name);
    onClose();
  };
  const types = noteTypeChoices(note);
  const row = (name: string | null, label: string) => (
    <li key={label}>
      <button type="button" aria-pressed={name === (current?.name ?? null)} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-body-m hover:bg-raised" onClick={() => pick(name)}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {name === (current?.name ?? null) && <Check size={16} className="shrink-0 text-acc" />}
      </button>
    </li>
  );
  return (
    <Sheet title={t('types.label')} onClose={onClose}>
      <ul className="mb-3">
        {row(null, t('types.none'))}
        {types.map((ty) => row(ty.name, ty.name))}
      </ul>
      <button
        type="button"
        className="btn-text"
        onClick={() => {
          onClose();
          navigate('/settings/types');
        }}
      >
        {t('types.manage')}
      </button>
    </Sheet>
  );
}
