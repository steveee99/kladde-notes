import { useState } from 'react';
import { cleanIcon, ICON_CHOICES } from '@kladde/shared';
import { t, useLang } from '../lib/i18n';
import { Sheet } from './Dialogs';

/** A note or folder icon (one emoji) in a box of `size` px, so rows with and without icons line up */
export function ItemIcon({ icon, size = 15, className = '' }: { icon: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 select-none items-center justify-center leading-none ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.9) }}
    >
      {icon}
    </span>
  );
}

/**
 * Picks the icon of a note or folder (opt-in feature `icons`): a choice of common emoji, a field for
 * any other emoji (typed or pasted, e.g. from the system emoji keyboard) and "remove".
 */
export function IconPickerDialog({
  title,
  current,
  onPick,
  onClose,
}: {
  title: string;
  current: string | null;
  onPick: (icon: string | null) => void;
  onClose: () => void;
}) {
  useLang();
  const [custom, setCustom] = useState('');
  const customIcon = cleanIcon(custom);
  const pick = (icon: string | null) => {
    onPick(icon);
    onClose();
  };
  return (
    <Sheet title={title} onClose={onClose}>
      <div role="listbox" aria-label={t('icons.choose')} className="grid grid-cols-8 gap-1 sm:grid-cols-10">
        {ICON_CHOICES.map((icon) => (
          <button
            key={icon}
            type="button"
            role="option"
            aria-selected={icon === current}
            onClick={() => pick(icon)}
            className={`state-layer flex aspect-square items-center justify-center rounded-xl text-[22px] leading-none transition-colors ${
              icon === current ? 'bg-secondary-container ring-2 ring-inset ring-primary' : 'hover:bg-surface-container-highest'
            }`}
          >
            {icon}
          </button>
        ))}
      </div>
      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (customIcon) pick(customIcon);
        }}
      >
        <input
          className="input min-w-0 flex-1"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={t('icons.customPlaceholder')}
          aria-label={t('icons.customPlaceholder')}
          aria-invalid={!!custom.trim() && !customIcon}
        />
        <button type="submit" className="btn-tonal shrink-0" disabled={!customIcon}>
          {t('icons.use')}
        </button>
      </form>
      {!!custom.trim() && !customIcon && <p className="mt-1.5 text-body-s text-error">{t('icons.invalid')}</p>}
      <div className="mt-5 flex justify-end gap-2">
        {current && (
          <button type="button" className="btn-text" onClick={() => pick(null)}>
            {t('icons.remove')}
          </button>
        )}
        <button type="button" className="btn-outlined" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </Sheet>
  );
}
