import { useState } from 'react';
import { ACCENTS, type Accent, type Me } from '@kladde/shared';
import { chooseAccent, useAccent } from '../lib/accent';
import { Check } from '../lib/icons';
import { t, useLang } from '../lib/i18n';

/** The swatch color of each preset in the current scheme comes from CSS (`.accent-swatch[data-swatch]`) */
export function AccentPicker({ onMe }: { onMe: (me: Me) => void }) {
  useLang();
  const accent = useAccent();
  const [error, setError] = useState('');
  const pick = (a: Accent) => {
    setError('');
    chooseAccent(a, onMe).catch((err: Error) => setError(err.message || t('settings.accentError')));
  };
  return (
    <div>
      <div role="radiogroup" aria-label={t('settings.accentTitle')} className="flex flex-wrap gap-x-1.5 gap-y-3">
        {ACCENTS.map((a) => {
          const active = a === accent;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pick(a)}
              data-accent-choice={a}
              className="group flex w-[4.25rem] flex-col items-center gap-1.5 rounded-md py-1 outline-none"
            >
              <span
                data-swatch={a}
                className={`accent-swatch flex h-9 w-9 items-center justify-center rounded-full group-focus-visible:ring-2 group-focus-visible:ring-acc group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-bg ${
                  active ? 'ring-2 ring-offset-[3px] ring-offset-bg' : ''
                }`}
              >
                {active && <Check size={20} className="accent-swatch-tick" />}
              </span>
              <span className={`text-body-s ${active ? 'text-text' : 'text-muted'}`}>{t(`settings.accent.${a}`)}</span>
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-body-s text-red">
          {error}
        </p>
      )}
    </div>
  );
}
