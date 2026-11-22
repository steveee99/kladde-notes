import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { vault } from './vault';

/** Backlinks and unlinked mentions of a note from the server (online mode: the device holds only some texts) */
export interface OnlineLinks {
  backlinks: string[];
  mentions: string[];
}

/**
 * The server's backlinks and mentions of `id`, asked again after every sync (others may have linked it meanwhile);
 * null outside online mode and until the first answer
 */
export function useOnlineBacklinks(id: string, enabled: boolean): OnlineLinks | null {
  const [links, setLinks] = useState<{ id: string; value: OnlineLinks } | null>(null);
  const stamp = vault.lastSync;
  useEffect(() => {
    if (!enabled || !vault.online) return;
    let live = true;
    api<OnlineLinks>(`/online/backlinks/${encodeURIComponent(id)}`)
      .then((value) => live && setLinks({ id, value }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, enabled, stamp]);
  return links?.id === id ? links.value : null;
}
