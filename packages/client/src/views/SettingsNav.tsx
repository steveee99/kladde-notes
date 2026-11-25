import { useState, type ComponentType, type ReactNode } from 'react';
import type { Me } from '@kladde/shared';
import {
  AccountCircle,
  Archive,
  Bell,
  Bot,
  CalendarDays,
  ChevronRight,
  Cloud,
  EditNote,
  Extension,
  FolderInput,
  Images,
  LayoutTemplate,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sync,
  Trash2,
} from '../lib/icons';
import { useConfluenceConnected } from '../lib/confluence';
import { tl, useLang, type I18nKey } from '../lib/i18n';
import { navigate, usePath } from '../lib/router';
import { useVault, vault } from '../data/vault';
import { DEMO } from '../demo/demoApi';
export { isSettingsPath, settingsSectionOf, useSettingsNavInPanel, type SettingsSection } from '../lib/settingsRoutes';
import { FeaturesDialog, useFeatureCounts } from './FeaturesDialog';

/*
 * Settings navigation (Werkbank): on the desktop it takes the place of the folder panel while a settings page is
 * open; on phones (and with the panel collapsed) `/settings` shows it as a list. The sections of the settings page
 * itself (account, appearance, editor, sync) and the settings subpages share it.
 */

type IconType = ComponentType<{ size?: number; className?: string }>;
interface Entry {
  path: string;
  Icon: IconType;
  label: I18nKey;
  desc?: I18nKey;
}
interface Group {
  label: I18nKey;
  entries: Entry[];
}

function useGroups(me: Me): Group[] {
  useVault();
  const connected = useConfluenceConnected();
  const features = vault.features();
  const server = !vault.standalone && !DEMO;
  const groups: Group[] = [
    {
      label: 'settings.groupGeneral',
      entries: [
        { path: '/settings/account', Icon: AccountCircle, label: 'settings.navAccount', desc: 'settings.navAccountDesc' },
        { path: '/settings/appearance', Icon: Palette, label: 'settings.navAppearance', desc: 'settings.navAppearanceDesc' },
        { path: '/settings/editor', Icon: EditNote, label: 'settings.navEditor', desc: 'settings.navEditorDesc' },
        { path: '/settings/sync', Icon: Sync, label: 'settings.navSync', desc: 'settings.navSyncDesc' },
      ],
    },
    {
      label: 'settings.groupContent',
      entries: [
        { path: '/settings/templates', Icon: LayoutTemplate, label: 'settings.templatesTitle', desc: 'settings.navTemplatesDesc' },
        { path: '/settings/types', Icon: SlidersHorizontal, label: 'types.title', desc: 'types.navDesc' },
        { path: '/settings/files', Icon: Images, label: 'settings.filesTitle', desc: 'settings.filesDesc' },
        { path: '/settings/trash', Icon: Trash2, label: 'settings.trashTitle', desc: 'settings.trashDesc' },
        ...(!me.standalone ? [{ path: '/settings/import', Icon: FolderInput, label: 'settings.importTitle', desc: 'settings.importDesc' } as Entry] : []),
        ...(!DEMO ? [{ path: '/settings/export', Icon: Archive, label: 'accountExport.title', desc: 'accountExport.cardDesc' } as Entry] : []),
      ],
    },
    {
      label: 'settings.groupConnections',
      entries: [
        ...(features.mcp.enabled ? [{ path: '/settings/mcp', Icon: Bot, label: 'settings.mcpTitle', desc: 'settings.mcpDesc' } as Entry] : []),
        ...(server && features.notifications.enabled ? [{ path: '/settings/notifications', Icon: Bell, label: 'settings.notifyTitle', desc: 'settings.notifyDesc' } as Entry] : []),
        ...(server && features.calendar.enabled ? [{ path: '/settings/calendar', Icon: CalendarDays, label: 'settings.calendarTitle', desc: 'settings.calendarDesc' } as Entry] : []),
        ...(server && features.shortcuts.enabled ? [{ path: '/settings/shortcuts', Icon: Smartphone, label: 'settings.shortcutsTitle', desc: 'settings.shortcutsDesc' } as Entry] : []),
        ...(connected && !DEMO ? [{ path: '/settings/confluence', Icon: Cloud, label: 'settings.confluenceTitle', desc: 'settings.confluenceDesc' } as Entry] : []),
      ],
    },
    ...(me.isAdmin && !me.standalone ? [{ label: 'settings.groupServer', entries: [{ path: '/settings/admin', Icon: ShieldCheck, label: 'settings.adminTitle', desc: 'settings.adminDesc' }] } as Group] : []),
  ];
  return groups.filter((g) => g.entries.length);
}

