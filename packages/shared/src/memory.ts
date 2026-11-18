/**
 * AI memory (#94): an opt-in folder in the user's space where AI agents (any provider, through MCP) and the user
 * build knowledge together. Notes follow a small, OKF v0.2-compatible core (`type`, `description`, `status`,
 * `stale_after`, `generated`, `verified`, `sources`); everything else in the frontmatter is kept untouched.
 * Pure rules shared by server and client: metadata, trust level, validation, stamping, index/log upkeep, rules.
 */
import { splitPath } from './markdown.js';
import { trimSlashes } from './util.js';
import { readFrontmatterYaml, setFrontmatterValues, yamlProblems, type YamlMap, type YamlValue } from './yaml.js';

export const OKF_VERSION = '0.2';
/** The types Kladde suggests; any other non-empty value is allowed */
export const MEMORY_TYPES = ['Reference', 'Technique', 'Rule', 'Decision', 'Preference'] as const;
export const MEMORY_STATUSES = ['draft', 'stable', 'deprecated'] as const;
/** Reserved names: directory overview and history (OKF); never concepts */
export const MEMORY_INDEX = 'index';
export const MEMORY_LOG = 'log';
/** Upper bound for the rules sent along with the MCP instructions */
export const MEMORY_RULES_MAX_BYTES = 8 * 1024;
/** Prefix of human actors in `generated.by` / `verified[].by` */
export const HUMAN_ACTOR = 'human:';

export type TrustLevel = 'unverified' | 'machine-confirmed' | 'human-reviewed';

export interface MemoryActor {
  by: string;
  at: string;
}

export interface MemorySource {
  id: string;
  resource: string;
  title: string;
}

export interface MemoryMeta {
  type: string;
  title: string;
  description: string;
  status: string;
  staleAfter: string;
  /** `stale_after` reached */
  stale: boolean;
  generated: MemoryActor | null;
  verified: MemoryActor[];
  sources: MemorySource[];
  trust: TrustLevel;
  /** Changed (generated.at) after the last human confirmation */
  changedSinceVerified: boolean;
  tags: string[];
}

export type MemoryProblemLevel = 'error' | 'warning';

export interface MemoryProblem {
  level: MemoryProblemLevel;
  code: string;
  message: string;
}

// ------------------------------------------------------------------ paths

const clean = (folder: string) => trimSlashes(folder);

/** Whether a path lies in the memory folder (at any depth) */
export function isMemoryPath(path: string, folder: string): boolean {
  const f = clean(folder);
  return !!f && path.startsWith(`${f}/`);
}

/** `index.md` or `log.md` (in any folder) */
export function isReservedMemoryNote(path: string): boolean {
  const name = splitPath(path).name.toLowerCase();
  return name === MEMORY_INDEX || name === MEMORY_LOG;
}

/** The path inside the memory folder without `.md` (the OKF concept id) */
export function conceptId(path: string, folder: string): string {
  return path.slice(clean(folder).length + 1).replace(/\.md$/i, '');
}

// ------------------------------------------------------------------ metadata

const str = (v: YamlValue | undefined): string => (typeof v === 'string' ? v.trim() : '');

function actor(v: YamlValue | undefined): MemoryActor | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const by = str(v.by);
  return by ? { by, at: str(v.at) } : null;
}

function actors(v: YamlValue | undefined): MemoryActor[] {
  if (Array.isArray(v)) return v.map(actor).filter((a): a is MemoryActor => !!a);
  const one = actor(v);
  return one ? [one] : [];
}

function sourcesOf(v: YamlValue | undefined): MemorySource[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => (s && typeof s === 'object' && !Array.isArray(s) ? { id: str(s.id), resource: str(s.resource), title: str(s.title) } : typeof s === 'string' ? { id: '', resource: s, title: '' } : null))
    .filter((s): s is MemorySource => !!s && !!(s.id || s.resource || s.title));
}

/** Milliseconds of an ISO 8601 date or date-time; NaN when unreadable */
function timeOf(iso: string): number {
  if (!iso) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
}

export const isHumanActor = (by: string) => by.startsWith(HUMAN_ACTOR);

