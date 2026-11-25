import crypto from 'crypto';
import {
  isRemoteImageFile,
  isRemotePath,
  parseRemoteUrl,
  remoteProjectAllowed,
  remoteWebUrl,
  type RemoteBase,
  type RemoteCommit,
  type RemoteNoteResponse,
  type RemoteProblem,
  type RemoteTestResult,
} from '@kladde/shared';
import { sha256 } from '../crypto.js';
import type { RemoteInstance, RemoteInstances } from './RemoteInstances.js';

/**
 * Reads files from the configured GitLab and GitHub instances. What keeps it from becoming an open proxy:
 * addresses are only matched against configured hosts (exact origin, `parseRemoteUrl`), requests go to fixed API
 * endpoints below the instance's own API root, every part of the path is checked and encoded, redirects are followed
 * by hand and never off that root (so the token never reaches another origin), and answers are bounded in time and size.
 * Private addresses are fine here: only an admin can configure a host.
 */

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** A file read this recently is not asked for again (several embeds of one note, images of one page) */
const FRESH_MS = 5_000;
const IMAGE_FRESH_MS = 5 * 60_000;
const CACHE_ENTRIES = 300;
const CACHE_BYTES = 64 * 1024 * 1024;

export class RemoteError extends Error {
  constructor(readonly problem: RemoteProblem) {
    super(problem);
  }
}

interface Answer {
  status: number;
  headers: Headers;
  body: Buffer;
}

interface CacheEntry {
  body: Buffer;
  etag: string | null;
  /** From GitLab's answer; without a date */
  commitId: string | null;
  commit: RemoteCommit | null;
  at: number;
}

export interface RemoteImage {
  mime: string;
  data: Buffer;
  etag: string;
}

const enc = encodeURIComponent;
const encPath = (path: string) => path.split('/').map(enc).join('/');

/** Image type by its first bytes (the instances answer with octet-stream or text); null for anything else */
export function sniffImage(data: Buffer, path: string): string | null {
  const ascii = (from: number, to: number) => data.subarray(from, to).toString('latin1');
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  if (/\.svg$/i.test(path) && !data.includes(0)) {
    const head = data.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
    if (/^<(?:svg[\s>]|\?xml|!--|!DOCTYPE svg)/i.test(head) && /<svg[\s>]/i.test(head)) return 'image/svg+xml';
  }
  return null;
}

export class RemoteFetcher {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly running = new Map<string, Promise<CacheEntry>>();

  constructor(
    private readonly instances: RemoteInstances,
    private readonly opts: { timeoutMs?: number; maxText?: number; maxImage?: number } = {}
  ) {}

  /** The text an address points to. Nothing upstream says (bodies, messages) gets into the answer besides the file itself */
  async text(source: string, ref: string, opts: { freshMs?: number } = {}): Promise<RemoteNoteResponse> {
    try {
      const { instance, base, entry } = await this.locate(source, ref, opts.freshMs ?? FRESH_MS);
      if (entry.body.includes(0)) return { state: 'unsupported' };
      entry.commit ??= await this.lastCommit(instance, base).catch(() => null);
      const commit = entry.commit ?? (entry.commitId ? { id: entry.commitId, at: null } : null);
      return { state: 'ok', text: entry.body.toString('utf8'), base, url: remoteWebUrl(base), commit, fetchedAt: entry.at };
    } catch (err) {
      if (err instanceof RemoteError) return { state: err.problem };
      throw err;
    }
  }

  /** An image of the same repository and version as the note's file */
  async image(source: string, ref: string, path: string): Promise<RemoteImage> {
    if (!isRemotePath(path) || !isRemoteImageFile(path)) throw new RemoteError('unsupported');
    const { instance, base } = await this.locate(source, ref, IMAGE_FRESH_MS);
    const entry = await this.file(instance, { ...base, path }, this.opts.maxImage ?? MAX_IMAGE_BYTES, IMAGE_FRESH_MS);
    const mime = sniffImage(entry.body, path);
    if (!mime) throw new RemoteError('unsupported');
    return { mime, data: entry.body, etag: `"${crypto.createHash('sha256').update(entry.body).digest('hex').slice(0, 32)}"` };
  }

