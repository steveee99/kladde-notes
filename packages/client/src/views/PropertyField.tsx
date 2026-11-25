import { formatDbValue, isHiddenPath, linkTarget, type DbProperty, type DbValue } from '@kladde/shared';
import { vault } from '../data/vault';
import { navigate } from '../lib/router';
import { t } from '../lib/i18n';
import { Dropdown, type DropdownOption } from './Dropdown';

const NONE: DropdownOption = { value: '', label: '—' };
const asOptions = (values: string[]): DropdownOption[] => values.map((v) => ({ value: v, label: v }));

/** Suggestions for note link fields; pages with one render it once */
export function LinkTargets() {
  return (
    <datalist id="db-link-targets">
      {vault
        .list()
        .filter((n) => !isHiddenPath(n.path))
        .map((n) => (
          <option key={n.id} value={n.path.replace(/^.*\//, '').replace(/\.md$/, '')} />
        ))}
    </datalist>
  );
}

/** The field of one typed property (database cells, panels of custom note types); `fill` fills variables in where the text cannot be edited */
export function PropertyField({
  prop,
  value,
  label,
  canEdit,
  onSave: save,
  fill,
}: {
  prop: DbProperty;
  value: DbValue;
  label: string;
  canEdit: boolean;
  onSave: (v: DbValue) => void;
  fill?: (text: string) => string;
}) {
  if (prop.type === 'checkbox') {
    return <input type="checkbox" className="cm-checkbox" aria-label={label} checked={value === true} disabled={!canEdit} onChange={(e) => save(e.target.checked)} />;
  }
  if (prop.type === 'select') {
    if (!canEdit) return <span>{formatDbValue(prop.type, value)}</span>;
    const current = typeof value === 'string' ? value : '';
    const opts = current && !prop.options.includes(current) ? [...prop.options, current] : prop.options;
    return <Dropdown className="!min-h-0 !py-1" aria-label={label} value={current} options={[NONE, ...asOptions(opts)]} onChange={(v) => save(v || null)} />;
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
        {canEdit && free.length > 0 && <Dropdown variant="chip" placeholder="+" aria-label={label} value="" options={asOptions(free)} onChange={(v) => save([...chosen, v])} />}
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
    return <span className="break-words">{fill ? fill(shown) : shown}</span>;
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
