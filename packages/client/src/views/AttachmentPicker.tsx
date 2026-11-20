/**
 * Links an attachment the user already uploaded (or a new one) into a note: a searchable list of
 * their files from `/api/files`, opened from the editor toolbar and the `/` menu through `editorHost.pickAttachment`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentInfo } from '@kladde/shared';
import { FileText, Loader2, Search, Upload } from '../lib/icons';
import { listFiles } from '../lib/api';
import { closeDialog } from '../lib/dialogs';
import { compareText, locale, tl, useLang } from '../lib/i18n';
import { editorHost, type UploadedFile } from '../editor/host';
import { vault } from '../data/vault';
import { Sheet } from './Dialogs';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPicker({ onPick }: { onPick: (file: UploadedFile) => void }) {
  const lang = useLang();
  const [items, setItems] = useState<AttachmentInfo[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dateFmt = useMemo(() => new Intl.DateTimeFormat(locale(lang), { day: '2-digit', month: '2-digit', year: 'numeric' }), [lang]);

  useEffect(() => {
    let cancelled = false;
    listFiles().then(
      (list) => !cancelled && setItems(list.sort((a, b) => b.createdAt - a.createdAt)),
      (err: Error) => {
        if (cancelled) return;
        setItems([]);
        setError(navigator.onLine || vault.standalone ? err.message : tl(lang, 'files.onlineOnlyError'));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = items ?? [];
    return q ? list.filter((f) => f.name.toLowerCase().includes(q)).sort((a, b) => compareText(a.name, b.name)) : list;
  }, [items, query]);

  const pick = (file: UploadedFile) => {
    closeDialog();
    onPick(file);
  };

  return (
    <Sheet title={tl(lang, 'attach.title')} onClose={closeDialog}>
      <div className="mb-3 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
          <input
            type="search"
            autoFocus
            className="input py-1.5 pl-9 text-sm"
            placeholder={tl(lang, 'attach.search')}
            aria-label={tl(lang, 'attach.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && visible[0]) pick(visible[0]);
            }}
          />
        </div>
        <button type="button" className="btn-tonal shrink-0" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          <span className="hidden sm:inline">{tl(lang, 'attach.uploadNew')}</span>
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*,application/pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            editorHost.upload(file).then(pick, (err: Error) => {
              setBusy(false);
              setError(tl(lang, 'editor.uploadFailed', { error: err.message }));
            });
          }}
        />
      </div>
      {error && <p className="mb-3 rounded-lg bg-error-container px-3 py-2 text-body-m text-on-error-container">{error}</p>}
      {items === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-on-surface-variant">
          <Loader2 size={18} className="animate-spin" /> {tl(lang, 'files.loading')}
        </div>
      ) : visible.length === 0 ? (
        !error && <p className="py-8 text-center text-sm text-on-surface-variant">{items.length ? tl(lang, 'files.emptyNoMatch') : tl(lang, 'files.emptyNone')}</p>
      ) : (
        <ul className="-mx-2 mb-4 space-y-0.5" aria-label={tl(lang, 'files.title')}>
          {visible.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                data-attachment-pick={f.id}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-surface-container-highest focus-visible:bg-surface-container-highest"
                onClick={() => pick({ url: f.url, name: f.name, mime: f.mime })}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-container">
                  {f.mime.startsWith('image/') ? (
                    <img src={f.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <FileText size={20} className="text-primary" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-m text-on-surface">{f.name}</span>
                  <span className="block truncate text-body-s text-on-surface-variant">
                    {formatBytes(f.size)} · {dateFmt.format(f.createdAt)}
                    {f.usedIn.length > 0 ? ` · ${tl(lang, 'attach.usedIn', { n: f.usedIn.length })}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
