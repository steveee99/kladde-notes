/**
 * The widget editor of the cockpit: everything a widget is made of (source, parameters, filters, sort order, view,
 * fields, highlights, notifications), generated from the source's description in shared/cockpit.ts, with a live
 * preview. The widget is copied as JSON (for a colleague or a dashboard) or as a ```cockpit block (for a note), and
 * "From JSON" takes over a pasted widget or block.
 */
import { createPortal } from 'react-dom';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  blankWidget,
  cockpitBlockMarkdown,
  COCKPIT_FILTER_OPS,
  COCKPIT_SOURCE_KINDS,
  COCKPIT_SOURCES,
  COCKPIT_TONES,
  COCKPIT_VIEWS,
  normalizeWidget,
  readShared,
  shareWidget,
  type CockpitFilter,
  type CockpitFilterOp,
  type CockpitParamDef,
  type CockpitParamValue,
  type CockpitSourceKind,
  type CockpitTone,
  type CockpitWidget,
} from '@kladde/shared';
import { ClipboardPaste, Code, Copy, Plus, Trash2, X } from '../lib/icons';
import { copyText } from '../lib/clipboard';
import { tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { useModal } from '../lib/modal';
import { showToast } from '../lib/toast';
import { Dropdown } from './Dropdown';
import { Switch } from './Switch';
import { WidgetCard } from './CockpitWidget';

const OP_KEYS: Record<CockpitFilterOp, I18nKey> = {
  eq: 'cockpit.op.eq',
  ne: 'cockpit.op.ne',
  contains: 'cockpit.op.contains',
  not_contains: 'cockpit.op.notContains',
  matches: 'cockpit.op.matches',
  gt: 'cockpit.op.gt',
  lt: 'cockpit.op.lt',
  older_than: 'cockpit.op.olderThan',
  newer_than: 'cockpit.op.newerThan',
  empty: 'cockpit.op.empty',
  not_empty: 'cockpit.op.notEmpty',
};
const VIEW_KEYS: Record<CockpitWidget['view'], I18nKey> = { list: 'cockpit.view.list', table: 'cockpit.view.table', count: 'cockpit.view.count', board: 'cockpit.view.board' };
const TONE_KEYS: Record<CockpitTone, I18nKey> = { amber: 'cockpit.tone.amber', red: 'cockpit.tone.red', green: 'cockpit.tone.green', accent: 'cockpit.tone.accent', violet: 'cockpit.tone.violet' };
const noValue = (op: CockpitFilterOp) => op === 'empty' || op === 'not_empty';

function ParamField({ def, value, onChange, lang }: { def: CockpitParamDef; value: CockpitParamValue | undefined; onChange: (v: CockpitParamValue | undefined) => void; lang: Lang }) {
  const id = useId();
  const label = def.label[lang];
  if (def.type === 'bool')
    return (
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-body-m text-body">
          {label}
        </label>
        <Switch id={id} label={label} checked={value === true} onChange={(v) => onChange(v)} />
      </div>
    );
  return (
    <label className="block">
      <span className="mb-1 block text-label-m text-muted">{label}</span>
      {def.type === 'enum' ? (
        <Dropdown aria-label={label} value={String(value ?? def.default ?? '')} options={(def.options ?? []).map((o) => ({ value: o.value, label: o.label[lang] }))} onChange={(v) => onChange(v)} />
      ) : (
        <input
          className={`input ${def.key === 'jql' ? 'font-mono text-body-s' : ''}`}
          type={def.type === 'number' ? 'number' : 'text'}
          min={def.min}
          max={def.max}
          placeholder={def.placeholder}
          value={Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (def.type === 'number') onChange(raw === '' ? undefined : Number(raw));
            else if (def.type === 'list') onChange(raw.split(',').map((s) => s.trim()).filter(Boolean));
            else onChange(raw);
          }}
        />
      )}
      {def.hint && <span className="mt-1 block text-caption text-faint">{def.hint[lang]}</span>}
    </label>
  );
}