/** OKF trust tiers, derived from `verified` */
export function trustLevel(verified: MemoryActor[]): TrustLevel {
  if (verified.some((v) => isHumanActor(v.by))) return 'human-reviewed';
  return verified.length ? 'machine-confirmed' : 'unverified';
}

/** Metadata of a memory note from its frontmatter (empty values when missing) */
export function memoryMeta(content: string, path = '', now = Date.now()): MemoryMeta {
  const fm = readFrontmatterYaml(content);
  const data: YamlMap = fm?.data ?? {};
  const verified = actors(data.verified);
  const generated = actor(data.generated);
  const staleAfter = str(data.stale_after);
  const staleAt = timeOf(staleAfter);
  const lastHuman = Math.max(...verified.filter((v) => isHumanActor(v.by)).map((v) => timeOf(v.at)).filter((n) => !Number.isNaN(n)), -Infinity);
  const genAt = generated ? timeOf(generated.at) : NaN;
  const tagsRaw = data.tags;
  return {
    type: str(data.type),
    title: str(data.title) || (path ? splitPath(path).name : ''),
    description: str(data.description),
    status: str(data.status) || 'stable',
    staleAfter,
    stale: !Number.isNaN(staleAt) && staleAt <= now,
    generated,
    verified,
    sources: sourcesOf(data.sources),
    trust: trustLevel(verified),
    changedSinceVerified: lastHuman > -Infinity && !Number.isNaN(genAt) && genAt > lastHuman,
    tags: Array.isArray(tagsRaw) ? tagsRaw.filter((t): t is string => typeof t === 'string') : str(tagsRaw) ? str(tagsRaw).split(',').map((t) => t.trim()).filter(Boolean) : [],
  };
}

// ------------------------------------------------------------------ validation

/** ISO 8601 date-time with an explicit offset (`Z` or `+01:00`) */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export interface MemoryCheckOptions {
  /** Resolves a [[link]] target; links that resolve to nothing are reported */
  resolveLink?: (target: string) => boolean;
  /** How many notes in the memory carry each title (lower case); more than one is reported */
  titleCounts?: Map<string, number>;
  now?: number;
}

