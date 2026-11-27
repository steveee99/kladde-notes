import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { localize, type Localized, type PluginLang } from './index.js';

export { localize, type Localized, type PluginLang } from './index.js';

export interface PluginIconProps {
  size?: number | string;
  className?: string;
  /** Filled variant (the active navigation destination) */
  filled?: boolean;
}

/** An icon: a component that draws an SVG in `currentColor` (Material Symbols Rounded, weight 300, fit best) */
export type PluginIcon = ComponentType<PluginIconProps>;

export interface PluginPageProps {
  /** Values of `:name` parts of the page's path */
  params: Record<string, string>;
  /** The path below `/p/<id>` */
  path: string;
}

/** A page at `/p/<id><path>`; `path` may hold parameters (`/entry/:id`) */
export interface PluginPage {
  path: string;
  component: ComponentType<PluginPageProps>;
}

/** A destination in the navigation rail (and, with `bottomBar`, in the tablet bottom bar) */
export interface PluginNavItem {
  label: Localized;
  /** Page path below `/p/<id>`; default the start page */
  path?: string;
  /** Default: the plugin's icon */
  icon?: PluginIcon;
  bottomBar?: boolean;
}

/** An entry of the command palette (Ctrl/⌘+K) */
export interface PluginCommand {
  /** Unique within the plugin; the host prefixes it with the plugin id */
  id: string;
  label: Localized;
  /** Extra words the filter matches */
  keywords?: string;
  /** Opens this page below `/p/<id>` … */
  path?: string;
  /** … or runs this */
  run?(host: KladdeHost): void;
}

export interface ClientPlugin {
  /** The same id as `kladde.id` in package.json */
  id: string;
  name: Localized;
  /** One line for its card under Settings → Features */
  summary: Localized;
  /** What it does, on its overview tab */
  description: Localized;
  icon: PluginIcon;
  /** On for everyone who has not switched it off (default: off until switched on) */
  defaultEnabled?: boolean;
  pages: PluginPage[];
  nav?: PluginNavItem[];
  commands?: PluginCommand[];
  /** Contents of the settings tab of its card while it is on */
  settings?: ComponentType;
}

/** Declares a client plugin (only types the object; the host does the rest) */
export function defineClientPlugin(plugin: ClientPlugin): ClientPlugin {
  return plugin;
}

/** A note as the client side sees it */
export interface PluginClientNote {
  id: string;
  path: string;
  title: string;
  content: string;
  version: number;
  updatedAt: number;
  access: 'owner' | 'write' | 'read';
  /** Id of the group that owns the note */
  group?: string;
  type?: string;
  /** Online mode: only the catalog entry is on the device; `notes.load` fetches the text */
  partial?: boolean;
}

/** Notes on this device (offline-first): changes are saved locally and synced like edits in the app */
export interface PluginClientNotes {
  list(filter?: { type?: string; folder?: string }): PluginClientNote[];
  get(id: string): PluginClientNote | undefined;
  /** Loads the text of a partial note (online mode); the note itself otherwise */
  load(id: string): Promise<PluginClientNote | undefined>;
  create(folder: string, title: string, content: string): Promise<PluginClientNote>;
  update(id: string, patch: { content?: string; title?: string; folder?: string }): Promise<void>;
  /** Moves the note to the trash */
  remove(id: string): Promise<void>;
}

/** A failed request to the plugin's routes */
export class PluginRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'PluginRequestError';
  }
}

/** Components of the Werkbank design for plugin pages (classes like `.btn-primary`, `.card`, `.input` work too) */
export interface PluginUi {
  PageHeader: ComponentType<{ title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; display?: boolean }>;
  PageBody: ComponentType<{ children: ReactNode; className?: string }>;
  Panel: ComponentType<{ label: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }>;
  Switch: ComponentType<{ id?: string; checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }>;
}

/** What the host gives the plugin's components (`useKladde()`) */
export interface KladdeHost {
  readonly pluginId: string;
  readonly lang: PluginLang;
  readonly me: { id: string; username: string; displayName: string | null; isAdmin: boolean };
  /** A `Localized` text in the interface's language */
  t(text: Localized): string;
  /** App path of a plugin page: `href('/entry/1')` → `/p/<id>/entry/1` */
  href(path?: string): string;
  navigate(to: string): void;
  openNote(id: string): void;
  toast(text: string, tone?: 'ok' | 'error'): void;
  /** JSON request to the plugin's routes (`api('/entries')` → `/api/p/<id>/entries`); throws `PluginRequestError` */
  api<T = unknown>(path: string, init?: { method?: string; json?: unknown; signal?: AbortSignal }): Promise<T>;
  readonly notes: PluginClientNotes;
  /** Re-renders the component on every change of the notes; returns a counter */
  useNotesVersion(): number;
  readonly ui: PluginUi;
}

/** Provided by the host around every plugin component */
export const KladdeHostContext = createContext<KladdeHost | null>(null);

/** The host inside a plugin page, settings tab or command */
export function useKladde(): KladdeHost {
  const host = useContext(KladdeHostContext);
  if (!host) throw new Error('useKladde() works only inside components the Kladde host renders');
  return host;
}

/** `t` without the host, e.g. for constants */
export function text(value: Localized, lang: PluginLang): string {
  return localize(value, lang);
}
