import { useEffect, useState } from 'react';
import type { AccountExportStatus } from '@kladde/shared';
import { Download, Loader2, Trash2 } from '../lib/icons';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { SettingsPage } from './SettingsPage';
import { Switch } from './Switch';

const formatSize = (bytes: number, loc: string) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toLocaleString(loc, { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(loc)} KB`;

/**
 * Settings → Export account (#93): the whole account as a ZIP archive (notes in their folders, attachments,
 * templates, settings and shares, optionally the history). The server builds it in the background; it can be
 * downloaded once and is deleted after a day.
 */
export function AccountExportView() {
  const lang = useLang();
  const loc = locale(lang);
  const [status, setStatus] = useState<AccountExportStatus | null | undefined>(undefined);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    api<{ export: AccountExportStatus | null }>('/account-export').then(
      (r) => setStatus(r.export),
      (err) => setError((err as Error).message)
    );

  useEffect(() => {
    void load();
  }, []);

  // While it is being built: ask again every two seconds
  useEffect(() => {
    if (status?.state !== 'running') return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [status?.state]);

  const start = async () => {
    setError('');
    try {
      setStatus((await api<{ export: AccountExportStatus }>('/account-export', { method: 'POST', json: { history } })).export);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const discard = async () => {
    setError('');
    try {
      await api('/account-export', { method: 'DELETE' });
      setStatus(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const download = (s: AccountExportStatus) => {
    // A plain navigation: the browser streams the archive to disk instead of holding it in memory
    const a = document.createElement('a');
    a.href = `/api/account-export/${encodeURIComponent(s.id)}/download`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    setStatus(null);
  };

  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' }) : '');

  return (
    <SettingsPage title={tl(lang, 'accountExport.title')}>
      <p className="text-body-m text-on-surface-variant anim-fade-up">{tl(lang, 'accountExport.intro')}</p>
      <section className="card space-y-4 p-5 anim-fade-up" aria-live="polite">
        {status === undefined ? (
          <Loader2 size={20} className="animate-spin text-on-surface-variant" />
        ) : status?.state === 'running' ? (
          <div className="flex items-center gap-3">
            <Loader2 size={20} className="shrink-0 animate-spin text-primary" />
            <div>
              <div className="text-title-s">{tl(lang, 'accountExport.running')}</div>
              <div className="text-body-s text-on-surface-variant">{tl(lang, 'accountExport.runningHint')}</div>
            </div>
          </div>
        ) : status?.state === 'ready' ? (
          <div className="space-y-3">
            <div>
              <div className="text-title-s">{tl(lang, 'accountExport.ready')}</div>
              <div className="text-body-s text-on-surface-variant">
                {tl(lang, 'accountExport.readyDetail', {
                  notes: status.notes,
                  files: status.files,
                  size: formatSize(status.size, loc),
                  until: when(status.expiresAt),
                })}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" onClick={() => download(status)}>
                <Download size={18} /> {tl(lang, 'accountExport.download')}
              </button>
              <button className="btn-text" onClick={() => void discard()}>
                <Trash2 size={18} /> {tl(lang, 'accountExport.discard')}
              </button>
            </div>
            <p className="text-body-s text-on-surface-variant">{tl(lang, 'accountExport.once')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {status?.state === 'failed' && (
              <p className="text-sm text-error" role="alert">
                {tl(lang, 'accountExport.failed', { error: status.error ?? '' })}
              </p>
            )}
            <div className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-body-l">{tl(lang, 'accountExport.history')}</span>
                <span className="block text-body-s text-on-surface-variant">{tl(lang, 'accountExport.historyHint')}</span>
              </span>
              <Switch checked={history} onChange={setHistory} label={tl(lang, 'accountExport.history')} />
            </div>
            <button className="btn-primary" onClick={() => void start()}>
              <Download size={18} /> {tl(lang, 'accountExport.start')}
            </button>
          </div>
        )}
        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <section className="card space-y-2 p-5 text-body-m anim-fade-up">
        <h2 className="text-title-s">{tl(lang, 'accountExport.contentsTitle')}</h2>
        <ul className="list-disc space-y-1 pl-5 text-on-surface-variant">
          <li>{tl(lang, 'accountExport.contentsNotes')}</li>
          <li>{tl(lang, 'accountExport.contentsFiles')}</li>
          <li>{tl(lang, 'accountExport.contentsJson')}</li>
          <li>{tl(lang, 'accountExport.contentsHistory')}</li>
        </ul>
        <p className="text-on-surface-variant">{tl(lang, 'accountExport.importHint')}</p>
      </section>
    </SettingsPage>
  );
}
