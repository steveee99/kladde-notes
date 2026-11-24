/**
 * Remote notes: a note that shows a Markdown file from GitLab or GitHub, always loaded live and read-only.
 *
 *   ---
 *   type: remote
 *   source: "https://gitlab.example.com/team/{{var:project}}/-/blob/main/README.md"
 *   ref: main
 *   ---
 *
 * Only the address is stored; the text comes from the server each time the note opens and is never part of the note.
 * This module is pure: it reads and writes the frontmatter, takes the addresses apart and prepares the remote text.
 * The source comes from notes other people may write, so addresses are matched against the hosts an admin configured
 * (exact origin) and every part of them is checked; whatever is not plainly understood is refused.
 */
import { parseFrontmatter, setFrontmatter } from './markdown.js';
import { safeUrl } from './util.js';
import { hasVariables, resolveVariableUrl, resolveVariables, type VariableScope } from './variables.js';

export type RemoteKind = 'gitlab' | 'github';

export interface RemoteSource {
  /** As written, may contain `{{var:…}}` */
  source: string;
  /** Branch, tag or commit; '' = the one in the address, or the default branch */
  ref: string;
}

const MAX_SOURCE = 2000;

const looksLikeSource = (source: string): boolean => source === '' || /^https?:\/\//i.test(source) || hasVariables(source);

