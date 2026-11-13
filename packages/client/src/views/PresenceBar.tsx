import { useEffect } from 'react';
import { presence, usePresence } from '../lib/presence';
import { t } from '../lib/i18n';
import { Avatar } from './Avatar';

/** At most this many avatars; the rest is shown as "+N" */
const MAX_SHOWN = 4;

/** Announces the open note; unannounces when it closes */
export function useAnnouncePresence(noteId: string | null) {
  useEffect(() => {
    presence.setNote(noteId);
    return () => presence.setNote(null);
  }, [noteId]);
}

/**
 * Profile pictures of everybody who has the note open, shown as soon as it is open in more than this one
 * place (another person, or the user's own other device/tab).
 */
export function PresenceBar({ noteId }: { noteId: string }) {
  const viewers = usePresence(noteId);
  const clients = viewers.reduce((n, v) => n + v.clients, 0);
  if (clients < 2) return null;
  const label = (v: (typeof viewers)[number]) => (v.clients > 1 ? t('presence.devices', { name: v.username, n: v.clients }) : v.username);
  const title = t('presence.title', { names: viewers.map(label).join(', ') });
  const shown = viewers.slice(0, MAX_SHOWN);
  const more = viewers.length - shown.length;
  return (
    <div className="no-print flex shrink-0 items-center gap-1.5 anim-fade-in" title={title} aria-label={title} role="status">
      <span className="flex items-center gap-1 text-label-m text-ok">
        <span className="h-2 w-2 animate-pulse rounded-full bg-ok" aria-hidden="true" />
        <span className="hidden sm:inline">{t('presence.live')}</span>
      </span>
      <span className="flex -space-x-1.5">
        {shown.map((v) => (
          <span key={v.userId} className="relative rounded-full ring-2 ring-surface-container-low">
            <Avatar name={v.username} avatarUrl={v.avatarUrl} size="sm" />
            {v.clients > 1 && (
              <span className="absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-on-primary">
                {v.clients}
              </span>
            )}
          </span>
        ))}
        {more > 0 && (
          <span className="relative inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-container-high text-[10px] font-medium text-on-surface-variant ring-2 ring-surface-container-low">
            +{more}
          </span>
        )}
      </span>
    </div>
  );
}
