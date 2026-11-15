import { useRef, useState } from 'react';
import { t, useLang } from '../lib/i18n';
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, setSidebarWidth, useSidebarWidth } from '../lib/sidebarWidth';

const STEP = 16;

/**
 * Drag handle on the right edge of the expanded sidebar: pointer drag, arrow keys (Shift for bigger
 * steps), Home/End for the limits, double-click resets. The width is saved per device on release.
 */
export function SidebarResizeHandle() {
  useLang();
  const width = useSidebarWidth();
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('nav.resizeSidebar')}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuenow={width}
      title={t('nav.resizeSidebar')}
      tabIndex={0}
      className="group absolute inset-y-4 -right-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (start.current) setSidebarWidth(start.current.width + e.clientX - start.current.x, false);
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        setSidebarWidth(start.current.width + e.clientX - start.current.x);
        start.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        if (start.current) setSidebarWidth(start.current.width);
        start.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? STEP * 4 : STEP;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = width - step;
        else if (e.key === 'ArrowRight') next = width + step;
        else if (e.key === 'Home') next = SIDEBAR_WIDTH_MIN;
        else if (e.key === 'End') next = SIDEBAR_WIDTH_MAX;
        if (next === null) return;
        e.preventDefault();
        setSidebarWidth(next);
      }}
    >
      <span
        aria-hidden
        className={`h-full w-0.5 rounded-full transition-colors group-hover:bg-primary group-focus-visible:bg-primary ${dragging ? 'bg-primary' : 'bg-transparent'}`}
      />
    </div>
  );
}