  /** "Test access" in the admin area: does the instance answer and accept the token? */
  async test(instance: RemoteInstance): Promise<RemoteTestResult> {
    try {
      const path = instance.kind === 'github' ? '/rate_limit' : instance.token ? '/user' : '/projects?per_page=1&simple=true';
      const res = await this.get(instance, path, { max: 1024 * 1024 });
      if (res.status >= 200 && res.status < 300) return { state: isJson(res) ? 'ok' : 'unreachable' };
      // GitLab: 403 is a valid token without the right to read its user (e.g. only read_repository)
      if (res.status === 403 && instance.kind === 'gitlab') return { state: 'limited' };
      const problem = problemOf(res);
      return { state: problem === 'not_found' ? 'unreachable' : problem };
    } catch (err) {
      if (err instanceof RemoteError) return { state: err.problem };
      throw err;
    }
  }

  /** Finds the file behind an address: host and paths are checked before anything is requested or taken from the cache */
  private async locate(source: string, ref: string, freshMs: number): Promise<{ instance: RemoteInstance; base: RemoteBase; entry: CacheEntry }> {
    const parsed = parseRemoteUrl(source, this.instances.active(), ref);
    if (!parsed.ok) throw new RemoteError(parsed.problem);
    const { target } = parsed;
    const instance = target.host as RemoteInstance;
    if (!remoteProjectAllowed(instance.kind, target.project, instance.allowedPaths)) throw new RemoteError('not_allowed');
    for (const c of target.candidates) {
      const base: RemoteBase = { kind: instance.kind, host: instance.url, project: target.project, ref: c.ref, path: c.path };
      try {
        return { instance, base, entry: await this.file(instance, base, this.opts.maxText ?? MAX_TEXT_BYTES, freshMs) };
      } catch (err) {
        // A branch name with slashes, or another spelling of the README: try the next reading
        if (!(err instanceof RemoteError) || err.problem !== 'not_found') throw err;
      }
    }
    throw new RemoteError('not_found');
  }

