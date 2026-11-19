import { useRef, useState } from 'react';
import { t, useLang } from '../lib/i18n';
import { sidebarWidth, useWidth, type WidthStore } from '../lib/sidebarWidth';

const STEP = 16;

/**
 * Drag handle on the edge of a resizable panel: pointer drag, arrow keys (Shift for bigger steps),
 * Home/End for the limits, double-click resets. The width is saved per device on release.
 * `edge: 'right'` sits on the right edge of a left panel (dragging right widens it), `'left'` on the left
 * edge of a right panel (dragging left widens it).
 */
export function ResizeHandle({ store, edge, label, className = '' }: { store: WidthStore; edge: 'left' | 'right'; label: string; className?: string }) {
  const width = useWidth(store);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const dir = edge === 'right' ? 1 : -1;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={store.min}
      aria-valuemax={store.max}
      aria-valuenow={width}
      title={label}
      tabIndex={0}
      className={`group absolute inset-y-4 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none ${edge === 'right' ? '-right-1.5' : '-left-1.5'} ${className}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (start.current) store.set(start.current.width + dir * (e.clientX - start.current.x), false);
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        store.set(start.current.width + dir * (e.clientX - start.current.x));
        start.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        if (start.current) store.set(start.current.width);
        start.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => store.set(store.fallback)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? STEP * 4 : STEP;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = width - dir * step;
        else if (e.key === 'ArrowRight') next = width + dir * step;
        else if (e.key === 'Home') next = store.min;
        else if (e.key === 'End') next = store.max;
        if (next === null) return;
        e.preventDefault();
        store.set(next);
      }}
    >
      <span
        aria-hidden
        className={`h-full w-0.5 rounded-full transition-colors group-hover:bg-primary group-focus-visible:bg-primary ${dragging ? 'bg-primary' : 'bg-transparent'}`}
      />
    </div>
  );
}

/** Handle on the right edge of the expanded left sidebar */
export function SidebarResizeHandle() {
  useLang();
  return <ResizeHandle store={sidebarWidth} edge="right" label={t('nav.resizeSidebar')} />;
}
