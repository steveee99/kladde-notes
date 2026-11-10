import { Children, isValidElement, type ReactNode } from 'react';
import { Dropdown, type DropdownOption } from './Dropdown';

export interface ChipSelectProps {
  value: string;
  onChange: (value: string) => void;
  children?: ReactNode;
  options?: DropdownOption[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * Material 3 styled filter/select chip with an exposed listbox menu instead of a native `<select>`.
 */
export function ChipSelect({
  value,
  onChange,
  children,
  options,
  className = '',
  placeholder,
  disabled,
  title,
  'aria-label': ariaLabel,
  onClick,
}: ChipSelectProps) {
  const resolvedOptions: DropdownOption[] =
    options ??
    Children.toArray(children)
      .filter((child): child is React.ReactElement<{ value?: string; disabled?: boolean; children?: ReactNode }> => isValidElement(child))
      .map((el) => ({
        value: String(el.props.value ?? ''),
        label: Children.toArray(el.props.children).map(String).join(''),
        disabled: el.props.disabled,
      }));

  return (
    <Dropdown
      variant="chip"
      value={value}
      options={resolvedOptions}
      onChange={onChange}
      className={className}
      placeholder={placeholder}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    />
  );
}
