import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from '../lib/icons';
import { tl, useLang } from '../lib/i18n';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps {
  id?: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  variant?: 'field' | 'chip' | 'ghost';
  placeholder?: string;
  leadingIcon?: React.ReactNode;
  className?: string;
  menuClassName?: string;
  disabled?: boolean;
  title?: string;
  'aria-label'?: string;
  onClick?: (e: React.MouseEvent) => void;
}

interface MenuCoords {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  direction: 'down' | 'up';
}

export function Dropdown({
  id,
  value,
  options,
  onChange,
  variant = 'field',
  placeholder,
  leadingIcon,
  className = '',
  menuClassName = '',
  disabled = false,
  title,
  'aria-label': ariaLabel,
  onClick,
}: DropdownProps) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const resolvedPlaceholder = placeholder ?? tl(lang, 'common.selectPlaceholder');
  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label ?? resolvedPlaceholder;

  const updatePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const vpLeft = vv?.offsetLeft ?? 0;
    const vpTop = vv?.offsetTop ?? 0;
    const vpWidth = vv?.width ?? window.innerWidth;
    const vpHeight = vv?.height ?? window.innerHeight;
    const margin = 8;

    const maxWidth = Math.max(160, vpWidth - margin * 2);
    const minWidth = Math.min(Math.max(rect.width, 180), maxWidth);
    const measuredWidth = menuRef.current?.offsetWidth ?? minWidth;
    const targetWidth = Math.min(Math.max(minWidth, measuredWidth), maxWidth);
    const left = Math.max(vpLeft + margin, Math.min(rect.left, vpLeft + vpWidth - targetWidth - margin));

    const spaceBelow = vpTop + vpHeight - rect.bottom - margin;
    const spaceAbove = rect.top - vpTop - margin;
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;

    if (openUp) {
      setCoords({
        bottom: window.innerHeight - rect.top + 6,
        left,
        minWidth,
        maxWidth,
        maxHeight: Math.max(120, Math.min(320, spaceAbove)),
        direction: 'up',
      });
    } else {
      setCoords({
        top: rect.bottom + 6,
        left,
        minWidth,
        maxWidth,
        maxHeight: Math.max(120, Math.min(320, spaceBelow)),
        direction: 'down',
      });
    }
  };

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const idx = options.findIndex((o) => o.value === value && !o.disabled);
    setActiveIndex(idx >= 0 ? idx : options.findIndex((o) => !o.disabled));
    updatePosition();
    // Re-measure once mounted so right-edge clamping uses actual menu width
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
  }, [open, value, options.length]);

  const scrollItemIntoMenu = (el: HTMLElement | null | undefined) => {
    const menu = menuRef.current;
    if (!menu || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < menu.scrollTop) menu.scrollTop = top - 6;
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight + 6;
  };

  useEffect(() => {
    if (!open || !coords) return;
    const selectedEl = menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    scrollItemIntoMenu(selectedEl);
  }, [open, coords !== null]);

  useEffect(() => {
    if (!open) return;
    const anchorRect = triggerRef.current?.getBoundingClientRect();
    const anchorTop = anchorRect?.top ?? 0;
    const anchorLeft = anchorRect?.left ?? 0;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      if (target === document || target === window || (target instanceof Element && target.contains(triggerRef.current))) {
        const now = triggerRef.current?.getBoundingClientRect();
        if (now && Math.abs(now.top - anchorTop) < 6 && Math.abs(now.left - anchorLeft) < 6) return;
        setOpen(false);
      }
    };
    const onResize = () => updatePosition();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [open]);

  const selectOption = (opt: DropdownOption) => {
    if (opt.disabled) return;
    setOpen(false);
    if (opt.value !== value) onChange(opt.value);
    triggerRef.current?.focus();
  };

  const moveActive = (delta: number) => {
    if (!options.length) return;
    let i = activeIndex;
    for (let step = 0; step < options.length; step++) {
      i = (i + delta + options.length) % options.length;
      if (!options[i].disabled) {
        setActiveIndex(i);
        const item = menuRef.current?.children[i] as HTMLElement | undefined;
        scrollItemIntoMenu(item);
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const first = options.findIndex((o) => !o.disabled);
      if (first >= 0) setActiveIndex(first);
    } else if (e.key === 'End') {
      e.preventDefault();
      for (let i = options.length - 1; i >= 0; i--) {
        if (!options[i].disabled) {
          setActiveIndex(i);
          break;
        }
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[activeIndex];
      if (opt && !opt.disabled) selectOption(opt);
    }
  };

  const triggerVariantClass =
    variant === 'chip'
      ? `m3-select-chip chip min-w-0 max-w-full cursor-pointer justify-between gap-1.5 text-left transition-colors ${open ? '!border-primary bg-primary/10 text-on-surface' : ''}`
      : variant === 'ghost'
        ? `m3-select-ghost inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-surface-container-high ${open ? 'bg-surface-container-high text-on-surface' : ''}`
        : `m3-select-field input flex min-w-0 items-center justify-between gap-2 text-left text-sm ${open ? '!border-primary ring-2 ring-primary/25' : ''}`;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          onClick?.(e);
          if (!disabled) setOpen((v) => !v);
        }}
        className={`${triggerVariantClass} ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
      >
        {leadingIcon}
        <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
        <ChevronDown
          size={variant === 'chip' ? 13 : 16}
          className={`shrink-0 text-on-surface-variant transition-transform duration-200 ${open ? 'rotate-180 text-primary' : ''}`}
        />
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            id={listId}
            role="listbox"
            data-m3-menu="true"
            aria-label={ariaLabel}
            style={
              coords
                ? {
                    position: 'fixed',
                    left: `${coords.left}px`,
                    ...(coords.top !== undefined ? { top: `${coords.top}px` } : {}),
                    ...(coords.bottom !== undefined ? { bottom: `${coords.bottom}px` } : {}),
                    minWidth: `${coords.minWidth}px`,
                    maxWidth: `${coords.maxWidth}px`,
                    maxHeight: `${coords.maxHeight}px`,
                    transformOrigin: coords.direction === 'up' ? 'bottom center' : 'top center',
                  }
                : { position: 'fixed', left: '-9999px', top: '-9999px' }
            }
            className={`m3-menu z-[100] overflow-y-auto scrollbar-thin ${coords ? 'anim-m3-menu' : 'opacity-0'} ${menuClassName}`}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isHighlighted = idx === activeIndex;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled}
                  data-highlighted={isHighlighted ? 'true' : undefined}
                  onMouseEnter={() => !opt.disabled && setActiveIndex(idx)}
                  onMouseDown={(e) => {
                    // Keep focus behavior clean on desktop while executing selection on click
                    e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectOption(opt);
                  }}
                  className="m3-menu-item"
                >
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {isSelected && <Check size={16} className="shrink-0" />}
                </li>
              );
            })}
          </ul>,
          document.body
        )}
    </>
  );
}
