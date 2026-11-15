import { DatabaseSync } from 'node:sqlite';
import { IMPORT_TOKEN_DAYS } from '@kladde/shared';
import { BearerTokenStore } from '../security/BearerTokenStore.js';

/**
 * Tokens for the import CLI, created by the user in the settings (expire after the chosen days, revocable).
 * They only work on `/api/import`. Only SHA-256 hashes of the secrets are stored.
 */
export class ImportTokenStore extends BearerTokenStore {
  constructor(db: DatabaseSync) {
    // `kli_` is different from MCP's `kld_`, so neither kind of token is mistaken for the other
    super(db, { table: 'import_tokens', prefix: 'kli_', days: IMPORT_TOKEN_DAYS, defaultName: 'Import-Token', label: 'Import-Token' });
  }
}
