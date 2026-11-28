import { createContext, useContext, type ComponentType, type ReactElement, type ReactNode } from 'react';
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

export interface PluginBlockProps {
  /** The text between the fences */
  source: string;
  /** The block's info string (`lang` of its `PluginBlock`) */
  lang: string;
  /** The note the block is in */
  noteId: string;
  /** Replaces the text between the fences; missing while the note is read-only */
  setSource?(next: string): void;
}

/**
 * A fenced block a plugin renders in the editor: ```` ```<lang> ```` … ```` ``` ```` shows the component instead of
 * the code while the cursor is outside it (inside, the text is edited as usual). Notes keep plain Markdown: exports,
 * public links and devices without the plugin show the block as code. Since plugin API 1.1.
 */
export interface PluginBlock {
  /** Info string: the plugin id itself or `<id>-<name>` (`logbook`, `logbook-chart`), so plugins never collide */
  lang: string;
  /** Its entry in the slash menu (`/`) */
  label: Localized;
  /** Extra words the slash menu matches */
  keywords?: string;
  /** Text between the fences of a block inserted from the slash menu */
  template?: string;
  component: ComponentType<PluginBlockProps>;
  /** Expected height in pixels (scrolling stays steady while it loads); default 160 */
  height?: number;
}

/** What an inspector panel gets: the open note (with its text) and whether the user may change it */
export interface PluginInspectorProps {
  note: PluginClientNote;
  /** False for read-only notes (shares, group readers, published releases) */
  canEdit: boolean;
}

/**
 * A tab in the inspector next to a note (the side panel with outline, tasks, links …). It shows for the notes that
 * `types` and/or `when` pick and renders `component` with the open note; the component re-renders when the note
 * changes. Since plugin API 1.3.
 */
export interface PluginInspectorPanel {
  /** Unique within the plugin, `a–z`, `0–9`, `-` */
  id: string;
  /** The tab's label (short: tabs are narrow) */
  label: Localized;
  /** Default: the plugin's icon */
  icon?: PluginIcon;
  /** Note types (`type` in the frontmatter) it shows for, e.g. `plugin:time:project` */
  types?: string[];
  /** Further condition; with `types` both must hold. Without both the panel shows for every note */
  when?(note: PluginClientNote): boolean;
  /** A number next to the tab's icon (e.g. open findings); nothing for 0 or undefined */
  count?(note: PluginClientNote): number | undefined;
  component: ComponentType<PluginInspectorProps>;
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
  /** Fenced blocks it renders in the editor (since plugin API 1.1) */
  blocks?: PluginBlock[];
  /** Tabs in the inspector next to a note (since plugin API 1.3) */
  inspector?: PluginInspectorPanel[];
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

/** A cell value of `ui.Table`; other values are shown as text */
export type PluginTableValue = string | number | null | undefined;

/** Colors of badges in `ui.Table` (Kladde's state colors; `neutral` is grey, `accent` the account's accent) */
export type PluginTone = 'neutral' | 'accent' | 'green' | 'amber' | 'red' | 'violet';

/** A small colored label in a table cell instead of its text. Since plugin API 1.3 */
export interface PluginTableBadge {
  text: string;
  tone?: PluginTone;
  /** Tooltip */
  title?: string;
}

/** A column of `ui.Table` */
export interface PluginTableColumn<Row> {
  /** Property of the row the column shows */
  key: string;
  label: Localized;
  align?: 'left' | 'center' | 'right';
  /**
   * `text` (default): inline Markdown like in note tables (bold, code, links, [[note links]]), escaped by the host.
   * `number`: formatted for the interface's language, sorted by value. `date`: milliseconds or an ISO date, shown as
   * a date and sorted by time; its cell editor holds `YYYY-MM-DD`.
   */
  type?: 'text' | 'number' | 'date';
  /** Cells of this column can be edited while the table is editable (default true) */
  editable?: boolean;
  /** Own display text of a cell (inline Markdown, escaped); filtering uses it too */
  format?(value: unknown, row: Row): string;
  /**
   * Shows the cell as a badge (a colored label); `null`/`undefined` falls back to the text. Filtering and, for text
   * columns, sorting use the badge's text; the cell editor still holds the raw value. Since plugin API 1.3.
   */
  badge?(value: unknown, row: Row): PluginTableBadge | null | undefined;
  /** Monospaced cells (ids, paths, hashes). Since plugin API 1.3 */
  mono?: boolean;
}

/**
 * The table of notes (sorting by a header click, filter field, row count), for plugin pages, settings and blocks.
 * It is read-only unless `editable` is set together with `onCellChange`: then a click into a cell edits it (Enter,
 * Tab and Escape as in note tables), `onAddRow` adds the "+ row" button and `onRemoveRow` a delete button per row.
 * The columns stay as the plugin defines them. The plugin saves the change and passes the new `rows`; until then
 * the cell shows the typed text. A rejected promise shows its message and the old value again. Since plugin API 1.2;
 * badges, monospaced columns, row clicks, a selected row and a sticky first column since 1.3.
 */
export interface PluginTableProps<Row> {
  columns: PluginTableColumn<Row>[];
  rows: Row[];
  /** Property with a unique id per row, or a function returning it */
  rowKey: string | ((row: Row) => string);
  caption?: Localized;
  /** The filter field (default true) */
  filter?: boolean;
  /** A summary row below the body, one text per column; it is not sorted or filtered */
  footer?: string[];
  /** Shown while there are no rows */
  empty?: Localized;
  editable?: boolean;
  /** `value` is the text the user typed (also for number and date columns) */
  onCellChange?(rowId: string, key: string, value: string, row: Row): void | Promise<void>;
  /** Adds a row; the host opens the first editable cell of the row that appears at the end */
  onAddRow?(): void | Promise<void>;
  onRemoveRow?(rowId: string, row: Row): void | Promise<void>;
  /**
   * A click on a row (outside links, buttons and cells being edited) or Enter on a focused row; rows become
   * focusable. In an editable table a click into an editable cell still edits it. Since plugin API 1.3.
   */
  onRowClick?(rowId: string, row: Row): void;
  /** Id of the row shown as selected (e.g. the one whose details are open). Since plugin API 1.3 */
  selected?: string | null;
  /** Keeps the first column in view while the table scrolls sideways (wide tables). Since plugin API 1.3 */
  stickyFirstColumn?: boolean;
}

/** Components of the Werkbank design for plugin pages (classes like `.btn-primary`, `.card`, `.input` work too) */
export interface PluginUi {
  PageHeader: ComponentType<{ title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; display?: boolean }>;
  PageBody: ComponentType<{ children: ReactNode; className?: string }>;
  Panel: ComponentType<{ label: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }>;
  Switch: ComponentType<{ id?: string; checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }>;
  /** The table of notes (since plugin API 1.2) */
  Table<Row extends object>(props: PluginTableProps<Row>): ReactElement | null;
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
