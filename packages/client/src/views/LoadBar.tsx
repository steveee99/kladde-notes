/**
 * A loading bar with a caption: filled to `value` (0…1), or running back and forth while the share is unknown.
 * Used where a page waits for the server or a long computation (online mode: graph, query blocks).
 */
export function LoadBar({ label, value, detail, className = '' }: { label: string; value?: number | null; detail?: string; className?: string }) {
  const pct = value == null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={`w-full max-w-sm space-y-2 ${className}`}>
      <div className="flex items-baseline justify-between gap-3 text-body-s text-muted">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-faint">{pct != null ? `${pct} %` : detail ?? ''}</span>
      </div>
      <div
        className="load-bar h-1 overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct == null ? detail || label : undefined}
      >
        {pct != null ? <div className="h-full rounded-full bg-acc transition-[width] duration-200" style={{ width: `${pct}%` }} /> : <div className="load-bar-run h-full w-1/3 rounded-full bg-acc" />}
      </div>
    </div>
  );
}
