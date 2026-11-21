import { useEffect, useState } from 'react';
import type { ConfluenceKind, ConfluenceOverview } from '@kladde/shared';
import { Check, Cloud, ExternalLink, Folder, FileText, RefreshCw, Trash2 } from '../lib/icons';
import { api } from '../lib/api';
import { refreshConfluence, setConfluenceOverview, useConfluence } from '../lib/confluence';
import { locale, tl, useLang } from '../lib/i18n';
import { SettingsPage } from './SettingsPage';
import { navigate } from '../lib/router';
import { Dropdown } from './Dropdown';
import { ConfluenceStatus } from './ConfluenceDialog';

/** Settings → Confluence (#48): the user's own Confluence address and token, and the syncs set up with it */
export function ConfluenceSettingsView({ embedded }: { embedded?: boolean } = {}) {
  const lang = useLang();
  const overview = useConfluence();
  const connection = overview?.connection ?? null;
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<ConfluenceKind>('cloud');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'' | 'test' | 'save' | 'remove' | string>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => void refreshConfluence(), []);
  useEffect(() => {
    if (!connection) return;
    setUrl(connection.url);
    setKind(connection.kind);
    setEmail(connection.email);
  }, [connection?.updatedAt]);

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const input = () => ({ url, kind, email, token });
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' }) : tl(lang, 'confluence.never'));

  return (
    <SettingsPage title={tl(lang, 'confluence.settingsTitle')} embedded={embedded}>
      <p className="text-sm text-on-surface-variant anim-fade-up">{tl(lang, 'confluence.intro')}</p>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="text-title-m text-strong">{tl(lang, 'confluence.connectionTitle')}</h2>
        {connection && (
          <p className="flex items-center gap-2 text-sm text-primary">
            <Check size={16} /> {tl(lang, 'confluence.connectedAs', { name: connection.accountName })}
          </p>
        )}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act('save', async () => {
              setConfluenceOverview(await api<ConfluenceOverview>('/confluence/connection', { method: 'PUT', json: input() }));
              setToken('');
              setMessage(tl(lang, 'confluence.saved'));
            });
          }}
        >
          <Dropdown
            value={kind}
            onChange={(v) => setKind(v === 'datacenter' ? 'datacenter' : 'cloud')}
            aria-label={tl(lang, 'confluence.kind')}
            options={[
              { value: 'cloud', label: tl(lang, 'confluence.kindCloud') },
              { value: 'datacenter', label: tl(lang, 'confluence.kindDc') },
            ]}
          />
          <input className="input" type="url" required placeholder={kind === 'cloud' ? 'https://firma.atlassian.net/wiki' : 'https://wiki.firma.de'} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={tl(lang, 'confluence.url')} />
          {kind === 'cloud' && (
            <input className="input" type="email" required autoComplete="off" placeholder={tl(lang, 'confluence.email')} value={email} onChange={(e) => setEmail(e.target.value)} aria-label={tl(lang, 'confluence.email')} />
          )}
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required={!connection}
            placeholder={connection ? tl(lang, 'confluence.tokenKeep') : tl(lang, kind === 'cloud' ? 'confluence.tokenCloud' : 'confluence.tokenDc')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label={tl(lang, 'confluence.token')}
          />
          <p className="text-xs text-on-surface-variant">{tl(lang, kind === 'cloud' ? 'confluence.tokenCloudHint' : 'confluence.tokenDcHint')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-outlined px-4"
              disabled={!!busy || !url}
              onClick={() =>
                void act('test', async () => {
                  const res = await api<{ accountName: string }>('/confluence/connection/test', { method: 'POST', json: input() });
                  setMessage(tl(lang, 'confluence.testOk', { name: res.accountName }));
                })
              }
            >
              {busy === 'test' ? <RefreshCw size={16} className="animate-spin" /> : <Check size={16} />} {tl(lang, 'confluence.test')}
            </button>
            <button className="btn-primary px-4" disabled={!!busy || !url}>
              <Cloud size={16} /> {tl(lang, 'common.save')}
            </button>
            {connection && (
              <button
                type="button"
                className="btn-text px-4 text-error"
                disabled={!!busy}
                onClick={() => {
                  if (!confirm(tl(lang, 'confluence.removeConfirm'))) return;
                  void act('remove', async () => {
                    setConfluenceOverview(await api<ConfluenceOverview>('/confluence/connection', { method: 'DELETE' }));
                    setUrl('');
                    setEmail('');
                    setToken('');
                  });
                }}
              >
                <Trash2 size={16} /> {tl(lang, 'confluence.remove')}
              </button>
            )}
          </div>
          {message && <p className="text-sm text-primary">{message}</p>}
          {error && <p className="text-sm text-error">{error}</p>}
        </form>
      </section>

      {connection && (
        <section className="card divide-y divide-outline-variant anim-fade-up">
          <div className="p-5 pb-3">
            <h2 className="text-title-m text-strong">{tl(lang, 'confluence.syncsTitle')}</h2>
            <p className="mt-1 text-sm text-on-surface-variant">{tl(lang, 'confluence.syncsHint')}</p>
          </div>
          {!overview?.syncs.length && <p className="p-5 pt-3 text-sm text-on-surface-variant">{tl(lang, 'confluence.syncsEmpty')}</p>}
          {overview?.syncs.map((s) => {
            const status = s.conflicts ? 'conflict' : s.errors ? 'error' : s.lastSyncAt ? 'ok' : 'pending';
            return (
              <div key={s.id} className="space-y-2 p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary-container text-on-secondary-container">
                    {s.kind === 'folder' ? <Folder size={18} /> : <FileText size={18} />}
                  </span>
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => (s.kind === 'folder' ? navigate(`/f/${encodeURIComponent(s.folder ?? '')}`) : s.noteId && navigate(`/n/${s.noteId}`))}
                  >
                    <div className="truncate font-medium">{s.label}</div>
                    <div className="truncate text-xs text-on-surface-variant">
                      {s.spaceKey}
                      {s.parentTitle ? ` › ${s.parentTitle}` : ''} · {tl(lang, 'confluence.lastSync')} {when(s.lastSyncAt)}
                      {s.kind === 'folder' ? ` · ${tl(lang, 'confluence.pagesCount', { n: s.notes })}` : ''}
                    </div>
                  </button>
                  {s.pageUrl && (
                    <a className="btn-icon h-8 w-8 shrink-0" href={s.pageUrl} target="_blank" rel="noopener noreferrer" title={tl(lang, 'confluence.openPage')}>
                      <ExternalLink size={15} />
                    </a>
                  )}
                  <button
                    className="btn-icon h-8 w-8 shrink-0"
                    disabled={!!busy}
                    title={tl(lang, 'confluence.syncNow')}
                    onClick={() => void act(s.id, async () => setConfluenceOverview(await api<ConfluenceOverview>(`/confluence/syncs/${s.id}/run`, { method: 'POST', json: {} })))}
                  >
                    <RefreshCw size={15} className={busy === s.id ? 'animate-spin' : ''} />
                  </button>
                  <button
                    className="btn-icon h-8 w-8 shrink-0"
                    disabled={!!busy}
                    title={tl(lang, 'confluence.stop')}
                    onClick={() => {
                      if (!confirm(tl(lang, s.kind === 'folder' ? 'confluence.stopFolderConfirm' : 'confluence.stopNoteConfirm'))) return;
                      void act(s.id, async () => setConfluenceOverview(await api<ConfluenceOverview>(`/confluence/syncs/${s.id}`, { method: 'DELETE' })));
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {status !== 'ok' && (
                  <ConfluenceStatus status={status} error={s.errors || s.conflicts ? tl(lang, 'confluence.folderProblems', { errors: s.errors, conflicts: s.conflicts }) : null} lang={lang} />
                )}
              </div>
            );
          })}
        </section>
      )}
    </SettingsPage>
  );
}
