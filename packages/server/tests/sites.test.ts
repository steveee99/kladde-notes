import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { isValidSiteSlug, normalizeSiteSlug, type PublicSite } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';
import { SiteStore } from '../src/sites/SiteStore';

// Folder websites: an own folder published read-only under /site/<slug>

const note = (id: string, content: string, notePath: string) => ({ id, baseVersion: 0, path: notePath, content, deleted: false, createdAt: Date.now(), updatedAt: Date.now() });

describe('site slugs', () => {
  it('accepts lower case words joined by hyphens', () => {
    expect(isValidSiteSlug('team-docs')).toBe(true);
    expect(isValidSiteSlug('a1b')).toBe(true);
    for (const bad of ['ab', 'Team', 'team--docs', '-team', 'team-', 'team docs', 'x'.repeat(49), 42]) expect(isValidSiteSlug(bad)).toBe(false);
  });

  it('turns typed text into a slug', () => {
    expect(normalizeSiteSlug('  Größe & Übersicht ')).toBe('groesse-uebersicht');
    expect(normalizeSiteSlug('Café Résumé_2026')).toBe('cafe-resume-2026');
    expect(normalizeSiteSlug('---')).toBe('');
  });
});

describe('folder websites', () => {
  const db = openDatabase(':memory:');
  const cipher = new DataCipher(crypto.randomBytes(32));
  const users = new UserStore(db);
  const notes = new NoteStore(db, cipher);
  const sites = new SiteStore(db, cipher, notes);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-sites-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = new FileStore(db, cipher, dir);
  const anna = users.createUser('anna');
  users.createUser('ben');
  const sessions = new Map<string, string>();
  const cookie = (name: string) => {
    if (!sessions.has(name)) sessions.set(name, `kladde_session=${users.createSession(users.findByUsername(name)!.id)}`);
    return sessions.get(name)!;
  };
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter(users, notes, files, new LiveUpdates(), { sites }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const call = (who: string | null, url: string, method = 'GET', body?: unknown) =>
    fetch(`${base}/api${url}`, {
      method,
      headers: { ...(who ? { Cookie: cookie(who) } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const site = async (slug: string) => {
    const res = await call(null, `/sites/${slug}`);
    return res.status === 200 ? ((await res.json()) as PublicSite) : res.status;
  };

  it('publishes a folder with its subfolders under a random address', async () => {
    notes.push(anna.id, [
      note('site-0001', '# Start\nSiehe [[Anleitung]][^1]\n\n[^1]: Fußnote', 'Wissen/Docs/Start.md'),
      note('site-0002', '# Anleitung\nText', 'Wissen/Docs/Guides/Anleitung.md'),
      note('site-0003', '---\ntype: database\n---\n', 'Wissen/Docs/_database-0b1e7a0c-6c2e-4d4b-9c35-1d1f1d1f1d1f.md'),
      note('site-0004', '# Privat', 'Wissen/Privat.md'),
    ]);
    expect(await (await call('anna', `/folders/site?folder=${encodeURIComponent('Wissen/Docs')}`)).json()).toEqual({ site: null });
    expect((await call('anna', '/folders/site', 'PUT', { enabled: true })).status).toBe(400);
    const on = (await (await call('anna', '/folders/site', 'PUT', { folder: 'Wissen/Docs', enabled: true })).json()).site;
    expect(on.slug).toMatch(/^[a-z0-9]{20}$/);
    // Asking again keeps the address
    expect((await (await call('anna', '/folders/site', 'PUT', { folder: 'Wissen/Docs', enabled: true })).json()).site.slug).toBe(on.slug);

    const pub = await site(on.slug);
    if (typeof pub === 'number') throw new Error(`status ${pub}`);
    expect(pub).toMatchObject({ title: 'Docs', owner: 'anna' });
    // Relative paths, no hidden system notes, nothing from outside the folder, no note ids
    expect(pub.notes.map((n) => n.path)).toEqual(['Guides/Anleitung.md', 'Start.md']);
    expect(pub.notes.find((n) => n.path === 'Start.md')!.content).toContain('[^1]: Fußnote');
    expect(JSON.stringify(pub)).not.toContain('site-0001');
    expect(JSON.stringify(pub)).not.toContain('Wissen');
  });

  it('takes an own address, refuses invalid or taken ones and frees the old one', async () => {
    const random = (await (await call('anna', `/folders/site?folder=${encodeURIComponent('Wissen/Docs')}`)).json()).site.slug;
    expect((await call('anna', '/folders/site', 'PUT', { folder: 'Wissen/Docs', slug: 'Team Docs' })).status).toBe(400);
    const own = await call('anna', '/folders/site', 'PUT', { folder: 'Wissen/Docs', slug: 'team-docs' });
    expect((await own.json()).site.slug).toBe('team-docs');
    expect(await site(random)).toBe(404);
    expect(await site('team-docs')).toMatchObject({ title: 'Docs' });

    notes.push(users.findByUsername('ben')!.id, [note('site-ben-01', '# Ben', 'Ben/Seite.md')]);
    const taken = await call('ben', '/folders/site', 'PUT', { folder: 'Ben', slug: 'team-docs' });
    expect(taken.status).toBe(409);
    // Setting an address publishes the folder, too
    expect((await (await call('ben', '/folders/site', 'PUT', { folder: 'Ben', slug: 'ben-seite' })).json()).site.slug).toBe('ben-seite');
    expect(await site('ben-seite')).toMatchObject({ owner: 'ben' });
  });

  it('shows changes, follows folder renames and goes down with the folder', async () => {
    notes.push(anna.id, [note('site-0005', '# Neu', 'Wissen/Docs/Neu.md')]);
    expect((await site('team-docs') as PublicSite).notes.map((n) => n.path)).toContain('Neu.md');

    // Ben cannot move Anna's site
    await call('ben', '/folders/renamed', 'POST', { from: 'Wissen', to: 'Ben' });
    expect(sites.ofFolder(anna.id, 'Wissen/Docs')).not.toBeNull();

    await call('anna', '/folders/renamed', 'POST', { from: 'Wissen', to: 'Archiv/Wissen' });
    expect(sites.ofFolder(anna.id, 'Archiv/Wissen/Docs')?.slug).toBe('team-docs');
    expect(sites.ofFolder(anna.id, 'Wissen/Docs')).toBeNull();

    await call('anna', '/folders/deleted', 'POST', { folder: 'Archiv' });
    expect(await site('team-docs')).toBe(404);
  });

  it('takes a site down on request', async () => {
    expect((await call(null, '/folders/site', 'PUT', { folder: 'Ben', enabled: false })).status).toBe(401);
    expect((await (await call('ben', '/folders/site', 'PUT', { folder: 'Ben', enabled: false })).json()).site).toBeNull();
    expect(await site('ben-seite')).toBe(404);
    expect(await site('Not-Valid')).toBe(404);
  });

  it('keeps folder and address out of the database in plain text', () => {
    const { slug } = sites.enable(anna.id, 'Wissen/Geheim');
    const rows = db.prepare('SELECT * FROM public_sites').all() as { slug_mac: string; payload: Uint8Array }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Buffer.from(r.payload).toString('latin1')).not.toContain('Geheim');
      expect(r.slug_mac).not.toBe(slug);
    }
  });
});
