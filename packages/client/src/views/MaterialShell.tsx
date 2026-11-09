import { useState } from 'react';
import { FileText, Home, Inbox as InboxIcon, Menu, Network, Pencil, Search, Settings } from 'lucide-react';
import { excerpt, PARA, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import { navigate, usePath } from '../lib/router';
import { Dialogs } from './Dialogs';
import { QuickCapture } from './QuickCapture';
import { newNote, ReadOnlyToggle, Sidebar, SyncBadge } from './Shell';

/*
 * Shell of the Material theme (Material 3): a navigation rail with the main action on tablet and desktop,
 * the notes of the open note's folder as a list pane beside it (list-detail), content on a rounded
 * surface, and a navigation bar with pill indicators on phones. The full sidebar (folders, new zettel,
 * recipes) opens as a modal navigation drawer from the menu button.
 */

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

const dayFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
function when(ts: number): string {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? timeFmt.format(d) : dayFmt.format(d);
}

/** List pane beside an open note: the notes of its folder (or all), newest first */
function ListPane({ noteId }: { noteId: string }) {
  useVault();
  const [all, setAll] = useState(false);
  const note = vault.get(noteId);
  const folder = note ? splitPath(note.path).folder : '';
  const notes = vault
    .list()
    .filter((n) => (all ? n.access === 'owner' : splitPath(n.path).folder === folder))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200);
  const folderName = folder ? folder.split('/').pop()!.replace(/^\d+\s+/, '') : 'Oberste Ebene';
  return (
    <section aria-label="Notizliste" className="hidden w-[340px] shrink-0 flex-col gap-4 xl:flex">
      <button onClick={() => navigate('/search')} className="flex h-14 shrink-0 items-center gap-4 rounded-full bg-raised px-4 text-left text-muted transition-colors hover:text-ink">
        <Search size={22} />
        <span className="flex-1 text-base">In Notizen suchen</span>
      </button>
      <div role="group" aria-label="Filter" className="flex flex-wrap gap-2">
        {[
          [false, folderName],
          [true, 'Alle Notizen'],
        ].map(([value, label]) => (
          <button
            key={String(value)}
            aria-pressed={all === value}
            onClick={() => setAll(value as boolean)}
            className={`h-8 rounded-lg px-4 text-sm font-medium transition-colors ${all === value ? 'bg-accent/20 text-accent' : 'border border-faint/60 text-muted hover:text-ink'}`}
          >
            {label as string}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl scrollbar-thin">
        <div className="flex flex-col gap-0.5">
          {notes.map((n) => {
            const name = splitPath(n.path).name;
            const active = n.id === noteId;
            return (
              <button
                key={n.id}
                onClick={() => navigate(`/n/${n.id}`)}
                aria-current={active ? 'true' : undefined}
                className={`flex items-center gap-4 px-4 py-3 text-left transition-colors ${active ? 'bg-accent/15' : 'bg-surface hover:bg-raised'}`}
              >
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-semibold ${active ? 'bg-accent-container text-on-accent-container' : 'bg-raised text-ink'}`}>
                  {(name.replace(/^\d{12}\s*/, '')[0] ?? '?').toUpperCase()}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-base">{name}</span>
                  <span className="truncate text-sm text-muted">{excerpt(n.content, 80) || 'Leer'}</span>
                </span>
                <span className="shrink-0 self-start pt-0.5 text-xs text-muted">{when(n.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function MaterialShell({ children, isAdmin }: { children: React.ReactNode; isAdmin?: boolean }) {
  useVault();
  const [drawer, setDrawer] = useState(false);
  const [capture, setCapture] = useState(false);
  const path = usePath();
  const noteId = path.startsWith('/n/') ? decodeURIComponent(path.slice(3)) : null;
  const inboxCount = vault.list().filter((n) => n.access === 'owner' && splitPath(n.path).folder === PARA.inbox).length;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="sticky top-0 z-20 hidden shrink-0 bg-bg [--pad-top:0.375rem] safe-top [@media(display-mode:standalone)]:md:block" />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Hauptnavigation" className="hidden w-[88px] shrink-0 flex-col items-center gap-3 py-4 md:flex">
          <button className="btn-icon" onClick={() => setDrawer(true)} aria-label="Ordner und Menü">
            <Menu size={22} />
          </button>
          <button
            className="edit-only mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-container text-on-accent-container shadow-soft transition-transform duration-200 ease-spring hover:scale-105 active:scale-95"
            onClick={() => newNote()}
            aria-label="Neue Notiz"
            title="Neue Notiz"
          >
            <Pencil size={22} />
          </button>
          <RailItem to="/" Icon={Home} label="Start" />
          <RailItem to="/inbox" Icon={InboxIcon} label="Inbox" badge={inboxCount} />
          <RailItem to="/notes" Icon={FileText} label="Notizen" />
          <RailItem to="/search" Icon={Search} label="Suche" />
          <RailItem to="/graph" Icon={Network} label="Netz" />
          <div className="m3-status mt-auto flex flex-col items-center gap-1">
            <ReadOnlyToggle />
            <SyncBadge />
            <RailItem to="/settings" Icon={Settings} label="Optionen" />
          </div>
        </nav>

        {drawer && (
          <div className="fixed inset-0 z-40">
            <div className="absolute inset-0 bg-black/50 anim-fade-in" onClick={() => setDrawer(false)} />
            {/* Modal navigation drawer: closes with the scrim, a destination or Escape, as in Material 3 */}
            <aside className="m3-status absolute inset-y-0 left-0 w-[85%] max-w-[360px] rounded-r-2xl bg-surface shadow-soft safe-top safe-bottom" style={{ animation: 'slide-in 300ms var(--ease) both' }} onKeyDown={(e) => e.key === 'Escape' && setDrawer(false)}>
              <Sidebar isAdmin={isAdmin} onNavigate={() => setDrawer(false)} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col md:py-4 md:pr-4">
          <header className="sticky top-0 z-20 flex items-center gap-1 bg-bg pb-1 [--pad-top:0.5rem] [--pad-x:0.25rem] safe-top safe-x md:hidden">
            <button className="btn-icon" onClick={() => setDrawer(true)} aria-label="Ordner und Menü">
              <Menu size={22} />
            </button>
            <span className="text-[22px]">Kladde</span>
            <div className="m3-status ml-auto flex items-center gap-1 pr-2">
              <ReadOnlyToggle />
              <SyncBadge />
            </div>
          </header>
          <div className="flex min-h-0 flex-1 md:gap-3">
            {noteId && <ListPane noteId={noteId} />}
            <main className="vt-main min-h-0 flex-1 overflow-y-auto scrollbar-thin md:rounded-[28px] md:bg-surface">{children}</main>
          </div>
          <nav aria-label="Hauptnavigation" className="grid grid-cols-4 bg-surface safe-bottom safe-x md:hidden">
            <BarItem to="/" Icon={Home} label="Start" />
            <BarItem to="/inbox" Icon={InboxIcon} label="Inbox" badge={inboxCount} />
            <BarItem to="/notes" Icon={FileText} label="Notizen" />
            <BarItem to="/search" Icon={Search} label="Suche" />
          </nav>
        </div>
      </div>
      {!noteId && (
        <button
          className="edit-only fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-14 items-center gap-3 rounded-2xl bg-accent-container pl-4 pr-5 text-base font-medium text-on-accent-container shadow-soft transition-transform duration-200 ease-spring hover:scale-[1.03] active:scale-95 md:bottom-[calc(2.5rem+env(safe-area-inset-bottom))] md:right-10"
          onClick={() => setCapture(true)}
          title="Schnell erfassen"
        >
          <Pencil size={22} /> Erfassen
        </button>
      )}
      {capture && <QuickCapture onClose={() => setCapture(false)} />}
      <Dialogs />
    </div>
  );
}