/** Button that opens the features dialog (in both variants of the navigation) */
function FeaturesEntry({ render }: { render: (props: { onClick: () => void; desc: string }) => ReactNode }) {
  const lang = useLang();
  const { active, available } = useFeatureCounts();
  const [open, setOpen] = useState(false);
  return (
    <>
      {render({ onClick: () => setOpen(true), desc: tl(lang, 'features.cardDesc', { active, available }) })}
      {open && <FeaturesDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The settings navigation. `panel`: compact rows in the side panel (desktop); otherwise the list page of `/settings`
 * on phones, with a description under every entry.
 */
export function SettingsNav({ me, panel, headerAction }: { me: Me; panel?: boolean; headerAction?: ReactNode }) {
  const lang = useLang();
  const path = usePath();
  const groups = useGroups(me);
  const activePath = path === '/settings' && panel ? '/settings/account' : path;

  if (panel) {
    const row = (active: boolean) =>
      `flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-body-m outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-acc ${
        active ? 'bg-line text-strong' : 'text-soft hover:bg-raised hover:text-text'
      }`;
    return (
      <nav aria-label={tl(lang, 'settings.title')} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 pl-4 pr-1.5">
          <span className="section-label">{tl(lang, 'settings.title')}</span>
          {headerAction}
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-4 scrollbar-thin">
          {groups.map((g, gi) => (
            <div key={g.label}>
              {gi > 0 && <div className="px-2.5 pb-1 text-label-s text-faint">{tl(lang, g.label)}</div>}
              <ul className="space-y-px">
                {g.entries.map(({ path: to, Icon, label }) => (
                  <li key={to}>
                    <a
                      href={to}
                      aria-current={activePath === to ? 'page' : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        navigate(to);
                      }}
                      className={row(activePath === to)}
                    >
                      <Icon size={16} className={activePath === to ? 'shrink-0 text-acc' : 'shrink-0 text-muted'} />
                      <span className="truncate">{tl(lang, label)}</span>
                    </a>
                  </li>
                ))}
                {gi === 0 && (
                  <li>
                    <FeaturesEntry
                      render={({ onClick }) => (
                        <button type="button" className={row(false)} onClick={onClick} aria-haspopup="dialog" data-open-features>
                          <Extension size={16} className="shrink-0 text-muted" />
                          <span className="truncate">{tl(lang, 'features.title')}</span>
                        </button>
                      )}
                    />
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    );
  }

  const card = 'flex w-full min-w-0 items-center gap-3 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-raised focus-visible:bg-raised';
  const tile = (Icon: IconType) => (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line2 bg-raised text-soft">
      <Icon size={16} />
    </span>
  );
  return (
    <nav aria-label={tl(lang, 'settings.title')} className="space-y-5">
      {groups.map((g, gi) => (
        <section key={g.label} className="space-y-2">
          <h2 className="section-label px-1">{tl(lang, g.label)}</h2>
          <ul className="card divide-y divide-line overflow-hidden">
            {g.entries.map(({ path: to, Icon, label, desc }) => (
              <li key={to}>
                <a
                  href={to}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(to);
                  }}
                  className={card}
                >
                  {tile(Icon)}
                  <span className="min-w-0 flex-1">
                    <span className="block text-title-s text-strong">{tl(lang, label)}</span>
                    {desc && <span className="block truncate text-body-s text-muted">{tl(lang, desc)}</span>}
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-muted" />
                </a>
              </li>
            ))}
            {gi === 0 && (
              <li>
                <FeaturesEntry
                  render={({ onClick, desc }) => (
                    <button type="button" className={card} onClick={onClick} aria-haspopup="dialog" data-open-features>
                      {tile(Extension)}
                      <span className="min-w-0 flex-1">
                        <span className="block text-title-s text-strong">{tl(lang, 'features.title')}</span>
                        <span className="block truncate text-body-s text-muted">{desc}</span>
                      </span>
                      <ChevronRight size={16} className="shrink-0 text-muted" />
                    </button>
                  )}
                />
              </li>
            )}
          </ul>
        </section>
      ))}
    </nav>
  );
}
