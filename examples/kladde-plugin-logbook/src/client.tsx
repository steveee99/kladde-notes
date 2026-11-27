import { lazy } from 'react';
import { defineClientPlugin } from '@kladde/plugin-api/client';
import { LogbookIcon } from './icon.js';
import { LogbookSettings } from './Settings.js';

// Pages load on first use, like Kladde's own pages
const LogbookPage = lazy(() => import('./LogbookPage.js').then((m) => ({ default: m.LogbookPage })));

/** Client part of the example plugin: a page with a navigation entry, a command and a settings tab */
export default defineClientPlugin({
  id: 'logbook',
  name: { de: 'Logbuch', en: 'Logbook' },
  summary: { de: 'Kurze Einträge mit Stimmung, verschlüsselt gespeichert', en: 'Short entries with a mood, stored encrypted' },
  description: {
    de: 'Ein Beispiel-Plugin: eigene Tabellen mit Migrationen, verschlüsselte Einträge, ein Menüpunkt und Einträge, die auf Wunsch zu Notizen werden.',
    en: 'An example plugin: own tables with migrations, encrypted entries, a navigation entry and entries that become notes on request.',
  },
  icon: LogbookIcon,
  pages: [
    { path: '', component: LogbookPage },
    { path: '/new', component: LogbookPage },
  ],
  nav: [{ label: { de: 'Logbuch', en: 'Logbook' }, bottomBar: true }],
  commands: [{ id: 'new', label: { de: 'Neuer Logbuch-Eintrag', en: 'New logbook entry' }, keywords: 'journal tagebuch', path: '/new' }],
  settings: LogbookSettings,
});
