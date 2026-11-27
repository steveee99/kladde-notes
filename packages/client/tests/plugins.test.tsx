// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { normalizeFeatures } from '@kladde/shared';
import { KladdeHostContext, type KladdeHost } from '@kladde/plugin-api/client';
import logbook from '../../../examples/kladde-plugin-logbook/src/client';
import { LogbookPage } from '../../../examples/kladde-plugin-logbook/src/LogbookPage';
import { LogbookBlock, parseBlock } from '../../../examples/kladde-plugin-logbook/src/LogbookBlock';
import { allPlugins, isPluginEnabled, pluginBlockFor, pluginCommands, pluginHref, pluginNavItems, pluginSlashBlocks, resolvePluginPath, setInstalledPlugins } from '../src/plugins/registry';
import { notificationUrl } from '../src/views/NotificationsPanel';
import { PluginTable } from '../src/plugins/PluginTable';
import type { NotificationItem } from '@kladde/shared';
import type { InstalledClientPlugin } from '../src/plugins/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const installed = (over: Partial<InstalledClientPlugin> = {}): InstalledClientPlugin => ({ name: 'kladde-plugin-logbook', id: 'logbook', version: '0.1.0', api: '^1.0.0', defaultEnabled: false, plugin: logbook, ...over });

afterEach(() => setInstalledPlugins([]));

describe('plugin registry', () => {
  it('finds the page of a plugin path with its parameters', () => {
    setInstalledPlugins([installed()]);
    expect(resolvePluginPath('/p/logbook')).toMatchObject({ sub: '', page: { path: '' } });
    expect(resolvePluginPath('/p/logbook/new')).toMatchObject({ sub: '/new', page: { path: '/new' } });
    expect(resolvePluginPath('/p/logbook/missing')).toMatchObject({ page: null });
    expect(resolvePluginPath('/p/other')).toBeNull();
    expect(resolvePluginPath('/notes')).toBeNull();
    expect(pluginHref('logbook', 'new')).toBe('/p/logbook/new');
    expect(pluginHref('logbook', '/')).toBe('/p/logbook');
  });

  it('follows the switch in the features, else the package default', () => {
    expect(isPluginEnabled(installed(), normalizeFeatures({}))).toBe(false);
    expect(isPluginEnabled(installed({ defaultEnabled: true }), normalizeFeatures({}))).toBe(true);
    expect(isPluginEnabled(installed({ defaultEnabled: true }), normalizeFeatures({ plugins: { logbook: false } }))).toBe(false);
    expect(isPluginEnabled(installed(), normalizeFeatures({ plugins: { logbook: true } }))).toBe(true);
  });

  it('adds navigation entries and commands of plugins that are on', () => {
    setInstalledPlugins([installed({ defaultEnabled: true })]);
    expect(pluginNavItems('en')).toEqual([expect.objectContaining({ to: '/p/logbook', label: 'Logbook', bottomBar: true })]);
    expect(pluginCommands('de').map((c) => c.label)).toEqual(['Logbuch', 'Neuer Logbuch-Eintrag']);
    setInstalledPlugins([installed()]);
    expect(pluginNavItems('en')).toEqual([]);
  });

  it('renders the blocks of plugins that are on, only under their own names', () => {
    const on = normalizeFeatures({ plugins: { logbook: true } });
    setInstalledPlugins([installed()]);
    expect(pluginBlockFor('logbook', normalizeFeatures({}))).toBeNull();
    expect(pluginBlockFor('logbook', on)?.block.lang).toBe('logbook');
    expect(pluginBlockFor('mermaid', on)).toBeNull();
    // A block named after something else than the plugin is ignored
    const thief = { ...logbook, blocks: [{ ...logbook.blocks![0], lang: 'query' }] };
    setInstalledPlugins([installed({ plugin: thief, defaultEnabled: true })]);
    expect(pluginBlockFor('query')).toBeNull();
    expect(pluginSlashBlocks('de')).toEqual([]);
    setInstalledPlugins([installed({ defaultEnabled: true })]);
    expect(pluginSlashBlocks('en')).toEqual([expect.objectContaining({ label: 'Logbook entries', detail: 'logbook', template: '```logbook\nlimit: 5\n```' })]);
  });

  it('opens plugin notifications only inside the plugin or at a note', () => {
    const n = (over: Partial<NotificationItem>): NotificationItem => ({ id: 'x', kind: 'plugin', at: 0, read: false, actor: null, noteId: '', path: 'kladde-plugin-logbook', text: '', plugin: 'logbook', ...over });
    expect(notificationUrl(n({ href: '/p/logbook/entries/1' }))).toBe('/p/logbook/entries/1');
    expect(notificationUrl(n({ href: '/n/abc' }))).toBe('/n/abc');
    expect(notificationUrl(n({ href: 'https://evil.example' }))).toBe('/p/logbook');
    expect(notificationUrl(n({ href: '//evil.example' }))).toBe('/p/logbook');
  });

  it('leaves out a plugin whose package id differs from its own', () => {
    setInstalledPlugins([installed({ id: 'other' })]);
    expect(allPlugins()).toEqual([]);
  });
});

