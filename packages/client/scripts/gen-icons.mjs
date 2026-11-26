// Generates src/lib/icons.tsx from Material Symbols Rounded (weight 300, @material-symbols/svg-300).
// The components keep the names the views import (formerly lucide-react), so call sites stay unchanged.
// Run with `npm run icons --workspace=packages/client` after adding an icon to MAP.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(require.resolve('@material-symbols/svg-300/package.json')), 'rounded');
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/lib/icons.tsx');

/** Component name → Material Symbols name */
const MAP = {
  Variables: 'data_object', RemoteDoc: 'source_notes', Ticket: 'confirmation_number', Flag: 'flag', PriorityHigh: 'keyboard_double_arrow_up', PriorityLow: 'keyboard_double_arrow_down', PriorityMedium: 'drag_handle', DragIndicator: 'drag_indicator', Person: 'person', TableRows: 'table_rows', ViewTimeline: 'view_timeline', AddLink: 'add_link',
  AlertTriangle: 'warning', AlignJustify: 'density_small', FormatAlignCenter: 'format_align_center', FormatAlignJustify: 'format_align_justify', FormatAlignLeft: 'format_align_left', FormatAlignRight: 'format_align_right', Archive: 'archive', ArchiveRestore: 'unarchive',
  ArrowDownAZ: 'sort_by_alpha', ArrowDownToLine: 'vertical_align_bottom', ArrowLeft: 'arrow_back', ArrowRight: 'arrow_forward',
  Backup: 'backup', Ban: 'block', Bell: 'notifications', Bold: 'format_bold', CenterFocus: 'center_focus_strong', CloseFullscreen: 'fullscreen_exit', Bot: 'smart_toy', Briefcase: 'work', CalendarCheck: 'event_available',
  CalendarClock: 'edit_calendar', CalendarDays: 'today', CalendarPlus: 'calendar_add_on', CalendarRange: 'date_range', CalendarMonth: 'calendar_month', Activity: 'timeline', AtSign: 'alternate_email', CheckCheck: 'done_all', MessageSquare: 'chat_bubble', MessageSquarePlus: 'add_comment', Reply: 'reply',
  Camera: 'photo_camera', Check: 'check', CheckCircle2: 'check_circle', CheckSquare: 'check_box', ChefHat: 'chef_hat',
  ChevronDown: 'keyboard_arrow_down', ChevronLeft: 'chevron_left', ChevronRight: 'chevron_right', ClipboardPaste: 'content_paste',
  Clock: 'schedule', Cloud: 'cloud_done', CloudOff: 'cloud_off', Code: 'code', Copy: 'content_copy',
  CornerLeftUp: 'subdirectory_arrow_left', Download: 'download', ExternalLink: 'open_in_new', FileCode: 'code_blocks',
  FilePlus2: 'note_add', FileSpreadsheet: 'table_view', FileText: 'description', FileType2: 'article', Folder: 'folder',
  FolderInput: 'drive_file_move', FolderKanban: 'folder_special', FolderOpen: 'folder_open', FolderPlus: 'create_new_folder',
  GitBranch: 'fork_right', Globe: 'public', Hash: 'tag', Heading: 'title', History: 'history', Home: 'home', Image: 'image',
  Images: 'photo_library', Inbox: 'inbox', Info: 'info', Kanban: 'view_kanban', KeyRound: 'key', LayoutGrid: 'grid_view',
  LayoutTemplate: 'view_quilt', Library: 'library_books', Lightbulb: 'lightbulb', Link2: 'link', List: 'list',
  ListChecks: 'checklist', ListTodo: 'task_alt', ListTree: 'toc', Loader2: 'progress_activity', LocateFixed: 'my_location',
  Lock: 'lock', LockOpen: 'lock_open', LogIn: 'login', LogOut: 'logout', Mail: 'mail', Maximize2: 'open_in_full',
  Menu: 'menu', Minimize2: 'close_fullscreen', Monitor: 'computer', MoreVertical: 'more_vert', Network: 'hub', PanelRight: 'right_panel_open',
  PanelRightClose: 'right_panel_close', PenLine: 'edit_note', Pencil: 'edit', Draw: 'draw', Plus: 'add', Printer: 'print',
  RefreshCw: 'sync', Repeat: 'repeat', RotateCcw: 'restart_alt', ScrollText: 'receipt_long', Search: 'search',
  Send: 'send', Settings: 'settings', Share2: 'share', ShieldCheck: 'verified_user', ShieldOff: 'remove_moderator',
  SlidersHorizontal: 'tune', Smartphone: 'mobile', Sparkles: 'wand_stars', Star: 'star', SunMoon: 'contrast',
  Table2: 'table', Tags: 'sell', Target: 'target', Trash2: 'delete', Undo2: 'undo', Unlink: 'link_off', Upload: 'upload',
  UnfoldLess: 'unfold_less', UnfoldMore: 'unfold_more', Merge: 'merge', Filter: 'filter_list',
  SwapHoriz: 'swap_horiz', VerticalSplit: 'vertical_split', OpenInFull: 'open_in_full',
  Psychology: 'psychology', Mic: 'mic', Mood: 'mood', StopCircle: 'stop_circle', Subtitles: 'subtitles', TextFields: 'format_size', NewReleases: 'approval',
  Palette: 'palette', PanelLeftClose: 'left_panel_close', PanelLeftOpen: 'left_panel_open', Callout: 'chat_info', Extension: 'extension', Slideshow: 'slideshow', SpeakerNotes: 'speaker_notes', Fullscreen: 'fullscreen', AspectRatio: 'aspect_ratio', PictureAsPdf: 'picture_as_pdf', UserCheck: 'how_to_reg', UserPlus: 'person_add', Users: 'group', AccountCircle: 'account_circle', EditNote: 'edit_note', Sync: 'sync', X: 'close', Zap: 'bolt',
  ArrowUp: 'arrow_upward', ArrowDown: 'arrow_downward', Webhook: 'webhook', Route: 'route',
  Dashboard: 'dashboard', Memory: 'memory', HardDrive: 'hard_drive', Database: 'database', Speed: 'speed', MarkRead: 'mark_email_read', NotificationsActive: 'notifications_active', NotificationsOff: 'notifications_off',
  BugReport: 'bug_report', SubdirectoryArrowRight: 'subdirectory_arrow_right', Stars: 'stars', AccountTree: 'account_tree',
  FindReplace: 'find_replace', Flame: 'local_fire_department', SavedSearch: 'saved_search', SelectCheck: 'select_check_box', Bookmark: 'bookmark',
  CheckBoxBlank: 'check_box_outline_blank', Keep: 'keep', KeepOff: 'keep_off', TabClose: 'tab_close', TabCloseRight: 'tab_close_right', FirstPage: 'first_page', MoreHoriz: 'more_horiz', WidthNormal: 'width_normal',
};

