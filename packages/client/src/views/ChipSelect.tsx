import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * A <select> styled as a chip. The native control draws its own arrow (on iOS outside the rounded
 * background); here it is hidden and a chevron sits inside the chip instead.
 */
export function ChipSelect({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`chip relative cursor-pointer gap-0 p-0 overflow-hidden focus-within:ring-2 focus-within:ring-accent/25 ${className}`}>
      <select {...props} className="w-full max-w-full min-w-0 cursor-pointer appearance-none truncate rounded-full bg-transparent py-1 pl-2.5 pr-6 leading-tight text-inherit outline-none">
        {children}
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" />
    </span>
  );
}
