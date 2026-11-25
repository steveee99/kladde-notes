import { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { parseMarkdownForExport, safeUrl } from '@kladde/shared';
import { renderDiagram, setPaperDiagrams, type DiagramKind } from '../editor/diagram';

/**
 * Browser print. The editor only keeps what is on screen in the DOM and renders the rest when printing starts; there is
 * no time left to load anything then, so the images and diagrams of the open notes are prepared before the dialog opens.
 */

/** Text of the notes on screen (two in split view) */
const openNotes = new Set<() => string>();
/** Keeps the prepared images alive, so the ones the editor creates for printing show up at once */
let held: HTMLImageElement[] = [];
/** Longest wait for images and diagrams before printing without them */
const MAX_WAIT = 8000;

function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
    held.push(img);
  });
}

async function prepare(): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const urls = new Set<string>();
  for (const textOf of openNotes) {
    const text = textOf();
    for (const b of parseMarkdownForExport('', text).blocks) {
      if (b.type === 'image') urls.add(b.url);
      else if (b.type === 'code' && (b.lang === 'mermaid' || b.lang === 'mindmap')) jobs.push(renderDiagram(b.lang as DiagramKind, b.code, true));
    }
    // Images in text, lists and quotes
    for (const m of text.matchAll(/!\[[^\]\n]{0,500}\]\(([^)\s]+)/g)) urls.add(m[1]);
  }
  held = [];
  for (const url of urls) {
    const src = safeUrl(url, 'media', true);
    if (src) jobs.push(preload(src));
  }
  // Diagrams of embedded notes on screen
  document.querySelectorAll<HTMLElement>('.wz-diagram[data-kind][data-src]').forEach((el) => {
    jobs.push(renderDiagram(el.dataset.kind as DiagramKind, el.dataset.src ?? '', true));
  });
  await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, MAX_WAIT))]);
}

let preparing = false;

/** Opens the browser's print dialog for the open note */
export async function printNote(): Promise<void> {
  if (preparing) return;
  preparing = true;
  try {
    await prepare();
    await new Promise((r) => requestAnimationFrame(r));
  } finally {
    preparing = false;
  }
  window.print();
}

/**
 * CodeMirror renders the whole note when the print media query changes. Chromium has counted the pages by then (from the
 * estimated height), and the end of the note would be missing: the same handler runs on `beforeprint` already.
 */
function renderEditorsInFull(): void {
  document.querySelectorAll<HTMLElement>('.cm-editor').forEach((el) => {
    const view = EditorView.findFromDOM(el) as unknown as { observer?: { onPrint?: (e: { type: string }) => void } } | null;
    view?.observer?.onPrint?.({ type: 'beforeprint' });
  });
}

/** The component shows this note: printing (the menu or Ctrl/Cmd+P) prepares its images and diagrams */
export function usePrintable(content: string): void {
  const text = useRef(content);
  useEffect(() => {
    text.current = content;
  }, [content]);
  useEffect(() => {
    const get = () => text.current;
    openNotes.add(get);
    return () => void openNotes.delete(get);
  }, []);
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!openNotes.size || e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'p') return;
    e.preventDefault();
    void printNote();
  });
  // While printing, images load at once and diagrams take their paper colors
  window.addEventListener('beforeprint', () => {
    document.querySelectorAll<HTMLImageElement>('.cm-editor img[loading="lazy"]').forEach((img) => (img.loading = 'eager'));
    setPaperDiagrams(true);
    renderEditorsInFull();
  });
  window.addEventListener('afterprint', () => setPaperDiagrams(false));
}