  private file(instance: RemoteInstance, base: RemoteBase, max: number, freshMs: number): Promise<CacheEntry> {
    // The token is part of the key: after it changed nothing read with the old one is served
    const key = [sha256(`${instance.apiBase}\n${instance.token}`), instance.kind, base.project, base.ref, base.path, max].join('\n');
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < freshMs) return Promise.resolve(cached);
    let job = this.running.get(key);
    if (!job) {
      job = this.load(instance, base, max, key, cached).finally(() => this.running.delete(key));
      this.running.set(key, job);
    }
    return job;
  }

  private async load(instance: RemoteInstance, base: RemoteBase, max: number, key: string, cached: CacheEntry | undefined): Promise<CacheEntry> {
    const path =
      instance.kind === 'gitlab'
        ? `/projects/${enc(base.project)}/repository/files/${enc(base.path)}/raw?ref=${enc(base.ref)}`
        : `/repos/${encPath(base.project)}/contents/${encPath(base.path)}${base.ref === 'HEAD' ? '' : `?ref=${enc(base.ref)}`}`;
    const res = await this.get(instance, path, { max, accept: instance.kind === 'github' ? 'application/vnd.github.raw+json' : '*/*', etag: cached?.etag });
    if (res.status === 304 && cached) {
      cached.at = Date.now();
      return cached;
    }
    if (res.status !== 200) {
      this.forget(key);
      throw new RemoteError(problemOf(res));
    }
    // A folder or submodule: GitHub lists it as JSON instead of sending a file
    if (instance.kind === 'github' && isJson(res) && !/raw/.test(res.headers.get('content-type') ?? '')) throw new RemoteError('not_found');
    const commitId = /^[0-9a-f]{40,64}$/.exec(res.headers.get('x-gitlab-last-commit-id') ?? '')?.[0] ?? null;
    const entry: CacheEntry = { body: res.body, etag: res.headers.get('etag'), commitId, commit: cached?.body.equals(res.body) ? cached.commit : null, at: Date.now() };
    this.remember(key, entry);
    return entry;
  }

  /** Best effort: a token limited to file contents may not list commits */
  private async lastCommit(instance: RemoteInstance, base: RemoteBase): Promise<RemoteCommit | null> {
    const path =
      instance.kind === 'gitlab'
        ? `/projects/${enc(base.project)}/repository/commits?per_page=1&path=${enc(base.path)}&ref_name=${enc(base.ref)}`
        : `/repos/${encPath(base.project)}/commits?per_page=1&path=${enc(base.path)}${base.ref === 'HEAD' ? '' : `&sha=${enc(base.ref)}`}`;
    const res = await this.get(instance, path, { max: 512 * 1024, timeoutMs: 5_000 });
    if (res.status !== 200) return null;
    const list = JSON.parse(res.body.toString('utf8')) as unknown;
    const c = (Array.isArray(list) ? list[0] : null) as { id?: unknown; sha?: unknown; committed_date?: unknown; commit?: { committer?: { date?: unknown } } } | null;
    const id = c?.id ?? c?.sha;
    const at = Date.parse(String(c?.committed_date ?? c?.commit?.committer?.date ?? ''));
    return typeof id === 'string' && /^[0-9a-f]{7,64}$/.test(id) ? { id, at: Number.isFinite(at) ? at : null } : null;
  }

  /** One GET below the instance's API root */
  private async get(instance: RemoteInstance, path: string, opts: { max: number; accept?: string; etag?: string | null; timeoutMs?: number }): Promise<Answer> {
    const root = new URL(`${instance.apiBase}/`);
    const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json', 'User-Agent': 'Kladde' };
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    if (instance.token) {
      if (instance.kind === 'gitlab') headers['PRIVATE-TOKEN'] = instance.token;
      else headers.Authorization = `Bearer ${instance.token}`;
    }
    if (instance.kind === 'github') headers['X-GitHub-Api-Version'] = '2022-11-28';
    const signal = AbortSignal.timeout(opts.timeoutMs ?? this.opts.timeoutMs ?? TIMEOUT_MS);
    let url = new URL(instance.apiBase + path);
    for (let hop = 0; ; hop++) {
      if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.username || url.password) throw new RemoteError('redirect');
      let res: Response;
      try {
        res = await fetch(url, { headers, redirect: 'manual', signal });
      } catch {
        throw new RemoteError('unreachable');
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) return { status: res.status, headers: res.headers, body: await readBody(res, opts.max) };
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      // A renamed project redirects inside the API. With allowed paths it could lead outside of them
      if (!location || hop >= MAX_REDIRECTS || instance.allowedPaths.length) throw new RemoteError('redirect');
      try {
        url = new URL(location, url);
      } catch {
        throw new RemoteError('redirect');
      }
    }
  }

  private forget(key: string): void {
    const old = this.cache.get(key);
    if (!old) return;
    this.cacheBytes -= old.body.length;
    this.cache.delete(key);
  }

  private remember(key: string, entry: CacheEntry): void {
    this.forget(key);
    this.cache.set(key, entry);
    this.cacheBytes += entry.body.length;
    for (const k of this.cache.keys()) {
      if (this.cache.size <= CACHE_ENTRIES && this.cacheBytes <= CACHE_BYTES) break;
      this.forget(k);
    }
  }
}

const isJson = (res: Answer): boolean => /\bjson\b/.test(res.headers.get('content-type') ?? '');

function problemOf(res: Answer): RemoteProblem {
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) return 'upstream_limit';
  if (res.status === 401 || res.status === 403) return 'no_access';
  if (res.status === 404 || res.status === 400 || res.status === 410 || res.status === 422) return 'not_found';
  if (res.status === 413) return 'too_large';
  return 'unreachable';
}

/** The body up to `max` bytes (after decompression); of error answers nothing is kept */
async function readBody(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  if (res.status !== 200) {
    await res.body.cancel().catch(() => undefined);
    return Buffer.alloc(0);
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.length;
      if (size > max) throw new RemoteError('too_large');
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err instanceof RemoteError ? err : new RemoteError('unreachable');
  }
}
