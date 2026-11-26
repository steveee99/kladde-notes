import { useState } from 'react';
import { vault } from '../data/vault';
import { Check, Folder } from '../lib/icons';
import { folderDisplayName, t, useLang } from '../lib/i18n';
import { isCoarsePointer } from '../lib/viewport';
import { Sheet } from './Dialogs';

/** Material 3 modal sheet for picking a destination folder when moving a note */
export function MoveNoteSheet({
  noteTitle,
  currentFolder,
  folders = vault.folders(),
  onMove,
  onClose,
}: {
  noteTitle: string;
  currentFolder: string;
  /** Folders to choose from: the own ones, or those of the note's group (#58) */
  folders?: string[];
  onMove: (folder: string) => void;
  onClose: () => void;
}) {
  const lang = useLang();
  const [filter, setFilter] = useState('');
  const allFolders = ['', ...folders];
  const q = filter.trim().toLowerCase();
  const visible = q
    ? allFolders.filter((f) => (f ? folderDisplayName(f, lang) : t('common.topLevelPlain')).toLowerCase().includes(q) || f.toLowerCase().includes(q))
    : allFolders;

  return (
    <Sheet title={t('note.moveTitle')} onClose={onClose}>
      <p className="mb-3 text-sm text-on-surface-variant">{t('note.moveDesc', { name: noteTitle })}</p>
      {allFolders.length > 7 && (
        <input
          className="input mb-3"
          placeholder={t('common.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus={!isCoarsePointer()}
        />
      )}
      <ul className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
        {visible.map((f) => {
          const active = f === currentFolder;
          return (
            <li key={f || '__root__'}>
              <button
                type="button"
                onClick={() => onMove(f)}
                className={`flex w-full items-center gap-3 rounded-full px-3.5 py-2.5 text-left text-sm transition-colors ${active ? 'bg-secondary-container text-on-secondary-container font-medium' : 'text-on-surface hover:bg-surface-container-high'}`}
              >
                <Folder size={16} className={active ? 'shrink-0' : 'shrink-0 text-primary'} />
                <span className="min-w-0 flex-1 truncate">{f ? folderDisplayName(f, lang) : t('common.topLevelPlain')}</span>
                {active && <Check size={16} className="shrink-0" />}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
