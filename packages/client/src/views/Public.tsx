import { useEffect, useState } from 'react';
import { PublicNote as PublicNoteData, splitPath } from '@kladde/shared';
import { api } from '../lib/api';
import { Editor } from '../editor/Editor';

/** Read-only view of a note shared by link (no account needed) */
export function PublicNote({ token }: { token: string }) {
  const [note, setNote] = useState<PublicNoteData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<PublicNoteData>(`/public/${encodeURIComponent(token)}`).then(setNote, (e) => setError(e.message));
  }, [token]);
  if (error) return <div className="p-8 text-center text-muted">{error}</div>;
  if (!note) return <div className="p-8 text-center text-faint">Lade …</div>;
  return (
    <div className="content-container mx-auto px-4 py-8 sm:px-8 anim-fade-up">
      <div className="mb-6 flex items-center gap-2 text-sm text-faint">
        <img src="/icons/icon.svg" className="h-6 w-6" alt="" /> Geteilt von {note.owner} · {new Date(note.updatedAt).toLocaleDateString('de-DE')}
      </div>
      <h1 className="mb-4 text-3xl font-bold tracking-tight">{splitPath(note.path).name}</h1>
      <Editor docKey={token} value={note.content} readOnly />
    </div>
  );
}