function FilterRow({ kind, filter, onChange, onRemove, lang, tone, onTone }: { kind: CockpitSourceKind; filter: CockpitFilter; onChange: (f: CockpitFilter) => void; onRemove: () => void; lang: Lang; tone?: CockpitTone; onTone?: (t: CockpitTone) => void }) {
  const fields = COCKPIT_SOURCES[kind].fields;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-cockpit-filter>
      <Dropdown aria-label={tl(lang, 'cockpit.field')} className="w-36" value={filter.field} options={fields.map((f) => ({ value: f.key, label: f.label[lang] }))} onChange={(field) => onChange({ ...filter, field })} />
      <Dropdown aria-label={tl(lang, 'cockpit.operator')} className="w-36" value={filter.op} options={COCKPIT_FILTER_OPS.map((op) => ({ value: op, label: tl(lang, OP_KEYS[op]) }))} onChange={(op) => onChange({ ...filter, op: op as CockpitFilterOp })} />
      {!noValue(filter.op) && (
        <input
          className="input min-w-0 flex-1 basis-24"
          aria-label={tl(lang, 'cockpit.value')}
          placeholder={filter.op === 'older_than' || filter.op === 'newer_than' ? '24h, 3d, 2w' : ''}
          value={filter.value}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
        />
      )}
      {onTone && <Dropdown aria-label={tl(lang, 'cockpit.tone')} className="w-28" value={tone ?? 'amber'} options={COCKPIT_TONES.map((t) => ({ value: t, label: tl(lang, TONE_KEYS[t]) }))} onChange={(t) => onTone(t as CockpitTone)} />}
      <button type="button" className="btn-icon h-8 w-8" onClick={onRemove} title={tl(lang, 'common.delete')} aria-label={tl(lang, 'common.delete')}>
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2.5 border-t border-line pt-3.5">
      <legend className="section-label float-left mb-1 w-full">{title}</legend>
      <div className="clear-both space-y-2.5">{children}</div>
    </fieldset>
  );
}

export interface WidgetEditorProps {
  /** null: a new widget */
  widget: CockpitWidget | null;
  vars: Record<string, string>;
  onSave: (w: CockpitWidget) => void;
  onClose: () => void;
}

