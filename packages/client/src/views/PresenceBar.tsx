import { useEffect } from 'react';
import { presence, useCursors, usePresence } from '../lib/presence';
import { t } from '../lib/i18n';
import { Avatar } from './Avatar';
import { jumpToCursor } from '../editor/remoteCursors';


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
  const cursors = useCursors(noteId);
  const clients = viewers.reduce((n, v) => n + v.clients, 0);
  if (clients < 2) return null;
  const nameOf = (v: (typeof viewers)[number]) => v.displayName || v.username;
  const label = (v: (typeof viewers)[number]) => (v.clients > 1 ? t('presence.devices', { name: nameOf(v), n: v.clients }) : nameOf(v));
  const title = t('presence.title', { names: viewers.map(label).join(', ') });
  const shown = viewers.slice(0, MAX_SHOWN);
  const more = viewers.length - shown.length;
  return (
    <div className="no-print flex shrink-0 items-center gap-1.5 anim-fade-in" title={title} aria-label={title} role="group">
      <span className="flex items-center gap-1 text-label-m text-ok">
        <span className="h-2 w-2 animate-pulse rounded-full bg-ok" aria-hidden="true" />
        <span className="hidden sm:inline">{t('presence.live')}</span>
      </span>
      <span className="flex -space-x-1.5">
        {shown.map((v) => (
          <button
            key={v.userId}
            type="button"
            className="relative rounded-full ring-2 ring-surface-container-low outline-none hover:z-10 hover:ring-acc focus-visible:z-10 focus-visible:ring-acc disabled:cursor-default disabled:hover:ring-surface-container-low"
            title={t('presence.jump', { name: label(v) })}
            aria-label={t('presence.jump', { name: label(v) })}
            disabled={!cursors.some((c) => c.userId === v.userId)}
            onClick={() => jumpToCursor(noteId, v.userId)}
            data-presence-user={v.username}
          >
            <Avatar name={nameOf(v)} avatarUrl={v.avatarUrl} size="sm" />
            {v.clients > 1 && (
              <span className="absolute -bottom-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-on-primary">
                {v.clients}
              </span>
            )}
          </button>
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
