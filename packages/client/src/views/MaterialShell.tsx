import { createContext, useContext, useEffect, useState } from 'react';
import { FileText, Home, Images, Inbox as InboxIcon, Menu, Network, Pencil, Settings, X } from 'lucide-react';
import { INBOX_FOLDER, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate, usePath } from '../lib/router';
import { toggleMaterialSidebarMode, useMaterialSidebarMode } from '../lib/sidebarMode';
import { Dialogs } from './Dialogs';
import { QuickCapture } from './QuickCapture';
import { newNote, ReadOnlyToggle, Sidebar, SyncBadge } from './Shell';
import { t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';

/*
 * Shell of Kladde (Material 3): a navigation rail or sticky navigation drawer on tablet and desktop
 * (toggled cleanly via the 3-line Menu icon), content on a rounded M3 surface container, an optional
 * detached right inspector surface for open notes, and a navigation bar + modal drawer on mobile (< md).
 */

const RightPaneHostContext = createContext<HTMLDivElement | null>(null);

export function useRightPaneHost(): HTMLDivElement | null {
  return useContext(RightPaneHostContext);
}

type Icon = typeof Home;

function RailItem({ to, Icon, label, badge }: { to: string; Icon: Icon; label: string; badge?: number }) {
  const path = usePath();
  const active = path === to;
  return (
    <button onClick={() => navigate(to)} aria-current={active ? 'page' : undefined} className={`flex w-20 flex-col items-center gap-1 text-xs font-medium ${active ? 'text-ink' : 'text-muted hover:text-ink'}`}>
      <span className={`relative flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-200 ${active ? 'bg-accent/20 text-accent' : 'hover:bg-raised'}`}>
        <Icon size={22} />
        {!!badge && <span className="absolute right-2.5 top-0 min-w-4 rounded-full bg-danger px-1 text-center text-[11px] font-semibold leading-4 text-bg">{badge}</span>}
      </span>
      {label}
    </button>
  );
}

function BarItem({ to, Icon, label, badge }: { to: string; Icon: Icon; label: string; badge?: number }) {
  const path = usePath();
  const active = path === to;
  return (
    <button onClick={() => navigate(to)} aria-current={active ? 'page' : undefined} className={`flex flex-col items-center gap-1 pb-4 pt-3 text-xs font-medium ${active ? 'text-ink' : 'text-muted'}`}>
      <span className={`relative flex h-8 w-16 items-center justify-center rounded-full transition-colors duration-200 ${active ? 'bg-accent/20 text-accent' : ''}`}>
        <Icon size={22} />
        {!!badge && <span className="absolute right-3.5 top-0 min-w-4 rounded-full bg-danger px-1 text-center text-[11px] font-semibold leading-4 text-bg">{badge}</span>}
      </span>
      {label}
    </button>
  );
}

export function MaterialShell({ children, isAdmin }: { children: React.ReactNode; isAdmin?: boolean }) {
  useVault();
  useLang();
  const sidebarMode = useMaterialSidebarMode();
  const sticky = sidebarMode === 'sticky';
  const inboxZero = useInboxZero();
  const [drawer, setDrawer] = useState(false);
  const [capture, setCapture] = useState(false);
  const [rightHost, setRightHost] = useState<HTMLDivElement | null>(null);
  const path = usePath();
  const noteId = path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
  const inboxCount = vault.list().filter((n) => n.access === 'owner' && splitPath(n.path).folder === INBOX_FOLDER).length;
  const inboxBadge = inboxZero && inboxCount > 0 ? inboxCount : undefined;

  useEffect(() => {
    const onOpenSearch = () => {
      setDrawer(true);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-search-input]')?.select())
      );
    };
    window.addEventListener('kladde:open-search', onOpenSearch);
    return () => window.removeEventListener('kladde:open-search', onOpenSearch);
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="sticky top-0 z-20 hidden shrink-0 bg-bg [--pad-top:0.375rem] safe-top [@media(display-mode:standalone)]:md:block" />
      <div className="flex min-h-0 flex-1">
        {sticky ? (
          <aside aria-label={t('nav.navigationLabel')} className="m3-status hidden w-[292px] shrink-0 py-4 pl-4 pr-3 md:flex lg:w-[308px]">
            <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-[28px] bg-surface">
              <Sidebar
                isAdmin={isAdmin}
                headerAction={
                  <button
                    type="button"
                    onClick={toggleMaterialSidebarMode}
                    className="btn-icon hidden h-9 w-9 shrink-0 rounded-full md:inline-flex"
                    title={t('nav.toggleSidebar')}
                    aria-label={t('nav.toggleSidebar')}
                  >
                    <Menu size={20} />
                  </button>
                }
              />
            </div>
          </aside>
        ) : (
          <nav aria-label={t('nav.navigationLabel')} className="hidden w-[88px] shrink-0 flex-col items-center gap-3 overflow-y-auto py-4 scrollbar-thin md:flex">
            <button
              type="button"
              className="btn-icon shrink-0 rounded-full"
              onClick={toggleMaterialSidebarMode}
              title={t('nav.toggleSidebar')}
              aria-label={t('nav.toggleSidebar')}
            >
              <Menu size={22} />
            </button>
            <button
              className="edit-only mb-5 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-container text-on-accent-container shadow-soft transition-transform duration-200 ease-spring hover:scale-105 active:scale-95"
              onClick={() => newNote()}
              aria-label={t('nav.newNote')}
              title={t('nav.newNote')}
            >
              <Pencil size={22} />
            </button>
            <RailItem to="/" Icon={Home} label={t('nav.home')} />
            <RailItem to="/inbox" Icon={InboxIcon} label={t('nav.inbox')} badge={inboxBadge} />
            <RailItem to="/notes" Icon={FileText} label={t('nav.notes')} />
            <RailItem to="/graph" Icon={Network} label={t('nav.graphShort')} />
            <RailItem to="/files" Icon={Images} label={t('nav.files')} />
            <div className="m3-status mt-auto flex flex-col items-center gap-1 pt-2">
              <ReadOnlyToggle />
              <SyncBadge />
              <RailItem to="/settings" Icon={Settings} label={t('nav.options')} />
            </div>
          </nav>
        )}

        {/* Mobile navigation drawer (< md only) */}
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/50 anim-fade-in" onClick={() => setDrawer(false)} />
            <aside
              className="m3-status absolute inset-y-0 left-0 w-[85%] max-w-[360px] rounded-r-2xl bg-surface shadow-soft safe-top safe-bottom"
              style={{ animation: 'slide-in 300ms var(--ease) both' }}
              onKeyDown={(e) => e.key === 'Escape' && setDrawer(false)}
            >
              <Sidebar
                isAdmin={isAdmin}
                onNavigate={() => setDrawer(false)}
                headerAction={
                  <button
                    type="button"
                    onClick={() => setDrawer(false)}
                    className="btn-icon h-9 w-9 shrink-0 rounded-full md:hidden"
                    aria-label={t('common.close')}
                  >
                    <X size={18} />
                  </button>
                }
              />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col md:py-4 md:pr-4">
          <header className="sticky top-0 z-20 flex items-center gap-1 bg-bg pb-1 [--pad-top:0.5rem] [--pad-x:0.25rem] safe-top safe-x md:hidden">
            <button className="btn-icon" onClick={() => setDrawer(true)} aria-label={t('nav.openMenu')}>
              <Menu size={22} />
            </button>
            <span className="text-[22px]">Kladde</span>
            <div className="m3-status ml-auto flex items-center gap-1 pr-2">
              <ReadOnlyToggle />
              <SyncBadge />
            </div>
          </header>
          <div className="flex min-h-0 flex-1 md:gap-3">
            <RightPaneHostContext.Provider value={rightHost}>
              <main className="vt-main min-h-0 flex-1 overflow-y-auto scrollbar-thin md:rounded-[28px] md:bg-surface">{children}</main>
            </RightPaneHostContext.Provider>
            <div ref={setRightHost} className="no-print hidden shrink-0 lg:flex empty:hidden" />
          </div>
          <nav aria-label={t('nav.navigationLabel')} className="grid grid-cols-4 bg-surface safe-bottom safe-x md:hidden">
            <BarItem to="/" Icon={Home} label={t('nav.home')} />
            <BarItem to="/inbox" Icon={InboxIcon} label={t('nav.inbox')} badge={inboxBadge} />
            <BarItem to="/notes" Icon={FileText} label={t('nav.notes')} />
            <BarItem to="/settings" Icon={Settings} label={t('nav.options')} />
          </nav>
        </div>
      </div>
      {!noteId && (
        <button
          className="edit-only fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-14 items-center gap-3 rounded-2xl bg-accent-container pl-4 pr-5 text-base font-medium text-on-accent-container shadow-soft transition-transform duration-200 ease-spring hover:scale-[1.03] active:scale-95 md:bottom-[calc(2.5rem+env(safe-area-inset-bottom))] md:right-10"
          onClick={() => setCapture(true)}
          title={t('nav.capture')}
        >
          <Pencil size={22} /> {t('nav.captureShort')}
        </button>
      )}
      {capture && <QuickCapture onClose={() => setCapture(false)} />}
      <Dialogs />
    </div>
  );
}
