import type { TicketKind } from '@kladde/shared';
import { t, type I18nKey } from '../lib/i18n';
import { BugReport, CheckSquare, Stars, SubdirectoryArrowRight, Zap } from '../lib/icons';

export const kindLabel = (k: TicketKind) => t(`tickets.kind.${k}` as I18nKey);

const KIND_ICON: Record<TicketKind, { Icon: typeof Zap; tone: string }> = {
  epic: { Icon: Zap, tone: 'text-violet' },
  feature: { Icon: Stars, tone: 'text-green' },
  task: { Icon: CheckSquare, tone: 'text-acc' },
  bug: { Icon: BugReport, tone: 'text-red' },
  subtask: { Icon: SubdirectoryArrowRight, tone: 'text-muted' },
};

/** Ticket type as an icon in its color (epic violet, feature green, task accent, bug red, subtask muted) */
export function KindIcon({ kind, size = 16, className = '' }: { kind: TicketKind; size?: number; className?: string }) {
  const { Icon, tone } = KIND_ICON[kind];
  return (
    <span className={`inline-flex shrink-0 ${tone} ${className}`} title={kindLabel(kind)} aria-label={kindLabel(kind)} role="img">
      <Icon size={size} />
    </span>
  );
}

