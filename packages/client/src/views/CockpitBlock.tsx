/**
 * A ```cockpit block in a note (development cockpit): the widget its text describes (JSON or the short YAML form of
 * `parseCockpitBlock`), with the note's variables and its properties as `{{this.<key>}}`. Mounted by the editor.
 */
import { useMemo } from 'react';
import { parseCockpitBlock, type VariableScope } from '@kladde/shared';
import { noteVars } from '../data/cockpit';
import { vault } from '../data/vault';
import { navigate } from '../lib/router';
import { tl, useLang } from '../lib/i18n';
import { WidgetCard } from './CockpitWidget';

export function CockpitBlock({ src, doc, scope }: { src: string; doc: string; scope: VariableScope | null }) {
  const lang = useLang();
  const widget = useMemo(() => parseCockpitBlock(src), [src]);
  const vars = useMemo(() => noteVars(doc, scope ? { list: () => scope.list().map((v) => ({ name: v.name, value: scope.resolve(v.name).status === 'ok' ? scope.resolve(v.name).text : '' })) } : null), [doc, scope]);
  if (!vault.features().cockpit.enabled || vault.standalone) return <div className="cm-block-widget wz-query-error">{tl(lang, 'cockpit.blockOff')}</div>;
  if (!widget) return <div className="cm-block-widget wz-query-error">{tl(lang, 'cockpit.blockInvalid')}</div>;
  return <WidgetCard widget={widget} vars={vars} embedded onConnect={() => navigate('/cockpit')} />;
}
