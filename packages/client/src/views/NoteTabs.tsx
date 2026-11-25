import { useCallback, useEffect, useRef, useState } from 'react';
import { isHiddenPath, projectTitleOf } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { FirstPage, Keep, KeepOff, Plus, TabClose, TabCloseRight, X } from '../lib/icons';
import { t, useLang } from '../lib/i18n';
import { navigate, usePath } from '../lib/router';
import { closeOtherTabs, closeTab, closeTabsBeside, isPinnedTab, moveTab, neighborTab, pruneTabs, setTabPinned, touchTab, usePinnedTabs, useTabs } from '../lib/tabs';
import { ContextMenu, type MenuAction, type MenuAnchor } from './ContextMenu';
import { folderOfRoute, newNote } from './Shell';

const DRAG_MIME = 'application/x-kladde-tab';

/** The note of the main pane, from the route */
export function openNoteOfPath(path: string): string | null {
  return path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
}

/** Closes a tab; when it was the open note, the neighbouring tab (or the note list) opens. Pinned tabs stay. */
export function closeNoteTab(id: string, activeId: string | null): void {
  if (isPinnedTab(id)) return;
  const next = closeTab(id);
  if (id !== activeId) return;
  navigate(next ? `/n/${next}` : '/notes');
}

/** After closing several tabs: when the open note lost its tab, show the suggested one */
function followClose(next: string | null): void {
  if (next) navigate(`/n/${next}`);
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
  return !!note && !isHiddenPath(note.path);
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
  const pinned = usePinnedTabs();
  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor; returnFocus: HTMLElement | null } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
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

  const menuActions = (id: string): MenuAction[] => {
    const at = ids.indexOf(id);
    const isPinned = pinned.includes(id);
    const closable = (i: number) => !pinned.includes(ids[i]);
    const actions: (MenuAction | false)[] = [
      { icon: isPinned ? KeepOff : Keep, label: t(isPinned ? 'tabs.unpin' : 'tabs.pin'), onSelect: () => setTabPinned(id, !isPinned) },
      !isPinned && { icon: X, label: t('tabs.closeOne'), onSelect: () => closeNoteTab(id, activeId) },
      ids.some((x, i) => x !== id && closable(i)) && {
        icon: TabClose,
        label: t('tabs.closeOthers'),
        onSelect: () => {
          closeOtherTabs(id);
          if (activeId && activeId !== id && !pinned.includes(activeId)) navigate(`/n/${id}`);
        },
      },
      ids.some((_, i) => i > at && closable(i)) && { icon: TabCloseRight, label: t('tabs.closeRight'), onSelect: () => followClose(closeTabsBeside(id, 1, activeId)) },
      ids.some((_, i) => i < at && closable(i)) && { icon: FirstPage, label: t('tabs.closeLeft'), onSelect: () => followClose(closeTabsBeside(id, -1, activeId)) },
    ];
    return actions.filter((a): a is MenuAction => !!a);
  };

  return (
    <nav aria-label={t('tabs.label')} className="no-print hidden h-[38px] shrink-0 items-stretch border-b border-line bg-panel nav:flex">
      <div ref={rowRef} className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-thin">
        {tabs.map((n, i) => {
          const title = projectTitleOf(n.path, n.content, roleConfig) || t('common.unnamed');
          const active = n.id === activeId;
          const isPinned = pinned.includes(n.id);
          return (
            <div
              key={n.id}
              data-note-tab={n.id}
              data-pinned={isPinned || undefined}
              draggable
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: n.id, anchor: { x: e.clientX, y: e.clientY }, returnFocus: e.currentTarget.querySelector('a') });
              }}
              onKeyDown={(e) => {
                if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
                e.preventDefault();
                setMenu({ id: n.id, anchor: { rect: e.currentTarget.getBoundingClientRect() }, returnFocus: e.currentTarget.querySelector('a') });
              }}
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
              className={`group relative flex min-w-0 ${isPinned ? 'max-w-[180px]' : 'max-w-[220px]'} shrink-0 items-center border-r border-line ${
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
              {isPinned ? (
                <button
                  type="button"
                  onClick={() => setTabPinned(n.id, false)}
                  aria-label={t('tabs.unpinNamed', { name: title })}
                  title={t('tabs.unpin')}
                  className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-acc-hi outline-none hover:bg-line focus-visible:ring-2 focus-visible:ring-acc"
                >
                  <Keep size={14} filled />
                </button>
              ) : (
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
              )}
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
      {menu && (
        <ContextMenu
          anchor={menu.anchor}
          actions={menuActions(menu.id)}
          label={t('tabs.menu')}
          onClose={closeMenu}
          returnFocus={menu.returnFocus}
        />
      )}
    </nav>
  );
}
