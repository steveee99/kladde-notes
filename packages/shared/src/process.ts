/**
 * Guided development processes (part of the opt-in feature `cockpit`): a **process model** describes stages, the
 * steps in them and the ways between them; a **run** walks one piece of work (a feature, a bug) through a model.
 *
 * Both are hidden notes at the top of a space, as JSON in a fenced block (like cockpit dashboards):
 * - `_process-<uuid>.md` (`type: process`, block ```` ```process ````) holds a model;
 * - `_process-run-<uuid>.md` (`type: process-run`, block ```` ```process-run ````) holds a run.
 *
 * Single source of truth: a run only keeps references (URLs, the ticket key, repositories, the target branch),
 * decisions and the ids of finished steps. Whatever the sources say (Jira status, merge requests, branches, pipelines)
 * is read live through the cockpit's queries each time the run is shown; nothing is synced.
 *
 * Versions: a model counts its saves (`version`), every step remembers the version it came in (`since`). A running
 * run always follows the current model; a step added later to a stage the run already left shows as "to catch up"
 * when it is marked `retro`. Finishing a run (or a sub-workflow) stores a snapshot of its model in the run, so a
 * finished run keeps showing the process as it was.
 *
 * Stages are steps (`steps`), a decision between ways (`choice`, the picked value becomes a variable), a sub-workflow
 * (`sub`: another model of the same space runs inside, its end picks the way on) or an end (`end`). Any stage can
 * carry a condition (`when`) on an earlier variable; a stage whose condition fails is skipped.
 */
import { parseFrontmatter } from './markdown.js';
import { isCockpitSourceKind, normalizeWidget, type CockpitFilter, type CockpitParamValue, type CockpitSourceKind } from './cockpit.js';

// ------------------------------------------------------------------ notes

export const PROCESS_TYPE = 'process';
export const PROCESS_RUN_TYPE = 'process-run';
export const PROCESS_BLOCK = 'process';
export const PROCESS_RUN_BLOCK = 'process-run';

const MODEL_NAME = /^_process(?:-[0-9a-f][0-9a-f-]{7,})?\.md$/i;
const RUN_NAME = /^_process-run(?:-[0-9a-f][0-9a-f-]{7,})?\.md$/i;

export const processFileName = (id: string): string => `_process-${id}.md`;
export const processRunFileName = (id: string): string => `_process-run-${id}.md`;

const fileOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const isProcessModelPath = (path: string): boolean => fileOf(path)[0] === '_' && MODEL_NAME.test(fileOf(path)) && !RUN_NAME.test(fileOf(path));
export const isProcessRunPath = (path: string): boolean => fileOf(path)[0] === '_' && RUN_NAME.test(fileOf(path));
/** Model or run: kept out of lists, the tree, search and the graph */
export const isProcessPath = (path: string): boolean => isProcessModelPath(path) || isProcessRunPath(path);

// ------------------------------------------------------------------ model

export type ProcessConditionOp = 'eq' | 'ne' | 'set' | 'unset';
export const PROCESS_CONDITION_OPS: ProcessConditionOp[] = ['eq', 'ne', 'set', 'unset'];

/** A condition on a run variable (a decision made earlier, a link set earlier) */
export interface ProcessCondition {
  var: string;
  op: ProcessConditionOp;
  value: string;
}

export type ProcessStepKind = 'task' | 'link' | 'check' | 'branch' | 'mr';
export const PROCESS_STEP_KINDS: ProcessStepKind[] = ['task', 'link', 'check', 'branch', 'mr'];

export type ProcessLinkSource = 'jira' | 'confluence' | 'gitlab' | 'kladde' | 'web';
export const PROCESS_LINK_SOURCES: ProcessLinkSource[] = ['jira', 'confluence', 'gitlab', 'kladde', 'web'];

/** A cockpit query as a check: the rows of a source after the filters; `{{run.x}}` is filled from the run */
export interface ProcessQuery {
  source: CockpitSourceKind;
  params: Record<string, CockpitParamValue>;
  filters: CockpitFilter[];
}

export interface ProcessStep {
  id: string;
  kind: ProcessStepKind;
  label: string;
  hint: string;
  /** Model version the step came in */
  since: number;
  /** Added to a stage a running run already left: it still has to be done there (shown as "to catch up") */
  retro: boolean;
  /** link: the run variable the pasted URL goes to */
  var: string;
  /** link: where the page is made */
  source: ProcessLinkSource;
  /** link: where "Create" leads (may use `{{run.x}}`); empty: no button */
  createUrl: string;
  /** check: the query */
  query: ProcessQuery | null;
  /** check: met when the query finds rows (`any`) or none (`none`) */
  expect: 'any' | 'none';
  /** mr: the merge request of the run's branch into the target branch is open (or merged), or merged, in every repository */
  mrState: 'opened' | 'merged';
}

export type ProcessStageKind = 'steps' | 'choice' | 'sub' | 'end';

export interface ProcessOption {
  value: string;
  label: string;
  hint: string;
  to: string;
}

export interface ProcessTransition {
  to: string;
  label: string;
  /** Goes back to an earlier stage: its steps are open again */
  back: boolean;
  /** After a sub-workflow: taken when the sub-workflow ended with this end (empty: any end) */
  end: string;
}

export interface ProcessStage {
  id: string;
  title: string;
  description: string;
  kind: ProcessStageKind;
  /** Only when this holds; otherwise skipped */
  when: ProcessCondition | null;
  steps: ProcessStep[];
  /** choice: the variable the picked value goes to */
  var: string;
  options: ProcessOption[];
  /** sub: the key of the model that runs inside */
  process: string;
  /** sub: variables of the sub-workflow → variables of this run (empty: every variable the run does not have yet) */
  outputs: Record<string, string>;
  next: ProcessTransition[];
  /** end: the name of this end (a sub-workflow's caller picks its way by it) */
  end: string;
}

export interface ProcessModel {
  /** Stable name within its space; sub-workflows and runs refer to it */
  key: string;
  title: string;
  description: string;
  /** Counts the saves; steps remember the version they came in */
  version: number;
  /** First part of suggested branch names (`feature`, `bugfix`) */
  branchPrefix: string;
  /** Suggested branch name: `{{prefix}}`, `{{ticket}}`, `{{slug}}` (of the run's title) */
  branchPattern: string;
  start: string;
  stages: ProcessStage[];
}

export const PROCESS_LIMITS = { stages: 60, steps: 40, options: 8, next: 8, text: 400, label: 160 };
export const DEFAULT_BRANCH_PATTERN = '{{prefix}}/{{ticket}}-{{slug}}';

