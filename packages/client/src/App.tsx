import { useCallback, useEffect, useState } from 'react';
import { INBOX_FOLDER, Me, projectTitleOf, runQuery } from '@kladde/shared';
import { api, ApiError, uploadFile } from './lib/api';
import { t } from './lib/i18n';
import { match, navigate, usePath } from './lib/router';
import { vault } from './data/vault';
import { editorHost } from './editor/host';
import { isReadOnly } from './lib/readOnly';
import { Invite, LinkDevice, Login } from './views/Auth';
import { PublicNote } from './views/Public';
import { Shell } from './views/Shell';
import { HomeView } from './views/Home';
import { NoteList } from './views/NoteList';
import { NoteView } from './views/NoteView';
import { SearchView } from './views/Search';
import { SettingsView } from './views/Settings';
import { InboxView } from './views/Inbox';
import { ShareCaptureView } from './views/ShareCapture';
import { GraphView } from './views/Graph';
import { ReviewView } from './views/Review';
import { AdminView } from './views/Admin';
import { TemplatesView } from './views/Templates';
import { McpSettingsView } from './views/McpSettings';
import { ImportSettingsView } from './views/ImportSettings';
import { CalendarSettingsView } from './views/CalendarSettings';
import { NotificationSettingsView } from './views/NotificationSettings';
import { OAuthConsent } from './views/OAuthConsent';
import { FilesView } from './views/Files';
import { TrashView } from './views/Trash';
import { DailyNoteEmptyView } from './views/DailyNoteBar';
import { CalendarView } from './views/ActivityHeatmap';

const ME_KEY = 'kladde_me';

function cachedMe(): Me | null {
  try {
    return JSON.parse(localStorage.getItem(ME_KEY) ?? 'null');
  } catch {
    return null;
  }
}

