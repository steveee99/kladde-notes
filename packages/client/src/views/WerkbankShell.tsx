import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from 'react';
import { useModal } from '../lib/modal';
import { Bell, CalendarCheck, CalendarDays, CalendarMonth, FileText, Home, Inbox as InboxIcon, Kanban, ListChecks, Menu, Network, PanelLeftClose, PanelLeftOpen, Pencil, Search as SearchIcon, Share2, Tags, Users, X } from '../lib/icons';
import { openSearch, SearchDialogHost } from './SearchDialog';
import { APP_VERSION, INBOX_FOLDER, Me, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate, usePath } from '../lib/router';
import { toggleMaterialSidebarMode, useMaterialSidebarMode } from '../lib/sidebarMode';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { useSidebarWidth } from '../lib/sidebarWidth';
import { ticketsAnywhere } from '../data/tickets';
import { DEMO } from '../demo/demoApi';
import { NavBadge } from './NavBadge';
import { reviewDue } from './Review';
import { Dialogs } from './Dialogs';
import { QuickCapture } from './QuickCapture';
import { folderOfRoute, newNote, openTodayDailyNote, ReadOnlyToggle, Sidebar, SyncBadge } from './Shell';
import { Avatar } from './Avatar';
import { AppLogo } from './AppLogo';
import { NoteTabs } from './NoteTabs';
import { buildCommands } from './commands';
import { urgentTaskCount } from './TaskParts';
import { locale, t, useLang } from '../lib/i18n';
import { useInboxZero } from '../lib/prefs';
import { useReadOnly } from '../lib/readOnly';
import { setFocusMode, useFocusMode } from '../lib/focus';
import { isSettingsPath, useSettingsNavInPanel } from '../lib/settingsRoutes';

const SettingsNav = lazy(() => import('./SettingsNav').then((m) => ({ default: m.SettingsNav })));

/*
 * Shell of Kladde, Werkbank design (docs/DESIGN.md). Desktop (`nav:`): a top bar with the command field, a
 * navigation rail of icons, the collapsible folder side panel (Ctrl/⌘+\), the content and an optional right
 * inspector, and a status bar at the bottom. Phones: top bar, bottom navigation bar and the drawer.
 */

/** The modal navigation drawer on phones: Escape closes it, Tab stays inside, focus returns to the menu button */
function DrawerPanel({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  useModal(panel, onClose);
  return (
    <aside
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className="m3-status absolute inset-y-0 left-0 w-[85%] max-w-[360px] border-r border-line bg-panel shadow-elevation-3 outline-none safe-top safe-bottom"
      style={{ animation: 'slide-in 180ms var(--ease) both' }}
    >
      {children}
    </aside>
  );
}

export const RightPaneHostContext = createContext<HTMLDivElement | null>(null);

export function useRightPaneHost(): HTMLDivElement | null {
  return useContext(RightPaneHostContext);
}

type Icon = typeof Home;

/**
 * One navigation destination. In the rail it is an icon with a tooltip (active: line background and the
 * accent); in the phone's navigation bar an icon with a label below and an accent line above when active.
 */
function Destination({
  active,
  onClick,
  Icon,
  icon,
  label,
  badge,
  badgeLabel,
  bar,
  title,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  Icon?: Icon;
  icon?: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
  /** What the (visually only) badge says, read out after the label */
  badgeLabel?: string;
  bar?: boolean;
  title?: string;
  className?: string;
}) {
  if (!bar)
    return (
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        aria-label={badge && badgeLabel ? `${label}, ${badgeLabel}` : label}
        title={title ?? label}
        className={`state-layer relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-acc ${
          active ? 'bg-line text-acc' : 'text-muted hover:text-text'
        } ${className}`}
      >
        {Icon ? <Icon size={20} filled={active} /> : icon}
        {badge && <span className="absolute -right-0.5 -top-0.5 flex">{badge}</span>}
      </button>
    );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={title}
      className={`group relative flex min-w-0 flex-1 basis-0 flex-col items-center gap-1 px-1 pb-1 pt-2.5 text-label-s outline-none ${className} ${active ? 'text-acc' : 'text-muted'}`}
    >
      {active && <span aria-hidden className="absolute left-[30%] right-[30%] top-0 h-0.5 rounded-full bg-acc" />}
      <span className="state-layer relative flex h-8 w-12 max-w-full items-center justify-center rounded-md group-focus-visible:ring-2 group-focus-visible:ring-acc">
        {Icon ? <Icon size={22} filled={active} /> : icon}
        {badge && <span className="absolute -top-1 left-[calc(50%+4px)] flex">{badge}</span>}
      </span>
      <span className="max-w-full truncate px-1">{label}</span>
      {badge && badgeLabel && <span className="sr-only">, {badgeLabel}</span>}
    </button>
  );
}