// ------------------------------------------------------------------ normalizing

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number = PROCESS_LIMITS.text): string => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const ID = /^[A-Za-z0-9_-]{1,60}$/;
const VAR = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const id = (v: unknown): string => (typeof v === 'string' && ID.test(v) ? v : '');
const varName = (v: unknown): string => (typeof v === 'string' && VAR.test(v) ? v : '');
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const intOf = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e6 ? v : fallback);

/** `s` without the characters of `chars` at both ends (a loop: no regex that backtracks on long runs) */
function trimChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

export function processKey(text: string): string {
  const dashed = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-');
  return trimChars(trimChars(dashed, '-').slice(0, 40), '-') || 'prozess';
}

function normalizeCondition(raw: unknown): ProcessCondition | null {
  const o = obj(raw);
  const v = varName(o?.var);
  if (!o || !v) return null;
  return { var: v, op: pick(o.op, PROCESS_CONDITION_OPS, 'eq'), value: clean(o.value, PROCESS_LIMITS.label) };
}

function normalizeQuery(raw: unknown): ProcessQuery | null {
  const o = obj(raw);
  if (!o || !isCockpitSourceKind(o.source)) return null;
  // The cockpit's own rules for parameters and filters
  const w = normalizeWidget({ title: 'check', source: { kind: o.source, params: o.params ?? {} }, filters: o.filters ?? [] });
  if (!w) return null;
  return { source: w.source.kind, params: w.source.params, filters: w.filters };
}

function normalizeStep(raw: unknown, fallbackSince: number): ProcessStep | null {
  const o = obj(raw);
  const sid = id(o?.id);
  const label = clean(o?.label, PROCESS_LIMITS.label);
  if (!o || !sid || !label) return null;
  const kind = pick(o.kind, PROCESS_STEP_KINDS, 'task');
  const step: ProcessStep = {
    id: sid,
    kind,
    label,
    hint: clean(o.hint),
    since: intOf(o.since, fallbackSince),
    retro: o.retro === true,
    var: varName(o.var),
    source: pick(o.source, PROCESS_LINK_SOURCES, 'web'),
    createUrl: clean(o.createUrl, 1000),
    query: normalizeQuery(o.query),
    expect: o.expect === 'none' ? 'none' : 'any',
    mrState: o.mrState === 'merged' ? 'merged' : 'opened',
  };
  if (kind === 'link' && !step.var) return null;
  if (kind === 'check' && !step.query) return null;
  return step;
}

function normalizeStage(raw: unknown, version: number): ProcessStage | null {
  const o = obj(raw);
  const sid = id(o?.id);
  if (!o || !sid) return null;
  const kind = pick(o.kind, ['steps', 'choice', 'sub', 'end'] as const, 'steps');
  const steps: ProcessStep[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(o.steps) ? o.steps.slice(0, PROCESS_LIMITS.steps) : []) {
    const step = normalizeStep(s, version);
    if (step && !seen.has(step.id)) {
      seen.add(step.id);
      steps.push(step);
    }
  }
  const options: ProcessOption[] = [];
  for (const r of Array.isArray(o.options) ? o.options.slice(0, PROCESS_LIMITS.options) : []) {
    const opt = obj(r);
    const value = clean(opt?.value, 60);
    const to = id(opt?.to);
    if (opt && value && to && !options.some((x) => x.value === value)) options.push({ value, label: clean(opt.label, PROCESS_LIMITS.label) || value, hint: clean(opt.hint), to });
  }
  const next: ProcessTransition[] = [];
  for (const r of Array.isArray(o.next) ? o.next.slice(0, PROCESS_LIMITS.next) : []) {
    const t = obj(r);
    const to = id(t?.to);
    if (t && to) next.push({ to, label: clean(t.label, PROCESS_LIMITS.label), back: t.back === true, end: clean(t.end, 60) });
  }
  const outputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(o.outputs) ?? {}).slice(0, 30)) if (varName(k) && varName(v)) outputs[k] = v as string;
  return {
    id: sid,
    title: clean(o.title, PROCESS_LIMITS.label) || sid,
    description: clean(o.description),
    kind,
    when: normalizeCondition(o.when),
    steps: kind === 'steps' ? steps : [],
    var: kind === 'choice' ? varName(o.var) || sid.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]/, 'v') : '',
    options: kind === 'choice' ? options : [],
    process: kind === 'sub' ? clean(o.process, 40) : '',
    outputs: kind === 'sub' ? outputs : {},
    next: kind === 'end' ? [] : next,
    end: kind === 'end' ? clean(o.end, 60) || sid : '',
  };
}

/** A model from untrusted JSON; ways to stages that do not exist are dropped */
export function normalizeProcess(raw: unknown): ProcessModel | null {
  const o = obj(raw);
  if (!o) return null;
  const version = Math.max(1, intOf(o.version, 1));
  const stages: ProcessStage[] = [];
  for (const s of Array.isArray(o.stages) ? o.stages.slice(0, PROCESS_LIMITS.stages) : []) {
    const st = normalizeStage(s, version);
    if (st && !stages.some((x) => x.id === st.id)) stages.push(st);
  }
  if (!stages.length) return null;
  const ids = new Set(stages.map((s) => s.id));
  for (const st of stages) {
    st.next = st.next.filter((t) => ids.has(t.to));
    st.options = st.options.filter((x) => ids.has(x.to));
  }
  const title = clean(o.title, PROCESS_LIMITS.label) || 'Prozess';
  const start = id(o.start);
  return {
    key: processKey(clean(o.key, 40) || title),
    title,
    description: clean(o.description),
    version,
    branchPrefix: clean(o.branchPrefix, 40).replace(/[^A-Za-z0-9._-]/g, '') || 'feature',
    branchPattern: clean(o.branchPattern, 200) || DEFAULT_BRANCH_PATTERN,
    start: ids.has(start) ? start : stages[0].id,
    stages,
  };
}

/**
 * The model to save after an edit: the version goes up when anything changed, and every step that is new (by stage
 * and step id) gets the new version as `since`; steps that were there keep theirs.
 */
export function nextProcessVersion(before: ProcessModel | null, edited: ProcessModel): ProcessModel {
  const next = normalizeProcess(JSON.parse(JSON.stringify(edited)))!;
  if (!before) {
    for (const st of next.stages) for (const s of st.steps) s.since = next.version;
    return next;
  }
  const old = new Map<string, ProcessStep>();
  for (const st of before.stages) for (const s of st.steps) old.set(`${st.id}/${s.id}`, s);
  const strip = (m: ProcessModel) => JSON.stringify({ ...m, version: 0, stages: m.stages.map((st) => ({ ...st, steps: st.steps.map((s) => ({ ...s, since: 0 })) })) });
  if (strip(before) === strip(next)) return { ...next, version: before.version, stages: before.stages };
  const version = before.version + 1;
  for (const st of next.stages) for (const s of st.steps) s.since = old.get(`${st.id}/${s.id}`)?.since ?? version;
  return { ...next, version };
}

