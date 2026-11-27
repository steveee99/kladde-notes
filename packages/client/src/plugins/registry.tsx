import { Component, Suspense, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { extractMeta, parseFrontmatter, type FeatureSettings, type Me } from '@kladde/shared';
import { KladdeHostContext, localize, PluginRequestError, type KladdeHost, type PluginBlock, type PluginClientNote, type PluginIconProps } from '@kladde/plugin-api/client';
import { api, ApiError } from '../lib/api';
import { getLang, tl, type Lang } from '../lib/i18n';
import type { Icon, IconProps } from '../lib/icons';
import { openNoteLink } from '../lib/panes';
import { match, navigate } from '../lib/router';
import { showToast } from '../lib/toast';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { DEMO } from '../demo/demoApi';
import { PageBody, PageHeader, Panel } from '../views/PageHeader';
import { Switch } from '../views/Switch';
import { installedPlugins } from './installed';
import { PluginTable } from './PluginTable';
import type { InstalledClientPlugin } from './types';

// The plugins `npm run plugins` built into this app (docs/PLUGINS.md); tests replace them
let plugins: InstalledClientPlugin[] = installedPlugins;

/** Replaces the installed plugins (tests) */
export function setInstalledPlugins(list: InstalledClientPlugin[]): void {
  plugins = list;
  hosts.clear();
}

/** Every plugin of this build (none in the browser-only demo, which has no server for their routes) */
export function allPlugins(): InstalledClientPlugin[] {
  return DEMO ? [] : plugins.filter((p) => p.id === p.plugin.id);
}

/** A plugin of this build by its id */
export function pluginById(id: string): InstalledClientPlugin | undefined {
  return allPlugins().find((p) => p.plugin.id === id);
}

export function isPluginEnabled(entry: InstalledClientPlugin, features: FeatureSettings = vault.features()): boolean {
  return features.plugins[entry.plugin.id] ?? entry.defaultEnabled;
}

/** The plugins the user switched on */
export function enabledPlugins(features: FeatureSettings = vault.features()): InstalledClientPlugin[] {
  return allPlugins().filter((p) => isPluginEnabled(p, features));
}

/** Switches a plugin for this account; synced right away, because the server checks the switch on every request */
export async function setPluginEnabled(id: string, on: boolean): Promise<void> {
  const f = vault.features();
  await vault.updateFeatures({ ...f, plugins: { ...f.plugins, [id]: on } });
  void vault.sync().catch(() => {});
}

/** Whether the server refused a plugin request because the user's switch has not reached it yet */
const notYetOn = (err: unknown) => err instanceof ApiError && err.status === 403 && (err.data as { code?: string } | null)?.code === 'plugin_disabled';

/** App path of a plugin page */
export function pluginHref(id: string, sub = ''): string {
  const clean = sub && !sub.startsWith('/') ? `/${sub}` : sub;
  return `/p/${id}${clean === '/' ? '' : clean}`;
}

/** The plugin and page of an app path `/p/<id>/…`; `page` is null when the plugin has no page there */
export function resolvePluginPath(path: string) {
  const m = /^\/p\/([a-z0-9-]+)(\/.*)?$/.exec(path);
  if (!m) return null;
  const entry = allPlugins().find((p) => p.plugin.id === m[1]);
  if (!entry) return null;
  const sub = (m[2] ?? '').replace(/\/+$/, '');
  for (const page of entry.plugin.pages) {
    const pattern = page.path.replace(/\/+$/, '');
    const params = pattern === '' ? (sub === '' ? {} : null) : match(sub, pattern.startsWith('/') ? pattern : `/${pattern}`);
    if (params) return { entry, page, params, sub };
  }
  return { entry, page: null, params: {}, sub };
}

// Plugin icons as the app's icon type (NavItem, command palette); one adapter per component
const adapters = new WeakMap<ComponentType<PluginIconProps>, Icon>();
export function appIcon(PluginIconComponent: ComponentType<PluginIconProps>): Icon {
  let adapted = adapters.get(PluginIconComponent);
  if (!adapted) {
    adapted = ({ size, className, filled }: IconProps) => <PluginIconComponent size={size} className={className} filled={filled} />;
    adapters.set(PluginIconComponent, adapted);
  }
  return adapted;
}

/** Navigation destinations of the plugins that are on */
export function pluginNavItems(lang: Lang = getLang()): { key: string; to: string; label: string; Icon: Icon; bottomBar: boolean }[] {
  return enabledPlugins().flatMap((p) =>
    (p.plugin.nav ?? []).map((n, i) => ({
      key: `${p.plugin.id}-${i}`,
      to: pluginHref(p.plugin.id, n.path),
      label: localize(n.label, lang),
      Icon: appIcon(n.icon ?? p.plugin.icon),
      bottomBar: !!n.bottomBar,
    }))
  );
}

/** Command palette entries of the plugins that are on: one per destination and their own commands */
export function pluginCommands(lang: Lang = getLang()): { id: string; label: string; icon: ReactNode; keywords?: string; run: () => void }[] {
  return enabledPlugins().flatMap((p) => {
    const PluginIconComponent = p.plugin.icon;
    const icon = <PluginIconComponent size={16} />;
    const host = hostFor(p);
    return [
      ...(p.plugin.nav ?? []).map((n, i) => ({ id: `plugin-${p.plugin.id}-nav-${i}`, label: localize(n.label, lang), icon, keywords: localize(p.plugin.name, lang), run: () => navigate(pluginHref(p.plugin.id, n.path)) })),
      ...(p.plugin.commands ?? []).map((c) => ({
        id: `plugin-${p.plugin.id}-${c.id}`,
        label: localize(c.label, lang),
        icon,
        keywords: [localize(p.plugin.name, lang), c.keywords].filter(Boolean).join(' '),
        run: () => (c.run ? c.run(host) : navigate(pluginHref(p.plugin.id, c.path))),
      })),
    ];
  });
}

// ------------------------------------------------------------------ editor blocks

/** A block's info string must be the plugin's id or start with `<id>-`: plugins never take each other's (or Kladde's) */
const ownLang = (id: string, lang: string) => (lang === id || lang.startsWith(`${id}-`)) && /^[a-z0-9-]+$/.test(lang);

/** The block of an enabled plugin that renders ```` ```<lang> ```` */
export function pluginBlockFor(lang: string, features?: FeatureSettings): { entry: InstalledClientPlugin; block: PluginBlock } | null {
  if (!lang) return null;
  for (const entry of enabledPlugins(features)) {
    const block = entry.plugin.blocks?.find((b) => b.lang === lang && ownLang(entry.plugin.id, b.lang));
    if (block) return { entry, block };
  }
  return null;
}

/** Slash menu entries for the blocks of the plugins that are on */
export function pluginSlashBlocks(lang: Lang = getLang()): { label: string; detail: string; keywords: string; template: string }[] {
  return enabledPlugins().flatMap((entry) =>
    (entry.plugin.blocks ?? [])
      .filter((b) => ownLang(entry.plugin.id, b.lang))
      .map((b) => ({
        label: localize(b.label, lang),
        detail: b.lang,
        keywords: [entry.plugin.id, localize(entry.plugin.name, lang), b.keywords].filter(Boolean).join(' ').toLowerCase(),
        template: `\`\`\`${b.lang}\n${b.template ? b.template.replace(/\n?$/, '\n') : ''}\`\`\``,
      }))
  );
}

/**
 * Mounts a plugin block into the editor's frame `el` (its own React root with the plugin's host and error
 * boundary); returns the unmount
 */
export function mountPluginBlock(el: HTMLElement, lang: string, props: { source: string; noteId: string; setSource?: (next: string) => void }): () => void {
  const found = pluginBlockFor(lang);
  if (!found) return () => {};
  const { entry, block } = found;
  const Block = block.component;
  const root = createRoot(el);
  root.render(
    <WithPluginHost entry={entry}>
      <Suspense fallback={null}>
        <Block source={props.source} lang={lang} noteId={props.noteId} setSource={props.setSource} />
      </Suspense>
    </WithPluginHost>
  );
  // Not while React renders the editor's parent
  return () => setTimeout(() => root.unmount(), 0);
}

// ------------------------------------------------------------------ host

let me: Me | null = null;
const hosts = new Map<string, KladdeHost>();

/** The signed-in account plugins see (`useKladde().me`) */
export function setPluginUser(next: Me): void {
  if (me?.id === next.id && me.username === next.username && me.displayName === next.displayName && me.isAdmin === next.isAdmin) return;
  me = next;
  hosts.clear();
}

const toNote = (n: LocalNote): PluginClientNote => {
  const type = n.partial ? undefined : parseFrontmatter(n.content).data.type;
  return {
    id: n.id,
    path: n.path,
    title: extractMeta(n.path, n.content).title,
    content: n.content,
    version: n.version,
    updatedAt: n.updatedAt,
    access: n.access === 'owner' && !n.group ? 'owner' : n.access === 'read' ? 'read' : 'write',
    ...(n.group ? { group: n.group } : {}),
    ...(type ? { type } : {}),
    ...(n.partial ? { partial: true } : {}),
  };
};

const ui: KladdeHost['ui'] = { PageHeader, PageBody, Panel, Switch, Table: PluginTable };

/** What a plugin's components get from `useKladde()`; one per plugin and language */
export function hostFor(entry: InstalledClientPlugin): KladdeHost {
  const lang = getLang();
  const id = entry.plugin.id;
  const key = `${id}:${lang}`;
  const cached = hosts.get(key);
  if (cached) return cached;
  const host: KladdeHost = {
    pluginId: id,
    lang,
    me: { id: me?.id ?? '', username: me?.username ?? '', displayName: me?.displayName ?? null, isAdmin: !!me?.isAdmin },
    t: (value) => localize(value, lang),
    href: (sub) => pluginHref(id, sub),
    navigate,
    openNote: (noteId) => openNoteLink(noteId),
    toast: (text, tone = 'ok') => showToast(text, tone === 'error' ? 'danger' : 'ok'),
    api: async <T,>(path: string, init: { method?: string; json?: unknown; signal?: AbortSignal } = {}) => {
      const request = () => api<T>(`/p/${id}${path.startsWith('/') ? path : `/${path}`}`, { method: init.method, json: init.json, signal: init.signal });
      try {
        try {
          return await request();
        } catch (err) {
          // Switched on here but not synced yet (just now, or while offline): push the setting, then ask once more
          if (!notYetOn(err) || !isPluginEnabled(entry)) throw err;
          await vault.sync();
          await vault.sync();
          return await request();
        }
      } catch (err) {
        if (err instanceof ApiError) throw new PluginRequestError(err.status, err.message);
        throw err;
      }
    },
    notes: {
      list: (filter = {}) => {
        const folder = filter.folder?.replace(/^\/+|\/+$/g, '');
        return vault
          .list()
          .filter((n) => !folder || n.path.startsWith(`${folder}/`))
          .map(toNote)
          .filter((n) => !filter.type || n.type === filter.type);
      },
      get: (noteId) => {
        const n = vault.get(noteId);
        return n ? toNote(n) : undefined;
      },
      load: async (noteId) => {
        const n = await vault.ensureFull(noteId);
        return n && !n.deleted ? toNote(n) : undefined;
      },
      create: async (folder, title, content) => toNote(await vault.create(folder, title, content)),
      update: (noteId, patch) => vault.update(noteId, patch),
      remove: (noteId) => vault.remove(noteId),
    },
    useNotesVersion: useVault,
    ui,
  };
  hosts.set(key, host);
  return host;
}

/** Keeps a plugin's error inside its own area */
class PluginBoundary extends Component<{ name: string; children: ReactNode }, { error: boolean }> {
  state = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(err: unknown) {
    console.error(`Plugin ${this.props.name}:`, err);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const lang = getLang();
    return (
      <div className="card m-4 p-4 text-body-m" role="alert">
        <p>{tl(lang, 'plugins.failed', { name: this.props.name })}</p>
        <button type="button" className="btn-outlined mt-3" onClick={() => this.setState({ error: false })}>
          {tl(lang, 'plugins.reload')}
        </button>
      </div>
    );
  }
}

/** Renders plugin components with their host and an error boundary */
export function WithPluginHost({ entry, children }: { entry: InstalledClientPlugin; children: ReactNode }) {
  return (
    <KladdeHostContext.Provider value={hostFor(entry)}>
      <PluginBoundary name={localize(entry.plugin.name, getLang())}>{children}</PluginBoundary>
    </KladdeHostContext.Provider>
  );
}
