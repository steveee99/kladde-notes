import { useCallback, useEffect, useId, useState } from 'react';
import type { AdminBackup, AdminBackupOverview } from '@kladde/shared';
import { Backup, Download, History, Loader2, Trash2 } from '../lib/icons';
import { api } from '../lib/api';
import { I18nKey, locale, tl, useLang } from '../lib/i18n';
import { Switch } from './Switch';

const formatBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** Waits for the server to come back after a restore, then reloads (the session may have ended with it) */
function useRestartWatch(active: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    let sawDown = false;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch('/health', { cache: 'no-store' });
        const body = (await res.json()) as { ok?: boolean; maintenance?: boolean };
        if (res.ok && body.ok && !body.maintenance && (sawDown || Date.now() - started > 8000)) {
          location.reload();
          return;
        }
      } catch {
        sawDown = true;
      }
      if (Date.now() - started > 60_000) setLate(true);
      setTimeout(() => void poll(), 1500);
    };
    const first = setTimeout(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
  }, [active]);
  return late;
}

function RestorePanel({ backup, date, onCancel, onConfirm }: { backup: AdminBackup; date: string; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const lang = useLang();
  const checkId = useId();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div role="group" aria-labelledby={`${checkId}-title`} className="mt-3 rounded-[var(--shape-medium)] border border-error/50 bg-error-container/30 p-3">
      <p id={`${checkId}-title`} className="text-title-s">
        {tl(lang, 'admin.restoreTitle', { date })}
      </p>
      <p className="mt-1 text-body-s text-on-surface-variant">{tl(lang, 'admin.restoreText')}</p>
      <label htmlFor={checkId} className="mt-2 flex items-start gap-2 text-body-s">
        <input id={checkId} type="checkbox" className="mt-0.5" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
        {tl(lang, 'admin.restoreCheck')}
      </label>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button className="btn-text" onClick={onCancel} disabled={busy}>
          {tl(lang, 'common.cancel')}
        </button>
        <button
          className="btn-primary bg-error text-on-error"
          disabled={!understood || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <History size={15} />} {tl(lang, 'admin.restoreConfirm')}
        </button>
      </div>
      <span className="sr-only">{backup.id}</span>
    </div>
  );
}