/** Separates groups of destinations in the navigation rail */
function RailDivider() {
  return <hr aria-hidden className="my-1 w-6 shrink-0 border-0 border-t border-line" />;
}

function NavItem({
  to,
  Icon,
  label,
  badge,
  badgeLabel,
  bar,
  className,
  onActiveClick,
}: {
  to: string;
  Icon: Icon;
  label: string;
  badge?: React.ReactNode;
  badgeLabel?: string;
  bar?: boolean;
  className?: string;
  /** Clicking the destination while it is active (Notes: toggles the side panel) */
  onActiveClick?: () => void;
}) {
  const path = usePath();
  // A destination stays active on its sub pages (`/tags/<tag>`)
  const active = path === to || (to !== '/' && path.startsWith(`${to}/`));
  return (
    <Destination
      active={active}
      onClick={() => (active && onActiveClick ? onActiveClick() : navigate(to))}
      Icon={Icon}
      label={label}
      badge={badge}
      badgeLabel={badgeLabel}
      bar={bar}
      className={className}
    />
  );
}

/** Ctrl/⌘+\ shows or collapses the folder side panel (desktop) */
function useSidePanelShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key !== '\\') return;
      e.preventDefault();
      toggleMaterialSidebarMode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function WerkbankShell({ me, children, isAdmin }: { me: Me; children: React.ReactNode; isAdmin?: boolean }) {
  const version = useVault();
  const lang = useLang();
  const panelOpen = useMaterialSidebarMode() === 'sticky';
  const inboxZero = useInboxZero();
  const locked = useReadOnly();
  const [drawer, setDrawer] = useState(false);
  const [capture, setCapture] = useState(false);
  const [rightHost, setRightHost] = useState<HTMLDivElement | null>(null);
  const path = usePath();
  const noteId = path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
  const inboxCount = vault.list().filter((n) => n.access === 'owner' && splitPath(n.path).folder === INBOX_FOLDER).length;
  const inboxBadge = inboxZero && inboxCount > 0 ? <NavBadge tone="warn" count={inboxCount} /> : undefined;
  // Overdue and today's open tasks (#45)
  const urgentTasks = urgentTaskCount(version);
  const taskBadge = urgentTasks ? <NavBadge tone="warn" count={urgentTasks} /> : undefined;
  const sharedCount = vault.list().filter((n) => n.access !== 'owner' && !n.group).length;
  const showShared = (sharedCount > 0 || vault.sharedFolders.length > 0) && !vault.standalone;
  const ownNotes = vault.list().filter((n) => n.access === 'owner').length;
  const sidebarWidth = useSidebarWidth();
  const features = vault.features();
  // Mentions and comments (#69, #68): only with an account on a server
  const showNotifications = !vault.standalone && !DEMO && (features.mentions.enabled || features.comments.enabled);
  const dailyNote = features.daily.enabled ? vault.findDailyNote() : undefined;
  const dailyActive = path === '/daily' || path.startsWith('/daily/') || (!!dailyNote && noteId === dailyNote.id);
  const showDailyRail = features.daily.enabled && (!locked || !!dailyNote);
  const settingsActive = path === '/settings' || path.startsWith('/settings/');
  // Focus mode: only the open note remains, without navigation or side panels
  const focusMode = useFocusMode();
  const focus = focusMode && !!noteId && features.focus.enabled;
  useSidePanelShortcut();

  // Focus mode belongs to a note: leaving it (or turning the feature off) ends it
  useEffect(() => {
    if (focusMode && (!noteId || !features.focus.enabled)) setFocusMode(false);
  }, [focusMode, noteId, features.focus.enabled]);

  const settingsNavInPanel = useSettingsNavInPanel();
  const settingsRoute = isSettingsPath(path);
  const hidePanelButton = (
    <button type="button" onClick={toggleMaterialSidebarMode} className="btn-icon h-8 w-8" title={`${t('nav.hideSidePanel')} (Ctrl/⌘+\\)`} aria-label={t('nav.hideSidePanel')}>
      <PanelLeftClose size={18} />
    </button>
  );
  const panelToggleLabel = panelOpen ? t('nav.hideSidePanel') : t('nav.showSidePanel');
  const PanelIcon = panelOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Top bar (desktop): brand, the command field in the middle (opens the search, Ctrl/⌘+K), account */}
      {!focus && (
        <header className="hidden h-12 shrink-0 items-center gap-3 border-b border-line bg-bar pl-2 pr-3 [--pad-top:0px] safe-top nav:flex">
          <button type="button" onClick={() => navigate('/')} className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-acc" title={t('nav.home')}>
            <AppLogo size={22} />
            <span className="font-display text-[19px] leading-6">Kladde</span>
          </button>
          <button
            type="button"
            onClick={openSearch}
            aria-haspopup="dialog"
            aria-keyshortcuts="Control+K Meta+K"
            className="mx-auto flex h-8 w-full max-w-[520px] items-center gap-2.5 rounded-md border border-line2 bg-bg px-3 text-left text-body-m text-muted outline-none transition-colors hover:border-edge focus-visible:border-acc"
          >
            <SearchIcon size={16} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('palette.topBar')}</span>
            <kbd className="kbd">⌘K</kbd>
          </button>
          <div className="m3-status flex shrink-0 items-center gap-1">
            <ReadOnlyToggle compact />
            <button
              type="button"
              onClick={() => navigate('/settings')}
              aria-current={settingsActive ? 'page' : undefined}
              title={`${me.username} · ${t('nav.settings')}`}
              aria-label={t('nav.settings')}
              className="flex h-9 w-9 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-acc"
            >
              <Avatar name={me.username} avatarUrl={me.avatarUrl} size="sm" active={settingsActive} />
            </button>
          </div>
        </header>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        {!focus && (
          <nav aria-label={t('nav.navigationLabel')} className="hidden w-[52px] shrink-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden border-r border-line bg-bar py-2 scrollbar-thin nav:flex">
            <button type="button" className="btn-icon" onClick={toggleMaterialSidebarMode} title={`${panelToggleLabel} (Ctrl/⌘+\\)`} aria-label={panelToggleLabel} aria-expanded={panelOpen}>
              <PanelIcon size={20} />
            </button>
            <button
              type="button"
              className="edit-only state-layer flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-acc outline-none hover:bg-acc-bg focus-visible:ring-2 focus-visible:ring-acc"
              onClick={() => newNote(folderOfRoute(path) ?? undefined)}
              aria-label={t('nav.newNote')}
              title={t('nav.newNote')}
            >
              <Pencil size={20} />
            </button>
            <RailDivider />
            <NavItem to="/" Icon={Home} label={t('nav.home')} />
            {showDailyRail && <Destination active={dailyActive} onClick={() => void openTodayDailyNote()} Icon={CalendarDays} label={t('daily.navShort')} title={t('daily.todayBtn')} />}
            <NavItem to="/notes" Icon={FileText} label={t('nav.notes')} onActiveClick={toggleMaterialSidebarMode} />
            <NavItem to="/tasks" Icon={ListChecks} label={t('nav.tasks')} badge={taskBadge} badgeLabel={t('nav.badgeTasks', { n: urgentTasks })} />
            {ticketsAnywhere() && <NavItem to="/projects" Icon={Kanban} label={t('nav.projects')} />}
            {features.calendarView.enabled && <NavItem to="/calendar" Icon={CalendarMonth} label={t('nav.calendar')} />}
            <NavItem to="/inbox" Icon={InboxIcon} label={t('nav.inbox')} badge={inboxBadge} badgeLabel={t('nav.badgeInbox', { n: inboxCount })} />
            {showNotifications && (
              <NavItem
                to="/notifications"
                Icon={Bell}
                label={t('notices.nav')}
                badge={vault.unreadNotifications ? <NavBadge count={vault.unreadNotifications} /> : undefined}
                badgeLabel={t('notices.badge', { n: vault.unreadNotifications })}
              />
            )}
            <RailDivider />
            <NavItem to="/graph" Icon={Network} label={t('nav.graphShort')} />
            <NavItem to="/tags" Icon={Tags} label={t('nav.tags')} />
            {features.review.enabled && (
              <NavItem to="/review" Icon={CalendarCheck} label={t('nav.review')} badge={reviewDue() ? <NavBadge dot /> : undefined} badgeLabel={t('nav.badgeReviewDue')} />
            )}
            {showShared && <NavItem to="/shared" Icon={Share2} label={t('nav.shared')} badge={sharedCount ? <NavBadge count={sharedCount} /> : undefined} badgeLabel={t('nav.badgeShared', { n: sharedCount })} />}
            {!vault.standalone && !DEMO && (
              <Destination active={path === '/groups' || path.startsWith('/groups/') || path.startsWith('/g/')} onClick={() => navigate('/groups')} Icon={Users} label={t('nav.groups')} />
            )}
          </nav>
        )}
        {!focus && panelOpen && (
          <aside aria-label={settingsRoute ? t('settings.title') : t('nav.folders')} className="relative hidden shrink-0 border-r border-line bg-panel nav:flex" style={{ width: sidebarWidth }}>
            <div className="flex min-h-0 w-full flex-col overflow-hidden">
              {settingsRoute && settingsNavInPanel ? (
                <Suspense fallback={null}>
                  <SettingsNav me={me} panel headerAction={hidePanelButton} />
                </Suspense>
              ) : (
                <Sidebar me={me} isAdmin={isAdmin} panel headerAction={hidePanelButton} />
              )}
            </div>
            <SidebarResizeHandle />
          </aside>
        )}

        {/* Mobile navigation drawer (< nav only) */}
        {drawer && (
          <div className="fixed inset-0 z-40 nav:hidden">
            <div className="absolute inset-0 bg-scrim/50 anim-fade-in" onClick={() => setDrawer(false)} />
            <DrawerPanel label={t('nav.navigationLabel')} onClose={() => setDrawer(false)}>
              <Sidebar
                me={me}
                isAdmin={isAdmin}
                onNavigate={() => setDrawer(false)}
                headerAction={
                  <button type="button" onClick={() => setDrawer(false)} className="btn-icon nav:hidden" aria-label={t('common.close')}>
                    <X size={24} />
                  </button>
                }
              />
            </DrawerPanel>
          </div>
        )}

        <div className={`flex min-w-0 flex-1 flex-col ${focus ? 'safe-top' : ''}`}>
          <header className={`sticky top-0 z-20 min-h-14 min-w-0 items-center gap-1 border-b border-line bg-bar [--pad-x:0.25rem] safe-top safe-x nav:hidden ${focus ? 'hidden' : 'flex'}`}>
            <button className="btn-icon shrink-0" onClick={() => setDrawer(true)} aria-label={t('nav.openMenu')}>
              <Menu size={22} />
            </button>
            <span className="font-display min-w-0 truncate pl-1 text-[21px] leading-7">Kladde</span>
            <div className="m3-status ml-auto flex shrink-0 items-center gap-0.5 pr-1">
              <button type="button" className="btn-icon shrink-0 sm:hidden" onClick={openSearch} aria-label={t('common.search')} title={t('common.search')}>
                <SearchIcon size={22} />
              </button>
              <ReadOnlyToggle />
              <SyncBadge />
            </div>
          </header>
          {!focus && <NoteTabs />}
          <div className="flex min-h-0 min-w-0 flex-1">
            <RightPaneHostContext.Provider value={rightHost}>
              <main className={`vt-main min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg scrollbar-thin ${!noteId ? 'pb-24 nav:pb-16' : ''}`}>{children}</main>
            </RightPaneHostContext.Provider>
            <div ref={setRightHost} className={`no-print hidden shrink-0 border-l border-line bg-panel empty:hidden ${focus ? '' : 'lg:flex'}`} />
          </div>
          {/*
            Bottom navigation bar (phones, and tablets in portrait): on tablets (`tablet:` screen) it has room for
            more destinations; phones keep the five main ones, so a tablet reaches daily note, search, tags and graph without opening the drawer.
          */}
          <nav aria-label={t('nav.navigationLabel')} className={`bottom-bar border-t border-line bg-bar safe-x nav:hidden ${focus ? 'hidden' : 'flex'}`}>
            <NavItem bar to="/" Icon={Home} label={t('nav.home')} />
            {showDailyRail && (
              <Destination bar className="hidden tablet:flex" active={dailyActive} onClick={() => void openTodayDailyNote()} Icon={CalendarDays} label={t('daily.navShort')} title={t('daily.todayBtn')} />
            )}
            <NavItem bar to="/tasks" Icon={ListChecks} label={t('nav.tasks')} badge={taskBadge} badgeLabel={t('nav.badgeTasks', { n: urgentTasks })} />
            {ticketsAnywhere() && <NavItem bar className="hidden tablet:flex" to="/projects" Icon={Kanban} label={t('nav.projects')} />}
            <NavItem bar to="/inbox" Icon={InboxIcon} label={t('nav.inbox')} badge={inboxBadge} badgeLabel={t('nav.badgeInbox', { n: inboxCount })} />
            <NavItem bar to="/notes" Icon={FileText} label={t('nav.notes')} />
            <Destination bar className="hidden tablet:flex" active={false} onClick={openSearch} Icon={SearchIcon} label={t('common.search')} title={t('common.search')} />
            <NavItem bar className="hidden tablet:flex" to="/tags" Icon={Tags} label={t('nav.tags')} />
            <NavItem bar className="hidden md:tablet:flex" to="/graph" Icon={Network} label={t('nav.graphShort')} />
            <Destination
              bar
              active={settingsActive}
              onClick={() => navigate('/settings')}
              icon={<Avatar name={me.username} avatarUrl={me.avatarUrl} size="sm" active={settingsActive} />}
              label={t('nav.options')}
              title={me.username}
            />
          </nav>
        </div>
      </div>
      {/* Status bar (desktop): sync state, counts, version */}
      {!focus && (
        <footer aria-label={t('nav.statusBar')} className="m3-status hidden h-6 shrink-0 items-center gap-4 border-t border-line bg-bar px-2.5 font-mono text-[11px] text-muted nav:flex">
          <SyncBadge status />
          <span key={ownNotes} className="num-tick">{t('nav.noteCount', { n: ownNotes.toLocaleString(locale(lang)) })}</span>
          <span className="ml-auto">v{APP_VERSION}</span>
        </footer>
      )}
      {!noteId && (
        <button
          className="edit-only state-layer fixed bottom-[calc(6rem+max(0px,env(safe-area-inset-bottom)-1.5rem))] right-4 z-30 flex h-14 items-center gap-2.5 rounded-[14px] bg-acc pl-4 pr-5 text-title-m text-on-acc shadow-elevation-2 transition-transform duration-150 active:scale-95 nav:bottom-10 nav:right-8 nav:h-11 nav:rounded-[10px] nav:text-title-s"
          onClick={() => setCapture(true)}
          title={t('nav.capture')}
        >
          <Pencil size={20} /> {t('nav.captureShort')}
        </button>
      )}
      {capture && <QuickCapture onClose={() => setCapture(false)} />}
      <Dialogs />
      <SearchDialogHost commands={() => buildCommands(path)} />
    </div>
  );
}