describe('the example plugin block', () => {
  it('reads its settings', () => {
    expect(parseBlock('')).toEqual({ limit: 5, mood: null, edit: false });
    expect(parseBlock('limit: 3\nmood: bad\nsonst: was')).toEqual({ limit: 3, mood: 'bad', edit: false });
    expect(parseBlock('limit: 900\nmood: wild\nedit: ja')).toEqual({ limit: 50, mood: null, edit: true });
  });

  it('shows the latest entries and writes a higher limit back into the note', async () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({ id: `e${i}`, text: `Eintrag ${i}`, mood: i % 2 ? 'good' : 'bad', at: Date.UTC(2026, 10, 20 + i) }));
    const api = vi.fn(async (path: string, init?: { json?: Record<string, string> }) => (init ? { ...entries[0], ...init.json } : entries));
    const host = { lang: 'de', t: (v: string | { de: string }) => (typeof v === 'string' ? v : v.de), href: () => '/p/logbook', navigate: vi.fn(), api, ui: { Table: PluginTable } } as unknown as KladdeHost;
    const setSource = vi.fn();
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        <KladdeHostContext.Provider value={host}>
          <LogbookBlock source="limit: 1" lang="logbook" noteId="n1" setSource={setSource} />
        </KladdeHostContext.Provider>
      );
    });
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(el.textContent).toContain('Eintrag 0');
    // Read-only without `edit: yes`
    expect(el.querySelector('td[data-row]')).toBeNull();
    const more = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Mehr zeigen')!;
    act(() => more.click());
    expect(setSource).toHaveBeenCalledWith('limit: 6');
    // `edit: yes` in an editable note: the text column edits the entry on the server
    await act(async () => {
      root.render(
        <KladdeHostContext.Provider value={host}>
          <LogbookBlock source={'limit: 1\nedit: yes'} lang="logbook" noteId="n1" setSource={setSource} />
        </KladdeHostContext.Provider>
      );
    });
    expect(el.querySelector('td[data-row="0"][data-col="0"]')).toBeNull();
    act(() => (el.querySelector('td[data-row="0"][data-col="2"]') as HTMLElement).click());
    const field = el.querySelector<HTMLInputElement>('.wz-cell-input')!;
    expect(field.value).toBe('Eintrag 0');
    field.value = 'Neu';
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(api).toHaveBeenCalledWith('/entries/e0', { method: 'PATCH', json: { text: 'Neu' } });
    expect(el.textContent).toContain('Neu');
    act(() => (more.isConnected ? more : [...el.querySelectorAll('button')].find((b) => b.textContent === 'Mehr zeigen')!).click());
    expect(setSource).toHaveBeenLastCalledWith('limit: 6\nedit: yes');
    // Read-only notes get no setSource: no button
    await act(async () => {
      root.render(
        <KladdeHostContext.Provider value={host}>
          <LogbookBlock source={'limit: 1\nmood: good'} lang="logbook" noteId="n1" />
        </KladdeHostContext.Provider>
      );
    });
    expect(el.textContent).toContain('Eintrag 1');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Mehr zeigen')).toBe(false);
    act(() => root.unmount());
  });
});

describe('the example plugin page', () => {
  it('renders with the host it gets from Kladde', async () => {
    const api = vi.fn(async () => [{ id: 'e1', text: 'Erster Eintrag', mood: 'good', at: Date.UTC(2026, 10, 27) }]);
    const Plain = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
    const host = {
      pluginId: 'logbook',
      lang: 'de',
      me: { id: 'u1', username: 'anna', displayName: null, isAdmin: false },
      t: (v: string | { de: string }) => (typeof v === 'string' ? v : v.de),
      href: (p = '') => `/p/logbook${p}`,
      navigate: vi.fn(),
      openNote: vi.fn(),
      toast: vi.fn(),
      api,
      notes: { list: () => [{ id: 'n1', path: 'Logbuch/a.md', title: 'Logbuch-Notiz', content: '', version: 1, updatedAt: 0, access: 'owner' }], get: vi.fn(), load: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
      useNotesVersion: () => 0,
      ui: {
        PageHeader: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
        PageBody: Plain,
        Panel: ({ label, aside, children }: { label: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) => (
          <section aria-label={String(label)}>
            {aside}
            {children}
          </section>
        ),
        Switch: ({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) => <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} />,
        Table: PluginTable,
      },
    } as unknown as KladdeHost;
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => {
      root.render(
        <KladdeHostContext.Provider value={host}>
          <LogbookPage params={{}} path="" />
        </KladdeHostContext.Provider>
      );
    });
    expect(api).toHaveBeenCalledWith('/entries');
    expect(el.querySelector('h1')?.textContent).toBe('Logbuch');
    expect(el.textContent).toContain('Erster Eintrag');
    expect(el.textContent).toContain('Logbuch-Notiz');
    // Read-only until the switch is on; then rows can be deleted
    expect(el.querySelector('.wz-row-delete')).toBeNull();
    act(() => el.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(el.querySelector('.wz-table-editable')).not.toBeNull();
    await act(async () => el.querySelector<HTMLButtonElement>('.wz-row-delete')!.click());
    expect(api).toHaveBeenCalledWith('/entries/e1', { method: 'DELETE' });
    expect(el.textContent).toContain('Noch keine Einträge.');
    act(() => root.unmount());
  });
});
