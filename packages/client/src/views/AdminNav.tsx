import type { ComponentType, ReactNode } from 'react';
import { ArrowLeft, Backup, ChevronRight, Mail, RemoteDoc, ScrollText, Users } from '../lib/icons';
import { tl, useLang, type I18nKey } from '../lib/i18n';
import { navigate, usePath } from '../lib/router';
import { adminSectionOf, type AdminSection } from '../lib/settingsRoutes';

/*
 * Navigation of the admin area: on the desktop it takes the place of the settings navigation in the side panel while
 * an admin page is open, with a way back to the settings on top; on phones (and with the panel collapsed)
 * `/settings/admin` shows it as a list.
 */

type IconType = ComponentType<{ size?: number; className?: string }>;
export interface AdminEntry {
  id: AdminSection;
  Icon: IconType;
  label: I18nKey;
  desc: I18nKey;
}

export const ADMIN_ENTRIES: AdminEntry[] = [
  { id: 'users', Icon: Users, label: 'admin.tabUsers', desc: 'admin.navUsersDesc' },
  { id: 'groups', Icon: Users, label: 'admin.tabGroups', desc: 'admin.navGroupsDesc' },
  { id: 'invites', Icon: Mail, label: 'admin.tabInvites', desc: 'admin.navInvitesDesc' },
  { id: 'remote', Icon: RemoteDoc, label: 'remote.admin.tab', desc: 'admin.navRemoteDesc' },
  { id: 'backups', Icon: Backup, label: 'admin.tabBackups', desc: 'admin.navBackupsDesc' },
  { id: 'audit', Icon: ScrollText, label: 'admin.tabAudit', desc: 'admin.navAuditDesc' },
];

/** The section the desktop shows on plain `/settings/admin` */
export const FIRST_ADMIN_SECTION: AdminSection = ADMIN_ENTRIES[0].id;

const hrefOf = (id: AdminSection) => `/settings/admin/${id}`;

function go(e: React.MouseEvent, to: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(to);
}

/** `panel`: compact rows in the side panel (desktop); otherwise the list page of `/settings/admin` */
export function AdminNav({ panel, headerAction }: { panel?: boolean; headerAction?: ReactNode }) {
  const lang = useLang();
  const path = usePath();
  const active = adminSectionOf(path) ?? (panel ? FIRST_ADMIN_SECTION : null);

  if (panel) {
    const row = (on: boolean) =>
      `flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-body-m outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-acc ${
        on ? 'bg-line text-strong' : 'text-soft hover:bg-raised hover:text-text'
      }`;
    return (
      <nav aria-label={tl(lang, 'admin.title')} className="flex min-h-0 flex-1 flex-col" data-admin-nav>
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 pl-1.5 pr-1.5">
          <a href="/settings" onClick={(e) => go(e, '/settings')} className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-body-m text-soft outline-none hover:bg-raised hover:text-text focus-visible:ring-2 focus-visible:ring-acc" data-admin-back>
            <ArrowLeft size={16} className="shrink-0" />
            <span className="truncate">{tl(lang, 'settings.title')}</span>
          </a>
          {headerAction}
        </div>
        <div className="px-4 pb-1 pt-1">
          <span className="section-label">{tl(lang, 'admin.title')}</span>
        </div>
        <ul className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-4 scrollbar-thin">
          {ADMIN_ENTRIES.map(({ id, Icon, label }) => (
            <li key={id}>
              <a href={hrefOf(id)} aria-current={active === id ? 'page' : undefined} onClick={(e) => go(e, hrefOf(id))} className={row(active === id)}>
                <Icon size={16} className={active === id ? 'shrink-0 text-acc' : 'shrink-0 text-muted'} />
                <span className="truncate">{tl(lang, label)}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label={tl(lang, 'admin.title')} data-admin-nav>
      <ul className="card divide-y divide-line overflow-hidden">
        {ADMIN_ENTRIES.map(({ id, Icon, label, desc }) => (
          <li key={id}>
            <a href={hrefOf(id)} onClick={(e) => go(e, hrefOf(id))} className="flex w-full min-w-0 items-center gap-3 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-raised focus-visible:bg-raised">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line2 bg-raised text-soft">
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-title-s text-strong">{tl(lang, label)}</span>
                <span className="block truncate text-body-s text-muted">{tl(lang, desc)}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
