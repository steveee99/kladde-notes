import { useEffect, useRef, useState } from 'react';
import { splitPath, type NotificationItem } from '@kladde/shared';
import { AtSign, Bell, Check, CheckCheck, MessageSquare, NotificationsActive, Speed, UserPlus } from '../lib/icons';
import { useVault, vault } from '../data/vault';
import { locale, tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { useModal } from '../lib/modal';
import { subscribeDevice, useDevicePush } from '../lib/pushDevice';
import { navigate } from '../lib/router';
import { Avatar } from './Avatar';
import { localize } from '@kladde/plugin-api/client';
import { pluginById } from '../plugins/registry';
import { NavBadge } from './NavBadge';

/*
 * Notifications (#69, #68): mentions, comments, replies and being added to a group. The bell in the top bar opens
 * a panel with the newest ones (more on request), `/notifications` shows the same list as a page. A click opens the
 * passage, the comment thread or the group and marks the notification read; each one can also be marked read alone.
 */

export function notificationUrl(n: NotificationItem): string {
  // Plugins lead only into their own pages or to a note (the server builds `href` that way)
  if (n.kind === 'plugin') return n.href && /^\/(p|n)\/[\w-]/.test(n.href) ? n.href : n.plugin ? `/p/${n.plugin}` : '/';
  if (n.kind === 'cockpit') return `/cockpit/${encodeURIComponent(n.noteId)}`;
  if (n.groupId) return `/groups/${encodeURIComponent(n.groupId)}`;
  return `/n/${n.noteId}${n.threadId ? `?thread=${encodeURIComponent(n.threadId)}` : n.line !== undefined ? `?line=${n.line + 1}` : ''}`;
}

const HEADLINES: Record<NotificationItem['kind'], I18nKey> = {
  mention: 'notices.mention',
  comment: 'notices.comment',
  reply: 'notices.reply',
  group_added: 'notices.groupAdded',
  cockpit: 'notices.cockpit',
  plugin: 'notices.comment',
};

function headline(n: NotificationItem, lang: Lang): string {
  if (n.kind === 'plugin') return n.title ? localize(n.title, lang) : n.path;
  return tl(lang, HEADLINES[n.kind] ?? 'notices.comment', { actor: n.actor ?? tl(lang, 'activity.someone') });
}

/** What follows the headline: the note's name or the group's */
function subject(n: NotificationItem, lang: Lang): string {
  if (n.kind === 'plugin') {
    const entry = n.plugin ? pluginById(n.plugin) : undefined;
    return entry ? localize(entry.plugin.name, lang) : n.path;
  }
  return n.kind === 'group_added' || n.kind === 'cockpit' ? n.path : splitPath(n.path).name;
}

/** The passage, the comment or, for a group, the role */
function detail(n: NotificationItem, lang: Lang): string {
  if (n.kind === 'group_added') return n.text === 'owner' || n.text === 'editor' || n.text === 'reader' ? tl(lang, 'notices.groupRole', { role: tl(lang, `groups.role.${n.text}`) }) : '';
  return n.text;
}

function KindIcon({ kind }: { kind: NotificationItem['kind'] }) {
  const Icon = kind === 'mention' ? AtSign : kind === 'group_added' ? UserPlus : kind === 'cockpit' ? Speed : kind === 'plugin' ? NotificationsActive : MessageSquare;
  return <Icon size={10} />;
}

/** A plugin's icon where people have their avatar */
function PluginBadge({ id }: { id?: string }) {
  const entry = id ? pluginById(id) : undefined;
  const Icon = entry?.plugin.icon;
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-raised text-soft" aria-hidden>
      {Icon ? <Icon size={14} /> : <NotificationsActive size={14} />}
    </span>
  );
}

