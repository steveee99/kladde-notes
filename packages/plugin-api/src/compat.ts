// Version and package checks shared by the host (server start) and `scripts/plugins.mjs` (build time).
// No imports and only erasable TypeScript: the build script loads this file directly with Node's type stripping.

/** Version of the plugin interface; bumped by hand, independent of the app version (major = breaking) */
export const PLUGIN_API_VERSION = '1.2.0';

/** A plugin's id: lower case, digits and dashes, 3–32 characters; it names routes, tables and settings */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/** Package names a plugin may have: `kladde-plugin-<name>`, optionally scoped (`@team/kladde-plugin-<name>`) */
export const PLUGIN_PACKAGE_PATTERN = /^(@[a-z0-9][a-z0-9._~-]*\/)?kladde-plugin-[a-z0-9][a-z0-9._~-]*$/;

/** Prefix of every table, index and trigger a plugin creates: `p_<id>_` (dashes become underscores) */
export function pluginTablePrefix(id: string): string {
  return `p_${id.replace(/-/g, '_')}_`;
}

type Version = [number, number, number, string[]];

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `1.2.3`, `1.2.3-rc.1` (build metadata ignored); null when it is no SemVer version */
export function parseVersion(text: string): Version | null {
  const m = VERSION_RE.exec(text.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []];
}

function comparePre(a: string[], b: string[]): number {
  // A release is newer than its pre-releases
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]) ? Number(a[i]) : NaN;
    const nb = /^\d+$/.test(b[i]) ? Number(b[i]) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
  return comparePre(a[3], b[3]);
}

/** -1, 0 or 1; throws on versions that are no SemVer */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) throw new Error(`Not a version: ${!va ? a : b}`);
  return compare(va, vb);
}

type Op = '<' | '<=' | '>' | '>=' | '=';
type Comparator = [Op, Version];

/** `1`, `1.2`, `1.x`, `1.2.*`, `1.2.3`: the given parts, the rest `null` (wildcards) */
function partial(text: string): { parts: (number | null)[]; pre: string[] } | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)));
  // Once a part is a wildcard, the later ones are too
  for (let i = 1; i < 3; i++) if (parts[i - 1] === null) parts[i] = null;
  return { parts, pre: m[4] ? m[4].split('.') : [] };
}

const v = (a: number, b: number, c: number, pre: string[] = []): Version => [a, b, c, pre];

function comparators(token: string): Comparator[] | null {
  if (token === '' || token === '*' || /^[xX]$/.test(token)) return [];
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token)!;
  const op = m[1] ?? '';
  const p = partial(m[2]);
  if (!p) return null;
  const [major, minor, patch] = p.parts;
  if (major === null) return op === '<' || op === '>' ? [['<', v(0, 0, 0, ['0'])]] : [];
  const lower = v(major, minor ?? 0, patch ?? 0, p.pre);
  // The exclusive upper bound of a partial version (`1.2` → `<1.3.0-0`)
  const nextOf = (): Version => (minor === null ? v(major + 1, 0, 0, ['0']) : v(major, minor + 1, 0, ['0']));
  switch (op) {
    case '^': {
      const upper = major > 0 || minor === null ? v(major + 1, 0, 0, ['0']) : (minor ?? 0) > 0 || patch === null ? v(0, (minor ?? 0) + 1, 0, ['0']) : v(0, 0, (patch ?? 0) + 1, ['0']);
      return [['>=', lower], ['<', upper]];
    }
    case '~':
      return [['>=', lower], ['<', minor === null ? v(major + 1, 0, 0, ['0']) : v(major, minor + 1, 0, ['0'])]];
    case '>':
      return patch === null ? [['>=', nextOf()]] : [['>', lower]];
    case '>=':
      return [['>=', lower]];
    case '<':
      return [['<', lower]];
    case '<=':
      return patch === null ? [['<', nextOf()]] : [['<=', lower]];
    default:
      return patch === null ? [['>=', lower], ['<', nextOf()]] : [['=', lower]];
  }
}

function test(version: Version, [op, bound]: Comparator): boolean {
  const c = compare(version, bound);
  return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
}

/**
 * Whether `version` lies in the npm-style `range`: `^1.2.0`, `~1.2`, `>=1.0.0 <3`, `1.x`, `*`, alternatives with
 * `||`. Like npm, a pre-release only matches a range that names a pre-release of the same major.minor.patch.
 */
