/**
 * "Variables…" of a folder or group: the folder's own variables (add, edit, delete) and the ones it inherits from the
 * folders above, each with its origin and a button that overrides it here. Read-only for group readers.
 */
import { useEffect, useRef, useState } from 'react';
import { cleanVariableValue, hasVariables, isVariableName, variableKey, variablePlaceholder, type VariableEntry } from '@kladde/shared';
import { canEditVariables, saveVariable, useVariables, type VariableSpace } from '../data/variables';
import { useVault, vault } from '../data/vault';
import { folderDisplayName, t, useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { isCoarsePointer } from '../lib/viewport';
import { Plus, Trash2 } from '../lib/icons';
import { Sheet } from './Dialogs';
import { variableOptions } from '../editor/variables';

const fail = (err: unknown) => alert(err instanceof Error ? err.message : String(err));

export function VariablesDialog({ space, folder, onClose }: { space: VariableSpace; folder: string; onClose: () => void }) {
  useVault();
  useReadOnly();
  const lang = useLang();
  const scope = useVariables({ space, folder });
  const canEdit = canEditVariables(space);
  const group = space.startsWith('group:') ? vault.group(space.slice('group:'.length)) : undefined;
  const label = (f: string) => (f ? (group ? f : folderDisplayName(f, lang)) : (group?.name ?? t('common.topLevelPlain')));
  const entries = scope.list();
  const own = entries.filter((e) => e.folder === folder);
  const inherited = entries.filter((e) => e.folder !== folder);
  /** The variable whose value field gets the focus (just overridden) */
  const [focus, setFocus] = useState<string | null>(null);
  /** What a value with placeholders in it comes out as */
  const result = (e: VariableEntry) => (hasVariables(e.value) ? scope.resolve(e.name) : null);

  const override = async (e: VariableEntry) => {
    try {
      await saveVariable(space, folder, e.name, e.value);
      setFocus(variableKey(e.name));
    } catch (err) {
      fail(err);
    }
  };

  return (
    <Sheet title={t('vars.title', { folder: folder ? label(folder).split('/').pop()! : label('') })} onClose={onClose}>
      <div data-variables-dialog>
        <p className="mb-4 text-body-m text-muted">{t('vars.intro')}</p>
        <section className="mb-5" aria-labelledby="vars-own">
          <h3 id="vars-own" className="mb-1.5 text-title-s text-text">
            {t('vars.own')}
          </h3>
          {own.length === 0 && <p className="mb-2 text-body-m text-muted">{t('vars.ownEmpty')}</p>}
          {own.length > 0 && (
            <ul className="card mb-2 divide-y divide-line">
              {own.map((e) => {
                const r = result(e);
                return (
                  <li key={variableKey(e.name)} className="px-3 py-2" data-variable={e.name}>
                    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                      <span className="min-w-0 truncate font-mono text-body-s text-text sm:w-36 sm:shrink-0" title={variablePlaceholder(e.name)}>
                        {e.name}
                      </span>
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        {canEdit ? (
                          <ValueField
                            name={e.name}
                            value={e.value}
                            focus={focus === variableKey(e.name)}
                            onFocused={() => setFocus(null)}
                            onSave={(value) => void saveVariable(space, folder, e.name, value).catch(fail)}
                          />
                        ) : (
                          <span className="min-w-0 flex-1 break-words text-body-m">{e.value}</span>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            className="btn-icon h-9 w-9 shrink-0 hover:text-error"
                            title={e.outer ? t('vars.removeOverride') : t('common.delete')}
                            aria-label={`${e.outer ? t('vars.removeOverride') : t('common.delete')}: ${e.name}`}
                            onClick={() => void saveVariable(space, folder, e.name, null).catch(fail)}
                          >
                            <Trash2 size={18} />
                          </button>
                        )}
                      </div>
                    </div>
                    {(r || e.outer) && (
                      <div className="mt-1 break-words text-caption text-muted">
                        {r && <span className={r.status === 'ok' ? '' : 'text-error'}>= {r.status === 'cycle' ? t('vars.cycle', { name: e.name }) : r.status === 'limit' ? t('vars.limit', { name: e.name }) : r.text}</span>}
                        {r && e.outer && ' · '}
                        {e.outer && t('vars.overrides', { value: e.outer.value, folder: label(e.outer.folder) })}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit && <AddRow taken={(name) => own.some((e) => variableKey(e.name) === variableKey(name))} onAdd={(name, value) => saveVariable(space, folder, name, value)} />}
          {!canEdit && <p className="text-caption text-muted">{t('vars.readOnly')}</p>}
        </section>
        {inherited.length > 0 && (
          <section className="mb-2" aria-labelledby="vars-inherited">
            <h3 id="vars-inherited" className="mb-1.5 text-title-s text-text">
              {t('vars.inherited')}
            </h3>
            <ul className="card divide-y divide-line">
              {inherited.map((e) => {
                const r = scope.resolve(e.name);
                return (
                  <li key={variableKey(e.name)} className="flex items-center gap-3 px-3 py-2" data-variable-inherited={e.name}>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-body-s text-text">{e.name}</span>
                        <span className={`min-w-0 break-words text-body-m ${r.status === 'ok' ? 'text-soft' : 'text-error'}`}>{r.text}</span>
                      </div>
                      <div className="truncate text-caption text-muted">{t('vars.from', { folder: label(e.folder) })}</div>
                    </div>
                    {canEdit && (
                      <button type="button" className="btn-outlined shrink-0" aria-label={`${t('vars.override')}: ${e.name}`} onClick={() => void override(e)}>
                        {t('vars.override')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <details className="mt-4" data-variables-builtin>
          <summary className="cursor-pointer text-title-s text-text">{t('vars.builtinTitle')}</summary>
          <p className="my-1.5 text-body-s text-muted">{t('vars.builtinIntro')}</p>
          <ul className="card divide-y divide-line">
            {variableOptions(scope, lang)
              .filter((o) => o.builtin)
              .map((o) => (
                <li key={o.name} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-body-s text-text">{variablePlaceholder(o.name)}</span>
                  <span className="shrink-0 font-mono text-body-s text-muted">{o.value}</span>
                </li>
              ))}
          </ul>
        </details>
      </div>
    </Sheet>
  );
}

/** A value that is saved on Enter and when the field is left */
function ValueField({ name, value, focus, onFocused, onSave }: { name: string; value: string; focus: boolean; onFocused: () => void; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus();
    ref.current?.select();
    onFocused();
  }, [focus, onFocused]);
  // Closing the dialog with Escape unmounts the field without a blur
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };
  const save = () => {
    const l = latest.current;
    if (cleanVariableValue(l.draft) !== l.value) l.onSave(l.draft);
  };
  useEffect(() => () => save(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      ref={ref}
      className="input min-w-0 flex-1"
      aria-label={t('vars.valueOf', { name })}
      value={draft}
      maxLength={2000}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && save()}
    />
  );
}

function AddRow({ taken, onAdd }: { taken: (name: string) => boolean; onAdd: (name: string, value: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const clean = name.trim();
  const problem = clean && !isVariableName(clean) ? t('vars.badName') : clean && taken(clean) ? t('vars.taken') : '';
  const add = async () => {
    if (!clean || problem) return;
    try {
      await onAdd(clean, value);
      setName('');
      setValue('');
      nameRef.current?.focus();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          ref={nameRef}
          autoFocus={!isCoarsePointer()}
          className="input font-mono sm:!w-40 sm:shrink-0"
          placeholder={t('vars.name')}
          aria-label={t('vars.name')}
          aria-invalid={!!problem}
          autoCapitalize="off"
          spellCheck={false}
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <input className="input min-w-0 flex-1" placeholder={t('vars.value')} aria-label={t('vars.value')} value={value} maxLength={2000} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn-tonal shrink-0" disabled={!clean || !!problem}>
            <Plus size={18} /> {t('vars.add')}
          </button>
        </div>
      </div>
      {problem && (
        <p className="mt-1.5 text-caption text-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