/** Problems of one memory note (errors break the format, warnings are hints). index/log are not checked */
export function checkMemoryNote(path: string, content: string, opts: MemoryCheckOptions = {}): MemoryProblem[] {
  if (isReservedMemoryNote(path)) return [];
  const out: MemoryProblem[] = [];
  const err = (code: string, message: string) => out.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => out.push({ level: 'warning', code, message });
  const fm = readFrontmatterYaml(content);
  if (!fm) {
    err('frontmatter', 'Die Notiz hat kein YAML-Frontmatter (--- … ---).');
    return out;
  }
  const skipped = yamlProblems(fm.yaml);
  if (skipped.length) err('yaml', `Das Frontmatter ist nicht lesbar (Zeile ${skipped.map((n) => n + 2).join(', ')}).`);
  const meta = memoryMeta(content, path, opts.now);
  if (!meta.type) err('type', 'Das Pflichtfeld `type` fehlt (z. B. Reference, Technique, Rule, Decision, Preference).');
  if (meta.generated && meta.generated.at && !ISO_WITH_OFFSET.test(meta.generated.at)) err('timestamp', '`generated.at` braucht einen ISO-8601-Zeitpunkt mit Zeitzone, z. B. 2026-11-18T10:00:00Z.');
  for (const v of meta.verified) {
    if (!ISO_WITH_OFFSET.test(v.at)) err('timestamp', `\`verified\` von ${v.by} braucht einen ISO-8601-Zeitpunkt mit Zeitzone.`);
  }
  if (meta.staleAfter && !/^\d{4}-\d{2}-\d{2}$/.test(meta.staleAfter) && !ISO_WITH_OFFSET.test(meta.staleAfter)) {
    err('timestamp', '`stale_after` braucht ein Datum (YYYY-MM-DD) oder einen Zeitpunkt mit Zeitzone.');
  }
  if (!meta.description) warn('description', 'Eine `description` (ein Satz) fehlt; sie erscheint im Index und in der Suche.');
  if (!(MEMORY_STATUSES as readonly string[]).includes(meta.status)) warn('status', `Unbekannter \`status\` „${meta.status}“ (erwartet: draft, stable, deprecated).`);
  if (meta.stale) warn('stale', `Veraltet seit ${meta.staleAfter} (\`stale_after\`).`);
  if (opts.titleCounts && (opts.titleCounts.get(meta.title.toLowerCase()) ?? 0) > 1) warn('duplicate', `Den Titel „${meta.title}“ gibt es mehrfach im Gedächtnis.`);

  const body = fm.body.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '');
  if (opts.resolveLink) {
    const broken = new Set<string>();
    for (const m of body.matchAll(/\[\[([^\]|#\n]+)/g)) if (!opts.resolveLink(m[1].trim())) broken.add(m[1].trim());
    if (broken.size) warn('link', `Links ohne Ziel: ${[...broken].map((b) => `[[${b}]]`).join(', ')}.`);
  }
  const ids = new Set(meta.sources.map((s) => s.id).filter(Boolean));
  const defined = new Set([...body.matchAll(/^\[\^([^\]\s]+)\]:/gm)].map((m) => m[1]));
  const cited = new Set([...body.matchAll(/\[\^([^\]\s]+)\](?!:)/g)].map((m) => m[1]));
  const uncited = [...ids].filter((id) => !cited.has(id));
  if (uncited.length) warn('source', `Quellen ohne Fußnote im Text: ${uncited.join(', ')}.`);
  const dangling = [...cited].filter((c) => !ids.has(c) && !defined.has(c));
  if (dangling.length) warn('footnote', `Fußnoten ohne Quelle: ${dangling.map((d) => `[^${d}]`).join(', ')}.`);
  return out;
}

// ------------------------------------------------------------------ stamping

/** ISO 8601 with offset, second precision (`2026-11-18T10:00:00Z`) */
export const isoNow = (now = Date.now()) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Actor id from a free name (MCP connection name, user name): lower case, no spaces */
export function actorId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._/-]+/gu, '-')
      .split('-')
      .filter(Boolean)
      .join('-')
      .slice(0, 60) || 'agent'
  );
}

const actorYaml = (a: MemoryActor): YamlValue => ({ by: a.by, at: a.at });

/** Sets `generated` to the given actor; a different `by` an agent claimed is kept as `generated.model` */
export function stampGenerated(content: string, by: string, at = isoNow()): string {
  const fm = readFrontmatterYaml(content);
  const old = fm?.data.generated;
  const claimed = old && typeof old === 'object' && !Array.isArray(old) ? str(old.by) : '';
  const next: YamlMap = { by, at };
  if (claimed && claimed !== by && !isHumanActor(claimed) && !isHumanActor(by)) next.model = claimed;
  return setFrontmatterValues(content, { generated: next });
}

/** Adds a confirmation (`verified`) by an actor, replacing an older one by the same actor */
export function addVerification(content: string, by: string, at = isoNow()): string {
  const meta = memoryMeta(content);
  const verified = [...meta.verified.filter((v) => v.by !== by), { by, at }];
  return setFrontmatterValues(content, { verified: verified.map(actorYaml) });
}

/** Sets `status` (draft/stable/deprecated) */
export function setMemoryStatus(content: string, status: string): string {
  return setFrontmatterValues(content, { status });
}

/**
 * The server's guard for agent writes: `verified` entries by humans can neither be added nor removed by an agent,
 * and an agent may only confirm in its own name. Returns the content with the human entries of `before` restored,
 * or an error message.
 */
