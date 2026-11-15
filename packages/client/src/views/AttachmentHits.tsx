import { useEffect, useState } from 'react';
import type { AttachmentSearchHit, AttachmentSearchResponse } from '@kladde/shared';
import { FileText, Image } from '../lib/icons';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { vault } from '../data/vault';

/**
 * Full-text search in the text of PDFs and images (#37). The text lives on the server (extracted and
 * encrypted there), so this only works online; the note search itself stays offline.
 */
export function useAttachmentSearch(query: string): AttachmentSearchHit[] {
  const [hits, setHits] = useState<AttachmentSearchHit[]>([]);
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2 || (!vault.standalone && !navigator.onLine)) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<AttachmentSearchResponse>(`/attachments/search?q=${encodeURIComponent(q)}`).then(
        (res) => !cancelled && setHits(res.hits ?? []),
        () => !cancelled && setHits([])
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);
  return hits;
}

/** Matches in attachments; each leads to the note(s) that embed the file */
export function AttachmentHitList({ hits, onOpen, compact = false }: { hits: AttachmentSearchHit[]; onOpen: (noteId: string) => void; compact?: boolean }) {
  if (!hits.length) return null;
  return (
    <section aria-label={t('search.inAttachments')} className={compact ? 'mt-3' : 'mt-8'}>
      <h2 className={compact ? 'mb-1.5 px-2 text-xs font-medium text-on-surface-variant' : 'mb-3 text-title-s text-on-surface-variant'}>
        {t('search.inAttachments')} ({hits.length})
      </h2>
      <ul className={compact ? 'space-y-1' : 'card divide-y divide-outline-variant/60 p-1'}>
        {hits.map((hit) => {
          const Icon = hit.mime === 'application/pdf' ? FileText : Image;
          const first = hit.notes[0];
          return (
            <li key={hit.fileId}>
              <div
                role="button"
                tabIndex={0}
                data-attachment-hit={hit.fileId}
                onClick={() => first && onOpen(first.id)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && first) {
                    e.preventDefault();
                    onOpen(first.id);
                  }
                }}
                className={`w-full cursor-pointer text-left transition-colors hover:bg-surface-container-high ${compact ? 'rounded-2xl px-3 py-2' : 'rounded-xl px-3 py-2.5'}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Icon size={compact ? 14 : 16} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{hit.name}</span>
                  <span className="shrink-0 text-[11px] text-on-surface-variant">
                    {hit.mime === 'application/pdf' ? t('search.attachmentPage', { n: hit.page }) : ''}
                    {hit.ocr ? ` · ${t('search.attachmentOcr')}` : ''}
                  </span>
                </div>
                <div className={`mt-0.5 text-xs text-on-surface-variant ${compact ? 'line-clamp-2' : 'line-clamp-3'}`}>{hit.snippet}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {hit.notes.slice(0, compact ? 2 : 6).map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      className="chip max-w-full truncate px-2 py-0.5 text-[11px]"
                      title={n.path}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(n.id);
                      }}
                    >
                      {n.title}
                    </button>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