/** One notification: opens it on click, a check marks it read without opening it */
function NotificationRow({ n, compact, onOpen }: { n: NotificationItem; compact?: boolean; onOpen?: () => void }) {
  const lang = useLang();
  const fmt = new Intl.DateTimeFormat(locale(lang), compact ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' });
  const text = detail(n, lang);
  return (
    <li className={`group/notice relative flex items-start rounded-md transition-colors hover:bg-raised ${n.read ? '' : 'bg-acc-bg/40'}`}>
      <button
        type="button"
        data-notification={n.kind}
        data-read={n.read ? 'true' : 'false'}
        className={`flex min-w-0 flex-1 items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-acc ${compact ? 'px-2.5 py-2' : 'px-3 py-3'}`}
        onClick={() => {
          if (!n.read) void vault.readNotifications({ ids: [n.id] });
          onOpen?.();
          navigate(notificationUrl(n));
        }}
      >
        <span className="relative mt-0.5 shrink-0">
          {n.kind === 'plugin' ? <PluginBadge id={n.plugin} /> : <Avatar name={n.actor ?? '?'} avatarUrl={n.actorAvatar} size="sm" />}
          <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-acc text-on-acc">
            <KindIcon kind={n.kind} />
          </span>
        </span>
        <span className="min-w-0 flex-1 pr-7">
          <span className="block text-body-m">
            <span className={n.read ? 'text-soft' : 'font-medium text-strong'}>{headline(n, lang)}</span> <span className="text-muted">· {subject(n, lang)}</span>
          </span>
          {text && <span className={`mt-0.5 block break-words text-body-s text-muted ${compact ? 'line-clamp-1' : 'line-clamp-2'}`}>{text}</span>}
          <time className="mt-0.5 block font-mono text-caption text-faint" dateTime={new Date(n.at).toISOString()}>
            {fmt.format(new Date(n.at))}
          </time>
        </span>
      </button>
      {!n.read && (
        <button
          type="button"
          className="btn-icon absolute right-1.5 top-1.5 h-7 w-7 text-acc"
          title={tl(lang, 'notices.markRead')}
          aria-label={tl(lang, 'notices.markReadOf', { what: headline(n, lang) })}
          data-mark-read
          onClick={() => void vault.readNotifications({ ids: [n.id] })}
        >
          <span aria-hidden className="h-2 w-2 rounded-full bg-acc group-hover/notice:hidden group-focus-within/notice:hidden" />
          <Check size={16} className="hidden group-hover/notice:block group-focus-within/notice:block" />
        </button>
      )}
    </li>
  );
}

/** The loaded notifications with "load more"; `compact` in the panel */
export function NotificationList({ compact, onOpen }: { compact?: boolean; onOpen?: () => void }) {
  useVault();
  const lang = useLang();
  const [loading, setLoading] = useState(false);
  const items = vault.notifications;
  if (items.length === 0)
    return (
      <div className={`flex flex-col items-center gap-2 text-center text-body-m text-muted ${compact ? 'px-4 py-8' : 'card p-8'}`}>
        <Bell size={28} />
        {tl(lang, 'notices.empty')}
      </div>
    );
  return (
    <div>
      <ul className={compact ? 'space-y-px p-1.5' : 'card space-y-px p-1'} data-notification-list>
        {items.map((n) => (
          <NotificationRow key={n.id} n={n} compact={compact} onOpen={onOpen} />
        ))}
      </ul>
      {vault.notificationsNext && (
        <div className={`flex justify-center ${compact ? 'pb-2' : 'pt-3'}`}>
          <button
            type="button"
            className="btn-text"
            disabled={loading}
            data-notifications-more
            onClick={() => {
              setLoading(true);
              void vault.loadMoreNotifications().finally(() => setLoading(false));
            }}
          >
            {loading ? '…' : tl(lang, 'notices.more')}
          </button>
        </div>
      )}
    </div>
  );
}

/** "Notify me on this device": while this device gets no push notifications and could */
export function DevicePushPrompt({ compact }: { compact?: boolean }) {
  const lang = useLang();
  const { state, refresh } = useDevicePush();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!vault.features().notifications.enabled || (state !== 'off' && state !== 'denied')) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border-line text-body-s ${compact ? 'border-b px-3.5 py-2.5' : 'card px-4 py-3'}`} data-push-prompt={state}>
      <NotificationsActive size={18} className="shrink-0 text-acc" />
      <span className="min-w-0 flex-1 basis-40 text-soft">{state === 'denied' ? tl(lang, 'notices.pushBlocked') : tl(lang, 'notices.pushHint')}</span>
      {state === 'off' && (
        <button
          type="button"
          className="btn-tonal shrink-0"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            subscribeDevice(lang)
              .then(refresh, (e: Error) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {tl(lang, 'notices.pushEnable')}
        </button>
      )}
      {error && (
        <span role="alert" className="basis-full text-red">
          {error}
        </span>
      )}
    </div>
  );
}

/** The bell in the top bar with the unread count; opens the panel */
export function NotificationsButton() {
  useVault();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const unread = vault.unreadNotifications;
  const label = unread ? `${tl(lang, 'notices.title')} · ${tl(lang, 'notices.badge', { n: unread })}` : tl(lang, 'notices.title');
  return (
    <div className="relative">
      <button
        type="button"
        className="btn-icon relative h-9 w-9"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        aria-label={label}
        data-notifications-button
      >
        <Bell size={20} />
        {unread > 0 && <NavBadge count={unread} tone="warn" className="pointer-events-none absolute -right-1 -top-1 scale-90" />}
      </button>
      {open && <NotificationsPopover onClose={() => setOpen(false)} />}
    </div>
  );
}

function NotificationsPopover({ onClose }: { onClose: () => void }) {
  useVault();
  const lang = useLang();
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  // Newest first every time it opens
  useEffect(() => void vault.loadNotifications(), []);
  // A click outside closes it (the bell toggles it itself)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || (target instanceof Element && target.closest('[data-notifications-button]'))) return;
      onClose();
    };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={tl(lang, 'notices.title')}
      tabIndex={-1}
      data-notifications-panel
      className="fixed inset-x-2 top-[calc(3.5rem+env(safe-area-inset-top))] z-50 flex max-h-[min(640px,calc(100dvh-5rem))] flex-col overflow-hidden rounded-lg border border-line2 bg-panel shadow-elevation-3 outline-none anim-fade-up nav:absolute nav:inset-x-auto nav:right-0 nav:top-11 nav:w-[400px]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line py-2 pl-3.5 pr-2">
        <h2 className="panel-title min-w-0 flex-1 truncate">{tl(lang, 'notices.title')}</h2>
        {vault.unreadNotifications > 0 && (
          <button type="button" className="btn-text h-8 px-2 text-body-s" onClick={() => void vault.readNotifications()} data-read-all>
            <CheckCheck size={16} /> {tl(lang, 'notices.readAll')}
          </button>
        )}
      </div>
      <DevicePushPrompt compact />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <NotificationList compact onOpen={onClose} />
      </div>
      <a
        href="/notifications"
        className="shrink-0 border-t border-line px-3.5 py-2.5 text-center text-body-m text-acc-hi outline-none hover:bg-raised focus-visible:bg-raised"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onClose();
          navigate('/notifications');
        }}
      >
        {tl(lang, 'notices.showAll')}
      </a>
    </div>
  );
}