export function guardVerified(before: string | null, after: string, agent: string): { content: string } | { error: string } {
  const old = before ? memoryMeta(before).verified : [];
  const next = memoryMeta(after).verified;
  const key = (v: MemoryActor) => `${v.by}\u0000${v.at}`;
  const oldKeys = new Set(old.map(key));
  for (const v of next) {
    if (oldKeys.has(key(v))) continue;
    if (isHumanActor(v.by)) return { error: `Nur Menschen bestätigen mit „${v.by}“. Bestätige als Agent höchstens mit „by: ${agent}“.` };
    if (v.by !== agent) return { error: `Ein Agent darf nur in eigenem Namen bestätigen („by: ${agent}“), nicht als „${v.by}“.` };
  }
  const humansLost = old.filter((v) => isHumanActor(v.by) && !next.some((n) => key(n) === key(v)));
  if (!humansLost.length) return { content: after };
  return { content: setFrontmatterValues(after, { verified: [...next, ...humansLost].map(actorYaml) }) };
}

// ------------------------------------------------------------------ building notes

export interface MemoryFields {
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  status?: string;
  stale_after?: string;
  resource?: string;
  sources?: { id: string; resource?: string; title?: string }[];
}

/** Sets the core fields on a note (new or existing); other frontmatter keys stay as they are */
export function applyMemoryFields(content: string, fields: MemoryFields): string {
  const updates: Record<string, YamlValue | undefined> = { type: fields.type };
  if (fields.title !== undefined) updates.title = fields.title;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.resource !== undefined) updates.resource = fields.resource || undefined;
  if (fields.tags !== undefined) updates.tags = fields.tags.length ? fields.tags : undefined;
  if (fields.status !== undefined) updates.status = fields.status || undefined;
  if (fields.stale_after !== undefined) updates.stale_after = fields.stale_after || undefined;
  if (fields.sources !== undefined) {
    updates.sources = fields.sources.length
      ? fields.sources.map((s) => {
          const o: YamlMap = { id: s.id };
          if (s.resource) o.resource = s.resource;
          if (s.title) o.title = s.title;
          return o;
        })
      : undefined;
  }
  return setFrontmatterValues(content, updates);
}

/** The body of a note (without frontmatter) */
export function memoryBody(content: string): string {
  return readFrontmatterYaml(content)?.body ?? content;
}

/** Replaces the body, keeping the frontmatter */
export function replaceMemoryBody(content: string, body: string): string {
  const fm = readFrontmatterYaml(content);
  if (!fm) return body;
  return `${content.slice(0, content.length - fm.body.length)}${body.replace(/^\n*/, '\n')}`;
}

/**
 * A copy for the user's own notes ("adopt"): agent metadata (`generated`, `verified`, `stale_after`, `status`)
 * dropped, `source` pointing back to the memory note.
 */
export function adoptedContent(content: string, sourceTitle: string): string {
  const next = setFrontmatterValues(content, { generated: undefined, verified: undefined, stale_after: undefined, status: undefined, source: `[[${sourceTitle}]]` });
  return next;
}

// ------------------------------------------------------------------ index and log

/** Text without trailing line breaks (a loop: `/\n+$/` is quadratic on long runs) */
function trimNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
  return text.slice(0, end);
}

export interface MemoryIndexEntry {
  /** Link target that resolves to the note ([[target]]) */
  target: string;
  /** Text shown for the link when it differs from the target */
  label?: string;
  type: string;
  description: string;
  deprecated?: boolean;
}

const INDEX_NOTE = '_Automatisch von Kladde ergänzt; Abschnitte und Reihenfolge darfst du frei ändern._';

const linkOf = (e: { target: string; label?: string }) => (e.label && e.label !== e.target ? `[[${e.target}|${e.label}]]` : `[[${e.target}]]`);

