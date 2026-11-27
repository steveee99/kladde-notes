import type { ServerPlugin } from '@kladde/plugin-api/server';

/** A plugin built into this image: package data from `npm run plugins` plus the plugin's server part */
export interface InstalledServerPlugin {
  /** npm package */
  name: string;
  /** `kladde.id` of the package; must match the plugin's `id` */
  id: string;
  version: string;
  /** Range of `@kladde/plugin-api` the plugin supports (its peerDependency) */
  api: string;
  /** `kladde.defaultEnabled` of the package: on for users who never switched it */
  defaultEnabled: boolean;
  plugin: ServerPlugin;
}
