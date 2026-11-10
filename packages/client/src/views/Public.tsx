import { useEffect, useState } from 'react';
import { PublicNote as PublicNoteData, splitPath } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { Editor } from '../editor/Editor';
import { ExportMenu } from './ExportMenu';

/** Read-only view of a note shared by link (no account needed) */
export function PublicNote({ token }: { token: string }) {
  const lang = useLang();
  const [note, setNote] = useState<PublicNoteData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<PublicNoteData>(`/public/${encodeURIComponent(token)}`).then(setNote, (e) => setError(e.message));
  }, [token]);
  if (error) return <div className="p-8 text-center text-muted">{error}</div>;
  if (!note) return <div className="p-8 text-center text-faint">{tl(lang, 'common.loading')}</div>;
  const title = splitPath(note.path).name;
  return (
    <div className="content-container px-4 py-8 sm:px-8 anim-fade-up">
      <div className="no-print mb-6 flex items-center gap-2 text-sm text-faint">
        <img src="/icons/icon.svg" className="h-6 w-6" alt="" />
        <span className="flex-1">{tl(lang, 'public.sharedBy', { owner: note.owner, date: new Date(note.updatedAt).toLocaleDateString(locale(lang)) })}</span>
        <ExportMenu title={title} content={note.content} />
      </div>
      <h1 className="mb-4 text-3xl font-bold tracking-tight">{title}</h1>
      <Editor docKey={token} value={note.content} readOnly />
    </div>
  );
}
