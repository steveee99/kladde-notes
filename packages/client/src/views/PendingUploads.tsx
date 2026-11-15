import { CloudOff, RefreshCw, Trash2 } from '../lib/icons';
import { PENDING_SCHEME, uploads, usePendingUploads } from '../data/uploads';
import { useVault, vault } from '../data/vault';
import { tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';

const formatBytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Attachments added offline that wait for a connection (#28): count and size, the note each one is in,
 * retry after a refusal, discard. Nothing is shown while the queue is empty.
 */
export function PendingUploadsCard() {
  useVault();
  const lang = useLang();
  const items = usePendingUploads();
  if (!items.length) return null;
  const total = items.reduce((s, i) => s + i.size, 0);
  const noteOf = (id: string) => vault.list().find((n) => n.content.includes(`${PENDING_SCHEME}${id}`));
  return (
    <section className="card space-y-2 p-4" aria-labelledby="pending-uploads-title">
      <h2 id="pending-uploads-title" className="flex items-center gap-2 text-title-m">
        <CloudOff size={20} className="text-warn" />
        {tl(lang, items.length === 1 ? 'uploads.titleSingle' : 'uploads.title', { n: items.length, size: formatBytes(total) })}
      </h2>
      <p className="text-body-m text-on-surface-variant">{tl(lang, navigator.onLine ? 'uploads.descOnline' : 'uploads.descOffline')}</p>
      <ul className="divide-y divide-outline-variant/60">
        {items.map((item) => {
          const note = noteOf(item.id);
          return (
            <li key={item.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body-l">{item.name}</div>
                <div className="truncate text-body-s text-on-surface-variant">
                  {formatBytes(item.size)} ·{' '}
                  {note ? (
                    <button className="hover:text-primary hover:underline" onClick={() => navigate(`/n/${note.id}`)}>
                      {vault.links().notes.get(note.id)?.title ?? note.path}
                    </button>
                  ) : (
                    tl(lang, 'uploads.noNote')
                  )}
                </div>
                {item.error && <div className="text-body-s text-error">{item.error}</div>}
              </div>
              {item.error && (
                <button className="btn-icon h-9 w-9 shrink-0" title={tl(lang, 'uploads.retry')} aria-label={tl(lang, 'uploads.retry')} onClick={() => void uploads.retry(item.id)}>
                  <RefreshCw size={18} />
                </button>
              )}
              <button
                className="btn-icon h-9 w-9 shrink-0"
                title={tl(lang, 'uploads.discard')}
                aria-label={tl(lang, 'uploads.discard')}
                onClick={() => confirm(tl(lang, 'uploads.discardConfirm', { name: item.name })) && void uploads.discard(item.id)}
              >
                <Trash2 size={18} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
