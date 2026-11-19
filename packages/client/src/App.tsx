import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { INBOX_FOLDER, Me, projectTitleOf, runQuery } from '@kladde/shared';
import { api, ApiError, uploadFile } from './lib/api';
import { match, navigate, usePath } from './lib/router';
import { vault } from './data/vault';
import { uploads } from './data/uploads';
import { recordVoice } from './views/VoiceRecorder';
import { getLang } from './lib/i18n';
import { editorHost } from './editor/host';
import { isReadOnly } from './lib/readOnly';
import { Invite, LinkDevice, Login } from './views/Auth';
import { PublicNote } from './views/Public';
import { Shell } from './views/Shell';
import { HomeView } from './views/Home';
import { NoteList } from './views/NoteList';
import { GroupManageView, GroupView, GroupsView } from './views/Groups';
import { NoteView } from './views/NoteView';
import { InboxView } from './views/Inbox';
import { GraphView } from './views/Graph';
import { ReviewView } from './views/Review';
import { McpSettingsView } from './views/McpSettings';
import { DailyNoteEmptyView } from './views/DailyNoteBar';
import { PeriodicEmptyView } from './views/PeriodicNoteBar';
import { ActivityView } from './views/ActivityView';
import { CalendarView } from './views/ActivityHeatmap';
import { TasksView } from './views/TasksView';

// Pages that are opened now and then load on first use, so the app starts with a smaller bundle (#64).
// The service worker caches them with everything else, so they work offline too.
const SearchView = lazy(() => import('./views/Search').then((m) => ({ default: m.SearchView })));
const SettingsView = lazy(() => import('./views/Settings').then((m) => ({ default: m.SettingsView })));
const ShareCaptureView = lazy(() => import('./views/ShareCapture').then((m) => ({ default: m.ShareCaptureView })));
const TagsView = lazy(() => import('./views/Tags').then((m) => ({ default: m.TagsView })));
const AdminView = lazy(() => import('./views/Admin').then((m) => ({ default: m.AdminView })));
const TemplatesView = lazy(() => import('./views/Templates').then((m) => ({ default: m.TemplatesView })));
const ImportSettingsView = lazy(() => import('./views/ImportSettings').then((m) => ({ default: m.ImportSettingsView })));
const CalendarSettingsView = lazy(() => import('./views/CalendarSettings').then((m) => ({ default: m.CalendarSettingsView })));
const NotificationSettingsView = lazy(() => import('./views/NotificationSettings').then((m) => ({ default: m.NotificationSettingsView })));
const OAuthConsent = lazy(() => import('./views/OAuthConsent').then((m) => ({ default: m.OAuthConsent })));
const FilesView = lazy(() => import('./views/Files').then((m) => ({ default: m.FilesView })));
const TrashView = lazy(() => import('./views/Trash').then((m) => ({ default: m.TrashView })));
const ShortcutsSettingsView = lazy(() => import('./views/ShortcutsSettings').then((m) => ({ default: m.ShortcutsSettingsView })));
const ClipRoute = lazy(() => import('./views/ClipRoute').then((m) => ({ default: m.ClipRoute })));
const ConfluenceSettingsView = lazy(() => import('./views/ConfluenceSettings').then((m) => ({ default: m.ConfluenceSettingsView })));

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
  tags: () => vault.tagCounts(),
  autoLinkTargets: (excludeId?: string) => vault.links().autoLinkTargets(excludeId),
  // Offline (or on a network error) the file waits on this device and the note links it as kladde-pending:<id> (#28)
  upload: (file: File) => (vault.standalone ? uploadFile(file) : uploads.upload(file)),
  pendingUrl: (id: string) => uploads.objectUrl(id),
  recordVoice,
});