export function satisfies(version: string, range: string): boolean {
  const ver = parseVersion(version);
  if (!ver) return false;
  return range.split('||').some((alt) => {
    // `>= 1.2` is written with a space now and then: glue operators to their version
    const tokens = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const set: Comparator[] = [];
    for (const token of tokens.length ? tokens : ['*']) {
      const c = comparators(token);
      if (!c) return false;
      set.push(...c);
    }
    if (!set.every((c) => test(ver, c))) return false;
    if (!ver[3].length) return true;
    return set.some(([, b]) => b[3].length > 0 && b[3][0] !== '0' && b[0] === ver[0] && b[1] === ver[1] && b[2] === ver[2]);
  });
}

/** What the build knows about the host it builds plugins into */
export interface HostVersions {
  /** Version of `@kladde/plugin-api` */
  api: string;
  /** Version of Kladde */
  app: string;
  /** Version of React the client bundles */
  react: string;
}

/** The parts of a plugin's package.json the checks read */
export interface PluginPackageJson {
  name?: string;
  version?: string;
  kladde?: { id?: string; app?: string };
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: unknown;
}

/** A plugin package that passed the checks */
export interface CheckedPlugin {
  name: string;
  version: string;
  id: string;
  /** Range of `@kladde/plugin-api` it was built against */
  api: string;
  server: boolean;
  client: boolean;
}

function hasExport(exports: unknown, key: './server' | './client'): boolean {
  return !!exports && typeof exports === 'object' && !Array.isArray(exports) && key in (exports as Record<string, unknown>);
}

/**
 * Checks one plugin package against the host: name, id, exports, the `@kladde/plugin-api` and React ranges of its
 * peerDependencies, the optional Kladde range (`kladde.app`) and the pinned version. Returns the plugin or problems.
 */
export function checkPluginPackage(pkg: PluginPackageJson, host: HostVersions, pinned?: string): { plugin: CheckedPlugin | null; problems: string[] } {
  const problems: string[] = [];
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  const label = name || '(package without a name)';
  if (!PLUGIN_PACKAGE_PATTERN.test(name)) problems.push(`${label}: the package name must be "kladde-plugin-<name>" (optionally scoped)`);
  const version = typeof pkg.version === 'string' ? pkg.version : '';
  if (!parseVersion(version)) problems.push(`${label}: "version" is no SemVer version`);
  if (pinned && parseVersion(pinned) && version && pinned !== version) problems.push(`${label}: pinned to ${pinned}, but ${version} is installed`);
  const id = pkg.kladde?.id ?? '';
  if (!PLUGIN_ID_PATTERN.test(id)) problems.push(`${label}: "kladde.id" must be 3–32 characters of a–z, 0–9 and "-", starting with a letter`);
  const server = hasExport(pkg.exports, './server');
  const client = hasExport(pkg.exports, './client');
  if (!server && !client) problems.push(`${label}: "exports" needs "./server" and/or "./client"`);
  const api = pkg.peerDependencies?.['@kladde/plugin-api'] ?? '';
  if (!api) problems.push(`${label}: "peerDependencies" must name "@kladde/plugin-api" with the range the plugin supports`);
  else if (!satisfies(host.api, api)) problems.push(`${label} ${version} needs @kladde/plugin-api ${api}, this Kladde ${host.app} provides ${host.api}`);
  if (pkg.dependencies?.['@kladde/plugin-api']) problems.push(`${label}: "@kladde/plugin-api" belongs in "peerDependencies", not "dependencies" (the host provides it)`);
  const react = pkg.peerDependencies?.react;
  if (client && react && !satisfies(host.react, react)) problems.push(`${label} ${version} needs React ${react}, this Kladde bundles ${host.react}`);
  if (pkg.dependencies?.react || pkg.dependencies?.['react-dom']) problems.push(`${label}: "react" belongs in "peerDependencies" (one React for the app and all plugins)`);
  const app = pkg.kladde?.app;
  if (app && !satisfies(host.app, app)) problems.push(`${label} ${version} needs Kladde ${app}, this build is ${host.app}`);
  return { plugin: problems.length ? null : { name, version, id, api, server, client }, problems };
}

/** Problems of the whole set: two plugins with the same id or package */
export function checkPluginSet(plugins: CheckedPlugin[]): string[] {
  const problems: string[] = [];
  const ids = new Map<string, string>();
  for (const p of plugins) {
    const other = ids.get(p.id);
    if (other) problems.push(`The plugin id "${p.id}" is used by ${other} and ${p.name}`);
    ids.set(p.id, p.name);
  }
  return problems;
}
