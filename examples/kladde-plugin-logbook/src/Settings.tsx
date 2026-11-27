import { useEffect, useState } from 'react';
import { useKladde } from '@kladde/plugin-api/client';

/** Settings tab of the logbook's card under Settings → Features */
export function LogbookSettings() {
  const host = useKladde();
  const [stats, setStats] = useState<{ entries: number; notesChanged: number; keepDays: number } | null>(null);
  useEffect(() => {
    host.api<{ entries: number; notesChanged: number; keepDays: number }>('/stats').then(setStats, () => setStats(null));
  }, [host]);
  if (!stats) return <p className="text-body-m text-muted">…</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-body-m">
      <dt className="text-muted">{host.t({ de: 'Einträge', en: 'Entries' })}</dt>
      <dd className="font-mono">{stats.entries}</dd>
      <dt className="text-muted">{host.t({ de: 'Geänderte Notizen', en: 'Notes changed' })}</dt>
      <dd className="font-mono">{stats.notesChanged}</dd>
      <dt className="text-muted">{host.t({ de: 'Aufbewahrung', en: 'Kept for' })}</dt>
      <dd className="font-mono">{host.t({ de: `${stats.keepDays} Tage`, en: `${stats.keepDays} days` })}</dd>
    </dl>
  );
}
