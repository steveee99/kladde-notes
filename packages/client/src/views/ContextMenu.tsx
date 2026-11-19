import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from '../lib/icons';

export interface MenuAction {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onSelect: () => void;
  /** Shown in the error color (delete) */
  danger?: boolean;
  title?: string;
}

/** Where a menu opens: below a button or at the pointer (right click) */
export type MenuAnchor = { x: number; y: number } | { rect: DOMRect };

/**
 * A Material 3 menu in a portal (the sidebar may be transformed in the mobile drawer, which traps fixed overlays).
 * Closes on a click outside, Escape, scrolling (wheel, touch) and resize; arrow keys move between the items; focus returns to `returnFocus`.
 */
export function ContextMenu({
  anchor,
  actions,
  label,
  onClose,
  returnFocus,
}: {
  anchor: MenuAnchor;
  actions: MenuAction[];
  label: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if ('rect' in anchor) {
      left = anchor.rect.right - w;
      top = anchor.rect.bottom + 4;
      if (top + h > vh - margin) top = anchor.rect.top - h - 4;
    } else {
      left = anchor.x;
      top = anchor.y;
      if (top + h > vh - margin) top = anchor.y - h;
    }
    setPos({ left: Math.max(margin, Math.min(left, vw - w - margin)), top: Math.max(margin, Math.min(top, vh - h - margin)) });
  }, [anchor]);

  useEffect(() => {
    const close = () => onClose();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        returnFocus?.focus();
      }
    };
    // Scrolling by the user closes it; scrolling the app does itself (revealing the open note) does not
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', onScroll, { capture: true, passive: true });
    window.addEventListener('touchmove', onScroll, { capture: true, passive: true });
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('touchmove', onScroll, true);
    };
  }, [onClose, returnFocus]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="m3-menu anim-m3-menu fixed z-[95] min-w-[200px] max-w-[280px]"
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          onClose();
          returnFocus?.focus();
          return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[next]?.focus();
      }}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          role="menuitem"
          title={a.title}
          className={`m3-menu-item w-full text-left ${a.danger ? '!text-error [&_svg]:!text-error' : ''}`}
          onClick={() => {
            onClose();
            a.onSelect();
          }}
        >
          <a.icon size={18} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}

/**
 * Item menu for a tree row: returns the props for the row (right click, Shift+F10 / the context menu key)
 * and a three-dot button plus the open menu. With no actions there is neither button nor menu.
 */
export function useItemMenu(actions: MenuAction[], label: string) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const enabled = actions.length > 0;
  const close = useRef(() => setAnchor(null)).current;

  const rowProps = enabled
    ? {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setAnchor({ x: e.clientX, y: e.clientY });
        },
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            setAnchor({ rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
          }
        },
      }
    : {};

  const button = enabled ? (
    <button
      ref={buttonRef}
      type="button"
      className="shrink-0 rounded-full p-1 hover:bg-surface-container-low hover:text-on-surface"
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={!!anchor}
      onClick={(e) => {
        e.stopPropagation();
        setAnchor(anchor ? null : { rect: e.currentTarget.getBoundingClientRect() });
      }}
    >
      <MoreVertical size={15} />
    </button>
  ) : null;

  const menu = anchor ? <ContextMenu anchor={anchor} actions={actions} label={label} onClose={close} returnFocus={buttonRef.current} /> : null;
  return { rowProps, button, menu, open: !!anchor };
}
