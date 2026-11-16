import { Facet } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';
import type { NoteReleaseInfo, ReleaseRenderOptions } from '@kladde/shared';
import { locale, tl, type Lang } from '../lib/i18n';

/*
 * Release versioning (#53) in the editor: with versioning on, the live preview shows the release placeholders
 * ({{version}}, ```versions, {{version_history}}, {{#versions}}…{{/versions}}) filled in; the text keeps them.
 */

export interface ReleaseContext {
  /** Releases of the note, newest first */
  releases: NoteReleaseInfo[];
}

/** null: versioning is off for this note, the placeholders stay as they are written */
export const releaseFacet = Facet.define<ReleaseContext | null, ReleaseContext | null>({ combine: (v) => v.find((x) => x !== null) ?? null });

/** Labels and date format of the user's language */
export function releaseRenderOptions(lang: Lang): ReleaseRenderOptions {
  return {
    formatDate: (ms) => new Date(ms).toLocaleDateString(locale(lang), { dateStyle: 'medium' }),
    labels: {
      version: tl(lang, 'release.colVersion'),
      releasedAt: tl(lang, 'release.colDate'),
      releasedBy: tl(lang, 'release.colBy'),
      changes: tl(lang, 'release.colChanges'),
      none: '—',
    },
  };
}

/** A filled-in `{{version}}` (or another field) in the text */
export class ReleaseFieldWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: ReleaseFieldWidget) {
    return o.text === this.text;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-release-field';
    s.textContent = this.text;
    return s;
  }
}
