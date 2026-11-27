import { lazy } from 'react';
import { defineClientPlugin } from '@kladde/plugin-api/client';
import { LogbookIcon } from './icon.js';
import { LogbookSettings } from './Settings.js';

// Pages load on first use, like Kladde's own pages
const LogbookPage = lazy(() => import('./LogbookPage.js').then((m) => ({ default: m.LogbookPage })));
const LogbookBlock = lazy(() => import('./LogbookBlock.js').then((m) => ({ default: m.LogbookBlock })));

/** Client part of the example plugin: a page with a navigation entry, a command, a block for notes and a settings tab */
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
  // ```logbook in a note shows the latest entries; /logbook in the editor inserts one
  blocks: [{ lang: 'logbook', label: { de: 'Logbuch-Einträge', en: 'Logbook entries' }, keywords: 'journal tagebuch', template: 'limit: 5', height: 220, component: LogbookBlock }],
  settings: LogbookSettings,
});
