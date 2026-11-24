import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { EMPTY_VARIABLE_SCOPE, PublicNote as PublicNoteData, type VariableScope, excalidrawSceneOf, extractMeta, fillReleasePlaceholders, fixedVariableScope, isPresentationNote } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { Editor } from '../editor/Editor';
import type { EmbedResolver } from '../editor/embedContext';
import { Avatar } from './Avatar';
import { ExportMenu } from './ExportMenu';
import { releaseRenderOptions } from '../editor/releases';
import { Slideshow } from '../lib/icons';

const ExcalidrawPanel = lazy(() => import('./ExcalidrawPanel'));
const Presentation = lazy(() => import('./Presentation'));

/** Only the values the note uses come with a public link; the others show as unknown */
const publicScopes = new WeakMap<object, VariableScope>();
function scopeOf(values: Record<string, string> | undefined): VariableScope {
  if (!values) return EMPTY_VARIABLE_SCOPE;
  let scope = publicScopes.get(values);
  if (!scope) publicScopes.set(values, (scope = fixedVariableScope(values)));
  return scope;
}

/** Read-only view of a note shared by link (no account needed) */
export function PublicNote({ token }: { token: string }) {
  const lang = useLang();
  const [note, setNote] = useState<PublicNoteData | null>(null);
  const [error, setError] = useState('');
  const [presenting, setPresenting] = useState(false);
  useEffect(() => {
    api<PublicNoteData>(`/public/${encodeURIComponent(token)}`).then(setNote, (e) => setError(e.message));
  }, [token]);
  // Embeds only show what the server sent along: the owner's notes that have a public link themselves
  const resolveEmbed = useMemo<EmbedResolver>(() => {
    const byTarget = new Map((note?.embeds ?? []).map((e) => [e.target, e]));
    return (target) => {
      const e = byTarget.get(target.trim().replace(/\.md$/i, '').toLowerCase());
      return e ? { id: e.token, title: e.title, content: e.content, canWrite: false, href: `/s/${e.token}`, variables: scopeOf(e.variables) } : null;
    };
  }, [note]);
  if (error) return <div className="p-8 text-center text-on-surface-variant">{error}</div>;
  if (!note) return <div className="p-8 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>;
  const title = extractMeta(note.path, note.content).title;
  // Drawing notes show their canvas (view only) instead of the scene JSON
  const drawing = excalidrawSceneOf(note.content);
  // Notes the owner set up as a presentation (frontmatter `presentation`, #87) can be presented from the link
  const slides = drawing === null && isPresentationNote(note.content);
  const variables = scopeOf(note.variables);
  const exported = note.versioning ? fillReleasePlaceholders(note.content, note.releases ?? [], releaseRenderOptions(lang)) : note.content;
  const releases = note.versioning ? (note.releases ?? []) : null;
  return (
    // No transform animation around a drawing: it would trap Excalidraw's fixed layers and full screen in this box
    <div className={`content-container px-4 py-8 sm:px-8 ${drawing !== null ? 'anim-fade-in' : 'anim-fade-up'}`}>
      <div className="no-print mb-6 flex items-center gap-2.5 text-sm text-on-surface-variant">
        <Avatar name={note.owner} avatarUrl={note.ownerAvatar} size="md" />
        <span className="min-w-0 flex-1">{tl(lang, 'public.sharedBy', { owner: note.owner, date: new Date(note.updatedAt).toLocaleDateString(locale(lang)) })}</span>
        {note.showsRelease && <span className="chip shrink-0 tabular-nums">v{note.showsRelease}</span>}
        {slides && (
          <button type="button" className="btn-tonal h-9 shrink-0 px-4" data-present onClick={() => setPresenting(true)}>
            <Slideshow size={18} />
            {tl(lang, 'present.start')}
          </button>
        )}
        <ExportMenu title={title} slides={slides} content={exported} variables={variables} />
      </div>
      <h1 className="font-display mb-4 break-words text-[34px] leading-tight">{title}</h1>
      {drawing !== null ? (
        <Suspense fallback={<div className="p-8 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>}>
          <ExcalidrawPanel scene={drawing} readOnly lang={lang} />
        </Suspense>
      ) : (
        <Editor docKey={token} value={note.content} readOnly resolveEmbed={resolveEmbed} releases={releases} variables={variables} slideBreaks={slides ? tl(lang, 'present.slideBreak') : ''} />
      )}
      {presenting && (
        <Suspense fallback={null}>
          <Presentation docKey={token} title={title} content={note.content} resolveEmbed={resolveEmbed} releases={releases} variables={variables} onClose={() => setPresenting(false)} />
        </Suspense>
      )}
    </div>
  );
}
