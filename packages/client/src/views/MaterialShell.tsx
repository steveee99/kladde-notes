import { createContext, useContext, useEffect, useState } from 'react';
import { CalendarDays, CalendarRange, FileText, Home, Images, Inbox as InboxIcon, Menu, Network, Pencil, X } from '../lib/icons';
import { INBOX_FOLDER, Me, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate, usePath } from '../lib/router';
import { toggleMaterialSidebarMode, useMaterialSidebarMode } from '../lib/sidebarMode';
import { Dialogs } from './Dialogs';
import { QuickCapture } from './QuickCapture';
import { newNote, openTodayDailyNote, ReadOnlyToggle, Sidebar, SyncBadge } from './Shell';
import { Avatar } from './Avatar';
import { t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';
import { useReadOnly } from '../lib/readOnly';
import { setFocusMode, useFocusMode } from '../lib/focus';

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

/**
 * One navigation destination (M3 navigation rail or navigation bar): an active indicator pill in
 * secondary-container behind the icon, the filled icon variant while active, and a Label Medium below.
 */
function Destination({
  active,
  onClick,
  Icon,
  icon,
  label,
  badge,
  bar,
  title,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  Icon?: Icon;
  icon?: React.ReactNode;
  label: string;
  badge?: number;
  bar?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={ariaLabel}
      title={title}
      className={`group flex min-w-0 flex-col items-center gap-1 text-label-m outline-none ${bar ? 'px-1 pb-1 pt-3' : 'w-full shrink-0 pb-1'} ${
        active ? 'text-on-surface' : 'text-on-surface-variant'
      }`}
    >
      <span
        className={`state-layer relative flex h-8 max-w-full items-center justify-center rounded-full group-focus-visible:ring-2 group-focus-visible:ring-primary ${bar ? 'w-16' : 'w-14'} ${
          active ? 'bg-secondary-container text-on-secondary-container' : 'group-hover:bg-on-surface/[0.08]'
        }`}
      >
        {Icon ? <Icon size={24} filled={active} /> : icon}
        {!!badge && (
          <span className="absolute left-[calc(50%+4px)] top-0.5 min-w-4 rounded-full bg-error px-1 text-center text-label-s text-on-error">{badge}</span>
        )}
      </span>
      <span className={`max-w-full truncate px-1 ${active ? 'font-bold' : ''}`}>{label}</span>
    </button>
  );
}

function NavItem({ to, Icon, label, badge, bar }: { to: string; Icon: Icon; label: string; badge?: number; bar?: boolean }) {
  const path = usePath();
  return <Destination active={path === to} onClick={() => navigate(to)} Icon={Icon} label={label} badge={badge} bar={bar} />;
}

export function MaterialShell({ me, children, isAdmin }: { me: Me; children: React.ReactNode; isAdmin?: boolean }) {
  useVault();
  useLang();
  const sidebarMode = useMaterialSidebarMode();
  const sticky = sidebarMode === 'sticky';
  const inboxZero = useInboxZero();
  const locked = useReadOnly();
  const [drawer, setDrawer] = useState(false);
  const [capture, setCapture] = useState(false);
  const [rightHost, setRightHost] = useState<HTMLDivElement | null>(null);
  const path = usePath();
  const noteId = path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
  const inboxCount = vault.list().filter((n) => n.access === 'owner' && splitPath(n.path).folder === INBOX_FOLDER).length;
  const inboxBadge = inboxZero && inboxCount > 0 ? inboxCount : undefined;
  const features = vault.features();
  const dailyNote = features.daily.enabled ? vault.findDailyNote() : undefined;
  const dailyActive = path === '/daily' || path.startsWith('/daily/') || (!!dailyNote && noteId === dailyNote.id);
  const showDailyRail = features.daily.enabled && (!locked || !!dailyNote);
  const settingsActive = path === '/settings' || path.startsWith('/settings/');
  // Focus mode: only the open note remains, without navigation or side panels
  const focusMode = useFocusMode();
  const focus = focusMode && !!noteId && features.focus.enabled;

  // Focus mode belongs to a note: leaving it (or turning the feature off) ends it
  useEffect(() => {
    if (focusMode && (!noteId || !features.focus.enabled)) setFocusMode(false);
  }, [focusMode, noteId, features.focus.enabled]);

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
    <div className="flex h-full flex-col bg-surface md:bg-surface-container">
      <div className="sticky top-0 z-20 hidden shrink-0 bg-surface-container [--pad-top:0.375rem] safe-top [@media(display-mode:standalone)]:md:block" />
      <div className="flex min-h-0 min-w-0 flex-1">
        {focus ? null : sticky ? (
          <aside aria-label={t('nav.navigationLabel')} className="m3-status hidden w-[292px] shrink-0 py-4 pl-4 pr-3 md:flex lg:w-[308px]">
            <div className="flex min-h-0 w-full flex-col overflow-hidden">
              <Sidebar
                me={me}
                isAdmin={isAdmin}
                headerAction={
                  <button
                    type="button"
                    onClick={toggleMaterialSidebarMode}
                    className="btn-icon hidden md:inline-flex"
                    title={t('nav.toggleSidebar')}
                    aria-label={t('nav.toggleSidebar')}
                  >
                    <Menu size={24} />
                  </button>
                }
              />
            </div>
          </aside>
        ) : (
          <nav aria-label={t('nav.navigationLabel')} className="hidden w-24 shrink-0 flex-col items-center gap-1 overflow-y-auto pb-4 pt-5 scrollbar-thin md:flex">
            <button
              type="button"
              className="btn-icon"
              onClick={toggleMaterialSidebarMode}
              title={t('nav.toggleSidebar')}
              aria-label={t('nav.toggleSidebar')}
            >
              <Menu size={24} />
            </button>
            <button
              className="edit-only state-layer mb-7 mt-2 flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary-container text-on-primary-container shadow-elevation-3 transition-[box-shadow,transform] duration-200 ease-spring hover:shadow-elevation-3 active:scale-95"
              onClick={() => newNote()}
              aria-label={t('nav.newNote')}
              title={t('nav.newNote')}
            >
              <Pencil size={24} />
            </button>
            <NavItem to="/" Icon={Home} label={t('nav.home')} />
            {showDailyRail && (
              <Destination active={dailyActive} onClick={() => void openTodayDailyNote()} Icon={CalendarDays} label={t('daily.navShort')} title={t('daily.todayBtn')} />
            )}
            {features.heatmap.enabled && <NavItem to="/calendar" Icon={CalendarRange} label={t('nav.calendar')} />}
            <NavItem to="/inbox" Icon={InboxIcon} label={t('nav.inbox')} badge={inboxBadge} />
            <NavItem to="/notes" Icon={FileText} label={t('nav.notes')} />
            <NavItem to="/graph" Icon={Network} label={t('nav.graphShort')} />
            <NavItem to="/files" Icon={Images} label={t('nav.files')} />
            <div className="m3-status mt-auto flex flex-col items-center gap-1 pt-2">
              <ReadOnlyToggle />
              <SyncBadge />
              <Destination
                active={settingsActive}
                onClick={() => navigate('/settings')}
                icon={<Avatar name={me.username} avatarUrl={me.avatarUrl} size="sm" active={settingsActive} />}
                label={t('nav.options')}
                ariaLabel={t('nav.settings')}
                title={me.username}
              />
            </div>
          </nav>
        )}

        {/* Mobile navigation drawer (< md only) */}
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-scrim/[0.32] anim-fade-in" onClick={() => setDrawer(false)} />
            <aside
              className="m3-status absolute inset-y-0 left-0 w-[85%] max-w-[360px] rounded-r-2xl bg-surface-container-low shadow-elevation-1 safe-top safe-bottom"
              style={{ animation: 'slide-in 300ms var(--ease) both' }}
              onKeyDown={(e) => e.key === 'Escape' && setDrawer(false)}
            >
              <Sidebar
                me={me}
                isAdmin={isAdmin}
                onNavigate={() => setDrawer(false)}
                headerAction={
                  <button
                    type="button"
                    onClick={() => setDrawer(false)}
                    className="btn-icon md:hidden"
                    aria-label={t('common.close')}
                  >
                    <X size={24} />
                  </button>
                }
              />
            </aside>
          </div>
        )}

        <div className={`flex min-w-0 flex-1 flex-col ${focus ? 'bg-surface safe-top' : 'md:py-4 md:pr-4'}`}>
          <header className={`sticky top-0 z-20 min-h-16 min-w-0 items-center gap-1 bg-surface [--pad-x:0.25rem] safe-top safe-x md:hidden ${focus ? 'hidden' : 'flex'}`}>
            <button className="btn-icon shrink-0" onClick={() => setDrawer(true)} aria-label={t('nav.openMenu')}>
              <Menu size={24} />
            </button>
            <span className="min-w-0 truncate pl-1 text-title-l">Kladde</span>
            <div className="m3-status ml-auto flex shrink-0 items-center gap-1 pr-2">
              <ReadOnlyToggle />
              <SyncBadge />
            </div>
          </header>
          <div className="flex min-h-0 min-w-0 flex-1 md:gap-3">
            <RightPaneHostContext.Provider value={rightHost}>
              <main className={`vt-main min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-thin md:bg-surface ${focus ? '' : 'md:rounded-[28px]'} ${!noteId ? 'pb-24' : ''}`}>
                {children}
              </main>
            </RightPaneHostContext.Provider>
            <div ref={setRightHost} className={`no-print hidden shrink-0 empty:hidden ${focus ? '' : 'lg:flex'}`} />
          </div>
          <nav aria-label={t('nav.navigationLabel')} className={`bottom-bar min-h-20 grid-cols-4 bg-surface-container safe-x md:hidden ${focus ? 'hidden' : 'grid'}`}>
            <NavItem bar to="/" Icon={Home} label={t('nav.home')} />
            <NavItem bar to="/inbox" Icon={InboxIcon} label={t('nav.inbox')} badge={inboxBadge} />
            <NavItem bar to="/notes" Icon={FileText} label={t('nav.notes')} />
            <Destination
              bar
              active={settingsActive}
              onClick={() => navigate('/settings')}
              icon={<Avatar name={me.username} avatarUrl={me.avatarUrl} size="sm" active={settingsActive} />}
              label={t('nav.options')}
              ariaLabel={t('nav.settings')}
              title={me.username}
            />
          </nav>
        </div>
      </div>
      {!noteId && (
        <button
          className="edit-only state-layer fixed bottom-[calc(6.5rem+max(0px,env(safe-area-inset-bottom)-1.5rem))] right-4 z-30 flex h-14 items-center gap-3 rounded-2xl bg-primary-container pl-4 pr-5 text-title-m text-on-primary-container shadow-elevation-3 transition-transform duration-200 ease-spring active:scale-95 md:bottom-[calc(2.5rem+env(safe-area-inset-bottom))] md:right-10"
          onClick={() => setCapture(true)}
          title={t('nav.capture')}
        >
          <Pencil size={24} /> {t('nav.captureShort')}
        </button>
      )}
      {capture && <QuickCapture onClose={() => setCapture(false)} />}
      <Dialogs />
    </div>
  );
}
