import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity as ActivityIcon,
  AtSign,
  MessageSquare,
  AlignJustify,
  ArrowLeft,
  Bell,
  Bot,
  CalendarCheck,
  CalendarDays,
  CalendarMonth,
  CalendarRange,
  CenterFocus,
  Check,
  ChefHat,
  ChevronRight,
  Cloud,
  Download,
  Extension,
  FolderKanban,
  FolderPlus,
  Info,
  Lightbulb,
  Loader2,
  Lock,
  Mood,
  Psychology,
  Slideshow,
  Link2,
  Flame,
  Gamepad,
  Speed,
  Callout,
  Smartphone,
  Star,
  Table2,
  Kanban,
  Upload,
  X,
} from '../lib/icons';
import {
  cleanDailyFormat,
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_FORMAT,
  DEFAULT_MONTHLY_FOLDER,
  DEFAULT_MONTHLY_FORMAT,
  DEFAULT_WEEKLY_FOLDER,
  DEFAULT_WEEKLY_FORMAT,
  DEFAULT_RECIPE_FOLDER,
  type FeatureSettings,
  resolveDailyNote,
  resolvePeriodicNote,
  STANDALONE_RECIPE_FOLDER,
} from '@kladde/shared';
import { api } from '../lib/api';
import { confluenceAvailable, setConfluenceOverview, useConfluence } from '../lib/confluence';
import { folderDisplayName, tl, useLang, type I18nKey, type Lang } from '../lib/i18n';
import { useModal } from '../lib/modal';
import { useReadOnly } from '../lib/readOnly';
import { useVault, vault } from '../data/vault';
import { DEMO } from '../demo/demoApi';
import { Dropdown } from './Dropdown';
import { FeatureArt, type FeatureArtId } from './FeatureArt';
import { Switch } from './Switch';
import type { ConfluenceOverview } from '@kladde/shared';

// The settings of the features that live on the server are their former settings pages, loaded on first use
const McpSettingsView = lazy(() => import('./McpSettings').then((m) => ({ default: m.McpSettingsView })));
const NotificationSettingsView = lazy(() => import('./NotificationSettings').then((m) => ({ default: m.NotificationSettingsView })));
const CalendarSettingsView = lazy(() => import('./CalendarSettings').then((m) => ({ default: m.CalendarSettingsView })));
const ShortcutsSettingsView = lazy(() => import('./ShortcutsSettings').then((m) => ({ default: m.ShortcutsSettingsView })));
const ConfluenceSettingsView = lazy(() => import('./ConfluenceSettings').then((m) => ({ default: m.ConfluenceSettingsView })));
const CockpitConnectionsView = lazy(() => import('./CockpitConnections').then((m) => ({ default: m.CockpitConnectionsView })));

/** One feature in the dialog */
interface Feature {
  id: FeatureArtId;
  Icon: typeof Star;
  title: string;
  /** One line for the card */
  summary: string;
  /** What it does, on its overview tab */
  details: string;
  /** PARA and Zettelkasten: on in new spaces */
  standard?: boolean;
  active: boolean;
  /** Switches it on or off; without it, "Activate" opens the settings (Confluence: on once a connection is saved) */
  setActive?: (on: boolean) => Promise<unknown>;
  /** Asked before switching it off */
  offConfirm?: string;
  /** Shown on the overview tab */
  hint?: string;
  /** Contents of the settings tab while it is on */
  settings?: () => ReactNode;
}

type ListTab = 'available' | 'active';
type DetailTab = 'overview' | 'settings';

const save = (patch: (f: FeatureSettings) => FeatureSettings) => vault.updateFeatures(patch(vault.features()));

