/**
 * `@kladde/plugin-api`: the only interface between Kladde and its plugins. Plugins import from here (and from
 * `@kladde/plugin-api/server` or `/client`), never from Kladde's packages: Kladde may change everything else in any
 * release, this package changes only with its own SemVer version (`PLUGIN_API_VERSION`).
 */
export {
  PLUGIN_API_VERSION,
  PLUGIN_ID_PATTERN,
  PLUGIN_PACKAGE_PATTERN,
  checkPluginPackage,
  checkPluginSet,
  compareVersions,
  parseVersion,
  pluginTablePrefix,
  satisfies,
  type CheckedPlugin,
  type HostVersions,
  type PluginPackageJson,
} from './compat.js';

/** Languages of the interface */
export type PluginLang = 'de' | 'en';

/** A text in the interface's languages; a plain string is used for all of them */
export type Localized = string | { de: string; en?: string };

/** The text of `value` in `lang` (German when there is no English one) */
export function localize(value: Localized, lang: PluginLang): string {
  return typeof value === 'string' ? value : lang === 'en' ? (value.en ?? value.de) : value.de;
}

/**
 * An error with an HTTP status a plugin route throws on purpose: the host answers `{ error: message }` with that
 * status. Any other error becomes a 500 without details.
 */
export class PluginError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'PluginError';
  }
}
