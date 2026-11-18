import { STORAGE_WARN_RATIO, type StorageUsage } from '@kladde/shared';
import { tl, useLang } from '../lib/i18n';

export function formatStorage(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Storage of an account or group (#91): the bar against its quota, a warning from 80 %, and what the space is used for */
export function StorageMeter({ usage, label }: { usage: StorageUsage; label?: string }) {
  const lang = useLang();
  const ratio = usage.quota ? usage.total / usage.quota : null;
  const over = ratio !== null && ratio >= 1;
  const warn = ratio !== null && ratio >= STORAGE_WARN_RATIO;
  const parts = [
    tl(lang, 'storage.notes', { size: formatStorage(usage.notes) }),
    tl(lang, 'storage.attachments', { size: formatStorage(usage.attachments) }),
    tl(lang, 'storage.history', { size: formatStorage(usage.history) }),
    tl(lang, 'storage.trash', { size: formatStorage(usage.trash) }),
  ];
  return (
    <div className="text-xs text-on-surface-variant">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium text-on-surface">
          {label ? `${label}: ` : ''}
          {usage.quota ? tl(lang, 'storage.ofQuota', { used: formatStorage(usage.total), quota: formatStorage(usage.quota) }) : tl(lang, 'storage.unlimited', { used: formatStorage(usage.total) })}
        </span>
        <span>{parts.join(' · ')}</span>
      </div>
      {ratio !== null && (
        <div
          role="progressbar"
          aria-label={tl(lang, 'storage.barLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.round(ratio * 100))}
          className="h-1.5 overflow-hidden rounded-full bg-surface-container-highest"
        >
          <div className={`h-full rounded-full ${over ? 'bg-error' : warn ? 'bg-warn' : 'bg-primary'}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      )}
      {over ? <p className="mt-1 text-error">{tl(lang, 'storage.full')}</p> : warn ? <p className="mt-1 text-warn">{tl(lang, 'storage.nearlyFull', { percent: Math.round((ratio ?? 0) * 100) })}</p> : null}
    </div>
  );
}