const block = (name: string) => new RegExp(`^(\`{3,}|~{3,})[ \\t]*${name}[ \\t]*\\n([\\s\\S]*?)\\n\\1[ \\t]*$`, 'm');
const MODEL_BLOCK_RE = block(PROCESS_BLOCK);
const RUN_BLOCK_RE = block(PROCESS_RUN_BLOCK);

function readBlock(content: string, type: string, re: RegExp): unknown {
  const { data, body } = parseFrontmatter(content);
  if (data.type && data.type !== type) return null;
  const m = re.exec(body);
  if (!m) return null;
  try {
    return JSON.parse(m[2]);
  } catch {
    return null;
  }
}

export function parseProcessNote(content: string): ProcessModel | null {
  return normalizeProcess(readBlock(content, PROCESS_TYPE, MODEL_BLOCK_RE));
}

export function serializeProcess(m: ProcessModel): string {
  return `---\ntype: ${PROCESS_TYPE}\n---\n\n\`\`\`${PROCESS_BLOCK}\n${JSON.stringify(normalizeProcess(m), null, 2)}\n\`\`\`\n`;
}

// ------------------------------------------------------------------ runs

export interface ProcessHistoryEntry {
  stage: string;
  at: number;
  by: string;
  /** choice: the picked value */
  pick?: string;
  /** The stage's condition failed: it was passed over */
  skipped?: boolean;
  /** Left through a way back */
  back?: boolean;
  /** Went on although steps were open */
  forced?: boolean;
  /** sub: the end the sub-workflow reached */
  subEnd?: string;
}

/** The part a run and a sub-workflow inside it share */
export interface ProcessRunNode {
  /** Key of the model */
  model: string;
  state: 'running' | 'done';
  /** Model version when the node started */
  started: number;
  /** Model version whose changes the user has seen */
  seen: number;
  stage: string;
  vars: Record<string, string>;
  /** Finished steps (tasks, links; checks when the stage was left) */
  done: string[];
  hist: ProcessHistoryEntry[];
  /** The end reached (finished nodes) */
  end?: string;
  /** The model as it was when the node finished; a finished node is shown with it */
  snapshot?: ProcessModel;
  /** The running sub-workflow */
  child?: ProcessRunNode;
  /** Finished sub-workflows, oldest first */
  children: ProcessRunNode[];
}

export interface ProcessRun extends ProcessRunNode {
  title: string;
  /** Jira key or other ticket id (part of the branch name) */
  ticket: string;
  /** The branch the work goes into */
  target: string;
  /** GitLab repositories (`group/project`) the work touches */
  repos: string[];
  /** The work's branch (suggested from the model's pattern, can be changed) */
  branch: string;
  owner: string;
  createdAt: number;
  closedAt?: number;
}

const strList = (v: unknown, max: number, len: number): string[] => (Array.isArray(v) ? v.map((x) => clean(x, len)).filter(Boolean).slice(0, max) : []);

function normalizeHist(raw: unknown): ProcessHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-500).flatMap((r): ProcessHistoryEntry[] => {
    const o = obj(r);
    const stage = id(o?.stage);
    if (!o || !stage) return [];
    const e: ProcessHistoryEntry = { stage, at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0, by: clean(o.by, 80) };
    if (typeof o.pick === 'string') e.pick = clean(o.pick, 60);
    if (o.skipped === true) e.skipped = true;
    if (o.back === true) e.back = true;
    if (o.forced === true) e.forced = true;
    if (typeof o.subEnd === 'string') e.subEnd = clean(o.subEnd, 60);
    return [e];
  });
}

function normalizeNode(o: Obj, depth: number): ProcessRunNode | null {
  const model = processKey(clean(o.model, 40));
  const stage = id(o.stage);
  if (!stage) return null;
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(o.vars) ?? {}).slice(0, 80)) if (varName(k) && typeof v === 'string') vars[k] = clean(v, 1000);
  const node: ProcessRunNode = {
    model,
    state: o.state === 'done' ? 'done' : 'running',
    started: Math.max(1, intOf(o.started, 1)),
    seen: Math.max(1, intOf(o.seen, intOf(o.started, 1))),
    stage,
    vars,
    done: strList(o.done, 500, 60).filter((s) => ID.test(s)),
    hist: normalizeHist(o.hist),
    children: [],
  };
  if (typeof o.end === 'string') node.end = clean(o.end, 60);
  const snap = o.snapshot ? normalizeProcess(o.snapshot) : null;
  if (snap) node.snapshot = snap;
  if (depth < 3) {
    const child = obj(o.child) && normalizeNode(obj(o.child)!, depth + 1);
    if (child) node.child = child;
    for (const c of Array.isArray(o.children) ? o.children.slice(-20) : []) {
      const n = obj(c) && normalizeNode(obj(c)!, depth + 1);
      if (n) node.children.push(n);
    }
  }
  return node;
}

