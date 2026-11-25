import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { AdminJob, AdminOverview } from '@kladde/shared';
import { Backup, CheckCircle2, Database, FileText, HardDrive, Images, Memory, Person, Speed, Sync, Trash2, Users, AlertTriangle, Monitor, RefreshCw } from '../lib/icons';
import { api } from '../lib/api';
import { locale, tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { Avatar } from './Avatar';
import { formatStorage } from './StorageMeter';

/*
 * Admin dashboard: tiles with what the server holds (notes count once, however often shared), how the machine runs
 * (CPU, memory, disk), who is online and the recent jobs. Refreshed every few seconds while it is open.
 */

const REFRESH_MS = 10_000;

type IconType = ComponentType<{ size?: number; className?: string }>;

const pct = (ratio: number | null) => (ratio === null ? '–' : `${Math.round(ratio * 100)} %`);

function Tile({ Icon, label, children, className = '', data }: { Icon: IconType; label: string; children: ReactNode; className?: string; data?: string }) {
  return (
    <section className={`card flex min-w-0 flex-col gap-2 p-4 ${className}`} aria-label={label} data-admin-tile={data}>
      <h2 className="flex items-center gap-2 text-label-l text-muted">
        <Icon size={16} className="shrink-0 text-soft" />
        <span className="truncate">{label}</span>
      </h2>
      {children}
    </section>
  );
}

function Big({ value, hint }: { value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[26px] leading-8 text-strong tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-body-s text-muted">{hint}</div>}
    </div>
  );
}

/** A bar for a share of something (CPU, memory, disk); amber from 80 %, red from 95 % */
function Meter({ ratio, label }: { ratio: number | null; label: string }) {
  if (ratio === null) return null;
  const r = Math.min(1, Math.max(0, ratio));
  const tone = r >= 0.95 ? 'bg-red' : r >= 0.8 ? 'bg-amber' : 'bg-acc';
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r * 100)} className="h-1.5 overflow-hidden rounded-full bg-line">
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${r * 100}%` }} />
    </div>
  );
}

const JOB_LABELS: Record<AdminJob['kind'], I18nKey> = { sync: 'admin.job.sync', backup: 'admin.job.backup', trash: 'admin.job.trash' };
const JOB_ICONS: Record<AdminJob['kind'], IconType> = { sync: Sync, backup: Backup, trash: Trash2 };

function jobDetail(j: AdminJob, lang: Lang): string {
  if (!j.ok) return j.error ?? tl(lang, 'admin.job.failed');
  if (j.kind === 'sync') return [tl(lang, 'admin.job.changes', { n: j.count ?? 0 }), j.rejected ? tl(lang, 'admin.job.rejected', { n: j.rejected }) : ''].filter(Boolean).join(' · ');
  if (j.kind === 'trash') return tl(lang, 'admin.job.purged', { n: j.count ?? 0 });
  return '';
}

function uptime(ms: number, lang: Lang): string {
  const min = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return tl(lang, 'admin.days', { n: Math.round(min / 1440) });
}

export function AdminOverviewTab({ onError }: { onError: (msg: string) => void }) {
  const lang = useLang();
  const loc = locale(lang);
  const [data, setData] = useState<AdminOverview | null>(null);

  const [loadedAt, setLoadedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      setBusy(true);
      return api<AdminOverview>('/admin/overview')
        .then(
          (d) => {
            if (!alive) return;
            setData(d);
            setLoadedAt(Date.now());
          },
          (e) => alive && onError(e.message)
        )
        .finally(() => alive && setBusy(false));
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [onError, tick]);

  if (!data) return <div className="py-10 text-center text-muted">…</div>;
  const n = (v: number) => v.toLocaleString(loc);
  const time = (ms: number) => new Date(ms).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'medium' });
  const { counts, system, online } = data;
  const memUsed = system.memory.total - system.memory.free;
  const diskUsed = system.disk ? system.disk.total - system.disk.free : 0;
  const kladdeBytes = system.storage.database + system.storage.attachments;

  return (
    <div className="space-y-4" data-admin-overview>
      <div className="flex items-center justify-end gap-2 text-caption text-muted">
        <span className="font-mono">{tl(lang, 'admin.tile.updated', { at: new Date(loadedAt).toLocaleTimeString(loc, { timeStyle: 'medium' }) })}</span>
        <button type="button" className="btn-icon h-8 w-8" onClick={() => setTick((t) => t + 1)} disabled={busy} title={tl(lang, 'admin.tile.refresh')} aria-label={tl(lang, 'admin.tile.refresh')}>
          <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile Icon={FileText} label={tl(lang, 'admin.tile.notes')} data="notes">
          <Big value={n(counts.notes)} hint={tl(lang, 'admin.tile.notesHint', { shares: n(counts.shares) })} />
        </Tile>
        <Tile Icon={Database} label={tl(lang, 'admin.tile.databases')} data="databases">
          <Big value={n(counts.databases)} />
        </Tile>
        <Tile Icon={Person} label={tl(lang, 'admin.tile.users')} data="users">
          <Big value={n(counts.users)} hint={tl(lang, 'admin.tile.invitesOpen', { n: n(counts.invites) })} />
        </Tile>
        <Tile Icon={Users} label={tl(lang, 'admin.tile.groups')} data="groups">
          <Big value={n(counts.groups)} />
        </Tile>
        <Tile Icon={Speed} label={tl(lang, 'admin.tile.cpu')} data="cpu">
          <Big value={pct(system.cpu.system)} hint={tl(lang, 'admin.tile.cpuHint', { load: system.cpu.load.map((l) => l.toFixed(2)).join(' · '), cores: system.cpu.cores, process: pct(system.cpu.process) })} />
          <Meter ratio={system.cpu.system} label={tl(lang, 'admin.tile.cpu')} />
        </Tile>
        <Tile Icon={Memory} label={tl(lang, 'admin.tile.memory')} data="memory">
          <Big value={pct(memUsed / system.memory.total)} hint={tl(lang, 'admin.tile.memoryHint', { used: formatStorage(memUsed), total: formatStorage(system.memory.total), rss: formatStorage(system.memory.rss) })} />
          <Meter ratio={memUsed / system.memory.total} label={tl(lang, 'admin.tile.memory')} />
        </Tile>
        <Tile Icon={HardDrive} label={tl(lang, 'admin.tile.disk')} data="disk">
          {system.disk ? (
            <>
              <Big value={pct(diskUsed / system.disk.total)} hint={tl(lang, 'admin.tile.diskHint', { free: formatStorage(system.disk.free), total: formatStorage(system.disk.total) })} />
              <Meter ratio={diskUsed / system.disk.total} label={tl(lang, 'admin.tile.disk')} />
            </>
          ) : (
            <Big value="–" />
          )}
        </Tile>
        <Tile Icon={Images} label={tl(lang, 'admin.tile.storage')} data="storage">
          <Big
            value={formatStorage(kladdeBytes)}
            hint={tl(lang, 'admin.tile.storageHint', { db: formatStorage(system.storage.database), files: formatStorage(system.storage.attachments), n: n(counts.attachments) })}
          />
        </Tile>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Tile Icon={Monitor} label={tl(lang, 'admin.tile.online', { n: online.users.length })} data="online">
          {online.users.length === 0 ? (
            <p className="text-body-m text-muted">{tl(lang, 'admin.tile.onlineEmpty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {online.users.map((u) => (
                <li key={u.username} className="flex items-center gap-2 text-body-m">
                  <span className="relative shrink-0">
                    <Avatar name={u.username} avatarUrl={u.avatarUrl} size="xs" />
                    <span aria-hidden className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-green ring-2 ring-[var(--panel)]" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{u.username}</span>
                  <span className="shrink-0 font-mono text-caption text-muted">{tl(lang, 'admin.tile.devices', { n: u.devices })}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-auto pt-1 text-caption text-muted">{tl(lang, 'admin.tile.connections', { n: online.connections })}</p>
        </Tile>

        <Tile Icon={Sync} label={tl(lang, 'admin.tile.jobs')} className="lg:col-span-2" data="jobs">
          {data.jobs.length === 0 ? (
            <p className="text-body-m text-muted">{tl(lang, 'admin.tile.jobsEmpty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.jobs.map((j, i) => {
                const Icon = JOB_ICONS[j.kind];
                return (
                  <li key={`${j.at}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-body-m" data-admin-job={j.kind}>
                    <Icon size={15} className="shrink-0 text-muted" />
                    <span className="font-medium">{tl(lang, JOB_LABELS[j.kind])}</span>
                    {j.user && <span className="text-soft">{j.user}</span>}
                    <span className={`min-w-0 flex-1 truncate ${j.ok ? 'text-muted' : 'text-red'}`}>
                      {!j.ok && <AlertTriangle size={13} className="mr-1 inline" />}
                      {jobDetail(j, lang)}
                    </span>
                    <span className="shrink-0 font-mono text-caption text-muted">{j.durationMs} ms</span>
                    <time className="w-36 shrink-0 text-right font-mono text-caption text-muted" dateTime={new Date(j.at).toISOString()}>
                      {time(j.at)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-auto pt-1 text-caption text-muted">{tl(lang, 'admin.tile.jobsNote')}</p>
        </Tile>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 font-mono text-caption text-muted">
        <span>Kladde {data.version}</span>
        <span>{tl(lang, 'admin.tile.uptime', { since: uptime(data.startedAt, lang) })}</span>
        <span>Node {system.node}</span>
        <span>{system.platform}</span>
        {system.cpu.model && <span>{system.cpu.model}</span>}
        <span className="inline-flex items-center gap-1">
          {data.lastBackupAt ? <CheckCircle2 size={13} /> : <Backup size={13} />}
          {data.lastBackupAt ? tl(lang, 'admin.tile.lastBackup', { at: time(data.lastBackupAt) }) : tl(lang, 'admin.tile.noBackup')}
        </span>
      </div>
    </div>
  );
}
