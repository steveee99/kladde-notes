import crypto from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cleanPath, isValidSiteSlug, MAX_SITE_NOTES, splitPath, type FolderSite, type PublicSite } from '@kladde/shared';
import type { DataCipher } from '../crypto.js';
import type { NoteStore } from '../NoteStore.js';

/** A slug that cannot be used: 400 (not valid), 409 (taken) */
export class SiteError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

interface SiteRow {
  id: string;
  owner_id: string;
  slug_mac: string;
  payload: Uint8Array;
  created_at: number;
}

interface SitePayload {
  folder: string;
  slug: string;
}

interface Site extends SitePayload {
  id: string;
  ownerId: string;
  createdAt: number;
}

const RANDOM_SLUG_LENGTH = 20;
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Built sites kept in memory while nothing changed (keyed by the global seq) */
const CACHE_SIZE = 32;

/** 20 of 36 characters, about 103 bits: as hard to guess as a public link */
function randomSlug(): string {
  let slug = '';
  for (let i = 0; i < RANDOM_SLUG_LENGTH; i++) slug += SLUG_ALPHABET[crypto.randomInt(SLUG_ALPHABET.length)];
  return slug;
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * Folder websites: an own folder published read-only under `/p/<slug>`. Folder and slug are encrypted; the slug is
 * found by its keyed hash, so the database alone does not tell which addresses exist.
 */
export class SiteStore {
  private cache = new Map<string, { seq: number; site: PublicSite }>();

  constructor(
    private db: DatabaseSync,
    private cipher: DataCipher,
    private notes: NoteStore
  ) {}

  private mac(slug: string): string {
    return this.cipher.mac(slug, 'site-slug');
  }

  private toSite(row: SiteRow): Site {
    const p = this.cipher.decryptJson<SitePayload>(row.payload, `public_site:${row.id}`);
    return { id: row.id, ownerId: row.owner_id, createdAt: row.created_at, folder: p.folder, slug: p.slug };
  }

  private sitesOf(ownerId: string): Site[] {
    return (this.db.prepare('SELECT * FROM public_sites WHERE owner_id = ?').all(ownerId) as unknown as SiteRow[]).map((r) => this.toSite(r));
  }

  private write(site: Site): void {
    this.db
      .prepare('UPDATE public_sites SET slug_mac = ?, payload = ? WHERE id = ?')
      .run(this.mac(site.slug), this.cipher.encryptJson({ folder: site.folder, slug: site.slug } satisfies SitePayload, `public_site:${site.id}`), site.id);
    this.cache.delete(site.id);
  }

  private taken(slug: string, exceptId?: string): boolean {
    const row = this.db.prepare('SELECT id FROM public_sites WHERE slug_mac = ?').get(this.mac(slug)) as { id: string } | undefined;
    return !!row && row.id !== exceptId;
  }

  /** The website of an own folder, null when it has none */
  ofFolder(ownerId: string, folder: string): FolderSite | null {
    const clean = cleanPath(folder);
    const site = this.sitesOf(ownerId).find((s) => s.folder === clean);
    return site ? { slug: site.slug, createdAt: site.createdAt } : null;
  }

  /** All websites of the owner (account export) */
  list(ownerId: string): { folder: string; slug: string }[] {
    return this.sitesOf(ownerId).map((s) => ({ folder: s.folder, slug: s.slug }));
  }

  /** Publishes the folder under a random slug (keeps the existing one) */
  enable(ownerId: string, folder: string): FolderSite {
    const clean = cleanPath(folder);
    if (!clean) throw new SiteError(400, 'Ungültiger Ordner.');
    const existing = this.ofFolder(ownerId, clean);
    if (existing) return existing;
    let slug = randomSlug();
    while (this.taken(slug)) slug = randomSlug();
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare('INSERT INTO public_sites (id, owner_id, slug_mac, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ownerId, this.mac(slug), this.cipher.encryptJson({ folder: clean, slug } satisfies SitePayload, `public_site:${id}`), createdAt);
    return { slug, createdAt };
  }

  /** Gives the folder's website its own address (publishing it first when needed) */
  setSlug(ownerId: string, folder: string, slug: string): FolderSite {
    if (!isValidSiteSlug(slug)) throw new SiteError(400, 'Die Adresse darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten (3–48 Zeichen).');
    this.enable(ownerId, folder);
    const clean = cleanPath(folder);
    const site = this.sitesOf(ownerId).find((s) => s.folder === clean)!;
    if (site.slug === slug) return { slug, createdAt: site.createdAt };
    if (this.taken(slug, site.id)) throw new SiteError(409, 'Diese Adresse ist schon vergeben.');
    this.write({ ...site, slug });
    return { slug, createdAt: site.createdAt };
  }

  /** Takes the folder's website down (the address is free again) */
  disable(ownerId: string, folder: string): void {
    const clean = cleanPath(folder);
    for (const s of this.sitesOf(ownerId)) {
      if (s.folder !== clean) continue;
      this.db.prepare('DELETE FROM public_sites WHERE id = ?').run(s.id);
      this.cache.delete(s.id);
    }
  }

  /** A folder was renamed or moved: its website (and those of its subfolders) follow, under the same address */
  renameFolder(ownerId: string, from: string, to: string): void {
    const source = cleanPath(from);
    const target = cleanPath(to);
    for (const s of this.sitesOf(ownerId)) if (inside(s.folder, source)) this.write({ ...s, folder: target + s.folder.slice(source.length) });
  }

  /** The folder was deleted: its website and those of its subfolders go down */
  dropFolder(ownerId: string, folder: string): void {
    const clean = cleanPath(folder);
    for (const s of this.sitesOf(ownerId)) if (inside(s.folder, clean)) this.disable(ownerId, s.folder);
  }

  /** What guests see under `/p/<slug>`; null when no folder is published under it */
  site(slug: string): PublicSite | null {
    if (!isValidSiteSlug(slug)) return null;
    const row = this.db.prepare('SELECT * FROM public_sites WHERE slug_mac = ?').get(this.mac(slug)) as SiteRow | undefined;
    if (!row) return null;
    const seq = this.notes.currentSeq();
    const cached = this.cache.get(row.id);
    if (cached && cached.seq === seq) return cached.site;
    const site = this.toSite(row);
    const owner = this.db.prepare('SELECT username, avatar_id FROM users WHERE id = ?').get(site.ownerId) as { username: string; avatar_id: string | null } | undefined;
    if (!owner) return null;
    const { notes, truncated } = this.notes.publicFolder(site.ownerId, site.folder, MAX_SITE_NOTES);
    const built: PublicSite = {
      title: splitPath(site.folder).name,
      owner: owner.username,
      ...(owner.avatar_id ? { ownerAvatar: `/api/avatars/${owner.avatar_id}` } : {}),
      updatedAt: notes.reduce((max, n) => Math.max(max, n.updatedAt), site.createdAt),
      notes,
      ...(truncated ? { truncated: true } : {}),
    };
    this.cache.delete(row.id);
    this.cache.set(row.id, { seq, site: built });
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return built;
  }
}