/** Every feature that this account can use, with its state */
function useFeatures(lang: Lang): Feature[] {
  useVault();
  const confluence = useConfluence();
  const features = vault.features();
  const folders = vault.folders();
  const locked = useReadOnly();
  const L = (key: I18nKey, vars?: Record<string, string | number>) => tl(lang, key, vars);
  const server = !vault.standalone;
  const serverHint = L('features.serverHint');

  const flag = (key: 'comments' | 'mentions' | 'activity' | 'calendarView' | 'heatmap' | 'review' | 'favorites' | 'icons' | 'writingStats' | 'database' | 'tickets' | 'presentation' | 'linkPreview' | 'habits' | 'minigame' | 'callouts' | 'mcp' | 'notifications' | 'calendar' | 'shortcuts') => ({
    active: features[key].enabled,
    setActive: (on: boolean) => save((f) => ({ ...f, [key]: { ...f[key], enabled: on } })),
  });
  const folderPicker = (id: string, key: 'zettel' | 'memory' | 'recipe') => (
    <FolderPicker
      id={id}
      label={L('settings.targetFolderLabel')}
      value={features[key].folder}
      folders={folders}
      disabled={locked}
      onChange={(folder) => void save((f) => ({ ...f, [key]: { ...f[key], folder } }))}
    />
  );
  const paraFolder = (key: 'projects' | 'areas' | 'resources' | 'archive', label: I18nKey) => (
    <FolderPicker
      id={`para-folder-${key}`}
      label={L(label)}
      value={features.para.folders[key]}
      folders={folders}
      disabled={locked}
      onChange={(value) => void save((f) => ({ ...f, para: { ...f.para, folders: { ...f.para.folders, [key]: value } } }))}
    />
  );

  const list: (Feature | false)[] = [
    {
      id: 'para',
      Icon: FolderKanban,
      title: L('settings.paraTitle'),
      summary: L('features.sum.para'),
      details: L('settings.paraDesc'),
      standard: true,
      active: features.para.enabled,
      setActive: (on) => save((f) => ({ ...f, para: { ...f.para, enabled: on } })),
      settings: () => (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {paraFolder('projects', 'settings.paraFolderProjects')}
          {paraFolder('areas', 'settings.paraFolderAreas')}
          {paraFolder('resources', 'settings.paraFolderResources')}
          {paraFolder('archive', 'settings.paraFolderArchive')}
        </div>
      ),
    },
    {
      id: 'zettel',
      Icon: Lightbulb,
      title: L('settings.zettelTitle'),
      summary: L('features.sum.zettel'),
      details: L('settings.zettelDesc'),
      standard: true,
      active: features.zettel.enabled,
      setActive: (on) => save((f) => ({ ...f, zettel: { ...f.zettel, enabled: on } })),
      settings: () => folderPicker('zettel-target-folder', 'zettel'),
    },
    {
      id: 'daily',
      Icon: CalendarDays,
      title: L('settings.dailyTitle'),
      summary: L('features.sum.daily'),
      details: L('settings.dailyDesc'),
      active: features.daily.enabled,
      setActive: (on) => save((f) => ({ ...f, daily: { ...f.daily, enabled: on } })),
      settings: () => <DailySettings features={features} folders={folders} locked={locked} />,
    },
    {
      id: 'weekly',
      Icon: CalendarRange,
      title: L('features.weeklyTitle'),
      summary: L('features.sum.weekly'),
      details: L('features.weeklyDesc'),
      active: features.weekly.enabled,
      setActive: (on) => save((f) => ({ ...f, weekly: { ...f.weekly, enabled: on } })),
      settings: () => <DailySettings kind="weekly" features={features} folders={folders} locked={locked} />,
    },
    {
      id: 'monthly',
      Icon: CalendarMonth,
      title: L('features.monthlyTitle'),
      summary: L('features.sum.monthly'),
      details: L('features.monthlyDesc'),
      active: features.monthly.enabled,
      setActive: (on) => save((f) => ({ ...f, monthly: { ...f.monthly, enabled: on } })),
      settings: () => <DailySettings kind="monthly" features={features} folders={folders} locked={locked} />,
    },
    {
      id: 'calendarView',
      Icon: CalendarMonth,
      title: L('features.calendarViewTitle'),
      summary: L('features.sum.calendarView'),
      details: L('features.calendarViewDesc'),
      standard: true,
      ...flag('calendarView'),
    },
    server && {
      id: 'comments',
      Icon: MessageSquare,
      title: L('features.commentsTitle'),
      summary: L('features.sum.comments'),
      details: L('features.commentsDesc'),
      standard: true,
      ...flag('comments'),
    },
    server && {
      id: 'mentions',
      Icon: AtSign,
      title: L('features.mentionsTitle'),
      summary: L('features.sum.mentions'),
      details: L('features.mentionsDesc'),
      standard: true,
      ...flag('mentions'),
    },
    server && {
      id: 'activity',
      Icon: ActivityIcon,
      title: L('features.activityTitle'),
      summary: L('features.sum.activity'),
      details: L('features.activityDesc'),
      standard: true,
      ...flag('activity'),
    },
    {
      id: 'review',
      Icon: CalendarCheck,
      title: L('settings.reviewTitle'),
      summary: L('features.sum.review'),
      details: L('settings.reviewDesc'),
      ...flag('review'),
    },
    {
      id: 'heatmap',
      Icon: CalendarRange,
      title: L('settings.heatmapTitle'),
      summary: L('features.sum.heatmap'),
      details: L('settings.heatmapDesc'),
      ...flag('heatmap'),
    },
    {
      id: 'favorites',
      Icon: Star,
      title: L('settings.favoritesTitle'),
      summary: L('features.sum.favorites'),
      details: L('settings.favoritesDesc'),
      ...flag('favorites'),
    },
    {
      id: 'icons',
      Icon: Mood,
      title: L('settings.iconsTitle'),
      summary: L('features.sum.icons'),
      details: L('settings.iconsDesc'),
      ...flag('icons'),
    },
    {
      id: 'writingStats',
      Icon: AlignJustify,
      title: L('settings.statsTitle'),
      summary: L('features.sum.writingStats'),
      details: L('settings.statsDesc'),
      ...flag('writingStats'),
    },
    {
      id: 'focus',
      Icon: CenterFocus,
      title: L('settings.focusTitle'),
      summary: L('features.sum.focus'),
      details: L('settings.focusDesc'),
      active: features.focus.enabled,
      setActive: (on) => save((f) => ({ ...f, focus: { ...f.focus, enabled: on } })),
      settings: () => (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <label htmlFor="feature-focus-dim-switch" className={`text-sm font-medium ${locked ? '' : 'cursor-pointer'}`}>
              {L('settings.focusDimTitle')}
            </label>
            <p className="text-xs text-on-surface-variant">{L('settings.focusDimDesc')}</p>
          </div>
          <Switch
            id="feature-focus-dim-switch"
            checked={features.focus.dim}
            disabled={locked}
            label={L('settings.focusDimTitle')}
            onChange={(dim) => void save((f) => ({ ...f, focus: { ...f.focus, dim } }))}
          />
        </div>
      ),
    },
    {
      id: 'database',
      Icon: Table2,
      title: L('features.databaseTitle'),
      summary: L('features.sum.database'),
      details: L('features.databaseDesc'),
      ...flag('database'),
    },
    {
      id: 'tickets',
      Icon: Kanban,
      title: L('features.ticketsTitle'),
      summary: L('features.sum.tickets'),
      details: L('features.ticketsDesc'),
      hint: server ? L('features.ticketsGroupHint') : undefined,
      ...flag('tickets'),
    },
    {
      id: 'presentation',
      Icon: Slideshow,
      title: L('features.presentationTitle'),
      summary: L('features.sum.presentation'),
      details: L('features.presentationDesc'),
      ...flag('presentation'),
    },
    {
      id: 'linkPreview',
      Icon: Link2,
      title: L('features.linkPreviewTitle'),
      summary: L('features.sum.linkPreview'),
      details: L('features.linkPreviewDesc'),
      ...flag('linkPreview'),
    },
    {
      id: 'habits',
      Icon: Flame,
      title: L('features.habitsTitle'),
      summary: L('features.sum.habits'),
      details: L('features.habitsDesc'),
      ...flag('habits'),
    },
    server &&
      !DEMO && {
        id: 'cockpit',
        Icon: Speed,
        title: L('features.cockpitTitle'),
        summary: L('features.sum.cockpit'),
        details: L('features.cockpitDesc'),
        active: features.cockpit.enabled,
        setActive: async (on: boolean) => {
          await save((f) => ({ ...f, cockpit: { enabled: on } }));
          // The first dashboard with the widgets most people need; later switches keep what is there
          if (on) await import('../data/cockpit').then((m) => m.ensureDefaultDashboard(lang));
        },
        settings: () => (
          <Suspense fallback={null}>
            <CockpitConnectionsView />
          </Suspense>
        ),
      },
    {
      id: 'minigame',
      Icon: Gamepad,
      title: L('features.minigameTitle'),
      summary: L('features.sum.minigame'),
      details: L('features.minigameDesc'),
      ...flag('minigame'),
    },
    {
      id: 'callouts',
      Icon: Callout,
      title: L('features.calloutsTitle'),
      summary: L('features.sum.callouts'),
      details: L('features.calloutsDesc'),
      standard: true,
      ...flag('callouts'),
    },
    {
      id: 'recipe',
      Icon: ChefHat,
      title: L('settings.recipeTitle'),
      summary: L('features.sum.recipe'),
      details: L('settings.recipeDesc'),
      active: features.recipe.enabled,
      setActive: (on) =>
        save((f) => {
          let folder = f.recipe.folder;
          if (on) {
            if (f.para.enabled && folder === STANDALONE_RECIPE_FOLDER && !folders.includes(STANDALONE_RECIPE_FOLDER)) folder = `${f.para.folders.resources}/Rezepte`;
            else if (!f.para.enabled && folder === DEFAULT_RECIPE_FOLDER && !folders.includes(DEFAULT_RECIPE_FOLDER)) folder = STANDALONE_RECIPE_FOLDER;
          }
          return { ...f, recipe: { ...f.recipe, enabled: on, folder } };
        }),
      settings: () => folderPicker('recipe-target-folder', 'recipe'),
    },
    {
      id: 'memory',
      Icon: Psychology,
      title: L('settings.memoryTitle'),
      summary: L('features.sum.memory'),
      details: L('settings.memoryDesc'),
      active: features.memory.enabled,
      setActive: (on) => save((f) => ({ ...f, memory: { ...f.memory, enabled: on } })),
      settings: () => (
        <>
          {folderPicker('memory-target-folder', 'memory')}
          <MemoryBundleActions disabled={locked} />
        </>
      ),
    },
    {
      id: 'mcp',
      Icon: Bot,
      title: L('settings.mcpTitle'),
      summary: L('settings.mcpDesc'),
      details: L('mcp.intro'),
      hint: serverHint,
      ...flag('mcp'),
      settings: () => <McpSettingsView embedded />,
    },
    server && {
      id: 'notifications',
      Icon: Bell,
      title: L('settings.notifyTitle'),
      summary: L('settings.notifyDesc'),
      details: L('notify.intro'),
      ...flag('notifications'),
      settings: () => <NotificationSettingsView embedded />,
    },
    server && {
      id: 'calendar',
      Icon: CalendarDays,
      title: L('settings.calendarTitle'),
      summary: L('settings.calendarDesc'),
      details: L('calendar.intro'),
      hint: serverHint,
      ...flag('calendar'),
      settings: () => <CalendarSettingsView embedded />,
    },
    server && {
      id: 'shortcuts',
      Icon: Smartphone,
      title: L('settings.shortcutsTitle'),
      summary: L('settings.shortcutsDesc'),
      details: L('shortcuts.intro'),
      hint: serverHint,
      ...flag('shortcuts'),
      settings: () => <ShortcutsSettingsView embedded />,
    },
    confluenceAvailable() &&
      !DEMO && {
        id: 'confluence',
        Icon: Cloud,
        title: L('settings.confluenceTitle'),
        summary: L('settings.confluenceDesc'),
        details: L('confluence.intro'),
        hint: L('features.confluenceHint'),
        active: !!confluence?.connection,
        // On once a connection is saved: "Activate" opens the form, "Deactivate" removes the connection
        setActive: confluence?.connection
          ? async (on) => {
              if (!on) setConfluenceOverview(await api<ConfluenceOverview>('/confluence/connection', { method: 'DELETE' }));
            }
          : undefined,
        offConfirm: L('confluence.removeConfirm'),
        settings: () => <ConfluenceSettingsView embedded />,
      },
  ];
  return list.filter((f): f is Feature => !!f);
}

