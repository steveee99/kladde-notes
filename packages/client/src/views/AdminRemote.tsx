import { useCallback, useEffect, useState } from 'react';
import { parseAllowedPaths, type AdminRemoteInstance, type RemoteKind, type RemoteTestResult } from '@kladde/shared';
import { Check, Loader2, Lock, Pencil, Plus, RemoteDoc, Trash2 } from '../lib/icons';
import { api } from '../lib/api';
import { t, useLang, type I18nKey } from '../lib/i18n';
import { remoteProblemText } from '../data/remoteNotes';
import { Sheet } from './Dialogs';
import { Switch } from './Switch';

const kindName = (kind: RemoteKind) => (kind === 'gitlab' ? 'GitLab' : 'GitHub');

/** A new or existing access; the stored token is never shown, only replaced */
function AccessDialog({ entry, onSaved, onClose }: { entry: AdminRemoteInstance | null; onSaved: (list: AdminRemoteInstance[]) => void; onClose: () => void }) {
  const [kind, setKind] = useState<RemoteKind>(entry?.kind ?? 'gitlab');
  const [url, setUrl] = useState(entry?.url ?? '');
  const [token, setToken] = useState('');
  const [anonymous, setAnonymous] = useState(entry?.anonymous ?? false);
  const [paths, setPaths] = useState(entry?.allowedPaths.join('\n') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = 'mb-1 block text-label-l text-text';

  return (
    <Sheet title={entry ? t('remote.admin.edit') : t('remote.admin.add')} onClose={onClose}>
      <form
        className="space-y-4"
        data-remote-access
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          api<AdminRemoteInstance[]>(`/admin/remote${entry ? `/${encodeURIComponent(entry.id)}` : ''}`, {
            method: entry ? 'PUT' : 'POST',
            json: { kind, url: url.trim() || `https://${kind}.com`, token: anonymous ? '' : token, anonymous, allowedPaths: parseAllowedPaths(paths) },
          })
            .then(onSaved)
            .catch((err: Error) => {
              setError(err.message);
              setBusy(false);
            });
        }}
      >
        <div className="segmented" role="group" aria-label={t('remote.admin.kind')}>
          {(['gitlab', 'github'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {kindName(k)}
            </button>
          ))}
        </div>
        <label className="block">
          <span className={field}>{t('remote.admin.url')}</span>
          <input className="input" type="url" inputMode="url" placeholder={`https://${kind}.com`} value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
        </label>
        <div className="flex items-center justify-between gap-3 text-body-m">
          <span>
            {t('remote.admin.anonymous')}
            <span className="block text-body-s text-muted">{t('remote.admin.anonymousHint')}</span>
          </span>
          <Switch checked={anonymous} label={t('remote.admin.anonymous')} onChange={setAnonymous} />
        </div>
        {!anonymous && (
          <label className="block">
            <span className={field}>{t('remote.admin.token')}</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder={entry?.hasToken && entry.url === url.trim() && entry.kind === kind ? t('remote.admin.tokenKeep') : ''}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <span className="mt-1 block text-body-s text-muted">{t(`remote.admin.tokenHint.${kind}`)}</span>
          </label>
        )}
        <label className="block">
          <span className={field}>{t('remote.admin.paths')}</span>
          <textarea className="input min-h-20 font-mono text-[13px]" placeholder={'team/docs\nteam/handbook'} value={paths} onChange={(e) => setPaths(e.target.value)} />
          <span className="mt-1 block text-body-s text-muted">{t('remote.admin.pathsHint')}</span>
        </label>
        {error && (
          <p role="alert" className="text-body-m text-red">
            {error}
          </p>
        )}
        <button className="btn-primary w-full py-2.5" disabled={busy}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {t('common.save')}
        </button>
      </form>
    </Sheet>
  );
}

