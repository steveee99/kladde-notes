import { uuidV4 } from '@kladde/shared';

/** A random UUID. `crypto.randomUUID` only exists in secure contexts, so it is missing on plain HTTP; `getRandomValues` works everywhere */
export const newUuid = (): string => uuidV4(crypto.getRandomValues(new Uint8Array(16)));