/** Number of active and available features, for the settings page */
export function useFeatureCounts(): { active: number; available: number } {
  const lang = useLang();
  const list = useFeatures(lang);
  const active = list.filter((f) => f.active).length;
  return { active, available: list.length - active };
}

/**
 * Features as a dialog, like installing plugins: "Available" lists what is off, "Active" what is on. A feature opens
 * with its picture, description and "Activate"/"Deactivate"; while it is on, a second tab holds its settings.
 */
export function FeaturesDialog({ onClose, initial }: { onClose: () => void; initial?: FeatureArtId }) {
  const lang = useLang();
  const locked = useReadOnly();
  const list = useFeatures(lang);
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  const [tab, setTab] = useState<ListTab>(() => (list.find((f) => f.id === initial)?.active ? 'active' : 'available'));
  const [openId, setOpenId] = useState<FeatureArtId | null>(initial ?? null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = list.find((f) => f.id === openId) ?? null;
  const active = list.filter((f) => f.active);
  const available = list.filter((f) => !f.active);
  const shown = tab === 'active' ? active : available;
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A feature that was switched off has no settings tab
  useEffect(() => {
    if (open && !open.active && detailTab === 'settings' && open.setActive) setDetailTab('overview');
  }, [open?.active]);
  // Moving between the list and a feature: the focus goes to the new heading
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), [openId]);

  const show = (id: FeatureArtId | null, nextTab: DetailTab = 'overview') => {
    setError('');
    setDetailTab(nextTab);
    setOpenId(id);
  };

  const toggle = async (f: Feature, on: boolean) => {
    // Confluence: on once a connection is saved, which happens in its settings
    if (on && !f.setActive) return show(f.id, 'settings');
    if (!f.setActive) return;
    if (!on && f.offConfirm && !confirm(f.offConfirm)) return;
    setBusy(true);
    setError('');
    try {
      await f.setActive(on);
      if (on && f.settings) setDetailTab('settings');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const L = (key: I18nKey, vars?: Record<string, string | number>) => tl(lang, key, vars);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4 lg:p-6">
      <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={L('features.title')}
        data-features-dialog
        className="relative flex h-[min(94dvh,100%)] w-full max-w-6xl flex-col overflow-hidden rounded-t-xl border border-line2 bg-panel shadow-elevation-3 outline-none anim-sheet sm:h-[min(92vh,1080px)] sm:rounded-xl"
      >
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-4 sm:px-6">
          {open ? (
            <button className="btn-icon -ml-2 shrink-0" onClick={() => show(null)} aria-label={L('features.back')} title={L('features.back')}>
              <ArrowLeft size={20} />
            </button>
          ) : (
            <Extension size={22} className="shrink-0 text-primary" />
          )}
          <h2 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-headline-s outline-none">
            {open ? open.title : L('features.title')}
          </h2>
          <button className="btn-icon shrink-0" onClick={onClose} aria-label={L('common.close')}>
            <X size={20} />
          </button>
        </div>

        {locked && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded-xl bg-surface-container-highest/60 px-3.5 py-2.5 text-xs text-on-surface-variant sm:mx-6">
            <Lock size={14} className="mt-0.5 shrink-0 text-primary" />
            <span>{L('settings.featuresReadOnlyHint')}</span>
          </div>
        )}

        {open ? (
          <FeatureDetail
            feature={open}
            tab={detailTab}
            onTab={setDetailTab}
            busy={busy || locked}
            error={error}
            onToggle={(on) => void toggle(open, on)}
          />
        ) : (
          <>
            <Tabs
              label={L('features.title')}
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'available', label: L('features.tabAvailable', { n: available.length }) },
                { id: 'active', label: L('features.tabActive', { n: active.length }) },
              ]}
            />
            <div role="tabpanel" aria-label={tab === 'active' ? L('features.tabActive', { n: active.length }) : L('features.tabAvailable', { n: available.length })} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 safe-bottom [--pad-bottom:1rem] sm:px-6">
              {shown.length === 0 ? (
                <p className="py-16 text-center text-sm text-on-surface-variant">{tab === 'active' ? L('features.emptyActive') : L('features.emptyAvailable')}</p>
              ) : (
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
                  {shown.map((f) => (
                    <li key={f.id}>
                      <FeatureCard feature={f} disabled={busy || locked} onOpen={() => show(f.id)} onActivate={() => void toggle(f, true).then(() => show(f.id, f.settings ? 'settings' : 'overview'))} />
                    </li>
                  ))}
                </ul>
              )}
              {error && <p className="mt-3 text-sm text-error">{error}</p>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

/** M3 primary tabs (label only) */
function Tabs<T extends string>({ label, value, onChange, tabs }: { label: string; value: T; onChange: (v: T) => void; tabs: { id: T; label: string }[] }) {
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 border-b border-outline-variant px-2 sm:px-4">
      {tabs.map(({ id, label: text }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            data-tab={id}
            onClick={() => onChange(id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const i = tabs.findIndex((t) => t.id === value);
              const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
              onChange(next.id);
              (e.currentTarget.parentElement?.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus();
            }}
            className={`state-layer relative flex h-12 min-w-0 flex-1 items-center justify-center px-3 text-title-s outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:flex-none sm:px-6 ${
              active ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="truncate">{text}</span>
            {active && <span aria-hidden className="absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-primary" />}
          </button>
        );
      })}
    </div>
  );
}

/** A feature in the list: picture, name, one line, and "Activate" or the way to its settings */
function FeatureCard({ feature: f, disabled, onOpen, onActivate }: { feature: Feature; disabled: boolean; onOpen: () => void; onActivate: () => void }) {
  const lang = useLang();
  return (
    <div className="card flex h-full flex-col overflow-hidden" data-feature={f.id}>
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col text-left transition-colors hover:bg-surface-container-high/40">
        <FeatureArt id={f.id} className="aspect-[16/7] w-full" />
        <div className="flex flex-1 items-start gap-3 p-4 pb-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary-container text-on-secondary-container">
            <f.Icon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{f.title}</span>
              {f.standard && <span className="rounded-full bg-tertiary-container px-2 py-0.5 text-label-s text-on-tertiary-container">{tl(lang, 'features.standard')}</span>}
            </div>
            <p className="mt-0.5 text-sm text-on-surface-variant">{f.summary}</p>
          </div>
        </div>
      </button>
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        {f.active ? (
          <>
            <span className="mr-auto inline-flex items-center gap-1 text-label-m text-ok">
              <Check size={14} /> {tl(lang, 'settings.featureOn')}
            </span>
            <button type="button" className="btn-text" onClick={onOpen}>
              {f.settings ? tl(lang, 'features.tabSettings') : tl(lang, 'features.details')} <ChevronRight size={16} />
            </button>
          </>
        ) : (
          <button type="button" className="btn-tonal" disabled={disabled} onClick={onActivate} data-activate={f.id}>
            {tl(lang, 'features.activate')}
          </button>
        )}
      </div>
    </div>
  );
}

/** One feature: picture, description and switch; its settings on a second tab while it is on */
function FeatureDetail({
  feature: f,
  tab,
  onTab,
  busy,
  error,
  onToggle,
}: {
  feature: Feature;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  busy: boolean;
  error: string;
  onToggle: (on: boolean) => void;
}) {
  const lang = useLang();
  // Confluence shows its settings (the connection form) before it is on
  const hasSettings = !!f.settings && (f.active || !f.setActive);
  const current = hasSettings ? tab : 'overview';
  return (
    <>
      {hasSettings && (
        <Tabs
          label={f.title}
          value={current}
          onChange={onTab}
          tabs={[
            { id: 'overview', label: tl(lang, 'features.tabOverview') },
            { id: 'settings', label: tl(lang, 'features.tabSettings') },
          ]}
        />
      )}
      <div role={hasSettings ? 'tabpanel' : undefined} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 safe-bottom [--pad-bottom:1rem] sm:px-6" data-feature-detail={f.id}>
        {current === 'overview' ? (
          <div className="mx-auto max-w-4xl space-y-4">
            <FeatureArt id={f.id} className="aspect-[16/9] w-full rounded-2xl sm:aspect-[16/7]" />
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary-container text-on-secondary-container">
                <f.Icon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-title-m">{f.title}</span>
                  {f.standard && <span className="rounded-full bg-tertiary-container px-2 py-0.5 text-label-s text-on-tertiary-container">{tl(lang, 'features.standard')}</span>}
                </div>
                <span className={`text-label-m ${f.active ? 'text-ok' : 'text-on-surface-variant'}`}>{f.active ? tl(lang, 'settings.featureOn') : tl(lang, 'settings.featureOff')}</span>
              </div>
              {f.active ? (
                f.setActive && (
                  <button type="button" className="btn-outlined text-error" disabled={busy} onClick={() => onToggle(false)} data-deactivate={f.id}>
                    {tl(lang, 'features.deactivate')}
                  </button>
                )
              ) : (
                <button type="button" className="btn-primary" disabled={busy} onClick={() => onToggle(true)} data-activate={f.id}>
                  {busy && <Loader2 size={16} className="animate-spin" />} {tl(lang, 'features.activate')}
                </button>
              )}
            </div>
            <p className="text-body-m text-on-surface-variant">{f.details}</p>
            {f.hint && (
              <div className="flex items-start gap-2 rounded-xl bg-surface-container-highest/60 px-3.5 py-2.5 text-xs text-on-surface-variant">
                <Info size={15} className="mt-0.5 shrink-0 text-primary" />
                <span>{f.hint}</span>
              </div>
            )}
            {f.active && f.settings && (
              <button type="button" className="btn-tonal" onClick={() => onTab('settings')}>
                {tl(lang, 'features.tabSettings')} <ChevronRight size={16} />
              </button>
            )}
          </div>
        ) : (
          <Suspense
            fallback={
              <p className="flex items-center gap-2 text-sm text-on-surface-variant">
                <Loader2 size={16} className="animate-spin" /> {tl(lang, 'common.loading')}
              </p>
            }
          >
            <div className="mx-auto max-w-4xl space-y-4">{f.settings!()}</div>
          </Suspense>
        )}
        {error && <p className="mt-3 text-sm text-error">{error}</p>}
      </div>
    </>
  );
}

const PERIOD_TOKENS = {
  daily: ['YYYY', 'YY', 'MMMM', 'MM', 'DD', 'WW', 'dddd'],
  weekly: ['GGGG', 'YYYY', 'WW', '[W]', 'MM'],
  monthly: ['YYYY', 'YY', 'MMMM', 'MM'],
} as const;
const PERIOD_DEFAULTS = {
  daily: { folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_FORMAT },
  weekly: { folder: DEFAULT_WEEKLY_FOLDER, format: DEFAULT_WEEKLY_FORMAT },
  monthly: { folder: DEFAULT_MONTHLY_FOLDER, format: DEFAULT_MONTHLY_FORMAT },
} as const;

/** Target folder and naming pattern of daily, weekly and monthly notes (#73) */
function DailySettings({ features, folders, locked, kind = 'daily' }: { features: FeatureSettings; folders: string[]; locked: boolean; kind?: 'daily' | 'weekly' | 'monthly' }) {
  const defaults = PERIOD_DEFAULTS[kind];
  const current = features[kind];
  const lang = useLang();
  const formatInputRef = useRef<HTMLInputElement>(null);
  const [formatDraft, setFormatDraft] = useState(current.format);

  useEffect(() => {
    setFormatDraft(current.format);
  }, [current.format]);

  const commitDailyFormat = (raw: string) => {
    const cleaned = cleanDailyFormat(raw, defaults.format);
    setFormatDraft(cleaned);
    if (cleaned !== vault.features()[kind].format) void save((f) => ({ ...f, [kind]: { ...f[kind], format: cleaned } })).catch(() => {});
  };

  const insertDailyToken = (tok: string) => {
    if (locked) return;
    const input = formatInputRef.current;
    if (input && document.activeElement === input && input.selectionStart !== null && input.selectionEnd !== null) {
      commitDailyFormat(`${formatDraft.slice(0, input.selectionStart)}${tok}${formatDraft.slice(input.selectionEnd)}`);
      return;
    }
    const trimmed = formatDraft.trim();
    if (!trimmed) {
      commitDailyFormat(`${tok}.md`);
      return;
    }
    const hadMd = /\.md$/i.test(trimmed);
    const stem = hadMd ? trimmed.slice(0, -3) : trimmed;
    const sep = !stem || stem.endsWith('/') || stem.endsWith('-') || stem.endsWith('_') || stem.endsWith(' ') ? '' : '-';
    commitDailyFormat(`${stem}${sep}${tok}${hadMd ? '.md' : ''}`);
  };

  const previewSettings = { folder: current.folder, format: formatDraft.trim() ? cleanDailyFormat(formatDraft, defaults.format) : defaults.format };
  const dailyPreview =
    kind === 'daily' ? resolveDailyNote(previewSettings, new Date(), lang).path : resolvePeriodicNote(kind === 'weekly' ? 'week' : 'month', previewSettings, new Date(), lang).path;

  return (
    <>
      <FolderPicker
        id={`${kind}-target-folder`}
        label={tl(lang, 'settings.targetFolderLabel')}
        value={current.folder}
        folders={folders}
        allowRoot
        extraOptions={[defaults.folder]}
        disabled={locked}
        onChange={(folder) => void save((f) => ({ ...f, [kind]: { ...f[kind], folder } }))}
      />
      <div className="space-y-1.5">
        <label htmlFor={`${kind}-naming-format`} className="block text-xs font-medium text-on-surface-variant">
          {tl(lang, 'settings.dailyFormatLabel')}
        </label>
        <input
          ref={formatInputRef}
          id={`${kind}-naming-format`}
          type="text"
          disabled={locked}
          placeholder={tl(lang, 'settings.dailyFormatPlaceholder')}
          className="input h-9 w-full py-1 font-mono text-sm disabled:cursor-not-allowed disabled:opacity-60"
          value={formatDraft}
          onChange={(e) => setFormatDraft(e.target.value)}
          onBlur={() => commitDailyFormat(formatDraft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDailyFormat(formatDraft);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
          <span className="text-on-surface-variant">{tl(lang, 'settings.dailyTokensLabel')}</span>
          {PERIOD_TOKENS[kind].map((tok) => (
            <button
              key={tok}
              type="button"
              disabled={locked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertDailyToken(tok)}
              className="chip font-mono text-[11px] hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {tok}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-baseline gap-1.5 pt-0.5 text-xs">
          <span className="text-on-surface-variant">{tl(lang, 'settings.dailyPreviewLabel')}</span>
          <code className="break-all rounded bg-surface-container-low px-1.5 py-0.5 font-mono text-[11px] text-primary">{dailyPreview}</code>
        </div>
      </div>
    </>
  );
}

function FolderPicker({
  id,
  label,
  value,
  folders,
  allowRoot,
  extraOptions = [],
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  folders: string[];
  allowRoot?: boolean;
  extraOptions?: string[];
  disabled?: boolean;
  onChange: (folder: string) => void;
}) {
  const lang = useLang();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const merged = [...folders];
  for (const extra of [...extraOptions, value]) {
    if (extra && !merged.includes(extra)) merged.unshift(extra);
  }
  const options = merged.filter(Boolean);
  const isCreating = creating && !disabled;

  const createFolder = async () => {
    const cleaned = draft
      .split('/')
      .map((p) => p.trim().replace(/[\\]/g, '-'))
      .filter((p) => p && p !== '.' && p !== '..')
      .join('/');
    if (!cleaned) {
      setCreating(false);
      setDraft('');
      return;
    }
    const created = await vault.addFolder(cleaned);
    setCreating(false);
    setDraft('');
    if (created) onChange(created);
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-on-surface-variant">
        {label}
      </label>
      {isCreating ? (
        <div className="flex items-center gap-1.5">
          <input
            id={id}
            autoFocus
            className="input h-9 min-w-0 flex-1 py-1 text-sm"
            placeholder={tl(lang, 'settings.newFolderPlaceholder')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void createFolder();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setCreating(false);
                setDraft('');
              }
            }}
          />
          <button
            type="button"
            className="btn-icon h-9 w-9 shrink-0 border border-line2 text-primary hover:bg-primary/10"
            title={tl(lang, 'common.create')}
            aria-label={tl(lang, 'common.create')}
            onClick={() => void createFolder()}
          >
            <Check size={16} />
          </button>
          <button
            type="button"
            className="btn-icon h-9 w-9 shrink-0 border border-line2"
            title={tl(lang, 'common.cancel')}
            aria-label={tl(lang, 'common.cancel')}
            onClick={() => {
              setCreating(false);
              setDraft('');
            }}
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <Dropdown
            id={id}
            value={value}
            disabled={disabled}
            aria-label={label}
            className="min-w-0 flex-1"
            onChange={onChange}
            options={[
              ...(allowRoot ? [{ value: '', label: tl(lang, 'common.topLevel') }] : []),
              ...options.map((f) => ({ value: f, label: folderDisplayName(f, lang) })),
            ]}
          />
          {!disabled && (
            <button
              type="button"
              className="btn-icon h-10 w-10 shrink-0 border border-line2"
              title={tl(lang, 'settings.newFolderBtnTitle')}
              aria-label={tl(lang, 'settings.newFolderBtnTitle')}
              onClick={() => setCreating(true)}
            >
              <FolderPlus size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Export of the AI memory as an OKF bundle (ZIP) and import of a bundle folder (#94) */
function MemoryBundleActions({ disabled }: { disabled: boolean }) {
  const lang = useLang();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    // Folder pick: not in the React types
    input.current?.setAttribute('webkitdirectory', '');
  }, []);
  const download = () => {
    const zip = vault.memoryBundle();
    if (!zip) return;
    const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${vault.memoryFolder() ?? 'memory'}.zip` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = await Promise.all(
      [...list]
        .filter((f) => /\.md$/i.test(f.name))
        .map(async (f) => {
          // The first path segment is the picked folder itself
          const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
          return { path: rel, content: await f.text() };
        })
    );
    const result = await vault.importMemoryBundle(files);
    setStatus(tl(lang, 'settings.memoryImportDone', { created: result.created, skipped: result.skipped }));
    if (input.current) input.current.value = '';
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-tonal" onClick={download}>
          <Download size={16} /> {tl(lang, 'settings.memoryExport')}
        </button>
        <button type="button" className="btn-outlined" disabled={disabled} onClick={() => input.current?.click()}>
          <Upload size={16} /> {tl(lang, 'settings.memoryImport')}
        </button>
        <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} data-memory-import />
      </div>
      {status && (
        <p role="status" className="text-body-s text-on-surface-variant">
          {status}
        </p>
      )}
    </div>
  );
}
