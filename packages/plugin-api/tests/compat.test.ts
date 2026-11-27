import { describe, expect, it } from 'vitest';
import fs from 'fs';
import { checkPluginPackage, checkPluginSet, compareVersions, PLUGIN_API_VERSION, pluginTablePrefix, satisfies, type PluginPackageJson } from '../src/index';

describe('satisfies', () => {
  it.each([
    ['1.4.0', '^1.3.0', true],
    ['2.0.0', '^1.3.0', false],
    ['1.2.9', '^1.3.0', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.0', '1.x', true],
    ['2.0.0', '1', false],
    ['1.5.0', '>=1.2 <2', true],
    ['2.0.0', '>=1.2 <2', false],
    ['3.1.0', '^1.0.0 || ^3.0.0', true],
    ['1.0.0', '*', true],
    ['1.0.0', '>= 1.0.0', true],
    ['1.0.0', '1.0.0', true],
    ['1.0.1', '=1.0.0', false],
    ['2.0.0-rc.1', '^1.0.0', false],
    ['2.0.0-rc.1', '>=2.0.0-rc.0', true],
    ['2.0.0', '>1', true],
    ['1.9.9', '<=1.9', true],
    ['not-a-version', '*', false],
    ['1.0.0', 'garbage', false],
  ])('%s in %s → %s', (version, range, ok) => {
    expect(satisfies(version, range)).toBe(ok);
  });

  it('orders versions and pre-releases', () => {
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('2.27.0', '2.27.0')).toBe(0);
  });
});

describe('checkPluginPackage', () => {
  const host = { api: '1.2.0', app: '2.28.0', react: '18.3.1' };
  const good: PluginPackageJson = {
    name: '@team/kladde-plugin-zeit',
    version: '1.4.0',
    kladde: { id: 'zeit' },
    exports: { './server': './dist/server.js', './client': './dist/client.js' },
    peerDependencies: { '@kladde/plugin-api': '^1.1.0', react: '^18.3.0' },
  };

  it('accepts a matching plugin', () => {
    const { plugin, problems } = checkPluginPackage(good, host, '1.4.0');
    expect(problems).toEqual([]);
    expect(plugin).toMatchObject({ id: 'zeit', server: true, client: true, api: '^1.1.0' });
  });

  it('refuses a plugin built for another plugin API', () => {
    const { plugin, problems } = checkPluginPackage(good, { ...host, api: '2.0.0' });
    expect(plugin).toBeNull();
    expect(problems.join('\n')).toContain('needs @kladde/plugin-api ^1.1.0, this Kladde 2.28.0 provides 2.0.0');
  });

  it('names every problem of a broken package', () => {
    const { problems } = checkPluginPackage(
      { name: 'zeit', version: 'x', kladde: { id: 'Zeit!', app: '>=3' }, dependencies: { react: '^18', '@kladde/plugin-api': '^1' }, peerDependencies: { react: '^19' }, exports: { './client': './c.js' } },
      host,
      '1.0.0'
    );
    const all = problems.join('\n');
    for (const part of ['package name', 'SemVer', 'kladde.id', 'peerDependencies" must name', 'belongs in "peerDependencies", not', 'needs React ^19', '"react" belongs', 'needs Kladde >=3']) expect(all).toContain(part);
  });

  it('checks the pinned version and duplicate ids', () => {
    expect(checkPluginPackage(good, host, '1.3.0').problems[0]).toContain('pinned to 1.3.0, but 1.4.0 is installed');
    const a = checkPluginPackage(good, host).plugin!;
    expect(checkPluginSet([a, { ...a, name: 'kladde-plugin-other' }])[0]).toContain('"zeit" is used by');
  });

  it('prefixes tables with the id', () => {
    expect(pluginTablePrefix('time-tracking')).toBe('p_time_tracking_');
  });

  it('keeps PLUGIN_API_VERSION in step with package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PLUGIN_API_VERSION).toBe(pkg.version);
  });
});
