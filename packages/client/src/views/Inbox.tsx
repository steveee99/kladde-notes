import { toastDeleted } from '../lib/undoDelete';
import { useState } from 'react';
import { Trash2 } from '../lib/icons';
import { INBOX_FOLDER, excerpt, isHiddenPath, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate } from '../lib/router';
import { ChipSelect } from './ChipSelect';
import { folderDisplayName, locale, t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';
import { PageBody, PageHeader } from './PageHeader';

function InboxItem({ note }: { note: LocalNote }) {
  const lang = useLang();
  const [leaving, setLeaving] = useState(false);
  const name = splitPath(note.path).name;
  const move = (target: string) => {
    if (!target) return;
    const folder = target === '__root__' ? '' : target;
    setLeaving(true);
    void vault.moveNote(note.id, folder).catch(() => setLeaving(false));
  };
  const remove = () => {
    if (!confirm(t('inbox.deleteConfirm', { name }))) return;
    setLeaving(true);
    void vault
      .remove(note.id)
      .then(() => toastDeleted([note.id], t('undo.noteDeleted', { name })))
      .catch(() => setLeaving(false));
  };
  return (
    <li className={`flex flex-col gap-2 px-3.5 py-3 transition-all duration-300 hover:bg-raised/50 sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${leaving ? 'translate-x-8 opacity-0' : ''}`}>
      <button className="block min-w-0 flex-1 text-left" onClick={() => navigate(`/n/${note.id}`)}>
        <div className="break-words text-title-s text-strong">{name}</div>
        {excerpt(note.content) && <div className="mt-0.5 line-clamp-2 break-words text-body-m text-soft">{excerpt(note.content, 240)}</div>}
        <div className="mt-1 font-mono text-[11px] text-muted">{new Date(note.createdAt).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' })}</div>
      </button>
      <div className="edit-only ml-auto flex max-w-full shrink-0 items-center justify-end gap-2">
        <ChipSelect
          className="max-w-[11rem] min-w-0 text-xs"
          value=""
          aria-label={t('inbox.folderAria')}
          onClick={(e) => e.stopPropagation()}
          onChange={(val) => move(val)}
        >
          <option value="">{t('inbox.folderPlaceholder')}</option>
          <option value="__root__">{t('common.topLevel')}</option>
          {vault
            .folders()
            .filter((f) => f !== INBOX_FOLDER)
            .map((f) => (
              <option key={f} value={f}>
                {folderDisplayName(f, lang)}
              </option>
            ))}
        </ChipSelect>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            remove();
          }}
          title={t('inbox.deleteTitle')}
          aria-label={t('inbox.deleteTitle')}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-red-bg hover:text-red"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </li>
  );
}

/** Inbox: captured thoughts waiting to be organized into folders */
export function InboxView() {
  useVault();
  useLang();
  const inboxZero = useInboxZero();
  const items = vault
    .list()
    .filter((n) => n.access === 'owner' && splitPath(n.path).folder === INBOX_FOLDER && !isHiddenPath(n.path))
    .sort((a, b) => a.createdAt - b.createdAt);

  const subtitle = inboxZero
    ? items.length === 0
      ? t('inbox.subtitleZero')
      : items.length === 1
        ? t('inbox.subtitleSingle')
        : t('inbox.subtitlePlural', { n: items.length })
    : items.length === 0
      ? t('inbox.emptyTitle')
      : t('inbox.subtitleNeutral');

  return (
    <div>
      <PageHeader title={t('inbox.title')} subtitle={subtitle} />
      <PageBody>
      {items.length === 0 ? (
        <div className="empty-sheet anim-fade-in">
          <p className="empty-title">{inboxZero ? t('inbox.emptyTitleZero') : t('inbox.emptyTitle')}</p>
          <p className="mt-1">{t('inbox.emptyBody')}</p>
        </div>
      ) : (
        <ul className="card stagger divide-y divide-line overflow-hidden">
          {items.map((n) => (
            <InboxItem key={n.id} note={n} />
          ))}
        </ul>
      )}
      </PageBody>
    </div>
  );
}
