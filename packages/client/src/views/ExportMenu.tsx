import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileCode, FileSpreadsheet, FileText, Loader2, Printer } from '../lib/icons';
import { safeExportFilename, stripFrontmatter } from '@kladde/shared';
import { t, tl, useLang } from '../lib/i18n';

interface ExportMenuProps {
  title: string;
  content: string;
}

export function ExportMenu({ title, content }: ExportMenuProps) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'word' | 'pdf' | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = menuRef.current?.offsetWidth || 224;
    const menuH = menuRef.current?.offsetHeight || 244;
    const left = Math.max(8, Math.min(rect.right - menuW, vw - menuW - 8));
    const fitsBelow = rect.bottom + gap + menuH <= vh - 8;
    const top = fitsBelow || rect.top < menuH + gap + 8 ? Math.max(8, Math.min(rect.bottom + gap, vh - menuH - 8)) : rect.top - gap - menuH;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r || r.bottom <= 0 || r.top >= window.innerHeight) setOpen(false);
      else updatePos();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, updatePos]);

  const exportMarkdown = () => {
    setOpen(false);
    const body = stripFrontmatter(content);
    const finalText = body && !body.endsWith('\n') ? `${body}\n` : body;
    const url = URL.createObjectURL(new Blob([finalText], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = safeExportFilename(title, 'md');
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const runAsync = async (kind: 'word' | 'pdf') => {
    setBusy(kind);
    setOpen(false);
    try {
      const mod = await import('../lib/noteExport');
      if (kind === 'word') await mod.exportNoteAsWord(title, content);
      else await mod.exportNoteAsPdf(title, content);
    } catch (err) {
      alert(t('export.failed', { error: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative no-print">
      <button
        ref={triggerRef}
        type="button"
        className="btn-icon"
        title={tl(lang, 'export.title')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy !== null}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="no-print fixed z-50 w-56 rounded-2xl border border-outline-variant bg-surface-container-low p-1.5 shadow-soft anim-fade-in"
          >
            <div className="px-2.5 py-1 text-label-m text-on-surface-variant">{tl(lang, 'export.headerNoFrontmatter')}</div>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-high"
              onClick={exportMarkdown}
            >
              <FileCode size={16} className="shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{tl(lang, 'export.mdTitle')}</div>
                <div className="text-xs text-on-surface-variant">{tl(lang, 'export.mdDesc')}</div>
              </div>
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-high"
              onClick={() => void runAsync('word')}
            >
              <FileSpreadsheet size={16} className="shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{tl(lang, 'export.wordTitle')}</div>
                <div className="text-xs text-on-surface-variant">{tl(lang, 'export.wordDesc')}</div>
              </div>
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container-high"
              onClick={() => void runAsync('pdf')}
            >
              <FileText size={16} className="shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{tl(lang, 'export.pdfTitle')}</div>
                <div className="text-xs text-on-surface-variant">{tl(lang, 'export.pdfDesc')}</div>
              </div>
            </button>
            <div className="my-1 border-t border-outline-variant" />
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
              onClick={() => {
                setOpen(false);
                requestAnimationFrame(() => window.print());
              }}
            >
              <Printer size={16} className="shrink-0" />
              <span>{tl(lang, 'export.printAction')}</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
