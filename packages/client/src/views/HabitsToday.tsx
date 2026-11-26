import { useMemo } from 'react';
import { toDateString } from '@kladde/shared';
import { useVault } from '../data/vault';
import { habitHistory, habits as loadHabits, setCheckin } from '../data/habits';
import { Check } from '../lib/icons';
import { useLang } from '../lib/i18n';
import { useReadOnly } from '../lib/readOnly';
import { showToast } from '../lib/toast';

const fail = (err: unknown) => showToast((err as Error).message, 'danger');

/** Today's open habits on the home page, to check off in passing */
export function HabitsToday() {
  const version = useVault();
  useLang();
  const locked = useReadOnly();
  const today = toDateString(new Date());
  const list = useMemo(() => loadHabits(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => habitHistory(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3.5 py-3" data-habits-today>
      {list.map((h) => {
        const on = !!history.get(h.id)?.has(today);
        return (
          <button
            key={h.id}
            type="button"
            className="chip"
            aria-pressed={on}
            disabled={locked}
            onClick={() => void setCheckin(h, today, !on).catch(fail)}
          >
            {on ? <Check size={14} /> : h.icon ? <span aria-hidden>{h.icon}</span> : null} {h.name}
          </button>
        );
      })}
    </div>
  );
}