export function WidgetEditor({ widget, vars, onSave, onClose }: WidgetEditorProps) {
  const lang = useLang();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModal(panel, onClose);
  const [w, setW] = useState<CockpitWidget>(() => widget ?? blankWidget('gitlab.mrs', lang));
  /** The "From JSON" field, null while closed */
  const [paste, setPaste] = useState<string | null>(null);
  const [preview, setPreview] = useState(w);
  const def = COCKPIT_SOURCES[w.source.kind];

  // The preview asks the server only after typing pauses
  useEffect(() => {
    const t = window.setTimeout(() => setPreview(w), 600);
    return () => window.clearTimeout(t);
  }, [w]);

  const update = (next: CockpitWidget) => setW(next);
  const pasted = useMemo(() => {
    const shared = paste?.trim() ? readShared(paste) : null;
    return shared?.kind === 'widgets' ? shared.widgets[0] : null;
  }, [paste]);
  const applyPaste = () => {
    if (!pasted) return;
    update({ ...pasted, id: w.id });
    setPreview({ ...pasted, id: w.id });
    setPaste(null);
  };
  const copy = (text: string, done: I18nKey) => void copyText(text).then((ok) => showToast(tl(lang, ok ? done : 'cockpit.copyFailed'), ok ? 'ok' : 'warn'));
  const patch = (p: Partial<CockpitWidget>) => update({ ...w, ...p });
  const setParam = (key: string, v: CockpitParamValue | undefined) => {
    const params = { ...w.source.params };
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete params[key];
    else params[key] = v;
    patch({ source: { ...w.source, params } });
  };
  const changeKind = (kind: CockpitSourceKind) => {
    const fresh = blankWidget(kind, lang);
    const oldDefault = COCKPIT_SOURCES[w.source.kind].label[lang];
    update({ ...fresh, id: w.id, title: w.title && w.title !== oldDefault ? w.title : fresh.title, notify: w.notify, width: w.width, limit: w.limit });
  };
  const fieldOptions = useMemo(() => def.fields.map((f) => ({ value: f.key, label: f.label[lang] })), [def, lang]);

  const firstField = def.fields[0].key;
  const save = () => {
    const clean = normalizeWidget(w);
    if (clean) onSave({ ...clean, id: w.id });
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[min(92vh,100%)] w-full max-w-[88rem] flex-col overflow-hidden rounded-t-xl border border-line2 bg-panel shadow-elevation-3 outline-none anim-sheet sm:rounded-xl"
        data-cockpit-editor
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-headline-s">
            {widget ? tl(lang, 'cockpit.editWidget') : tl(lang, 'cockpit.newWidget')}
          </h2>
          <button className="btn-icon shrink-0" onClick={onClose} title={tl(lang, 'common.close')} aria-label={tl(lang, 'common.close')}>
            <X size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <form
            className="min-w-0 flex-1 space-y-3.5 px-5 py-4 lg:overflow-y-auto"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="block">
              <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.title')}</span>
              <input className="input" value={w.title} maxLength={120} required onChange={(e) => patch({ title: e.target.value })} data-cockpit-title />
            </label>
            <div>
              <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.source')}</span>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={tl(lang, 'cockpit.source')}>
                {COCKPIT_SOURCE_KINDS.map((kind) => {
                  const s = COCKPIT_SOURCES[kind];
                  const on = kind === w.source.kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => changeKind(kind)}
                      className={`rounded-md border px-3 py-2 text-left state-layer ${on ? 'border-acc-line bg-acc-bg text-acc-hi' : 'border-line2 text-soft'}`}
                      data-cockpit-source={kind}
                    >
                      <span className="block text-label-l">{s.label[lang]}</span>
                      <span className="mt-0.5 block text-caption text-muted">{s.description[lang]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Section title={tl(lang, 'cockpit.params')}>
              {def.params.map((p) => (
                <ParamField key={p.key} def={p} value={w.source.params[p.key]} lang={lang} onChange={(v) => setParam(p.key, v)} />
              ))}
              <p className="text-caption text-faint">{tl(lang, 'cockpit.varsHint')}</p>
            </Section>

            <Section title={tl(lang, 'cockpit.filters')}>
              {w.filters.map((f, i) => (
                <FilterRow key={i} kind={w.source.kind} filter={f} lang={lang} onChange={(nf) => patch({ filters: w.filters.map((x, j) => (j === i ? nf : x)) })} onRemove={() => patch({ filters: w.filters.filter((_, j) => j !== i) })} />
              ))}
              <button type="button" className="btn-text" onClick={() => patch({ filters: [...w.filters, { field: firstField, op: 'contains', value: '' }] })} data-cockpit-add-filter>
                <Plus size={16} /> {tl(lang, 'cockpit.addFilter')}
              </button>
            </Section>

            <Section title={tl(lang, 'cockpit.display')}>
              <div className="segmented" role="group" aria-label={tl(lang, 'cockpit.display')}>
                {COCKPIT_VIEWS.map((v) => (
                  <button key={v} type="button" aria-pressed={w.view === v} onClick={() => patch({ view: v, ...(v === 'board' && !w.groupBy ? { groupBy: def.fields.find((f) => f.type === 'state')?.key } : {}) })}>
                    {tl(lang, VIEW_KEYS[v])}
                  </button>
                ))}
              </div>
              {w.view === 'board' && (
                <label className="block">
                  <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.groupBy')}</span>
                  <Dropdown aria-label={tl(lang, 'cockpit.groupBy')} value={w.groupBy ?? ''} options={fieldOptions} onChange={(groupBy) => patch({ groupBy })} />
                </label>
              )}
              {w.view !== 'count' && (
                <div>
                  <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.fields')}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {def.fields.map((f) => {
                      const on = w.fields.includes(f.key);
                      return (
                        <button key={f.key} type="button" className="chip" aria-pressed={on} onClick={() => patch({ fields: on ? w.fields.filter((x) => x !== f.key) : [...w.fields, f.key] })}>
                          {f.label[lang]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="grid gap-2.5 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.sortBy')}</span>
                  <Dropdown aria-label={tl(lang, 'cockpit.sortBy')} value={w.sort?.field ?? ''} options={[{ value: '', label: tl(lang, 'cockpit.sortNone') }, ...fieldOptions]} onChange={(field) => patch({ sort: field ? { field, dir: w.sort?.dir ?? 'desc' } : undefined })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.sortDir')}</span>
                  <Dropdown
                    aria-label={tl(lang, 'cockpit.sortDir')}
                    disabled={!w.sort}
                    value={w.sort?.dir ?? 'desc'}
                    options={[
                      { value: 'desc', label: tl(lang, 'cockpit.desc') },
                      { value: 'asc', label: tl(lang, 'cockpit.asc') },
                    ]}
                    onChange={(dir) => w.sort && patch({ sort: { ...w.sort, dir: dir === 'asc' ? 'asc' : 'desc' } })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-label-m text-muted">{tl(lang, 'cockpit.limit')}</span>
                  <input className="input" type="number" min={1} max={100} value={w.limit} onChange={(e) => patch({ limit: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
                </label>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-body-m text-body">{tl(lang, 'cockpit.wide')}</span>
                <Switch label={tl(lang, 'cockpit.wide')} checked={w.width === 2} onChange={(on) => patch({ width: on ? 2 : 1 })} />
              </div>
            </Section>

            <Section title={tl(lang, 'cockpit.highlight')}>
              {w.highlight.map((h, i) => (
                <FilterRow
                  key={i}
                  kind={w.source.kind}
                  filter={h.when}
                  lang={lang}
                  tone={h.tone}
                  onTone={(tone) => patch({ highlight: w.highlight.map((x, j) => (j === i ? { ...x, tone } : x)) })}
                  onChange={(when) => patch({ highlight: w.highlight.map((x, j) => (j === i ? { ...x, when } : x)) })}
                  onRemove={() => patch({ highlight: w.highlight.filter((_, j) => j !== i) })}
                />
              ))}
              <button type="button" className="btn-text" onClick={() => patch({ highlight: [...w.highlight, { when: { field: firstField, op: 'contains', value: '' }, tone: 'amber' }] })}>
                <Plus size={16} /> {tl(lang, 'cockpit.addHighlight')}
              </button>
            </Section>

            <Section title={tl(lang, 'cockpit.notifyTitle')}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-body-m text-body">{tl(lang, 'cockpit.notify')}</span>
                <Switch label={tl(lang, 'cockpit.notify')} checked={w.notify} onChange={(notify) => patch({ notify })} />
              </div>
              <p className="text-caption text-faint">{tl(lang, 'cockpit.notifyHint')}</p>
            </Section>
            <button type="submit" className="hidden" />
          </form>

          <div className="flex min-w-0 flex-1 flex-col gap-3 border-t border-line bg-bg px-5 py-4 lg:max-w-[48%] lg:overflow-y-auto lg:border-l lg:border-t-0">
            {paste !== null && (
              <div className="space-y-2 rounded-lg border border-line2 bg-panel p-3" data-cockpit-from-json>
                <p className="text-body-s text-muted">{tl(lang, 'cockpit.fromJsonHint')}</p>
                <textarea
                  className={`input min-h-48 w-full resize-y py-2 font-mono text-body-s ${paste.trim() && !pasted ? 'border-red' : ''}`}
                  spellCheck={false}
                  value={paste}
                  aria-label={tl(lang, 'cockpit.fromJson')}
                  aria-invalid={!!paste.trim() && !pasted}
                  autoFocus
                  onChange={(e) => setPaste(e.target.value)}
                  data-cockpit-paste-widget
                />
                {paste.trim() && !pasted && <p className="text-caption text-red">{tl(lang, 'cockpit.jsonInvalid')}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn-text" onClick={() => setPaste(null)}>
                    {tl(lang, 'common.cancel')}
                  </button>
                  <button type="button" className="btn-tonal" onClick={applyPaste} disabled={!pasted} data-cockpit-apply-json>
                    {tl(lang, 'cockpit.applyJson')}
                  </button>
                </div>
              </div>
            )}
            <span className="section-label">{tl(lang, 'cockpit.preview')}</span>
            <WidgetCard widget={preview} vars={vars} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <button type="button" className="btn-outlined" onClick={() => copy(shareWidget(w), 'cockpit.copied')} data-cockpit-copy-json>
            <Copy size={16} /> {tl(lang, 'cockpit.copyJson')}
          </button>
          <button type="button" className="btn-outlined" onClick={() => copy(cockpitBlockMarkdown(w), 'cockpit.copiedMarkdown')} data-cockpit-copy-markdown>
            <Code size={16} /> {tl(lang, 'cockpit.copyMarkdown')}
          </button>
          <button type="button" className="btn-outlined" onClick={() => setPaste((p) => (p === null ? '' : null))} aria-expanded={paste !== null} data-cockpit-from-json-toggle>
            <ClipboardPaste size={16} /> {tl(lang, 'cockpit.fromJson')}
          </button>
          <span className="text-caption text-faint">{tl(lang, 'cockpit.noTokens')}</span>
          <span className="flex-1" />
          <button type="button" className="btn-text" onClick={onClose}>
            {tl(lang, 'common.cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={!w.title.trim()} data-cockpit-save>
            {tl(lang, 'common.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
