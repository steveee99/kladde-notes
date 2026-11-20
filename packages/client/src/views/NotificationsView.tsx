/**
 * Notifications (#69, #68): mentions in notes and comments on them, newest first. A click opens the passage (or
 * the comment thread) and marks the notification read.
 */
import { useEffect } from 'react';
import { AtSign, Bell, CheckCheck, MessageSquare } from '../lib/icons';
import { splitPath, type NotificationItem } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { locale, tl, useLang, type Lang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Avatar } from './Avatar';
import { PageBody, PageHeader } from './PageHeader';

const urlOf = (n: NotificationItem) => `/n/${n.noteId}${n.threadId ? `?thread=${encodeURIComponent(n.threadId)}` : n.line !== undefined ? `?line=${n.line + 1}` : ''}`;

function headline(n: NotificationItem, lang: Lang): string {
  const actor = n.actor ?? tl(lang, 'activity.someone');
  return tl(lang, n.kind === 'mention' ? 'notices.mention' : n.kind === 'reply' ? 'notices.reply' : 'notices.comment', { actor });
}

export function NotificationsView() {
  useVault();
  const lang = useLang();
  const loc = locale(lang);
  useEffect(() => void vault.loadNotifications(), []);
  const items = vault.notifications;
  const fmt = new Intl.DateTimeFormat(loc, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div data-notifications>
      <PageHeader
        title={tl(lang, 'notices.title')}
        subtitle={tl(lang, 'notices.unread', { n: vault.unreadNotifications })}
        actions={
          vault.unreadNotifications > 0 && (
            <button className="btn-tonal" onClick={() => void vault.readNotifications()}>
              <CheckCheck size={16} /> {tl(lang, 'notices.readAll')}
            </button>
          )
        }
      />
      <PageBody className="max-w-[960px] !mx-0">
      {items.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-8 text-center text-sm text-on-surface-variant anim-fade-up">
          <Bell size={28} />
          {tl(lang, 'notices.empty')}
        </div>
      ) : (
        <ul className="card divide-y divide-outline-variant/60 p-1 anim-fade-up">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                data-notification={n.kind}
                className={`flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-surface-container-high/60 ${n.read ? '' : 'bg-secondary-container/40'}`}
                onClick={() => {
                  void vault.readNotifications({ ids: [n.id] });
                  navigate(urlOf(n));
                }}
              >
                <span className="relative shrink-0">
                  <Avatar name={n.actor ?? '?'} avatarUrl={n.actorAvatar} size="sm" />
                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-on-primary">
                    {n.kind === 'mention' ? <AtSign size={10} /> : <MessageSquare size={10} />}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">
                    <span className={n.read ? '' : 'font-medium'}>{headline(n, lang)}</span>{' '}
                    <span className="text-on-surface-variant">· {splitPath(n.path).name}</span>
                  </span>
                  {n.text && <span className="mt-0.5 line-clamp-2 block break-words text-sm text-on-surface-variant">{n.text}</span>}
                  <time className="mt-0.5 block text-xs text-on-surface-variant" dateTime={new Date(n.at).toISOString()}>
                    {fmt.format(new Date(n.at))}
                  </time>
                </span>
                {!n.read && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label={tl(lang, 'activity.new')} role="img" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      </PageBody>
    </div>
  );
}