// Widgets inside the editor reach the app through this bridge
Object.assign(editorHost, {
  openWiki: async (title: string) => {
    const target = vault.findByTitle(title);
    if (target) navigate(`/n/${target.id}`);
    else {
      const note = await vault.create(INBOX_FOLDER, title, `# ${title}\n\n`);
      navigate(`/n/${note.id}`);
    }
  },
  wikiExists: (title: string) => !!vault.findByTitle(title),
  openNote: (id: string) => navigate(`/n/${id}`),
  // Only through the link index (title, frontmatter id, Zettel id); the vault only holds notes this reader may see
  resolveEmbed: (target: string) => {
    const links = vault.links();
    const id = links.resolve(target);
    const note = id ? vault.get(id) : undefined;
    if (!note || note.deleted) return null;
    return { id: note.id, title: links.notes.get(note.id)?.title ?? target, content: note.content, canWrite: note.access !== 'read' && !isReadOnly() };
  },
  runQuery: (src: string) => {
    try {
      return runQuery(src, vault.list(), new Date(), { defaultDue: vault.taskDueResolver() });
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
  toggleTask: (id: string, line: number) => void vault.toggleTask(id, line),
  openTask: (id: string, line: number) => navigate(`/n/${id}?line=${line + 1}`),
  setFrontmatter: (id: string, updates: Record<string, string | null>) => void vault.setFrontmatter(id, updates),
  noteTitles: () => {
    const rc = vault.roleConfig();
    return vault.list().map((n) => projectTitleOf(n.path, n.content, rc));
  },
  autoLinkTargets: (excludeId?: string) => vault.links().autoLinkTargets(excludeId),
  upload: (file: File) => {
    if (!navigator.onLine && !vault.standalone) return Promise.reject(new Error(t('note.uploadOnlineOnly')));
    return uploadFile(file);
  },
});

export function App() {
  const path = usePath();
  // The account from the last visit shows the app at once (also after an update reload); /auth/me confirms it below
  const [me, setMe] = useState<Me | null | undefined>(() => {
    const cached = cachedMe();
    if (cached) {
      vault.standalone = !!cached.standalone;
      void vault.open(cached.id);
    }
    return cached ?? undefined;
  });

  const signedIn = useCallback((user: Me) => {
    vault.standalone = !!user.standalone;
    try {
      localStorage.setItem(ME_KEY, JSON.stringify(user));
    } catch {
      // ignore
    }
    setMe(user);
    void vault.open(user.id);
  }, []);

  const signedOut = useCallback(() => {
    vault.standalone = false;
    try {
      localStorage.removeItem(ME_KEY);
    } catch {
      // ignore
    }
    vault.close();
    setMe(null);
  }, []);

  // A click on a reminder opens its note in this window (public/push.js)
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: unknown } | null;
      if (data?.type === 'kladde:navigate' && typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//')) navigate(data.url);
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    vault.onUnauthorized = signedOut;
    vault.onBeforeFlush = () => {
      window.dispatchEvent(new CustomEvent('kladde:flush-note'));
      editorHost.flush();
    };
    api<Me>('/auth/me').then(signedIn, (err) => {
      // Offline: keep working with the account and notes stored on this device
      const cached = cachedMe();
      if (!(err instanceof ApiError) && cached) signedIn(cached);
      else signedOut();
    });
  }, [signedIn, signedOut]);

  // Routes without an account
  const pub = match(path, '/s/:token');
  if (pub && !me?.standalone) return <PublicNote token={pub.token} />;
  const invite = match(path, '/invite/:code');
  if (invite && !me?.standalone) return <Invite code={invite.code} onDone={signedIn} />;
  if (path === '/register' && me === null) return <Invite onDone={signedIn} />;
  const link = match(path, '/link/:code');
  if (link && !me?.standalone) return <LinkDevice code={link.code} onDone={signedIn} />;

  if (me === undefined) return <div className="flex h-full items-center justify-center text-on-surface-variant">…</div>;
  if (me === null) return <Login onDone={signedIn} />;
  // An AI assistant asks for access (OAuth): after the login above, without the app around it
  if (path === '/oauth/authorize') return <OAuthConsent me={me} />;

  let page: React.ReactNode;
  const note = match(path, '/n/:id');
  const dailyDate = match(path, '/daily/:date');
  if (note) page = <NoteView key={note.id} id={note.id} isNew={location.search.includes('new=1')} />;
  else if (path === '/daily') page = <DailyNoteEmptyView key="today" />;
  else if (dailyDate) page = <DailyNoteEmptyView key={dailyDate.date} date={dailyDate.date} />;
  else if (path === '/calendar') page = <CalendarView />;
  else if (path === '/inbox' || path === `/f/${encodeURIComponent(INBOX_FOLDER)}`) page = <InboxView />;
  // "Share → Kladde" from another app (PWA share target)
  else if (path === '/share') page = <ShareCaptureView key={location.search} />;
  else if (path === '/graph') page = <GraphView />;
  else if (path === '/review') page = <ReviewView />;
  else if (path.startsWith('/f/')) page = <NoteList key={path} mode="folder" folder={decodeURIComponent(path.slice(3))} />;
  else if (path === '/notes') page = <NoteList mode="all" />;
  else if (path === '/shared' && !me.standalone) page = <NoteList mode="shared" />;
  else if (path === '/search') page = <SearchView />;
  else if (path === '/admin' && !me.standalone) page = <AdminView me={me} />;
  else if (path === '/settings/templates') page = <TemplatesView />;
  else if (path === '/settings/mcp') page = <McpSettingsView />;
  else if (path === '/settings/import' && !me.standalone) page = <ImportSettingsView />;
  else if (path === '/settings/calendar' && !me.standalone) page = <CalendarSettingsView />;
  else if (path === '/settings/notifications' && !me.standalone) page = <NotificationSettingsView />;
  else if (path === '/files' || path === '/settings/files') page = <FilesView />;
  else if (path === '/trash') page = <TrashView />;
  else if (path === '/settings')
    page = (
      <SettingsView
        me={me}
        onMe={signedIn}
        onLogout={async () => {
          await api('/auth/logout', { method: 'POST', json: {} }).catch(() => {});
          signedOut();
          navigate('/', true);
        }}
      />
    );
  else page = <HomeView />;

  return <Shell me={me} isAdmin={!me.standalone && me.isAdmin}>{page}</Shell>;
}
