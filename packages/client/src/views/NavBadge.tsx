/**
 * Count badge of a navigation destination, in the user's accent color. One look for the expanded sidebar, the navigation rail
 * and the mobile navigation bar: `warn` for things that need attention (overdue tasks, a full
 * Inbox), `muted` for counts worth a glance, `plain` (same box, no fill) for counts that are only
 * information, `dot` for a due state without a number. All share one box, so numbers line up.
 */
export function NavBadge({ count = 0, tone = 'muted', dot, className = '' }: { count?: number; tone?: 'warn' | 'muted' | 'plain'; dot?: boolean; className?: string }) {
  if (dot) return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full bg-acc ${className}`} />;
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      className={`h-5 min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] leading-5 tabular-nums ${
        tone === 'warn' ? 'bg-acc font-semibold text-on-acc' : tone === 'plain' ? 'font-medium text-muted' : 'bg-acc-bg font-semibold text-acc-hi'
      } ${className}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