export function App() {
  const path = usePath();
  // The account from the last visit shows the app at once (also after an update reload); /auth/me confirms it below
  const [me, setMe] = useState<Me | null | undefined>(() => {
    const cached = cachedMe();
    if (cached) {
      vault.standalone = !!cached.standalone;
      vault.actorName = cached.username;
      void vault.open(cached.id);
    }
    return cached ?? undefined;
  });

  const signedIn = useCallback((user: Me) => {
    vault.standalone = !!user.standalone;
    // Voice notes: the server transcribes when its admin set up a speech-to-text service
    editorHost.transcribe = user.transcription
      ? (url: string) =>
          api<{ text: string }>(`${url.replace(/^\/api/, '')}/transcribe`, { method: 'POST', json: { lang: getLang() } }).then((r) => r.text)
      : null;
    try {
      localStorage.setItem(ME_KEY, JSON.stringify(user));
    } catch {
      // ignore
    }
    setMe(user);
    vault.actorName = user.username;
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
  if (path === '/oauth/authorize')
    return (
      <Suspense fallback={<PageLoading />}>
        <OAuthConsent me={me} />
      </Suspense>
    );

  let page: React.ReactNode;
  const note = match(path, '/n/:id');
  const dailyDate = match(path, '/daily/:date');
  const weekDate = match(path, '/week/:date');
  const monthDate = match(path, '/month/:date');
  const tagRoute = match(path, '/tags/:tag');
  const groupRoute = match(path, '/g/:id') ?? match(path, '/g/:id/:folder');
  const groupManage = match(path, '/groups/:id');
  if (note) page = <NoteView key={note.id} id={note.id} isNew={location.search.includes('new=1')} />;
  else if (path === '/daily') page = <DailyNoteEmptyView key="today" />;
  else if (dailyDate) page = <DailyNoteEmptyView key={dailyDate.date} date={dailyDate.date} />;
  else if (weekDate) page = <PeriodicEmptyView key={`w${weekDate.date}`} kind="week" date={weekDate.date} />;
  else if (monthDate) page = <PeriodicEmptyView key={`m${monthDate.date}`} kind="month" date={monthDate.date} />;
  else if (path === '/calendar') page = <CalendarView />;
  else if (path === '/activity' && !me.standalone) {
    const q = new URLSearchParams(location.search);
    const group = q.get('group');
    page = group ? <ActivityView key={`g${group}`} scope={{ group }} /> : <ActivityView key={location.search} scope={{ owner: q.get('owner') ?? '', folder: q.get('folder') ?? '' }} />;
  }
  else if (path === '/inbox' || path === `/f/${encodeURIComponent(INBOX_FOLDER)}`) page = <InboxView />;
  // "Share → Kladde" from another app (PWA share target)
  else if (path === '/share') page = <ShareCaptureView key={location.search} />;
  // The web clipper bookmarklet: opens the clip dialog for the page it came from
  else if (path === '/clip') page = <ClipRoute key={location.search} />;
  else if (path === '/tasks') page = <TasksView />;
  else if (path === '/graph') page = <GraphView />;
  else if (path === '/tags') page = <TagsView />;
  else if (tagRoute) page = <TagsView key={tagRoute.tag} tag={tagRoute.tag} />;
  else if (path === '/review') page = <ReviewView />;
  else if (path.startsWith('/f/')) page = <NoteList key={path} mode="folder" folder={decodeURIComponent(path.slice(3))} />;
  else if (path === '/notes') page = <NoteList mode="all" />;
  else if (path === '/shared' && !me.standalone) page = <NoteList mode="shared" />;
  else if (path === '/groups' && !me.standalone) page = <GroupsView />;
  else if (groupManage && !me.standalone) page = <GroupManageView key={path} groupId={groupManage.id} />;
  else if (groupRoute && !me.standalone) page = <GroupView key={path} groupId={groupRoute.id} folder={groupRoute.folder ?? ''} />;
  else if (path === '/search') page = <SearchView />;
  else if (path === '/admin' && !me.standalone) page = <AdminView me={me} />;
  else if (path === '/settings/templates') page = <TemplatesView />;
  else if (path === '/settings/mcp') page = <McpSettingsView />;
  else if (path === '/settings/confluence') page = <ConfluenceSettingsView />;
  else if (path === '/settings/import' && !me.standalone) page = <ImportSettingsView />;
  else if (path === '/settings/calendar' && !me.standalone) page = <CalendarSettingsView />;
  else if (path === '/settings/shortcuts' && !me.standalone) page = <ShortcutsSettingsView />;
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

  return (
    <Shell me={me} isAdmin={!me.standalone && me.isAdmin}>
      <Suspense fallback={<PageLoading />}>{page}</Suspense>
    </Shell>
  );
}

/** Shown for a moment while a page loads on first use */
function PageLoading() {
  return <div className="py-16 text-center text-on-surface-variant" role="status" aria-label="…" />;
}
