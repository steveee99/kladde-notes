import { Check } from '../lib/icons';

/** Material 3 switch: 52×32 track, handle grows from 16 to 24 dp when selected and shows a check icon */
export function Switch({
  id,
  checked,
  disabled,
  label,
  onChange,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-8 w-[52px] shrink-0 items-center rounded-full border-2 p-0.5 transition-colors ${
        disabled ? 'cursor-not-allowed opacity-[0.38]' : 'group cursor-pointer'
      } ${checked ? 'border-primary bg-primary' : 'border-outline bg-surface-container-highest'}`}
    >
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform duration-150 ${
          checked ? 'translate-x-5 bg-on-primary text-on-primary-container' : 'translate-x-0 scale-[0.667] bg-outline text-surface-container-highest group-hover:bg-on-surface-variant'
        }`}
      >
        {checked && <Check size={16} />}
      </span>
    </button>
  );
}
