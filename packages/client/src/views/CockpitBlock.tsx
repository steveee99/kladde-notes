/**
 * A ```cockpit block in a note (development cockpit): the widget its text describes (JSON or the short YAML form of
 * `parseCockpitBlock`), with the note's variables and its properties as `{{this.<key>}}`. Mounted by the editor, which
 * also opens `CockpitBlockEditor` for /cockpit and for a block's settings.
 */
import { useMemo } from 'react';
import { blankWidget, cockpitBlockMarkdown, parseCockpitBlock, type VariableScope } from '@kladde/shared';
import { noteVars } from '../data/cockpit';
import { vault } from '../data/vault';
import { navigate } from '../lib/router';
import { tl, useLang } from '../lib/i18n';
import { SlidersHorizontal } from '../lib/icons';
import { WidgetCard } from './CockpitWidget';
import { WidgetEditor } from './CockpitWidgetEditor';

/** The note's variables (resolved) and properties, as the widget's parameters read them */
function useNoteVars(doc: string, scope: VariableScope | null) {
  return useMemo(
    () => noteVars(doc, scope ? { list: () => scope.list().map((v) => ({ name: v.name, value: scope.resolve(v.name).status === 'ok' ? scope.resolve(v.name).text : '' })) } : null),
    [doc, scope]
  );
}

export function CockpitBlock({ src, doc, scope, onConfigure }: { src: string; doc: string; scope: VariableScope | null; onConfigure?: () => void }) {
  const lang = useLang();
  const widget = useMemo(() => parseCockpitBlock(src), [src]);
  const vars = useNoteVars(doc, scope);
  if (!vault.features().cockpit.enabled || vault.standalone) return <div className="cm-block-widget wz-query-error">{tl(lang, 'cockpit.blockOff')}</div>;
  if (!widget) return <div className="cm-block-widget wz-query-error">{tl(lang, 'cockpit.blockInvalid')}</div>;
  const configure = onConfigure && (
    <button type="button" className="btn-icon h-7 w-7" onClick={onConfigure} title={tl(lang, 'cockpit.configure')} aria-label={tl(lang, 'cockpit.configureOf', { title: widget.title })} data-cockpit-configure>
      <SlidersHorizontal size={15} />
    </button>
  );
  return <WidgetCard widget={widget} vars={vars} embedded actions={configure} onConnect={() => navigate('/cockpit')} />;
}

/** The cockpit's widget editor for a block of a note; `onSave` gets the new ```cockpit block */
export function CockpitBlockEditor({ src, doc, scope, onSave, onClose }: { src: string | null; doc: string; scope: VariableScope | null; onSave: (block: string) => void; onClose: () => void }) {
  const lang = useLang();
  const vars = useNoteVars(doc, scope);
  const widget = useMemo(() => (src === null ? null : parseCockpitBlock(src) ?? blankWidget('gitlab.mrs', lang)), [src, lang]);
  return <WidgetEditor widget={widget} vars={vars} onSave={(w) => onSave(cockpitBlockMarkdown(w))} onClose={onClose} />;
}