/** Matches an index line linking to `target` ("- [[target]]…" or "- [[target|label]]…") */
function indexLineFor(lines: string[], target: string): number {
  const t = target.toLowerCase();
  return lines.findIndex((l) => {
    const m = /^\s*[-*]\s+\[\[([^\]|#\n]+)/.exec(l);
    return !!m && m[1].trim().toLowerCase() === t;
  });
}

/**
 * Brings an index (`index.md`) up to date without throwing away what was written by hand: every entry gets the
 * current description, missing concepts are added under a heading for their type, subfolders under "Ordner",
 * entries for notes that are gone are removed. `root` gives the root index its `okf_version`.
 */
export function syncMemoryIndex(current: string | null, heading: string, entries: MemoryIndexEntry[], subfolders: { target: string; label: string }[], root: boolean, known?: (target: string) => boolean): string {
  let text = current ?? `# ${heading}\n\n${INDEX_NOTE}\n`;
  if (root && !readFrontmatterYaml(text)?.data.okf_version) text = setFrontmatterValues(text, { okf_version: OKF_VERSION });
  const lines = trimNewlines(text).split('\n');
  const line = (e: MemoryIndexEntry) => `- ${linkOf(e)}${e.description ? `: ${e.description}` : ''}${e.deprecated ? ' _(veraltet)_' : ''}`;
  const addUnder = (section: string, entry: string) => {
    let at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase());
    if (at < 0) {
      if (lines[lines.length - 1]?.trim()) lines.push('');
      lines.push(`## ${section}`);
      lines.push(entry);
      return;
    }
    at++;
    while (at < lines.length && /^\s*[-*]\s/.test(lines[at])) at++;
    lines.splice(at, 0, entry);
  };
  for (const e of entries) {
    const at = indexLineFor(lines, e.target) >= 0 ? indexLineFor(lines, e.target) : e.label ? indexLineFor(lines, e.label) : -1;
    if (at >= 0) {
      const indent = /^\s*/.exec(lines[at])![0];
      lines[at] = `${indent}${line(e)}`;
    } else addUnder(e.type || 'Weitere', line(e));
  }
  for (const f of subfolders) {
    if (indexLineFor(lines, f.target) < 0) addUnder('Ordner', `- ${linkOf(f)}`);
  }
  // Entries whose note is gone (deleted, moved) drop out; links to other things (log, outside notes) stay
  if (known) {
    const mine = new Set([...entries.map((e) => e.target.toLowerCase()), ...entries.map((e) => (e.label ?? '').toLowerCase()), ...subfolders.map((f) => f.target.toLowerCase())]);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^\s*[-*]\s+\[\[([^\]|#\n]+)/.exec(lines[i]);
      if (m && !mine.has(m[1].trim().toLowerCase()) && !known(m[1].trim())) lines.splice(i, 1);
    }
  }
  return `${lines.join('\n')}\n`;
}

export type MemoryLogKind = 'Creation' | 'Update' | 'Deprecation';

/** Adds a log entry under today's date heading (`## YYYY-MM-DD`, newest first); the same entry is not repeated */
export function addMemoryLogEntry(current: string | null, date: string, kind: MemoryLogKind, text: string): string {
  const entry = `**${kind}** ${text}`;
  const lines = trimNewlines(current ?? '').split('\n');
  if (lines.length === 1 && !lines[0]) lines.length = 0;
  const dateRe = /^#{1,3}\s+(\d{4}-\d{2}-\d{2})\s*$/;
  const first = lines.findIndex((l) => dateRe.test(l));
  if (first >= 0 && dateRe.exec(lines[first])![1] === date) {
    // Same day: newest entry right below the heading, unless it is already there
    const next = lines.findIndex((l, i) => i > first && dateRe.test(l));
    const section = lines.slice(first + 1, next < 0 ? lines.length : next);
    if (section.some((l) => l.trim() === entry)) return `${lines.join('\n')}\n`;
    lines.splice(first + 1, 0, '', entry);
  } else {
    const level = first >= 0 ? /^#+/.exec(lines[first])![0] : '##';
    const block = [`${level} ${date}`, '', entry, ''];
    if (first >= 0) lines.splice(first, 0, ...block);
    else {
      if (lines.length && lines[lines.length - 1].trim()) lines.push('');
      lines.push(...block);
    }
  }
  // At most one blank line in a row
  const out = lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()));
  return `${trimNewlines(out.join('\n'))}\n`;
}

// ------------------------------------------------------------------ rules for agents

export interface MemoryRule {
  id: string;
  path: string;
  title: string;
  description: string;
  body: string;
}

/** Notes of type `Rule` in the memory that are not deprecated, ordered by path */
export function memoryRules(notes: { id: string; path: string; content: string }[], folder: string): MemoryRule[] {
  return notes
    .filter((n) => isMemoryPath(n.path, folder) && !isReservedMemoryNote(n.path))
    .map((n) => ({ n, meta: memoryMeta(n.content, n.path) }))
    .filter(({ meta }) => meta.type.toLowerCase() === 'rule' && meta.status !== 'deprecated')
    .sort((a, b) => a.n.path.localeCompare(b.n.path))
    .map(({ n, meta }) => ({ id: n.id, path: n.path, title: meta.title, description: meta.description, body: memoryBody(n.content).trim() }));
}

/** The rules as one Markdown text, cut at `maxBytes` (the rest listed by title, to read with read_note) */
export function memoryRulesText(rules: MemoryRule[], maxBytes = MEMORY_RULES_MAX_BYTES): string {
  const parts: string[] = [];
  const rest: string[] = [];
  let size = 0;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  for (const r of rules) {
    const part = `## ${r.title}\n${r.body}`;
    if (!rest.length && size + bytes(part) <= maxBytes) {
      parts.push(part);
      size += bytes(part) + 2;
    } else rest.push(r.title);
  }
  if (rest.length) parts.push(`(Further rules, read them with read_note: ${rest.map((t) => `"${t}"`).join(', ')})`);
  return parts.join('\n\n');
}

/** What every agent learns about the memory when it connects (MCP instructions) */
export function memoryInstructions(folder: string, rules: MemoryRule[]): string {
  const intro = [
    `AI memory: the folder "${folder}" is a shared, provider-independent knowledge store that you and other AI assistants build together with the user.`,
    'Save lasting knowledge there (facts about products and tools, techniques, decisions, the user\'s preferences) with memory_save; read the user\'s own notes elsewhere, but do not write AI knowledge into them.',
    `Every note has YAML frontmatter with the required \`type\` (${MEMORY_TYPES.join(', ')} or your own), a one-sentence \`description\`, optional \`tags\`, \`status\` (draft/stable/deprecated), \`stale_after\` and \`sources\` (id, resource, title; cite them as footnotes [^id]).`,
    'Kladde sets `generated` (who changed it, when) and keeps `index` and `log` up to date; do not edit those by hand. Only the user confirms (`verified`). Mark outdated knowledge with status deprecated instead of deleting it. Check the memory with memory_check.',
    'Notes of type Rule are instructions from the user to you; follow them.',
  ].join(' ');
  if (!rules.length) return intro;
  return `${intro}\n\n# Rules from the AI memory\n\n${memoryRulesText(rules)}`;
}

// ------------------------------------------------------------------ OKF export/import

/** A file of an OKF bundle: path inside the bundle (with `.md`) and its text */
export interface BundleFile {
  path: string;
  content: string;
}

/**
 * The memory as an OKF bundle: paths relative to the memory folder, [[links]] to notes in the memory turned into
 * bundle-relative Markdown links (`[Text](/Produkte/Foo)`), the root `index.md` with `okf_version`.
 * `resolve` maps a link target to a note id (the app's link index).
 */
export function toOkfBundle(notes: { id: string; path: string; content: string }[], folder: string, resolve: (target: string) => string | null): BundleFile[] {
  const inside = notes.filter((n) => isMemoryPath(n.path, folder));
  const byId = new Map(inside.map((n) => [n.id, n]));
  const files = inside.map((n) => {
    const content = n.content.replace(/\[\[([^[\]|#\n]+)((?:#[^[\]|\n]*)?)((?:\|[^[\]\n]*)?)\]\]/g, (all: string, target: string, anchorRaw: string, aliasRaw: string, at: number, text: string) => {
      // Embeds (![[…]]) stay as they are
      if (at > 0 && text[at - 1] === '!') return all;
      const anchor = anchorRaw || undefined;
      const alias = aliasRaw ? aliasRaw.slice(1) : undefined;
      const id = resolve(target.trim());
      const to = id ? byId.get(id) : undefined;
      if (!to) return all;
      return `[${(alias ?? target).trim()}](/${encodeOkfPath(conceptId(to.path, folder))}${anchor ?? ''})`;
    });
    return { path: n.path.slice(clean(folder).length + 1), content };
  });
  const root = files.find((f) => f.path.toLowerCase() === `${MEMORY_INDEX}.md`);
  if (root) {
    if (!readFrontmatterYaml(root.content)?.data.okf_version) root.content = setFrontmatterValues(root.content, { okf_version: OKF_VERSION });
  } else files.push({ path: `${MEMORY_INDEX}.md`, content: `---\nokf_version: "${OKF_VERSION}"\n---\n\n# ${splitPath(`${clean(folder)}.md`).name}\n` });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const encodeOkfPath = (p: string) => p.split('/').map((s) => (/[\s()]/.test(s) ? encodeURIComponent(s) : s)).join('/');

/** Bundle-relative or relative Markdown link target → bundle path without `.md`; null for URLs and anchors */
export function okfLinkTarget(url: string, fromFolder: string): string | null {
  const raw = url.trim().replace(/^<|>$/g, '');
  if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('/api/')) return null;
  let path = raw.replace(/[?#].*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep as written */
  }
  const parts = path.startsWith('/') ? [] : fromFolder.split('/').filter(Boolean);
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const out = parts.join('/').replace(/\.md$/i, '');
  return out || null;
}

/**
 * Notes for importing an OKF bundle into the memory folder: Markdown links between bundle files become [[links]]
 * (by file name, or by bundle path when the name is not unique), everything else is kept as written.
 */
export function fromOkfBundle(files: BundleFile[], folder: string): BundleFile[] {
  const md = files.filter((f) => /\.md$/i.test(f.path));
  const ids = new Map(md.map((f) => [f.path.replace(/\.md$/i, '').toLowerCase(), f.path.replace(/\.md$/i, '')]));
  const nameCount = new Map<string, number>();
  for (const f of md) {
    const name = splitPath(f.path).name.toLowerCase();
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }
  return md.map((f) => {
    const from = splitPath(f.path).folder;
    const content = f.content.replace(/\[([^[\]\n]*)\]\(([^()\s]+)\)/g, (all: string, text: string, url: string, at: number, whole: string) => {
      // Images stay as they are
      if (at > 0 && whole[at - 1] === '!') return all;
      const target = okfLinkTarget(url, from);
      const hit = target ? ids.get(target.toLowerCase()) : undefined;
      if (!hit) return all;
      const name = splitPath(`${hit}.md`).name;
      const ref = (nameCount.get(name.toLowerCase()) ?? 0) > 1 ? `${clean(folder)}/${hit}` : name;
      return text && text !== ref ? `[[${ref}|${text}]]` : `[[${ref}]]`;
    });
    return { path: `${clean(folder)}/${f.path}`, content };
  });
}

/** The memory notes as a bundle for checking: all problems per path, and the counts the overview shows */
export function memoryOverview(notes: { id: string; path: string; content: string }[], folder: string, opts: Omit<MemoryCheckOptions, 'titleCounts'> = {}) {
  const inside = notes.filter((n) => isMemoryPath(n.path, folder) && !isReservedMemoryNote(n.path));
  const titleCounts = new Map<string, number>();
  const metas = inside.map((n) => ({ n, meta: memoryMeta(n.content, n.path, opts.now) }));
  for (const { meta } of metas) titleCounts.set(meta.title.toLowerCase(), (titleCounts.get(meta.title.toLowerCase()) ?? 0) + 1);
  const notesOut = metas.map(({ n, meta }) => ({ id: n.id, path: n.path, title: meta.title, type: meta.type, status: meta.status, trust: meta.trust, stale: meta.stale, problems: checkMemoryNote(n.path, n.content, { ...opts, titleCounts }) }));
  return {
    total: notesOut.length,
    errors: notesOut.filter((n) => n.problems.some((p) => p.level === 'error')).length,
    warnings: notesOut.filter((n) => n.problems.some((p) => p.level === 'warning')).length,
    stale: notesOut.filter((n) => n.stale).length,
    deprecated: notesOut.filter((n) => n.status === 'deprecated').length,
    unverified: notesOut.filter((n) => n.trust === 'unverified').length,
    rules: notesOut.filter((n) => n.type.toLowerCase() === 'rule' && n.status !== 'deprecated').length,
    notes: notesOut,
  };
}


// ------------------------------------------------------------------ upkeep after a change

export interface MemoryWrite {
  /** Existing note to update, null for a new one */
  id: string | null;
  path: string;
  content: string;
}

export interface MemoryLogRequest {
  kind: MemoryLogKind;
  /** Who changed it (agent id or `human:<name>`) */
  actor: string;
  /** YYYY-MM-DD */
  date: string;
}

/** How a note is linked from an index or the log: by name when that resolves to it, else by full path */
function memoryLinkOf(n: { id: string; path: string }, resolve: (target: string) => string | null): { target: string; label?: string } {
  const name = splitPath(n.path).name;
  if (resolve(name) === n.id) return { target: name };
  return { target: n.path.replace(/\.md$/i, ''), label: name };
}

/**
 * The index and log writes after a note in the memory changed (or was deleted): the index of its folder and of
 * every folder above it up to the memory root, and an entry in the root `log`. `notes` is the state after the
 * change; `resolve` maps a [[link]] target to a note id over the same notes.
 */
export function memoryUpkeep(
  notes: { id: string; path: string; content: string }[],
  folder: string,
  changedPath: string,
  resolve: (target: string) => string | null,
  log: MemoryLogRequest | null
): MemoryWrite[] {
  const root = clean(folder);
  if (!isMemoryPath(changedPath, root) || isReservedMemoryNote(changedPath)) return [];
  const inside = notes.filter((n) => isMemoryPath(n.path, root));
  const byPath = new Map(inside.map((n) => [n.path, n]));
  const writes: MemoryWrite[] = [];
  const dirs: string[] = [];
  for (let dir = splitPath(changedPath).folder; ; dir = dir.slice(0, dir.lastIndexOf('/'))) {
    dirs.push(dir);
    if (dir === root || !dir.includes('/')) break;
  }
  for (const dir of dirs) {
    const concepts = inside.filter((n) => splitPath(n.path).folder === dir && !isReservedMemoryNote(n.path));
    const entries: MemoryIndexEntry[] = concepts.map((n) => {
      const meta = memoryMeta(n.content, n.path);
      return { ...memoryLinkOf(n, resolve), type: meta.type || 'Weitere', description: meta.description, deprecated: meta.status === 'deprecated' };
    });
    const subs = [
      ...new Set(
        inside
          .map((n) => splitPath(n.path).folder)
          .filter((f) => f.startsWith(`${dir}/`))
          .map((f) => `${dir}/${f.slice(dir.length + 1).split('/')[0]}`)
      ),
    ].sort();
    const subfolders = subs.map((s) => ({ target: `${s}/${MEMORY_INDEX}`, label: s.split('/').pop()! }));
    const indexPath = `${dir}/${MEMORY_INDEX}.md`;
    const existing = byPath.get(indexPath);
    const next = syncMemoryIndex(existing?.content ?? null, dir.split('/').pop()!, entries, subfolders, dir === root, (t) => !!resolve(t));
    if (next !== existing?.content) writes.push({ id: existing?.id ?? null, path: indexPath, content: next });
  }
  const changed = byPath.get(changedPath);
  if (log && changed) {
    const logPath = `${root}/${MEMORY_LOG}.md`;
    const existing = byPath.get(logPath);
    const link = memoryLinkOf(changed, resolve);
    const next = addMemoryLogEntry(existing?.content ?? null, log.date, log.kind, `${linkOf(link)} (${log.actor})`);
    if (next !== existing?.content) writes.push({ id: existing?.id ?? null, path: logPath, content: next });
  }
  return writes;
}

/** Which log entry a change makes: new note, newly deprecated, or an update */
export function memoryChangeKind(before: string | null, after: string): MemoryLogKind {
  if (before === null) return 'Creation';
  const was = memoryMeta(before).status;
  const now = memoryMeta(after).status;
  return now === 'deprecated' && was !== 'deprecated' ? 'Deprecation' : 'Update';
}
