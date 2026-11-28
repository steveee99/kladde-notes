import type { ClientPlugin } from '@kladde/plugin-api/client';

/** A plugin built into this app: package data from `npm run plugins` plus the plugin's client part */
export interface InstalledClientPlugin {
  /** npm package */
  name: string;
  /** `kladde.id` of the package; must match the plugin's `id` */
  id: string;
  version: string;
  /** Range of `@kladde/plugin-api` the plugin supports (its peerDependency) */
  api: string;
  /** `kladde.defaultEnabled` of the package */
  defaultEnabled: boolean;
  plugin: ClientPlugin;
}
