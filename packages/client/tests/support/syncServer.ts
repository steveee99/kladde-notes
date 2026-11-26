import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
// The real server, in this process: the tests check the client against the actual sync contract, not a mock of it
import { createKladdeApp } from '../../../server/src/app';
import { openDatabase } from '../../../server/src/db';

type Vault = (typeof import('../../src/data/vault'))['vault'];

export interface Device {
  vault: Vault;
  /** The device's IndexedDB: opening a new device on it is the same device after a restart */
  idb: IDBFactory;
}

/**
 * A Kladde server with one account and devices that sync with it. Each device is a fresh copy of the client
 * modules with its own IndexedDB; requests to `/api` go to the server with the account's session.
 */
export async function startSyncServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-client-sync-'));
  const ctx = createKladdeApp({ db: openDatabase(':memory:'), dataDir, env: {}, standalone: false, isProduction: false, publicUrl: null, trustProxy: false });
  const user = ctx.users.createUser('anna');
  let cookie = `kladde_session=${ctx.users.createSession(user.id)}`;
  const server: Server = ctx.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let offline = false;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) => {
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));
    const url = new URL(String(input), base);
    return realFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } });
  });

  const devices: Device[] = [];

  /** A device (a new one, or `idb` of an earlier one after a restart) signed in and synced */
  const device = async (idb = new IDBFactory()): Promise<Device> => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', idb);
    const { vault } = await import('../../src/data/vault');
    await vault.open(user.id);
    const d = { vault, idb };
    devices.push(d);
    return d;
  };

  return {
    ctx,
    user,
    device,
    /** Every following request fails like one without a network */
    setOffline(on: boolean) {
      offline = on;
    },
    /** Ends the session on the server: the next request answers 401 */
    signOut() {
      cookie = 'kladde_session=abgelaufen';
    },
    /** The note as the server has it */
    serverNote(id: string) {
      return ctx.notes.pull(user.id, 0).notes.find((n) => n.id === id);
    },
    async stop() {
      for (const d of devices) d.vault.close();
      vi.unstubAllGlobals();
      await new Promise((r) => server.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
