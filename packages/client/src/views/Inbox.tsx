import { useState } from 'react';
import { Inbox as InboxIcon, Trash2 } from '../lib/icons';
import { INBOX_FOLDER, excerpt, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate } from '../lib/router';
import { ChipSelect } from './ChipSelect';
import { folderDisplayName, locale, t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';

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
    void vault.remove(note.id).catch(() => setLeaving(false));
  };
  return (
    <li className={`card flex flex-col gap-3 p-4 transition-all duration-300 sm:flex-row sm:items-center sm:justify-between ${leaving ? 'translate-x-8 opacity-0' : ''}`}>
      <button className="block min-w-0 flex-1 text-left" onClick={() => navigate(`/n/${note.id}`)}>
        <div className="break-words font-medium">{name}</div>
        {excerpt(note.content) && <div className="mt-1 line-clamp-3 break-words text-sm text-on-surface-variant">{excerpt(note.content, 240)}</div>}
        <div className="mt-1 text-xs text-on-surface-variant">{new Date(note.createdAt).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' })}</div>
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
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-error/15 hover:text-error"
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
    .filter((n) => n.access === 'owner' && splitPath(n.path).folder === INBOX_FOLDER)
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
    <div className="content-container mx-auto px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 anim-fade-up">
        <h1 className="flex items-center gap-2 text-headline-m">
          <InboxIcon size={24} className="text-primary" /> {t('inbox.title')}
        </h1>
        <p className="mt-1 text-on-surface-variant">{subtitle}</p>
      </div>
      {items.length === 0 ? (
        <div className="card p-8 text-center anim-fade-in">
          <p className="font-medium text-on-surface">{inboxZero ? t('inbox.emptyTitleZero') : t('inbox.emptyTitle')}</p>
          <p className="mt-1 text-sm text-on-surface-variant">{t('inbox.emptyBody')}</p>
        </div>
      ) : (
        <ul className="stagger space-y-3">
          {items.map((n) => (
            <InboxItem key={n.id} note={n} />
          ))}
        </ul>
      )}
    </div>
  );
}
