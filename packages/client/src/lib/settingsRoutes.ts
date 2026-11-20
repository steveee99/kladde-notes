import { useSyncExternalStore } from 'react';
import { useMaterialSidebarMode } from './sidebarMode';

/** Sections of the settings page (`/settings/<section>`); plain `/settings` is the overview or the account section */
export type SettingsSection = 'account' | 'appearance' | 'editor' | 'sync';
export const SETTINGS_SECTIONS: SettingsSection[] = ['account', 'appearance', 'editor', 'sync'];

/** Routes that show the settings navigation instead of the folder panel */
export function isSettingsPath(path: string): boolean {
  return path === '/settings' || path.startsWith('/settings/');
}

/** The section of `/settings/<section>`; plain `/settings` counts as the account section */
export function settingsSectionOf(path: string): SettingsSection | null {
  if (path === '/settings') return 'account';
  if (!path.startsWith('/settings/')) return null;
  const id = path.slice('/settings/'.length) as SettingsSection;
  return SETTINGS_SECTIONS.includes(id) ? id : null;
}

/** The `nav:` screen of tailwind.config.js: the desktop layout with rail and side panel */
const NAV_QUERY = '(min-width: 768px) and (pointer: fine), (min-width: 1024px) and (orientation: landscape), (min-width: 1280px)';
const navMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NAV_QUERY) : null;
const subscribeNav = (l: () => void) => {
  navMedia?.addEventListener('change', l);
  return () => navMedia?.removeEventListener('change', l);
};

/** True while the settings navigation sits in the side panel (desktop layout with the panel open) */
export function useSettingsNavInPanel(): boolean {
  const desktop = useSyncExternalStore(subscribeNav, () => !!navMedia?.matches);
  const mode = useMaterialSidebarMode();
  return desktop && mode === 'sticky';
}
