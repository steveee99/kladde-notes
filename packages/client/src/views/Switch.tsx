/** Werkbank switch: a 36×20 track with a 14px knob (accent when on) inside a 24px tall target */
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
      className={`group inline-flex h-6 w-9 shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-acc focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
        disabled ? 'cursor-not-allowed opacity-[0.38]' : 'cursor-pointer'
      }`}
    >
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors duration-150 ${
          checked ? 'border-acc bg-acc' : 'border-edge bg-sunken group-hover:border-muted'
        }`}
      >
        <span
          className={`absolute left-[2px] h-3.5 w-3.5 rounded-full shadow-sm transition-transform duration-150 ${
            checked ? 'translate-x-4 bg-on-acc' : 'translate-x-0 bg-muted group-hover:bg-soft'
          }`}
        />
      </span>
    </button>
  );
}
