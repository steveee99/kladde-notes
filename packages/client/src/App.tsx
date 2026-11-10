import { useCallback, useEffect, useState } from 'react';
import { Me, PARA, runQuery, splitPath, INBOX_FOLDER } from '@kladde/shared';
import { api, ApiError, uploadFile } from './lib/api';
import { t } from './lib/i18n';
import { match, navigate, usePath } from './lib/router';
import { vault } from './data/vault';
import { editorHost } from './editor/host';
import { Invite, LinkDevice, Login } from './views/Auth';
import { PublicNote } from './views/Public';
import { Shell } from './views/Shell';
import { HomeView } from './views/Home';
import { NoteList } from './views/NoteList';
import { NoteView } from './views/NoteView';
import { SearchView } from './views/Search';
import { SettingsView } from './views/Settings';
import { InboxView } from './views/Inbox';
import { GraphView } from './views/Graph';
import { ReviewView } from './views/Review';
import { AdminView } from './views/Admin';
import { TemplatesView } from './views/Templates';
import { McpSettingsView } from './views/McpSettings';
import { GitSettingsView } from './views/GitSettings';
import { OAuthConsent } from './views/OAuthConsent';
import { FilesView } from './views/Files';

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
  runQuery: (src: string) => {
    try {
      return runQuery(src, vault.list());
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
  toggleTask: (id: string, line: number) => void vault.toggleTask(id, line),
  openTask: (id: string, line: number) => navigate(`/n/${id}?line=${line + 1}`),
  setFrontmatter: (id: string, updates: Record<string, string | null>) => void vault.setFrontmatter(id, updates),
  noteTitles: () => vault.list().map((n) => splitPath(n.path).name),
  autoLinkTargets: (excludeId?: string) => vault.links().autoLinkTargets(excludeId),
  upload: (file: File) => {
    if (!navigator.onLine) return Promise.reject(new Error(t('note.uploadOnlineOnly')));
    return uploadFile(file);
  },
});

export function App() {
  const path = usePath();
  // The account from the last visit shows the app at once (also after an update reload); /auth/me confirms it below
  const [me, setMe] = useState<Me | null | undefined>(() => {
    const cached = cachedMe();
    if (cached) void vault.open(cached.id);
    return cached ?? undefined;
  });

  const signedIn = useCallback((user: Me) => {
    try {
      localStorage.setItem(ME_KEY, JSON.stringify(user));
    } catch {
      // ignore
    }
    setMe(user);
    void vault.open(user.id);
  }, []);

  const signedOut = useCallback(() => {
    try {
      localStorage.removeItem(ME_KEY);
    } catch {
      // ignore
    }
    vault.close();
    setMe(null);
  }, []);

  useEffect(() => {
    vault.onUnauthorized = signedOut;
    api<Me>('/auth/me').then(signedIn, (err) => {
      // Offline: keep working with the account and notes stored on this device
      const cached = cachedMe();
      if (!(err instanceof ApiError) && cached) signedIn(cached);
      else signedOut();
    });
  }, [signedIn, signedOut]);

  // Routes without an account
  const pub = match(path, '/s/:token');
  if (pub) return <PublicNote token={pub.token} />;
  const invite = match(path, '/invite/:code');
  if (invite) return <Invite code={invite.code} onDone={signedIn} />;
  const link = match(path, '/link/:code');
  if (link) return <LinkDevice code={link.code} onDone={signedIn} />;

  if (me === undefined) return <div className="flex h-full items-center justify-center text-faint">…</div>;
  if (me === null) return <Login onDone={signedIn} />;
  // An AI assistant asks for access (OAuth): after the login above, without the app around it
  if (path === '/oauth/authorize') return <OAuthConsent me={me} />;

  let page: React.ReactNode;
  const note = match(path, '/n/:id');
  if (note) page = <NoteView key={note.id} id={note.id} isNew={location.search.includes('new=1')} />;
  else if (path === '/inbox' || path === `/f/${encodeURIComponent(PARA.inbox)}`) page = <InboxView />;
  else if (path === '/graph') page = <GraphView />;
  else if (path === '/review') page = <ReviewView />;
  else if (path.startsWith('/f/')) page = <NoteList key={path} mode="folder" folder={decodeURIComponent(path.slice(3))} />;
  else if (path === '/notes') page = <NoteList mode="all" />;
  else if (path === '/shared') page = <NoteList mode="shared" />;
  else if (path === '/search') page = <SearchView />;
  else if (path === '/admin') page = <AdminView me={me} />;
  else if (path === '/settings/templates') page = <TemplatesView />;
  else if (path === '/settings/mcp') page = <McpSettingsView />;
  else if (path === '/settings/git') page = <GitSettingsView />;
  else if (path === '/files' || path === '/settings/files') page = <FilesView />;
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

  return <Shell isAdmin={me.isAdmin}>{page}</Shell>;
}
