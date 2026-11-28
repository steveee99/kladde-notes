import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { PublicNote as PublicNoteData, extractMeta, fillReleasePlaceholders } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import type { EmbedResolver } from '../editor/embedContext';
import { Avatar } from './Avatar';
import { ExportMenu } from './ExportMenu';
import { releaseRenderOptions } from '../editor/releases';
import { Slideshow } from '../lib/icons';
import { guestNoteKind, PublicNoteContent, publicScope } from './PublicNoteContent';

const Presentation = lazy(() => import('./Presentation'));

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
      return e ? { id: e.token, title: e.title, content: e.content, canWrite: false, href: `/s/${e.token}`, variables: publicScope(e.variables) } : null;
    };
  }, [note]);
  if (error) return <div className="p-8 text-center text-on-surface-variant">{error}</div>;
  if (!note) return <div className="p-8 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>;
  const title = extractMeta(note.path, note.content).title;
  const { drawing, slides, remote } = guestNoteKind(note.content);
  const variables = publicScope(note.variables);
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
        {!remote && <ExportMenu title={title} slides={slides} content={exported} variables={variables} />}
      </div>
      <h1 className="font-display mb-4 break-words text-[34px] leading-tight">{title}</h1>
      <PublicNoteContent docKey={token} note={note} variables={variables} resolveEmbed={resolveEmbed} />
      {presenting && (
        <Suspense fallback={null}>
          <Presentation docKey={token} title={title} content={note.content} resolveEmbed={resolveEmbed} releases={releases} variables={variables} onClose={() => setPresenting(false)} />
        </Suspense>
      )}
    </div>
  );
}
