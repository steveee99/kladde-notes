// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { normalizeFeatures } from '@kladde/shared';
import { KladdeHostContext, type KladdeHost } from '@kladde/plugin-api/client';
import logbook from '../../../examples/kladde-plugin-logbook/src/client';
import { LogbookPage } from '../../../examples/kladde-plugin-logbook/src/LogbookPage';
import { allPlugins, isPluginEnabled, pluginCommands, pluginHref, pluginNavItems, resolvePluginPath, setInstalledPlugins } from '../src/plugins/registry';
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

  it('leaves out a plugin whose package id differs from its own', () => {
    setInstalledPlugins([installed({ id: 'other' })]);
    expect(allPlugins()).toEqual([]);
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
      ui: { PageHeader: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>, PageBody: Plain, Panel: ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => <section aria-label={String(label)}>{children}</section>, Switch: () => null },
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
    act(() => root.unmount());
  });
});
