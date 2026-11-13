import { lazy, Suspense, useEffect, useState } from 'react';
import { PublicNote as PublicNoteData, excalidrawSceneOf, extractMeta } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { Editor } from '../editor/Editor';
import { Avatar } from './Avatar';
import { ExportMenu } from './ExportMenu';

const ExcalidrawPanel = lazy(() => import('./ExcalidrawPanel'));

/** Read-only view of a note shared by link (no account needed) */
export function PublicNote({ token }: { token: string }) {
  const lang = useLang();
  const [note, setNote] = useState<PublicNoteData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<PublicNoteData>(`/public/${encodeURIComponent(token)}`).then(setNote, (e) => setError(e.message));
  }, [token]);
  if (error) return <div className="p-8 text-center text-on-surface-variant">{error}</div>;
  if (!note) return <div className="p-8 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>;
  const title = extractMeta(note.path, note.content).title;
  // Drawing notes show their canvas (view only) instead of the scene JSON
  const drawing = excalidrawSceneOf(note.content);
  return (
    // No transform animation around a drawing: it would trap Excalidraw's fixed layers and full screen in this box
    <div className={`content-container px-4 py-8 sm:px-8 ${drawing !== null ? 'anim-fade-in' : 'anim-fade-up'}`}>
      <div className="no-print mb-6 flex items-center gap-2.5 text-sm text-on-surface-variant">
        <Avatar name={note.owner} avatarUrl={note.ownerAvatar} size="md" />
        <span className="min-w-0 flex-1">{tl(lang, 'public.sharedBy', { owner: note.owner, date: new Date(note.updatedAt).toLocaleDateString(locale(lang)) })}</span>
        <ExportMenu title={title} content={note.content} />
      </div>
      <h1 className="mb-4 break-words text-headline-l">{title}</h1>
      {drawing !== null ? (
        <Suspense fallback={<div className="p-8 text-center text-on-surface-variant">{tl(lang, 'common.loading')}</div>}>
          <ExcalidrawPanel scene={drawing} readOnly lang={lang} />
        </Suspense>
      ) : (
        <Editor docKey={token} value={note.content} readOnly />
      )}
    </div>
  );
}
