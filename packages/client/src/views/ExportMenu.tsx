import { useEffect, useRef, useState } from 'react';
import { Download, FileCode, FileSpreadsheet, FileText, Loader2, Printer } from 'lucide-react';
import { safeExportFilename, stripFrontmatter } from '@kladde/shared';

interface ExportMenuProps {
  title: string;
  content: string;
}

export function ExportMenu({ title, content }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'word' | 'pdf' | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

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
      alert(`Export fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={root} className="relative no-print">
      <button
        className="btn-icon"
        title="Exportieren"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy !== null}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1.5 w-56 rounded-2xl border border-line bg-surface p-1.5 shadow-soft anim-fade-in"
        >
          <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Export ohne Frontmatter</div>
          <button
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-raised"
            onClick={exportMarkdown}
          >
            <FileCode size={16} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Markdown (.md)</div>
              <div className="text-xs text-faint">Reiner Text</div>
            </div>
          </button>
          <button
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-raised"
            onClick={() => void runAsync('word')}
          >
            <FileSpreadsheet size={16} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Word (.docx)</div>
              <div className="text-xs text-faint">Formatiertes Dokument</div>
            </div>
          </button>
          <button
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-raised"
            onClick={() => void runAsync('pdf')}
          >
            <FileText size={16} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">PDF (.pdf)</div>
              <div className="text-xs text-faint">Direkt herunterladen</div>
            </div>
          </button>
          <div className="my-1 border-t border-line" />
          <button
            role="menuitem"
            className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
            onClick={() => {
              setOpen(false);
              requestAnimationFrame(() => window.print());
            }}
          >
            <Printer size={16} className="shrink-0" />
            <span>Drucken …</span>
          </button>
        </div>
      )}
    </div>
  );
}