/** Callout kind (#86) → Material Symbol; written as plain paths to src/editor/calloutIcons.ts for the editor widgets */
const CALLOUT_ICONS = {
  note: 'edit', abstract: 'summarize', info: 'info', todo: 'check_circle', tip: 'lightbulb', success: 'check', question: 'help',
  warning: 'warning', failure: 'close', danger: 'bolt', bug: 'bug_report', example: 'list', quote: 'format_quote',
};
/** Icons drawn by editor widgets (plain DOM, no React), written as paths to src/editor/calloutIcons.ts as well */
const EDITOR_ICONS = {
  magicLink: 'wand_shine',
  // GitLab preview cards
  glMergeRequest: 'merge', glIssue: 'adjust', glPipeline: 'rocket_launch', glCommit: 'commit', glMilestone: 'flag', glRelease: 'sell',
  glProject: 'folder_code', glGroup: 'groups', glComment: 'chat_bubble', glStar: 'star', glFork: 'fork_right', glBranch: 'call_split', glTime: 'schedule',
};
const calloutOut = join(dirname(fileURLToPath(import.meta.url)), '../src/editor/calloutIcons.ts');

const pathOf = (file) => {
  const svg = readFileSync(file, 'utf8');
  const d = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  if (!d.length) throw new Error(`no path in ${file}`);
  return d.join(' ');
};

const lines = [];
for (const [name, symbol] of Object.entries(MAP).sort(([a], [b]) => a.localeCompare(b))) {
  const base = join(root, `${symbol}.svg`);
  if (!existsSync(base)) throw new Error(`Material Symbol "${symbol}" (for ${name}) does not exist`);
  const filled = join(root, `${symbol}-fill.svg`);
  const o = pathOf(base);
  const f = existsSync(filled) ? pathOf(filled) : o;
  lines.push(`/** Material Symbol \`${symbol}\` */\nexport const ${name} = icon('${o}'${f === o ? '' : `, '${f}'`});`);
}

writeFileSync(
  out,
  `/* eslint-disable */
// Generated by scripts/gen-icons.mjs from Material Symbols Rounded (Apache-2.0). Do not edit by hand.
import type { SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'fill'> & {
  size?: number | string;
  /** Filled variant (active navigation destinations, set favorites) */
  filled?: boolean;
  /** Compatibility with the former icon set: 'currentColor' selects the filled variant */
  fill?: string;
  /** Ignored: Material Symbols have a fixed weight */
  strokeWidth?: number | string;
};
export type Icon = (props: IconProps) => JSX.Element;

function icon(outline: string, fill = outline): Icon {
  return function MaterialSymbol({ size = 24, filled, fill: fillProp, strokeWidth: _w, ...rest }: IconProps) {
    const solid = filled || (fillProp !== undefined && fillProp !== 'none');
    return (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
        <path d={solid ? fill : outline} />
      </svg>
    );
  };
}

${lines.join('\n')}
`
);
console.log(`wrote ${Object.keys(MAP).length} icons to ${out}`);

writeFileSync(
  calloutOut,
  `/* eslint-disable */
// Generated by scripts/gen-icons.mjs from Material Symbols Rounded (Apache-2.0). Do not edit by hand.
import type { CalloutKind } from '@kladde/shared';

/** SVG path (viewBox 0 -960 960 960) of each callout kind's icon */
export const CALLOUT_ICON_PATHS: Record<CalloutKind, string> = {
${Object.entries(CALLOUT_ICONS)
  .map(([kind, symbol]) => {
    const file = join(root, `${symbol}.svg`);
    if (!existsSync(file)) throw new Error(`Material Symbol "${symbol}" (for callout ${kind}) does not exist`);
    return `  ${kind}: '${pathOf(file)}',`;
  })
  .join('\n')}
};

/** SVG path (viewBox 0 -960 960 960) of icons drawn by editor widgets */
export const EDITOR_ICON_PATHS = {
${Object.entries(EDITOR_ICONS)
  .map(([name, symbol]) => {
    const file = join(root, `${symbol}.svg`);
    if (!existsSync(file)) throw new Error(`Material Symbol "${symbol}" (for editor icon ${name}) does not exist`);
    return `  ${name}: '${pathOf(file)}',`;
  })
  .join('\n')}
} as const;
`
);
console.log(`wrote ${Object.keys(CALLOUT_ICONS).length} callout icons to ${calloutOut}`);
