import { useEffect, useState } from 'react';
import type { AdminGroupStorage, StorageUsage } from '@kladde/shared';
import { api } from '../lib/api';
import { tl, useLang } from '../lib/i18n';
import { StorageMeter } from './StorageMeter';

/** Sets the limit of an account or group: MB, unlimited, or the server default (#91) */
export function QuotaEditor({ id, usage, onChange, onError }: { id: string; usage: StorageUsage; onChange: (usage: StorageUsage) => void; onError: (msg: string) => void }) {
  const lang = useLang();
  const [mb, setMb] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (value: number | null) => {
    setBusy(true);
    onError('');
    try {
      const r = await api<{ storage: StorageUsage }>(`/admin/storage/${id}/quota`, { method: 'PUT', json: { mb: value } });
      onChange(r.storage);
      setMb('');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const parsed = Number(mb.replace(',', '.'));
  const valid = mb.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void send(parsed);
      }}
    >
      <label className="flex items-center gap-1.5">
        <span className="text-on-surface-variant">{tl(lang, 'storage.limitLabel')}</span>
        <input className="input w-24 py-1" inputMode="decimal" value={mb} placeholder={usage.quota ? String(Math.round(usage.quota / 1024 / 1024)) : '∞'} onChange={(e) => setMb(e.target.value)} />
        <span>MB</span>
      </label>
      <button type="submit" className="btn-ghost rounded-full border border-outline-variant px-3 py-1" disabled={busy || !valid}>
        {tl(lang, 'storage.setLimit')}
      </button>
      <button type="button" className="btn-ghost rounded-full border border-outline-variant px-3 py-1" disabled={busy} onClick={() => void send(0)}>
        {tl(lang, 'storage.setUnlimited')}
      </button>
      {usage.customQuota && (
        <button type="button" className="btn-ghost rounded-full border border-outline-variant px-3 py-1" disabled={busy} onClick={() => void send(null)}>
          {tl(lang, 'storage.useDefault')}
        </button>
      )}
    </form>
  );
}

/** Admin tab: storage per group (#91); accounts show theirs in the account list */
export function GroupsStorageTab({ onError }: { onError: (msg: string) => void }) {
  const lang = useLang();
  const [groups, setGroups] = useState<AdminGroupStorage[] | null>(null);
  useEffect(() => {
    api<AdminGroupStorage[]>('/admin/storage/groups').then(setGroups, (e) => onError(e.message));
  }, [onError]);
  if (!groups) return <div className="py-10 text-center text-on-surface-variant">…</div>;
  if (groups.length === 0) return <div className="card p-10 text-center text-on-surface-variant">{tl(lang, 'storage.noGroups')}</div>;
  return (
    <ul className="stagger space-y-3">
      {groups.map((g) => (
        <li key={g.id} className="card p-4">
          <div className="mb-2 font-medium">
            {g.name} <span className="text-xs font-normal text-on-surface-variant">{tl(lang, 'storage.members', { n: g.members })}</span>
          </div>
          <StorageMeter usage={g.storage} />
          <QuotaEditor id={g.id} usage={g.storage} onError={onError} onChange={(storage) => setGroups((list) => list && list.map((x) => (x.id === g.id ? { ...x, storage } : x)))} />
        </li>
      ))}
    </ul>
  );
}