/** Admin area → Backups (#65): list, back up now, daily schedule, download, restore, delete */
export function BackupsTab({ onError }: { onError: (msg: string) => void }) {
  const lang = useLang();
  const loc = locale(lang);
  const dateTime = (ms: number) => new Date(ms).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' });
  const [data, setData] = useState<AdminBackupOverview | null>(null);
  const [creating, setCreating] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [keep, setKeep] = useState('7');
  const [saved, setSaved] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const late = useRestartWatch(restarting);
  const keepId = useId();

  const apply = useCallback((overview: AdminBackupOverview) => {
    setData(overview);
    setEnabled(overview.schedule.enabled);
    setKeep(String(overview.schedule.keep));
  }, []);

  useEffect(() => {
    api<AdminBackupOverview>('/admin/backups').then(apply, (e) => onError(e.message));
  }, [apply, onError]);

  const run = async (fn: () => Promise<void>) => {
    onError('');
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  if (restarting) {
    return (
      <div className="card flex flex-col items-center gap-3 p-6 text-center" role="status" aria-live="polite">
        <Loader2 size={28} className="animate-spin text-primary" />
        <p className="text-body-l">{tl(lang, 'admin.restoreRestarting')}</p>
        {late && <p className="text-body-s text-on-surface-variant">{tl(lang, 'admin.restoreNoReturn')}</p>}
      </div>
    );
  }
  if (!data) return <div className="py-10 text-center text-on-surface-variant">…</div>;

  const scheduleDirty = enabled !== data.schedule.enabled || Number(keep) !== data.schedule.keep;

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn-primary"
            disabled={creating || data.busy}
            onClick={() =>
              run(async () => {
                setCreating(true);
                try {
                  apply(await api<AdminBackupOverview>('/admin/backups', { method: 'POST', json: {} }));
                } finally {
                  setCreating(false);
                }
              })
            }
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Backup size={16} />}
            {creating ? tl(lang, 'admin.backupRunning') : tl(lang, 'admin.backupNow')}
          </button>
          <span className="min-w-0 break-all text-body-s text-on-surface-variant">{tl(lang, 'admin.backupDir', { dir: data.dir })}</span>
        </div>
        <p className="mt-3 text-body-s text-on-surface-variant">{tl(lang, 'admin.backupKeyHint')}</p>
      </section>

      <form
        className="card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            apply(await api<AdminBackupOverview>('/admin/backups/schedule', { method: 'PUT', json: { enabled, keep: Number(keep) } }));
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          });
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-title-s" id={`${keepId}-daily`}>
            {tl(lang, 'admin.backupDaily')}
          </span>
          <Switch checked={enabled} label={tl(lang, 'admin.backupDaily')} onChange={setEnabled} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor={keepId} className="text-body-m">
            {tl(lang, 'admin.backupKeep')}
          </label>
          <input
            id={keepId}
            type="number"
            min={1}
            max={90}
            inputMode="numeric"
            className="input w-20"
            disabled={!enabled}
            value={keep}
            onChange={(e) => setKeep(e.target.value)}
          />
          <span className="text-body-m">{tl(lang, 'admin.backupKeepUnit')}</span>
          <span className="ml-auto flex items-center gap-2">
            {saved && (
              <span className="text-body-s text-on-surface-variant" role="status">
                {tl(lang, 'admin.backupSaved')}
              </span>
            )}
            <button className="btn-tonal" disabled={!scheduleDirty}>
              {tl(lang, 'admin.backupSave')}
            </button>
          </span>
        </div>
        <p className="mt-2 text-body-s text-on-surface-variant">{tl(lang, 'admin.backupKeepHint')}</p>
      </form>

      {data.backups.length === 0 ? (
        <div className="py-10 text-center text-on-surface-variant">{tl(lang, 'admin.backupsEmpty')}</div>
      ) : (
        <ul className="card divide-y divide-outline-variant/60 p-1">
          {data.backups.map((b) => {
            const date = dateTime(b.createdAt);
            return (
              <li key={b.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body-l font-medium">{date}</span>
                      <span className="chip">{b.kind === 'full' ? tl(lang, 'admin.backupFull') : tl(lang, 'admin.backupDbOnly')}</span>
                      <span className="chip">{tl(lang, `admin.backupTrigger.${b.trigger}` as I18nKey)}</span>
                    </div>
                    <div className="text-body-s text-on-surface-variant">
                      {formatBytes(b.size)}
                      {b.kind === 'full' && ` · ${tl(lang, 'admin.backupFiles', { n: b.files })}`}
                      {b.version && ` · v${b.version}`}
                      {b.kind === 'full' && !b.restorable && ` · ${tl(lang, 'admin.backupNewer')}`}
                    </div>
                  </div>
                  <a className="btn-outlined h-8 px-3 text-label-l" href={`/api/admin/backups/${encodeURIComponent(b.id)}/download`} download>
                    <Download size={15} /> {tl(lang, 'admin.backupDownload')}
                  </a>
                  {b.restorable && (
                    <button
                      className="btn-outlined h-8 px-3 text-label-l"
                      aria-expanded={restoring === b.id}
                      onClick={() => setRestoring(restoring === b.id ? null : b.id)}
                    >
                      <History size={15} /> {tl(lang, 'admin.backupRestore')}
                    </button>
                  )}
                  <button
                    className="btn-icon h-8 w-8"
                    title={tl(lang, 'admin.backupDelete')}
                    aria-label={`${tl(lang, 'admin.backupDelete')}: ${date}`}
                    onClick={() =>
                      confirm(tl(lang, 'admin.backupDeleteConfirm', { date })) &&
                      run(async () => apply(await api<AdminBackupOverview>(`/admin/backups/${encodeURIComponent(b.id)}`, { method: 'DELETE' })))
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {restoring === b.id && (
                  <RestorePanel
                    backup={b}
                    date={date}
                    onCancel={() => setRestoring(null)}
                    onConfirm={() =>
                      run(async () => {
                        await api(`/admin/backups/${encodeURIComponent(b.id)}/restore`, { method: 'POST', json: { confirm: b.id } });
                        setRestarting(true);
                      })
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