/** Access to GitLab and GitHub for remote notes: one token per instance, used for every user */
export function RemoteTab({ onError }: { onError: (msg: string) => void }) {
  useLang();
  const [list, setList] = useState<AdminRemoteInstance[] | null>(null);
  const [editing, setEditing] = useState<AdminRemoteInstance | 'new' | null>(null);
  const [tests, setTests] = useState<Record<string, RemoteTestResult['state'] | 'running'>>({});
  const load = useCallback(() => api<AdminRemoteInstance[]>('/admin/remote').then(setList, (e: Error) => onError(e.message)), [onError]);
  useEffect(() => void load(), [load]);

  const test = (id: string) => {
    setTests((r) => ({ ...r, [id]: 'running' }));
    api<RemoteTestResult>(`/admin/remote/${encodeURIComponent(id)}/test`, { method: 'POST', json: {} }).then(
      (r) => setTests((all) => ({ ...all, [id]: r.state })),
      (e: Error) => {
        onError(e.message);
        setTests(({ [id]: _gone, ...rest }) => rest);
      }
    );
  };
  const remove = (entry: AdminRemoteInstance) => {
    if (!confirm(t('remote.admin.deleteConfirm', { url: entry.url }))) return;
    api<AdminRemoteInstance[]>(`/admin/remote/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }).then(setList, (e: Error) => onError(e.message));
  };

  return (
    <>
      <p className="mb-2 text-body-m text-muted">{t('remote.admin.intro')}</p>
      <p className="mb-4 rounded-lg border border-line bg-panel px-3 py-2 text-body-m">{t('remote.admin.warning')}</p>
      {list === null ? (
        <div className="py-10 text-center text-muted">…</div>
      ) : (
        <ul className="card mb-4 divide-y divide-line" data-remote-list>
          {list.length === 0 && <li className="px-4 py-8 text-center text-body-m text-muted">{t('remote.admin.empty')}</li>}
          {list.map((i) => {
            const state = tests[i.id];
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-remote-instance={i.url}>
                <RemoteDoc size={18} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1 basis-52">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-body-m text-text">{i.url}</span>
                    <span className="chip">{kindName(i.kind)}</span>
                    {i.fromEnv && (
                      <span className="chip">
                        <Lock size={12} /> {t('remote.admin.fromEnv')}
                      </span>
                    )}
                    {i.overridden && <span className="chip text-amber">{t('remote.admin.overridden')}</span>}
                  </div>
                  <div className="text-body-s text-muted">
                    {i.hasToken ? t('remote.admin.hasToken') : t('remote.admin.noToken')} · {i.allowedPaths.length ? i.allowedPaths.join(', ') : t('remote.admin.allPaths')}
                  </div>
                  {state && state !== 'running' && (
                    <div role="status" className={`text-body-s ${state === 'ok' || state === 'limited' ? 'text-green' : 'text-red'}`} data-remote-test={state}>
                      {state === 'ok' || state === 'limited' ? t(`remote.admin.test.${state}` as I18nKey) : remoteProblemText(state)}
                    </div>
                  )}
                </div>
                {!i.overridden && (
                  <button type="button" className="btn-outlined px-3 py-1 text-xs" disabled={state === 'running'} onClick={() => test(i.id)}>
                    {state === 'running' && <Loader2 size={14} className="animate-spin" />} {t('remote.admin.test')}
                  </button>
                )}
                {!i.fromEnv && (
                  <>
                    <button type="button" className="btn-icon" title={t('remote.admin.edit')} aria-label={`${t('remote.admin.edit')}: ${i.url}`} onClick={() => setEditing(i)}>
                      <Pencil size={18} />
                    </button>
                    <button type="button" className="btn-icon hover:text-red" title={t('common.delete')} aria-label={`${t('common.delete')}: ${i.url}`} onClick={() => remove(i)}>
                      <Trash2 size={18} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
        <Plus size={16} /> {t('remote.admin.add')}
      </button>
      {editing && (
        <AccessDialog
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setList(next);
            setTests({});
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