export function normalizeRun(raw: unknown): ProcessRun | null {
  const o = obj(raw);
  const node = o && normalizeNode(o, 0);
  if (!o || !node) return null;
  const run: ProcessRun = {
    ...node,
    title: clean(o.title, PROCESS_LIMITS.label) || 'Lauf',
    ticket: clean(o.ticket, 60),
    target: cleanBranch(clean(o.target, 200)),
    repos: strList(o.repos, 30, 250).filter((r) => /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(r) && !r.includes('..')),
    branch: cleanBranch(clean(o.branch, 200)),
    owner: clean(o.owner, 80),
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
  if (typeof o.closedAt === 'number') run.closedAt = o.closedAt;
  return run;
}

export function parseRunNote(content: string): ProcessRun | null {
  return normalizeRun(readBlock(content, PROCESS_RUN_TYPE, RUN_BLOCK_RE));
}

export function serializeRun(r: ProcessRun): string {
  return `---\ntype: ${PROCESS_RUN_TYPE}\n---\n\n\`\`\`${PROCESS_RUN_BLOCK}\n${JSON.stringify(normalizeRun(r), null, 2)}\n\`\`\`\n`;
}

// ------------------------------------------------------------------ branches

/** A name git accepts as a branch: allowed characters only, no `..`, no leading or trailing `/` or `.` */
export function cleanBranch(name: string): string {
  const collapsed = name
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-');
  const trimmed = trimChars(collapsed, '/.-');
  return trimChars((trimmed.toLowerCase().endsWith('.lock') ? trimmed.slice(0, -5) : trimmed).slice(0, 120), '/.-');
}

export function branchSlug(title: string, max = 40): string {
  const s = processKey(title);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf('-');
  return at > 0 ? cut.slice(0, at) : cut;
}

/** The branch name the model suggests for a run */
export function suggestBranch(model: Pick<ProcessModel, 'branchPrefix' | 'branchPattern'>, run: { ticket: string; title: string }): string {
  const name = (model.branchPattern || DEFAULT_BRANCH_PATTERN)
    .replace(/\{\{\s*prefix\s*\}\}/g, model.branchPrefix)
    .replace(/\{\{\s*ticket\s*\}\}/g, run.ticket.trim())
    .replace(/\{\{\s*slug\s*\}\}/g, branchSlug(run.title));
  // An empty part leaves "feature/-titel" or "feature/ABC-1-": tidy the joints
  return cleanBranch(
    cleanBranch(name)
      .split('/')
      .map((part) => trimChars(part, '-'))
      .join('/')
  );
}

const trimEnd = (url: string): string => {
  let b = url.length;
  while (b > 0 && url[b - 1] === '/') b--;
  return url.slice(0, b);
};

/** Where GitLab makes a branch from `ref`, prefilled */
export function newBranchUrl(gitlabUrl: string, repo: string, branch: string, ref: string): string {
  return `${trimEnd(gitlabUrl)}/${repo.split('/').map(encodeURIComponent).join('/')}/-/branches/new?branch_name=${encodeURIComponent(branch)}&ref=${encodeURIComponent(ref)}`;
}

/** Where GitLab opens a merge request from `branch` into `target`, prefilled */
export function newMergeRequestUrl(gitlabUrl: string, repo: string, branch: string, target: string): string {
  return `${trimEnd(gitlabUrl)}/${repo.split('/').map(encodeURIComponent).join('/')}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(target)}`;
}

// ------------------------------------------------------------------ variables

/**
 * The variables of a run node as `{{run.x}}` sees them: the run's own fields (`title`, `ticket`, `target`, `branch`,
 * `repos`), its variables and, inside a sub-workflow, `nested` and the sub-workflow's own variables.
 */
export function runVars(run: ProcessRun, node: ProcessRunNode = run): Record<string, string> {
  const own = { title: run.title, ticket: run.ticket, target: run.target, branch: run.branch, repos: run.repos.join(',') };
  // `nested` tells a sub-workflow's conditions that it runs inside another process
  return node === run ? { ...own, ...run.vars } : { ...own, ...run.vars, nested: 'ja', ...node.vars };
}

const RUN_VAR = /\{\{\s*run\.([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;

/** Fills `{{run.x}}` (missing ones are named in `missing`) */
export function fillRunVars(text: string, vars: Record<string, string>, missing?: Set<string>): string {
  return text.replace(RUN_VAR, (_, name: string) => {
    const v = vars[name];
    if (!v) missing?.add(name);
    return v ?? '';
  });
}

/**
 * A check's query with the run's values: `{{run.x}}` in parameters and filter values. A list parameter that is just
 * `{{run.repos}}` becomes the run's repositories.
 */
export function fillQuery(q: ProcessQuery, vars: Record<string, string>): { query: ProcessQuery; missing: string[] } {
  const missing = new Set<string>();
  const params: Record<string, CockpitParamValue> = {};
  for (const [k, v] of Object.entries(q.params)) {
    if (typeof v === 'string') params[k] = fillRunVars(v, vars, missing);
    else if (Array.isArray(v)) params[k] = v.flatMap((x) => (/^\{\{\s*run\.repos\s*\}\}$/.test(x) ? (vars.repos ? vars.repos.split(',') : (missing.add('repos'), [])) : [fillRunVars(x, vars, missing)])).filter(Boolean);
    else params[k] = v;
  }
  const filters = q.filters.map((f) => ({ ...f, value: fillRunVars(f.value, vars, missing) }));
  return { query: { source: q.source, params, filters }, missing: [...missing] };
}

export function checkCondition(c: ProcessCondition, vars: Record<string, string>): boolean | null {
  const v = vars[c.var] ?? '';
  if (c.op === 'set') return v !== '';
  if (c.op === 'unset') return v === '';
  if (v === '') return null;
  return c.op === 'eq' ? v === c.value : v !== c.value;
}

export function conditionText(c: ProcessCondition, lang: 'de' | 'en' = 'de'): string {
  if (c.op === 'set') return `${c.var} ${lang === 'de' ? 'gesetzt' : 'set'}`;
  if (c.op === 'unset') return `${c.var} ${lang === 'de' ? 'leer' : 'empty'}`;
  return `${c.var} ${c.op === 'eq' ? '=' : '≠'} ${c.value}`;
}

// ------------------------------------------------------------------ walking

export const stageOf = (m: ProcessModel, stageId: string): ProcessStage | undefined => m.stages.find((s) => s.id === stageId);
/** The way on from a stage (not back, not bound to a sub-workflow's end) */
export const forwardOf = (st: ProcessStage): ProcessTransition | undefined => st.next.find((t) => !t.back && !t.end) ?? st.next.find((t) => !t.back);

/** Where a way to `to` lands: stages whose condition fails are passed over */
export function resolveStage(m: ProcessModel, vars: Record<string, string>, to: string): { to: string; skipped: string[] } {
  const skipped: string[] = [];
  let at = to;
  for (let guard = 0; guard < PROCESS_LIMITS.stages; guard++) {
    const st = stageOf(m, at);
    if (!st || !st.when || checkCondition(st.when, vars) !== false) break;
    const fwd = st.kind === 'choice' ? (st.options[0] ? { to: st.options[0].to } : undefined) : forwardOf(st);
    if (!fwd || skipped.includes(at)) break;
    skipped.push(at);
    at = fwd.to;
  }
  return { to: at, skipped };
}

export type PredictedStage = { id: string; skipped?: boolean; maybe?: boolean } | { open: 'choice' | 'sub' };

/** The stages still ahead of a node, as far as its variables tell (`vars`: `runVars` of the node) */
export function predictStages(m: ProcessModel, node: ProcessRunNode, vars: Record<string, string> = node.vars): PredictedStage[] {
  const out: PredictedStage[] = [];
  const seen = new Set<string>([node.stage]);
  let at = node.stage;
  for (let guard = 0; guard < PROCESS_LIMITS.stages; guard++) {
    const st = stageOf(m, at);
    if (!st || st.kind === 'end') break;
    let to: string | undefined;
    if (st.kind === 'choice') {
      const targets = [...new Set(st.options.map((o) => o.to))];
      const picked = vars[st.var];
      if (targets.length === 1) to = targets[0];
      else if (picked) to = st.options.find((o) => o.value === picked)?.to;
      if (!to) {
        out.push({ open: 'choice' });
        break;
      }
    } else if (st.kind === 'sub') {
      const ends = new Set(st.next.filter((t) => !t.back).map((t) => t.to));
      if (ends.size !== 1) {
        out.push({ open: 'sub' });
        break;
      }
      to = [...ends][0];
    } else to = forwardOf(st)?.to;
    if (!to) break;
    for (let g = 0; g < PROCESS_LIMITS.stages; g++) {
      const t = stageOf(m, to);
      if (!t) break;
      const ok = t.when ? checkCondition(t.when, vars) : true;
      if (ok === false) {
        out.push({ id: to, skipped: true });
        const f = t.kind === 'choice' ? t.options[0]?.to : forwardOf(t)?.to;
        if (!f) break;
        to = f;
        continue;
      }
      out.push(ok === null ? { id: to, maybe: true } : { id: to });
      break;
    }
    if (!to || seen.has(to)) break;
    seen.add(to);
    at = to;
  }
  return out;
}

/** Stages the node went through (not the skipped ones) */
export const passedStages = (node: ProcessRunNode): Set<string> => new Set(node.hist.filter((h) => !h.skipped).map((h) => h.stage));

/** Steps added later to stages the node already left that still have to be done */
export function catchUpSteps(m: ProcessModel, node: ProcessRunNode): { stage: ProcessStage; step: ProcessStep }[] {
  if (node.state !== 'running') return [];
  const passed = passedStages(node);
  const out: { stage: ProcessStage; step: ProcessStep }[] = [];
  for (const st of m.stages) {
    if (!passed.has(st.id) || st.id === node.stage) continue;
    for (const s of st.steps) if (s.retro && s.since > node.started && !node.done.includes(s.id)) out.push({ stage: st, step: s });
  }
  return out;
}

/** Steps that came in after the version the user has seen */
export function changedSteps(m: ProcessModel, node: ProcessRunNode): { stage: ProcessStage; step: ProcessStep }[] {
  if (node.state !== 'running' || m.version <= node.seen) return [];
  return m.stages.flatMap((st) => st.steps.filter((s) => s.since > node.seen).map((step) => ({ stage: st, step })));
}

/** The models a node is shown with: its snapshot when finished, otherwise the current one by key */
export function modelFor(node: ProcessRunNode, models: ReadonlyMap<string, ProcessModel>): ProcessModel | null {
  return node.snapshot ?? models.get(node.model) ?? null;
}

/** The node the user works in: the running sub-workflow, if the run is inside one */
export function activeNode(run: ProcessRun): ProcessRunNode {
  let n: ProcessRunNode = run;
  for (let d = 0; d < 3 && n.child && n.child.state === 'running'; d++) n = n.child;
  return n;
}

/** The node that holds `child` (the run itself for its direct sub-workflow) */
function parentOf(run: ProcessRun, child: ProcessRunNode): ProcessRunNode | null {
  let n: ProcessRunNode = run;
  for (let d = 0; d < 3 && n.child; d++) {
    if (n.child === child) return n;
    n = n.child;
  }
  return null;
}

export interface StepInput {
  by: string;
  now: number;
}

export type ProcessError = 'no_model' | 'no_stage' | 'no_way' | 'no_choice' | 'not_running';

export class ProcessMoveError extends Error {
  constructor(readonly problem: ProcessError) {
    super(problem);
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Finds the node in a cloned run that matches the path of `node` in the original */
function sameNode(original: ProcessRun, copy: ProcessRun, node: ProcessRunNode): ProcessRunNode {
  let a: ProcessRunNode = original;
  let b: ProcessRunNode = copy;
  for (let d = 0; d < 3 && a !== node && a.child && b.child; d++) {
    a = a.child;
    b = b.child;
  }
  return b;
}

/** Steps of a stage (and the reopened stages) are open again after going back */
function reopen(m: ProcessModel, node: ProcessRunNode, stageIds: string[]): void {
  const ids = new Set(m.stages.filter((s) => stageIds.includes(s.id)).flatMap((s) => s.steps.filter((x) => x.kind !== 'link').map((x) => x.id)));
  node.done = node.done.filter((d) => !ids.has(d));
}

/**
 * Enters `to` in `node`: skipped stages go into the history, a sub-workflow starts its own node, the end of a
 * sub-workflow finishes it and moves its caller on.
 */
function enter(run: ProcessRun, node: ProcessRunNode, to: string, models: ReadonlyMap<string, ProcessModel>, input: StepInput): void {
  const m = modelFor(node, models);
  if (!m) throw new ProcessMoveError('no_model');
  const vars = runVars(run, node);
  const { to: landed, skipped } = resolveStage(m, vars, to);
  for (const s of skipped) node.hist.push({ stage: s, at: input.now, by: input.by, skipped: true });
  node.stage = landed;
  const st = stageOf(m, landed);
  if (!st) throw new ProcessMoveError('no_stage');
  // A decision reached again (after a way back) is made again
  if (st.kind === 'choice') delete node.vars[st.var];
  if (st.kind === 'sub') {
    const sub = models.get(st.process);
    if (!sub) throw new ProcessMoveError('no_model');
    const child: ProcessRunNode = { model: sub.key, state: 'running', started: sub.version, seen: sub.version, stage: sub.start, vars: {}, done: [], hist: [], children: [] };
    node.child = child;
    enter(run, child, sub.start, models, input);
    return;
  }
  if (st.kind === 'end' && node !== run) {
    // A sub-workflow reached an end: freeze it, hand its variables to the caller, go on there
    node.hist.push({ stage: st.id, at: input.now, by: input.by });
    node.state = 'done';
    node.end = st.end;
    node.snapshot = clone(m);
    const parent = parentOf(run, node);
    if (!parent) return;
    const pm = modelFor(parent, models);
    const pst = pm && stageOf(pm, parent.stage);
    if (!pm || !pst) throw new ProcessMoveError('no_stage');
    const outputs = Object.keys(pst.outputs).length ? pst.outputs : Object.fromEntries(Object.keys(node.vars).filter((k) => !(k in parent.vars)).map((k) => [k, k]));
    for (const [from, toVar] of Object.entries(outputs)) if (node.vars[from]) parent.vars[toVar] = node.vars[from];
    parent.hist.push({ stage: pst.id, at: input.now, by: input.by, subEnd: st.end });
    parent.children.push(node);
    delete parent.child;
    const way = pst.next.find((t) => t.end === st.end) ?? pst.next.find((t) => !t.end && !t.back) ?? pst.next[0];
    if (!way) throw new ProcessMoveError('no_way');
    if (way.back) reopen(pm, parent, [way.to]);
    enter(run, parent, way.to, models, input);
  }
}

/** Open steps of the node's stage that `done` (including passing checks) does not cover */
export function openSteps(st: ProcessStage, done: ReadonlySet<string>): ProcessStep[] {
  return st.steps.filter((s) => !done.has(s.id));
}

/**
 * Moves the active node on: through the stage's way forward, the picked option of a decision, or a way back
 * (`back` is the target stage). `passing` are the ids of checks that are met right now (they are stored as done).
 */
export function advanceRun(
  run: ProcessRun,
  models: ReadonlyMap<string, ProcessModel>,
  move: { back?: string; forced?: boolean; passing?: string[] },
  input: StepInput
): ProcessRun {
  if (run.state !== 'running') throw new ProcessMoveError('not_running');
  const copy = clone(run);
  const node = sameNode(run, copy, activeNode(run));
  const m = modelFor(node, models);
  if (!m) throw new ProcessMoveError('no_model');
  const st = stageOf(m, node.stage);
  if (!st) throw new ProcessMoveError('no_stage');
  const entry: ProcessHistoryEntry = { stage: st.id, at: input.now, by: input.by };
  for (const p of move.passing ?? []) if (!node.done.includes(p)) node.done.push(p);
  let to: string | undefined;
  if (move.back) {
    const way = st.next.find((t) => t.back && t.to === move.back);
    if (!way) throw new ProcessMoveError('no_way');
    to = way.to;
    entry.back = true;
  } else if (st.kind === 'choice') {
    const value = node.vars[st.var];
    const opt = st.options.find((o) => o.value === value);
    if (!opt) throw new ProcessMoveError('no_choice');
    entry.pick = opt.value;
    to = opt.to;
  } else if (st.kind === 'end' || st.kind === 'sub') {
    throw new ProcessMoveError('no_way');
  } else {
    to = forwardOf(st)?.to;
    if (!to) throw new ProcessMoveError('no_way');
    if (move.forced && openSteps(st, new Set(node.done)).length) entry.forced = true;
  }
  node.hist.push(entry);
  if (move.back) reopen(m, node, [to, st.id]);
  enter(copy, node, to, models, input);
  return copy;
}

/** Picks a decision's option (the variable is set; `advanceRun` then takes the way) */
export function pickOption(run: ProcessRun, models: ReadonlyMap<string, ProcessModel>, value: string): ProcessRun {
  const copy = clone(run);
  const node = sameNode(run, copy, activeNode(run));
  const m = modelFor(node, models);
  const st = m && stageOf(m, node.stage);
  if (!st || st.kind !== 'choice' || !st.options.some((o) => o.value === value)) throw new ProcessMoveError('no_choice');
  node.vars[st.var] = value;
  return copy;
}

/** Sets a step's state or a link's value in the active node (or the run itself for a step to catch up) */
export function setStep(run: ProcessRun, models: ReadonlyMap<string, ProcessModel>, stepId: string, change: { done: boolean; value?: string }): ProcessRun {
  const copy = clone(run);
  const active = sameNode(run, copy, activeNode(run));
  for (let n: ProcessRunNode | undefined = active; n; n = n === copy ? undefined : (parentOf(copy, n) ?? undefined)) {
    const m = modelFor(n, models);
    const step = m?.stages.flatMap((s) => s.steps).find((s) => s.id === stepId);
    if (!step) continue;
    if (step.kind === 'link') {
      const value = (change.value ?? '').trim();
      if (change.done && value) n.vars[step.var] = value.slice(0, 1000);
      else delete n.vars[step.var];
    }
    n.done = n.done.filter((d) => d !== stepId);
    if (change.done && (step.kind !== 'link' || n.vars[step.var])) n.done.push(stepId);
    return copy;
  }
  return copy;
}

/** Marks the latest model changes as seen in the active node and the run */
export function markSeen(run: ProcessRun, models: ReadonlyMap<string, ProcessModel>): ProcessRun {
  const copy = clone(run);
  for (let n: ProcessRunNode | undefined = copy; n; n = n.child) {
    const m = models.get(n.model);
    if (m && n.state === 'running') n.seen = m.version;
  }
  return copy;
}

/** Puts a run whose stage is gone from the model onto a stage of the user's choice */
export function moveToStage(run: ProcessRun, models: ReadonlyMap<string, ProcessModel>, stageId: string, input: StepInput): ProcessRun {
  const copy = clone(run);
  const node = sameNode(run, copy, activeNode(run));
  const m = modelFor(node, models);
  if (!m || !stageOf(m, stageId)) throw new ProcessMoveError('no_stage');
  enter(copy, node, stageId, models, input);
  return copy;
}

/** Finishes a run at an end stage: it keeps its model from now on */
export function closeRun(run: ProcessRun, models: ReadonlyMap<string, ProcessModel>, input: StepInput): ProcessRun {
  const m = models.get(run.model);
  const st = m && stageOf(m, run.stage);
  if (!m || !st || st.kind !== 'end' || run.state !== 'running') throw new ProcessMoveError('no_way');
  const copy = clone(run);
  copy.hist.push({ stage: st.id, at: input.now, by: input.by });
  copy.state = 'done';
  copy.end = st.end;
  copy.snapshot = clone(m);
  copy.seen = m.version;
  copy.closedAt = input.now;
  return copy;
}

/** A new run at the model's first stage */
export function startRun(
  model: ProcessModel,
  models: ReadonlyMap<string, ProcessModel>,
  init: { title: string; ticket: string; target: string; repos: string[]; branch?: string },
  input: StepInput
): ProcessRun {
  const run: ProcessRun = {
    model: model.key,
    state: 'running',
    started: model.version,
    seen: model.version,
    stage: model.start,
    vars: {},
    done: [],
    hist: [],
    children: [],
    title: init.title.trim().slice(0, PROCESS_LIMITS.label) || model.title,
    ticket: init.ticket.trim().slice(0, 60),
    target: cleanBranch(init.target.trim()),
    repos: [...new Set(init.repos.map((r) => r.trim()).filter(Boolean))].slice(0, 30),
    branch: '',
    owner: input.by,
    createdAt: input.now,
  };
  run.branch = cleanBranch(init.branch?.trim() || suggestBranch(model, run));
  const all = new Map(models);
  all.set(model.key, model);
  enter(run, run, model.start, all, input);
  return normalizeRun(run)!;
}

// ------------------------------------------------------------------ examples

type Lang = 'de' | 'en';

function step(lang: Lang, s: Partial<ProcessStep> & { id: string; kind: ProcessStepKind; de: string; en: string; hintDe?: string; hintEn?: string }): Partial<ProcessStep> {
  const { de, en, hintDe, hintEn, ...rest } = s;
  return { ...rest, label: lang === 'de' ? de : en, hint: (lang === 'de' ? hintDe : hintEn) ?? '' };
}

/** The example models a new account gets: a waterfall development and a bug fix (which the waterfall calls when a test fails) */
export function exampleProcesses(lang: Lang = 'de'): ProcessModel[] {
  const L = (de: string, en: string) => (lang === 'de' ? de : en);
  const ticketJql = 'key = "{{run.ticket}}"';
  const waterfall = normalizeProcess({
    key: 'wasserfall',
    title: L('Wasserfall-Entwicklung', 'Waterfall development'),
    description: L(
      'Anforderung, Konzept, Design, Umsetzung, Test, Abnahme und Release nacheinander. Schlägt der Test fehl, läuft eine Fehlerbehebung als Sub-Workflow.',
      'Requirement, concept, design, implementation, test, acceptance and release in order. When the test fails, a bug fix runs as a sub-workflow.'
    ),
    version: 1,
    branchPrefix: 'feature',
    branchPattern: DEFAULT_BRANCH_PATTERN,
    start: 'anforderung',
    stages: [
      {
        id: 'anforderung',
        title: L('Anforderung', 'Requirement'),
        description: L('Die Anforderung steht als Ticket in Jira. Kladde merkt sich nur den Link.', 'The requirement is a Jira ticket. Kladde only keeps the link.'),
        steps: [
          step(lang, { id: 'a1', kind: 'link', de: 'Anforderung in Jira verlinken', en: 'Link the requirement in Jira', var: 'anforderung', source: 'jira' }),
          step(lang, {
            id: 'a2',
            kind: 'check',
            de: 'Ticket ist eingeplant',
            en: 'Ticket is planned',
            hintDe: 'Jira: Status nicht mehr „To Do“',
            hintEn: 'Jira: status no longer “To Do”',
            query: { source: 'jira.issues', params: { jql: `${ticketJql} AND statusCategory != "To Do"` }, filters: [] },
            expect: 'any',
          }),
        ],
        next: [{ to: 'konzept' }],
      },
      {
        id: 'konzept',
        title: L('Konzept', 'Concept'),
        description: L('Das Konzept entsteht in Confluence. Hier nur die fertige Seite verlinken.', 'The concept is written in Confluence. Link the finished page here.'),
        steps: [
          step(lang, { id: 'k1', kind: 'link', de: 'Konzeptseite verlinken', en: 'Link the concept page', var: 'konzept', source: 'confluence' }),
          step(lang, { id: 'k2', kind: 'task', de: 'Konzept vom Fachbereich abgenommen', en: 'Concept approved by the business side' }),
        ],
        next: [{ to: 'design' }],
      },
      {
        id: 'design',
        title: L('Design', 'Design'),
        description: L('Oberfläche und technischer Entwurf. Das Ergebnis liegt dort, wo es gepflegt wird.', 'User interface and technical design. The result lives where it is maintained.'),
        steps: [
          step(lang, { id: 'd1', kind: 'link', de: 'Design verlinken (Figma, Confluence …)', en: 'Link the design (Figma, Confluence …)', var: 'design', source: 'web' }),
          step(lang, { id: 'd2', kind: 'task', de: 'Design-Review durchgeführt', en: 'Design review held' }),
        ],
        next: [{ to: 'umsetzung' }, { to: 'konzept', back: true, label: L('Zurück zum Konzept', 'Back to the concept') }],
      },
      {
        id: 'umsetzung',
        title: L('Umsetzung', 'Implementation'),
        description: L('Der Branch geht vom Ziel-Branch ab, in jedem betroffenen Repository.', 'The branch starts from the target branch, in every affected repository.'),
        steps: [
          step(lang, { id: 'u1', kind: 'branch', de: 'Branch in allen Repositories angelegt', en: 'Branch created in every repository' }),
          step(lang, { id: 'u2', kind: 'mr', de: 'Merge Request je Repository geöffnet', en: 'Merge request opened in every repository', mrState: 'opened' }),
        ],
        next: [{ to: 'test' }],
      },
      {
        id: 'test',
        title: L('Test', 'Test'),
        description: L('Das Testprotokoll entsteht im Testwerkzeug oder in Confluence. Die Pipelines des Branches müssen grün sein.', 'The test report lives in the test tool or in Confluence. The branch’s pipelines must be green.'),
        steps: [
          step(lang, { id: 't1', kind: 'link', de: 'Testprotokoll verlinken', en: 'Link the test report', var: 'testprotokoll', source: 'confluence' }),
          step(lang, {
            id: 't2',
            kind: 'check',
            de: 'Keine roten CI-Jobs auf dem Branch',
            en: 'No red CI jobs on the branch',
            hintDe: 'GitLab: letzte Läufe der letzten 7 Tage',
            hintEn: 'GitLab: latest runs of the last 7 days',
            query: { source: 'gitlab.jobs', params: { projects: ['{{run.repos}}'], ref: '{{run.branch}}', since: '7d', latestOnly: true }, filters: [] },
            expect: 'none',
          }),
        ],
        next: [{ to: 'testergebnis' }],
      },
      {
        id: 'testergebnis',
        kind: 'choice',
        title: L('Testergebnis', 'Test result'),
        description: L('Bestanden geht es zur Abnahme. Gefundene Fehler laufen durch die Fehlerbehebung und danach zurück in den Test.', 'Passed goes on to acceptance. Bugs found go through the bug fix and then back to the test.'),
        var: 'testergebnis',
        options: [
          { value: 'bestanden', label: L('Bestanden', 'Passed'), hint: L('Weiter zur Abnahme', 'On to acceptance'), to: 'abnahme' },
          { value: 'fehler', label: L('Fehler gefunden', 'Bugs found'), hint: L('Fehlerbehebung als Sub-Workflow', 'Bug fix as a sub-workflow'), to: 'fehler' },
        ],
      },
      {
        id: 'fehler',
        kind: 'sub',
        title: L('Fehlerbehebung', 'Bug fix'),
        description: L('Läuft als eigener Workflow „Fehlerbehebung“. Danach wird erneut getestet.', 'Runs as its own workflow “Bug fix”. The test runs again afterwards.'),
        process: 'fehlerbehebung',
        outputs: { bug: 'fehlerticket' },
        next: [{ to: 'test', back: true, label: L('Erneut testen', 'Test again') }],
      },
      {
        id: 'abnahme',
        title: L('Abnahme', 'Acceptance'),
        description: L('Der Fachbereich nimmt das Ergebnis ab.', 'The business side accepts the result.'),
        steps: [
          step(lang, { id: 'n1', kind: 'link', de: 'Abnahmeprotokoll verlinken', en: 'Link the acceptance record', var: 'abnahme', source: 'confluence' }),
          step(lang, { id: 'n2', kind: 'task', de: 'Abnahme durch den Fachbereich', en: 'Accepted by the business side' }),
        ],
        next: [{ to: 'release' }, { to: 'umsetzung', back: true, label: L('Nacharbeit nötig', 'Rework needed') }],
      },
      {
        id: 'release',
        title: L('Release', 'Release'),
        description: L('Gemergt in den Ziel-Branch, Release Notes in Confluence.', 'Merged into the target branch, release notes in Confluence.'),
        steps: [
          step(lang, { id: 'r1', kind: 'mr', de: 'Merge Requests gemergt', en: 'Merge requests merged', mrState: 'merged' }),
          step(lang, { id: 'r2', kind: 'link', de: 'Release Notes verlinken', en: 'Link the release notes', var: 'releasenotes', source: 'confluence' }),
        ],
        next: [{ to: 'ende' }],
      },
      { id: 'ende', kind: 'end', title: L('Abgeschlossen', 'Done'), description: L('Alle Verweise sind beisammen.', 'All references are in one place.'), end: 'fertig' },
    ],
  })!;
  const bugfix = normalizeProcess({
    key: 'fehlerbehebung',
    title: L('Fehlerbehebung', 'Bug fix'),
    description: L(
      'Bug anlegen, umsetzen, abnehmen. Kritische Fehler brauchen eine Hotfix-Freigabe. Läuft allein oder als Sub-Workflow im Test der Wasserfall-Entwicklung.',
      'Create the bug, fix it, accept it. Critical bugs need a hotfix approval. Runs on its own or as a sub-workflow in the waterfall’s test.'
    ),
    version: 1,
    branchPrefix: 'bugfix',
    branchPattern: DEFAULT_BRANCH_PATTERN,
    start: 'bug',
    stages: [
      {
        id: 'bug',
        title: L('Bug angelegt', 'Bug created'),
        description: L('Der Fehler steht als Bug in Jira, mit Schritten zum Nachstellen.', 'The bug is a Jira issue with steps to reproduce.'),
        steps: [
          step(lang, { id: 'b1', kind: 'link', de: 'Bug in Jira verlinken', en: 'Link the bug in Jira', var: 'bug', source: 'jira' }),
          step(lang, { id: 'b2', kind: 'task', de: 'Fehler nachgestellt', en: 'Bug reproduced' }),
        ],
        next: [{ to: 'schwere' }],
      },
      {
        id: 'schwere',
        kind: 'choice',
        title: L('Schwere', 'Severity'),
        description: L('Die Wahl verzweigt nicht. Sie entscheidet, ob vor der Abnahme eine Hotfix-Freigabe nötig ist.', 'The choice does not branch. It decides whether a hotfix approval is needed before acceptance.'),
        var: 'schwere',
        options: [
          { value: 'normal', label: L('Normal', 'Normal'), hint: L('Regulär mit dem nächsten Release', 'With the next regular release'), to: 'umsetzung' },
          { value: 'kritisch', label: L('Kritisch', 'Critical'), hint: L('Hotfix mit Freigabe', 'Hotfix with approval'), to: 'umsetzung' },
        ],
      },
      {
        id: 'umsetzung',
        title: L('Umsetzung', 'Fix'),
        description: L('Fix auf eigenem Branch vom Ziel-Branch, in jedem betroffenen Repository.', 'Fix on its own branch from the target branch, in every affected repository.'),
        steps: [
          step(lang, { id: 'f1', kind: 'branch', de: 'Branch in allen Repositories angelegt', en: 'Branch created in every repository' }),
          step(lang, { id: 'f2', kind: 'mr', de: 'Merge Request je Repository geöffnet', en: 'Merge request opened in every repository', mrState: 'opened' }),
          step(lang, { id: 'f3', kind: 'task', de: 'Regressionstest ergänzt', en: 'Regression test added' }),
        ],
        next: [{ to: 'hotfix' }],
      },
      {
        id: 'hotfix',
        title: L('Hotfix-Freigabe', 'Hotfix approval'),
        description: L('Nur bei kritischen Fehlern.', 'Only for critical bugs.'),
        when: { var: 'schwere', op: 'eq', value: 'kritisch' },
        steps: [step(lang, { id: 'h1', kind: 'task', de: 'Freigabe durch die Teamleitung', en: 'Approved by the team lead' })],
        next: [{ to: 'abnahme' }],
      },
      {
        id: 'abnahme',
        title: L('Abnahme', 'Acceptance'),
        description: L('Der Melder bestätigt den Fix.', 'The reporter confirms the fix.'),
        steps: [step(lang, { id: 'n1', kind: 'task', de: 'Melder hat den Fix bestätigt', en: 'Reporter confirmed the fix' })],
        next: [{ to: 'merge' }, { to: 'umsetzung', back: true, label: L('Fehler besteht weiter', 'Bug still there') }],
      },
      {
        id: 'merge',
        title: L('Merge', 'Merge'),
        description: L(
          'Nur als eigener Lauf: Als Sub-Workflow wird mit dem umgebenden Prozess gemergt.',
          'Only as a run of its own: as a sub-workflow the merge happens with the surrounding process.'
        ),
        when: { var: 'nested', op: 'unset', value: '' },
        steps: [step(lang, { id: 'm1', kind: 'mr', de: 'Merge Requests gemergt', en: 'Merge requests merged', mrState: 'merged' })],
        next: [{ to: 'behoben' }],
      },
      { id: 'behoben', kind: 'end', title: L('Behoben', 'Fixed'), description: L('Der Fehler ist behoben.', 'The bug is fixed.'), end: 'behoben' },
    ],
  })!;
  return [waterfall, bugfix];
}