/** The source of a remote note, null for any other note. `source` may be empty (public links carry none) */
export function remoteNoteOf(content: string): RemoteSource | null {
  // Cheap test first: this runs for every row of a list
  if (!content.startsWith('---') || !/^type:[ \t]*["']?remote\b/im.test(content.slice(0, 4000))) return null;
  const { data } = parseFrontmatter(content);
  if (data.type?.toLowerCase() !== 'remote' || data.source === undefined || !looksLikeSource(data.source)) return null;
  return { source: data.source.slice(0, MAX_SOURCE), ref: data.ref ?? '' };
}

const clean = (value: string): string => value.replace(/[\r\n"]+/g, '').trim().slice(0, MAX_SOURCE);
/** `{{var:…}}` at the start would be a YAML mapping for other programs, so such values are quoted */
const yamlValue = (value: string): string => (/[{}#]|: /.test(value) || value === '' ? `"${value}"` : value);

/** Sets the source in a note's frontmatter; the rest of the note stays as it is */
export function setRemoteSource(content: string, { source, ref }: RemoteSource): string {
  const r = clean(ref);
  return setFrontmatter(content, { type: 'remote', source: yamlValue(clean(source)), ref: r ? yamlValue(r) : null });
}

/** A new remote note */
export const remoteNoteMarkdown = (source: RemoteSource): string => setRemoteSource('', source);

/** Takes `type`, `source` and `ref` out again: an ordinary note with whatever text of its own it has */
export const clearRemoteSource = (content: string): string => setFrontmatter(content, { type: null, source: null, ref: null });

/** Text of its own in a remote note (written by hand or by another program); it is kept but not shown */
export const remoteOwnText = (content: string): string => parseFrontmatter(content).body.trim();

/** What a public link may carry of a remote note: that it is one, and nothing else */
export function publicRemoteContent(content: string): string {
  return remoteNoteOf(content) ? '---\ntype: remote\nsource: ""\n---\n' : content;
}

/** The new text of a remote note with the body it had: its body is never written while it stays a remote note */
export function keepRemoteBody(before: string, after: string): string {
  if (!remoteNoteOf(before) || !remoteNoteOf(after)) return after;
  const old = parseFrontmatter(before).body;
  const { body } = parseFrontmatter(after);
  return body === old ? after : after.slice(0, after.length - body.length) + old;
}

// ------------------------------------------------------------------ addresses

/** A configured GitLab or GitHub: its address as people see it, with a path if it is installed below one */
export interface RemoteHost {
  kind: RemoteKind;
  url: string;
}

export interface RemoteFile {
  ref: string;
  path: string;
}

export interface RemoteTarget {
  host: RemoteHost;
  /** `group/sub/project` or `owner/repo` */
  project: string;
  /** `readme`: the README of the repository or of one of its folders */
  type: 'file' | 'readme';
  /**
   * The files the address may mean, best guess first. A branch name may contain slashes, so `blob/a/b/c.md` is `b/c.md`
   * on `a` or `c.md` on `a/b`; with an explicit `ref` there is only one.
   */
  candidates: RemoteFile[];
}

export type RemoteUrlProblem =
  /** Not an address, or one that is refused (credentials, `..`, encoded slashes, …) */
  | 'invalid_source'
  /** Its host is not one the admin configured */
  | 'host_not_configured'
  /** Understood, but not a Markdown file (an issue, a source file, …) */
  | 'unsupported';

export type RemoteUrlResult = { ok: true; target: RemoteTarget } | { ok: false; problem: RemoteUrlProblem };

const MAX_CANDIDATES = 4;
const MARKDOWN_FILE = /\.(?:md|markdown|mdown|mkdn?|mdx|txt)$/i;
const PLAIN_NAMES = /^(?:readme|license|licence|changelog|changes|contributing|authors|notice|copying|todo|install|security)$/i;
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown'];
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

export function isRemoteTextFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return MARKDOWN_FILE.test(name) || PLAIN_NAMES.test(name);
}
export const isRemoteImageFile = (path: string): boolean => IMAGE_FILE.test(path);

/** A branch, tag or commit as Git allows it, minus anything with a meaning in addresses */
export function isRemoteRef(ref: string): boolean {
  if (ref.length > 200 || ref.includes('..') || !/^[\p{L}\p{N}_.][\p{L}\p{N}_./+=@#,-]*$/u.test(ref)) return false;
  return ref.split('/').every((s) => s !== '' && s !== '.' && !s.endsWith('.lock'));
}

/** A file path inside a repository: no empty, `.` or `..` parts, nothing that decodes to a separator later on */
export function isRemotePath(path: string): boolean {
  if (!path || path.length > 1000) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path) || /%(?:2e|2f|5c|00|25)/i.test(path)) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const PROJECT_PART = /^[A-Za-z0-9_.-]{1,255}$/;

function isProject(parts: (string | undefined)[], kind: RemoteKind): boolean {
  if (kind === 'github' ? parts.length !== 2 : parts.length < 2 || parts.length > 21) return false;
  return parts.every((p) => p !== undefined && PROJECT_PART.test(p) && !p.startsWith('-') && !p.includes('..') && p !== '.');
}

/** The address without its trailing slash, as a configured host is kept; null when it cannot be one */
export function normalizeRemoteHost(raw: string): string | null {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text) || /[\s\\]/.test(text)) return null;
  try {
    const u = new URL(text);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || !u.hostname) return null;
    const path = u.pathname.split('/').filter(Boolean);
    if (path.length > 10 || !path.every((p) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$/.test(p))) return null;
    return [u.origin, ...path].join('/');
  } catch {
    return null;
  }
}

/** Decoded path parts of an address, null when one of them is not plain */
function pathParts(pathname: string): string[] | null {
  const out: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part.includes('/') || !isRemotePath(part)) return null;
    out.push(part);
  }
  return out;
}

const fail = (problem: RemoteUrlProblem): RemoteUrlResult => ({ ok: false, problem });

/** `refs/heads/x` as raw addresses write it */
const splitRefPrefix = (rest: string[]): string[] => (rest.length > 3 && rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') ? rest.slice(2) : rest);

/** `<ref>/<path>` in its possible readings; the last part is always the file */
function candidatesOf(parts: string[], ref: string): RemoteFile[] {
  const rest = splitRefPrefix(parts);
  if (ref) {
    const refParts = ref.split('/');
    const named = rest.length > refParts.length && refParts.every((p, i) => rest[i] === p);
    const path = rest.slice(named ? refParts.length : 1).join('/');
    return isRemotePath(path) ? [{ ref, path }] : [];
  }
  const out: RemoteFile[] = [];
  for (let i = 1; i < rest.length && out.length < MAX_CANDIDATES; i++) {
    const r = rest.slice(0, i).join('/');
    const path = rest.slice(i).join('/');
    if (isRemoteRef(r) && isRemotePath(path)) out.push({ ref: r, path });
  }
  return out;
}

/** Characters and spellings no address of a file needs, refused before anything reads them */
// eslint-disable-next-line no-control-regex
const SUSPICIOUS = /[\u0000- \u007f-\u009f\\<>"`]|%(?:00|2e|2f|5c|25)|\/\.{1,2}(?:\/|$)/i;

/** Takes the address of a file or repository apart. `hosts` are the configured ones; `ref` overrides the one in it */
export function parseRemoteUrl(raw: string, hosts: readonly RemoteHost[], ref = ''): RemoteUrlResult {
  const text = raw.trim();
  if (!text || text.length > MAX_SOURCE || !/^https?:\/\//i.test(text) || SUSPICIOUS.test(text.split(/[?#]/, 1)[0])) return fail('invalid_source');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('invalid_source');
  }
  if (url.username || url.password || (ref && !isRemoteRef(ref))) return fail('invalid_source');

  // raw.githubusercontent.com belongs to github.com and is only ever read through its API
  if (url.origin === 'https://raw.githubusercontent.com') {
    const host = hosts.find((h) => h.kind === 'github' && h.url === 'https://github.com');
    if (!host) return fail('host_not_configured');
    const parts = pathParts(url.pathname);
    if (!parts || !isProject(parts.slice(0, 2), 'github')) return fail('invalid_source');
    return fileTarget(host, parts.slice(0, 2).join('/'), parts.slice(2), ref);
  }

  let best: RemoteHost | null = null;
  let basePath = '';
  for (const h of hosts) {
    const u = new URL(h.url);
    const path = u.pathname.replace(/\/$/, '');
    if (u.origin !== url.origin || !(url.pathname === path || url.pathname.startsWith(`${path}/`))) continue;
    if (best && path.length <= basePath.length) continue;
    best = h;
    basePath = path;
  }
  if (!best) return fail('host_not_configured');
  const parts = pathParts(url.pathname.slice(basePath.length));
  if (!parts) return fail('invalid_source');

  let project: string[];
  let rest: string[];
  if (best.kind === 'github') {
    project = parts.slice(0, 2);
    rest = parts.slice(2);
  } else {
    // GitLab: `/-/` ends the project path; old addresses lack it (`blob` and `raw` are reserved names there)
    const dash = parts.indexOf('-');
    const old = dash >= 0 ? -1 : parts.findIndex((p, i) => i >= 2 && (p === 'blob' || p === 'raw'));
    project = dash >= 0 ? parts.slice(0, dash) : old >= 0 ? parts.slice(0, old) : parts;
    rest = dash >= 0 ? parts.slice(dash + 1) : old >= 0 ? parts.slice(old) : [];
    if (dash >= 0 && !rest.length) return fail('unsupported');
  }
  if (!rest.length && project.length) project = [...project.slice(0, -1), project[project.length - 1].replace(/\.git$/, '')];
  if (!isProject(project, best.kind)) return fail('unsupported');
  const name = project.join('/');
  if (!rest.length) return readmeTarget(best, name, ref || 'HEAD', '');
  if (['blob', 'raw', 'blame', 'edit'].includes(rest[0])) return fileTarget(best, name, rest.slice(1), ref);
  if (rest[0] === 'tree' && rest.length >= 2) return treeTarget(best, name, rest.slice(1), ref);
  return fail('unsupported');
}

function fileTarget(host: RemoteHost, project: string, rest: string[], ref: string): RemoteUrlResult {
  if (rest.length < 2) return fail('unsupported');
  const candidates = candidatesOf(rest, ref);
  if (!candidates.length) return fail('invalid_source');
  if (!isRemoteTextFile(rest[rest.length - 1])) return fail('unsupported');
  return { ok: true, target: { host, project, type: 'file', candidates } };
}

function readmeTarget(host: RemoteHost, project: string, ref: string, dir: string): RemoteUrlResult {
  const candidates = README_NAMES.map((name) => ({ ref, path: dir ? `${dir}/${name}` : name }));
  return { ok: true, target: { host, project, type: 'readme', candidates } };
}

/** A folder: its README. Without an explicit `ref` the first part is taken as the branch */
function treeTarget(host: RemoteHost, project: string, parts: string[], ref: string): RemoteUrlResult {
  const rest = parts.length > 2 && parts[0] === 'refs' ? parts.slice(2) : parts;
  const refParts = ref ? ref.split('/') : [rest[0]];
  const named = refParts.every((p, i) => rest[i] === p);
  const dir = rest.slice(named ? refParts.length : 1).join('/');
  const r = refParts.join('/');
  if (!isRemoteRef(r) || (dir && !isRemotePath(dir))) return fail('invalid_source');
  return readmeTarget(host, project, r, dir);
}

/** Group or repository prefixes (`team`, `team/docs`, optionally `gitlab:team`); an empty list allows everything */
export function remoteProjectAllowed(kind: RemoteKind, project: string, allowed: readonly string[]): boolean {
  if (!allowed.length) return true;
  const name = `${project.toLowerCase()}/`;
  return allowed.some((raw) => {
    const m = /^(gitlab|github):(.*)$/i.exec(raw.trim());
    if (m && m[1].toLowerCase() !== kind) return false;
    const prefix = (m ? m[2] : raw).trim().toLowerCase().split('/').filter(Boolean).join('/');
    return prefix !== '' && name.startsWith(`${prefix}/`);
  });
}

/** Reads `REMOTE_ALLOWED_PATHS` or the admin's field: comma or line separated */
export const parseAllowedPaths = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 200);

/** The source with its variables filled in; `complete` is false when one has no value */
export function resolveRemoteSource(src: RemoteSource, scope: VariableScope): { url: string; ref: string; complete: boolean } {
  const { url, complete } = resolveVariableUrl(src.source.trim(), scope);
  const ref = resolveVariables(src.ref.trim(), scope);
  return { url, ref, complete: complete && !hasVariables(ref) };
}

// ------------------------------------------------------------------ what the server answers

/** Where a loaded file lives; enough to make links */
export interface RemoteBase {
  kind: RemoteKind;
  /** Address of the instance */
  host: string;
  project: string;
  ref: string;
  path: string;
}

export interface RemoteCommit {
  id: string;
  at: number | null;
}

export type RemoteProblem =
  | RemoteUrlProblem
  | 'unknown_variable'
  /** Outside the paths the admin allows */
  | 'not_allowed'
  | 'no_access'
  | 'not_found'
  | 'too_large'
  | 'unreachable'
  /** The instance refuses more requests for now */
  | 'upstream_limit'
  /** The instance answers with a redirect to somewhere else */
  | 'redirect';

export type RemoteNoteResponse =
  | { state: 'ok'; text: string; base: RemoteBase; url: string; commit: RemoteCommit | null; fetchedAt: number }
  | { state: RemoteProblem };

/** One configured instance as the admin area sees it: never with its token */
export interface AdminRemoteInstance {
  id: string;
  kind: RemoteKind;
  url: string;
  hasToken: boolean;
  /** Read without a token (public projects only) */
  anonymous: boolean;
  allowedPaths: string[];
  /** Set by environment variables: shown only */
  fromEnv: boolean;
  /** An environment variable configures the same address, so this entry does not count */
  overridden?: boolean;
}

export interface RemoteTestResult {
  /** `limited`: the token works, but may not read who it belongs to (fine for `read_repository`) */
  state: 'ok' | 'limited' | RemoteProblem;
}

/** Path as it stands in an address; parentheses too, they would end a Markdown link */
const encodePath = (path: string): string =>
  path
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');

/** Address of a file on its host, as people open it */
export function remoteWebUrl(base: RemoteBase, view: 'blob' | 'raw' = 'blob'): string {
  return `${base.host}/${base.project}/${base.kind === 'gitlab' ? '-/' : ''}${view}/${encodePath(base.ref)}/${encodePath(base.path)}`;
}

/** A repository path in the query of the image proxy, safe inside a Markdown link */
export const encodeRemotePath = (path: string): string => encodePath(path).replace(/\//g, '%2F');

// ------------------------------------------------------------------ remote text

/** A relative address in the file, as a path inside the repository; null when it leaves it */
function resolveInRepo(dir: string, target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  const parts = decoded.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const s of decoded.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(s);
  }
  return parts.join('/');
}

/** What an address that must not be opened becomes: the renderer shows it as blocked */
const BLOCKED = 'about:blank';

const safeHash = (hash: string): string => hash.replace(/[()<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/** A destination from the remote text as one that works here: absolute, or the image proxy */
function destination(raw: string, image: boolean, base: RemoteBase, imageUrl: (path: string) => string): { url: string; image: boolean } {
  const url = raw.trim();
  if (!url) return { url, image };
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return { url: safeUrl(url, image ? 'media' : 'link', image) ?? BLOCKED, image };
  if (/^[\\/]{2}/.test(url)) return { url: `https://${url.slice(2).replace(/^[\\/]+/, '')}`, image };
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? safeHash(url.slice(hashAt)) : '';
  const target = (hashAt >= 0 ? url.slice(0, hashAt) : url).split('?', 1)[0];
  if (!target) return { url: remoteWebUrl(base) + hash, image: false };
  const slash = base.path.lastIndexOf('/');
  const path = resolveInRepo(slash >= 0 ? base.path.slice(0, slash) : '', target);
  if (path === '') return { url: `${base.host}/${base.project}`, image: false };
  if (path === null || !isRemotePath(path)) return { url: BLOCKED, image: false };
  if (image && isRemoteImageFile(path)) return { url: imageUrl(path), image: true };
  return { url: remoteWebUrl({ ...base, path }) + hash, image: false };
}

const MAX_DESTINATION = 2000;

/** Reads `(url "title")` behind a `]`; null when it is none. Bounded, and it stops at the next bracket: linear overall */
function readDestination(text: string, open: number): { url: string; title: string; end: number } | null {
  let i = open + 1;
  const limit = Math.min(text.length, open + MAX_DESTINATION);
  const blank = () => {
    while (i < limit && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  blank();
  let url: string;
  if (text[i] === '<') {
    const from = ++i;
    while (i < limit && !'<>]\n'.includes(text[i])) i++;
    if (text[i] !== '>') return null;
    url = text.slice(from, i++);
  } else {
    const from = i;
    let depth = 0;
    for (; i < limit; i++) {
      const c = text[i];
      if (' \t\n]<'.includes(c)) break;
      if (c === '(') depth++;
      else if (c === ')' && depth-- === 0) break;
    }
    url = text.slice(from, i);
  }
  blank();
  let title = '';
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    const from = i++;
    while (i < limit && text[i] !== quote && text[i] !== '\n' && text[i] !== ']') i++;
    if (text[i] !== quote) return null;
    title = text.slice(from, ++i);
    blank();
  }
  return i < limit && text[i] === ')' ? { url, title, end: i + 1 } : null;
}

/** Rewrites the destinations of one paragraph's links and images, code spans left alone */
function rewriteInline(text: string, base: RemoteBase, imageUrl: (path: string) => string): string {
  let out = '';
  let pos = 0;
  /** Open brackets: where each went in the output */
  const stack: { at: number; image: boolean }[] = [];
  /** Lengths of backtick runs that have no partner further on, so they are looked for only once */
  const unmatched = new Set<number>();
  const runAt = (at: number) => {
    let n = 1;
    while (text[at + n] === '`') n++;
    return n;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === '`') {
      const n = runAt(i);
      let close = -1;
      for (let at = unmatched.has(n) ? -1 : text.indexOf('`', i + n); at !== -1; ) {
        const m = runAt(at);
        if (m === n) {
          close = at + m;
          break;
        }
        at = text.indexOf('`', at + m);
      }
      if (close === -1) unmatched.add(n);
      i = close === -1 ? i + n : close;
    } else if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      out += text.slice(pos, i);
      pos = i;
      stack.push({ at: out.length, image: c === '!' });
      i += c === '!' ? 2 : 1;
    } else if (c === ']') {
      const open = stack.pop();
      const dest = open && text[i + 1] === '(' ? readDestination(text, i + 1) : null;
      if (open && dest) {
        const d = destination(dest.url, open.image, base, imageUrl);
        out += text.slice(pos, i);
        // An image that is none (a video, a PDF) becomes a link to the file
        if (open.image && !d.image) out = out.slice(0, open.at) + out.slice(open.at + 1);
        out += `](${d.url}${dest.title ? ` ${dest.title}` : ''})`;
        pos = i = dest.end;
      } else i++;
    } else i++;
  }
  return out + text.slice(pos);
}

const FENCE = /^([\s>]{0,20})(`{3,}|~{3,})(.*)$/;
/** Blocks Kladde would run or fill from the reader's own vault: shown as plain code instead */
const ACTIVE_BLOCK = /^\s*(?:query|versions|gallery|carousel)\b/i;

/**
 * The remote text as Kladde shows it: without its frontmatter, relative links leading to the file's host, relative
 * images to `imageUrl`, and blocks that would run against the reader's notes as plain code. Everything else in it that
 * would touch the vault ([[links]], embeds, variables, tickets, mentions) is switched off in the renderer.
 */
export function prepareRemoteMarkdown(text: string, base: RemoteBase, imageUrl: (path: string) => string): string {
  const body = parseFrontmatter(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')).body;
  const out: string[] = [];
  let para: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (para.length) out.push(rewriteInline(para.join('\n'), base, imageUrl));
    para = [];
  };
  for (const line of body.split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3].trim()) fence = null;
      out.push(line);
    } else if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
      flush();
      fence = f[2];
      out.push(ACTIVE_BLOCK.test(f[3]) ? `${f[1]}${f[2]}text` : line);
    } else if (!line.trim()) {
      flush();
      out.push(line);
    } else para.push(line);
  }
  flush();
  const result = out.join('\n');
  // A rule at the very top must not read as the note's frontmatter
  return result.startsWith('---\n') ? `\n${result}` : result;
}
