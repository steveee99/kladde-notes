import { useEffect, useRef, useState } from 'react';
import { isDatabasePath, projectTitleOf } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { Plus, X } from '../lib/icons';
import { t, useLang } from '../lib/i18n';
import { navigate, usePath } from '../lib/router';
import { closeTab, moveTab, neighborTab, pruneTabs, touchTab, useTabs } from '../lib/tabs';
import { folderOfRoute, newNote } from './Shell';

const DRAG_MIME = 'application/x-kladde-tab';

/** The note of the main pane, from the route */
export function openNoteOfPath(path: string): string | null {
  return path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
}

/** Closes a tab; when it was the open note, the neighbouring tab (or the note list) opens */
export function closeNoteTab(id: string, activeId: string | null): void {
  const next = closeTab(id);
  if (id !== activeId) return;
  navigate(next ? `/n/${next}` : '/notes');
}

/** Ctrl/⌘+Alt+PageDown / PageUp switch to the next / previous tab */
function useTabShortcuts(activeId: string | null) {
  const active = useRef(activeId);
  active.current = activeId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      const dir = e.key === 'PageDown' ? 1 : e.key === 'PageUp' ? -1 : 0;
      if (!dir) return;
      const next = neighborTab(active.current, dir);
      if (!next) return;
      e.preventDefault();
      navigate(`/n/${next}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Notes get a tab, database notes (a folder's settings) do not */
const hasTab = (id: string): boolean => {
  const note = vault.get(id);
  return !!note && !isDatabasePath(note.path);
};

/**
 * Tab row of open notes above the content (desktop). Opening a note adds a tab next to the active one; a click
 * switches, the × or a middle click closes, tabs can be dragged into another order.
 */
export function NoteTabs() {
  const version = useVault();
  useLang();
  const path = usePath();
  const ids = useTabs();
  const activeId = openNoteOfPath(path);
  const lastActive = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useTabShortcuts(activeId);

  // Opening a note gives it a tab (next to the tab that was active before)
  useEffect(() => {
    if (!activeId) return;
    if (hasTab(activeId)) touchTab(activeId, lastActive.current);
    lastActive.current = activeId;
  }, [activeId, version]);

  // Notes that are gone lose their tab once the vault has loaded
  useEffect(() => {
    if (vault.list().length) pruneTabs(hasTab);
  }, [version]);

  // The active tab stays in view
  useEffect(() => {
    rowRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, ids]);

  const roleConfig = vault.roleConfig();
  const tabs = ids.map((id) => vault.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
  if (!tabs.length) return null;

  return (
    <nav aria-label={t('tabs.label')} className="no-print hidden h-[38px] shrink-0 items-stretch border-b border-line bg-panel nav:flex">
      <div ref={rowRef} className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-thin">
        {tabs.map((n, i) => {
          const title = projectTitleOf(n.path, n.content, roleConfig) || t('common.unnamed');
          const active = n.id === activeId;
          return (
            <div
              key={n.id}
              data-note-tab={n.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, n.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
                e.preventDefault();
                setDragOver(i);
              }}
              onDragLeave={() => setDragOver((x) => (x === i ? null : x))}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(DRAG_MIME);
                setDragOver(null);
                if (id) moveTab(id, i);
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                closeNoteTab(n.id, activeId);
              }}
              className={`group relative flex min-w-0 max-w-[220px] shrink-0 items-center border-r border-line ${
                active ? 'bg-bg text-text shadow-[inset_0_2px_0_rgb(var(--acc))]' : 'text-muted hover:bg-raised/60 hover:text-text'
              } ${dragOver === i ? 'shadow-[inset_2px_0_0_rgb(var(--acc))]' : ''}`}
            >
              <a
                href={`/n/${n.id}`}
                aria-current={active ? 'page' : undefined}
                title={title}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(`/n/${n.id}`);
                }}
                className="min-w-0 truncate py-2 pl-3.5 pr-1 text-body-m text-inherit no-underline outline-none focus-visible:underline"
              >
                {title}
              </a>
              <button
                type="button"
                onClick={() => closeNoteTab(n.id, activeId)}
                aria-label={t('tabs.close', { name: title })}
                title={t('tabs.closeTitle')}
                className={`mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted outline-none hover:bg-line hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-acc ${
                  active ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="edit-only flex w-10 shrink-0 items-center justify-center text-muted outline-none hover:bg-raised hover:text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-acc"
        onClick={() => newNote(folderOfRoute(path) ?? undefined)}
        aria-label={t('nav.newNote')}
        title={t('nav.newNote')}
      >
        <Plus size={16} />
      </button>
    </nav>
  );
}
