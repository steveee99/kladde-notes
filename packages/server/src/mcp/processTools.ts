/**
 * MCP tools for guided processes (part of the feature `cockpit`, shared/process.ts): assistants read, create and
 * extend process models and start and move runs, through the same rules as the app. Models are checked with
 * `processProblems`/`normalizeProcess`, saving raises the version (`nextProcessVersion`), runs move with the pure
 * functions of the engine. Live checks (Jira, GitLab) are evaluated in the app with the user's connections; here
 * they show as `live` steps, which `next` passes only with `force` (the history keeps that).
 */
import crypto from 'crypto';
import {
  PROCESS_FORMAT,
  activeNode,
  advanceRun,
  canWriteInGroup,
  catchUpSteps,
  changedSteps,
  closeRun,
  conditionText,
  exampleProcesses,
  isProcessModelPath,
  isProcessRunPath,
  joinPath,
  markSeen,
  modelFor,
  moveToStage,
  nextProcessVersion,
  normalizeProcess,
  parseProcessNote,
  parseRunNote,
  passedStages,
  pickOption,
  predictStages,
  processFileName,
  processProblems,
  processRunFileName,
  ProcessMoveError,
  runVars,
  serializeProcess,
  serializeRun,
  setStep,
  splitPath,
  stageOf,
  startRun,
  type ProcessModel,
  type ProcessRun,
  type ProcessRunNode,
  type ProcessStep,
} from '@kladde/shared';
import { featuresOf, groupOf, saveWithContent, space, str, strList, ToolError, type SpaceNote, type ToolContext, type ToolDef } from './tools.js';

const LIVE_KINDS = new Set<ProcessStep['kind']>(['check', 'branch', 'mr']);

const MOVE_ERRORS: Record<string, string> = {
  no_model: 'Das Modell (oder das Modell des Sub-Workflows) fehlt in diesem Bereich.',
  no_stage: 'Diese Stufe gibt es im Modell nicht.',
  no_way: 'Von dieser Stufe führt kein solcher Weg weiter.',
  no_choice: 'Erst eine Option wählen (action "pick").',
  not_running: 'Der Lauf ist abgeschlossen.',
};

function cockpitOn(ctx: ToolContext): void {
  if (!featuresOf(ctx.notes, ctx.userId).cockpit.enabled) throw new ToolError('Prozesse gehören zum Cockpit. Schalte es in Kladde unter Einstellungen → Funktionen ein.');
}

interface Space {
  /** Group id, '' for the own space */
  id: string;
  name: string | null;
  readOnly: boolean;
}

interface ModelNote {
  note: SpaceNote;
  model: ProcessModel;
  space: Space;
}

interface RunNote {
  note: SpaceNote;
  run: ProcessRun;
  space: Space;
}

const atTop = (n: SpaceNote) => splitPath(n.realPath ?? n.path).folder === '';
const spaceOf = (n: SpaceNote): Space => ({ id: n.group ?? '', name: n.groupName ?? null, readOnly: n.access === 'read' });

function modelNotes(ctx: ToolContext): ModelNote[] {
  return space(ctx)
    .filter((n) => atTop(n) && isProcessModelPath(n.realPath ?? n.path))
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((note) => {
      const model = parseProcessNote(note.content);
      return model ? [{ note, model, space: spaceOf(note) }] : [];
    });
}

function runNotes(ctx: ToolContext): RunNote[] {
  return space(ctx)
    .filter((n) => atTop(n) && isProcessRunPath(n.realPath ?? n.path))
    .flatMap((note) => {
      const run = parseRunNote(note.content);
      return run ? [{ note, run, space: spaceOf(note) }] : [];
    });
}

/** The models of one space by key (the oldest of a key wins), as the engine wants them */
function modelsIn(ctx: ToolContext, spaceId: string): Map<string, ProcessModel> {
  const out = new Map<string, ProcessModel>();
  for (const m of modelNotes(ctx)) if (m.space.id === spaceId && !out.has(m.model.key)) out.set(m.model.key, m.model);
  return out;
}

/** The space a tool works in: a group by name, or the own one */
function targetSpace(ctx: ToolContext, group: string | undefined): Space {
  if (!group) return { id: '', name: null, readOnly: false };
  const g = groupOf(ctx, group);
  return { id: g.id, name: g.name, readOnly: !canWriteInGroup(g.role) };
}

function findModel(ctx: ToolContext, key: string, group: string | undefined): ModelNote {
  const sp = targetSpace(ctx, group);
  const wanted = key.trim().toLowerCase();
  const all = modelNotes(ctx);
  const found = all.find((m) => m.note.id === key) ?? all.find((m) => m.space.id === sp.id && (m.model.key === wanted || m.model.title.toLowerCase() === wanted));
  if (!found) throw new ToolError(`Das Modell „${key}“ gibt es ${sp.name ? `in der Gruppe „${sp.name}“` : 'in deinem Bereich'} nicht. Die Modelle stehen in process_list.`);
  return found;
}

function findRun(ctx: ToolContext, ref: string): RunNote {
  const wanted = ref.trim().toLowerCase();
  const runs = runNotes(ctx);
  const found = runs.find((r) => r.note.id === ref) ?? runs.filter((r) => r.run.state === 'running').find((r) => r.run.ticket.toLowerCase() === wanted || r.run.title.toLowerCase() === wanted);
  if (!found) throw new ToolError(`Den Lauf „${ref}“ gibt es nicht. Die Läufe stehen in process_list (id, oder Ticket/Titel eines laufenden Laufs).`);
  return found;
}

function guardWrite(sp: Space): void {
  if (sp.readOnly) throw new ToolError(`In der Gruppe „${sp.name ?? ''}“ darfst du nur lesen.`);
}

/** A hidden note at the top of a space, through the normal sync path */
function createHidden(ctx: ToolContext, sp: Space, fileName: string, content: string): string {
  guardWrite(sp);
  const id = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const path = joinPath('', fileName.replace(/\.md$/, ''));
  const [result] = ctx.notes.push(ctx.userId, [{ id, baseVersion: 0, path, content, deleted: false, createdAt: now, updatedAt: now, ...(sp.id ? { group: sp.id } : {}) }]);
  if (result.status !== 'ok') throw new ToolError('Die Notiz konnte nicht angelegt werden.');
  return id;
}

/** Parses the `model` argument: an object or JSON text */
function modelArg(args: Record<string, unknown>): unknown {
  const raw = args.model;
  if (raw === undefined || raw === null || raw === '') throw new ToolError('Parameter "model" fehlt. Das Format erklärt process_guide.');
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ToolError(`"model" ist kein gültiges JSON: ${(err as Error).message}`);
  }
}

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);

function modelSummary(m: ModelNote) {
  return {
    key: m.model.key,
    id: m.note.id,
    title: m.model.title,
    description: m.model.description,
    version: m.model.version,
    stages: m.model.stages.length,
    branch_pattern: m.model.branchPattern.replace('{{prefix}}', m.model.branchPrefix),
    ...(m.space.name ? { group: m.space.name, read_only: m.space.readOnly } : {}),
  };
}

function runSummary(r: RunNote, models: Map<string, ProcessModel>) {
  const node = activeNode(r.run);
  const m = modelFor(node, models);
  return {
    id: r.note.id,
    title: r.run.title,
    ticket: r.run.ticket || null,
    model: r.run.model,
    state: r.run.state,
    stage: m ? (stageOf(m, node.stage)?.title ?? node.stage) : node.stage,
    ...(node !== r.run ? { sub_workflow: m?.title ?? node.model } : {}),
    target: r.run.target,
    branch: r.run.branch,
    repos: r.run.repos,
    updated: iso(r.note.updatedAt),
    ...(r.space.name ? { group: r.space.name } : {}),
  };
}

/** A step as the assistant sees it: done (recorded), or live (the app checks it), with what it needs */
function stepView(step: ProcessStep, node: ProcessRunNode) {
  const done = node.done.includes(step.id);
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    ...(step.hint ? { hint: step.hint } : {}),
    done,
    ...(LIVE_KINDS.has(step.kind) && !done ? { live: true } : {}),
    ...(step.kind === 'link' ? { var: step.var, source: step.source, value: node.vars[step.var] ?? null } : {}),
    ...(step.kind === 'check' && step.query ? { query: step.query, expect: step.expect } : {}),
    ...(step.kind === 'mr' ? { mr_state: step.mrState } : {}),
  };
}

function nodeView(run: ProcessRun, node: ProcessRunNode, models: Map<string, ProcessModel>) {
  const m = modelFor(node, models);
  if (!m) return { model: node.model, problem: 'Das Modell fehlt in diesem Bereich.' };
  const st = stageOf(m, node.stage);
  const vars = runVars(run, node);
  const current = st
    ? {
        id: st.id,
        title: st.title,
        kind: st.kind,
        ...(st.description ? { description: st.description } : {}),
        ...(st.when ? { applies_because: conditionText(st.when) } : {}),
        ...(st.kind === 'steps' ? { steps: st.steps.map((s) => stepView(s, node)) } : {}),
        ...(st.onEnter ? { on_enter: st.onEnter } : {}),
        ...(st.onExit ? { on_exit: st.onExit } : {}),
        ...(st.kind === 'choice' ? { variable: st.var, picked: node.vars[st.var] ?? null, options: st.options.map((o) => ({ value: o.value, label: o.label, hint: o.hint, to: stageOf(m, o.to)?.title ?? o.to })) } : {}),
        ...(st.next.some((t) => t.back) ? { ways_back: st.next.filter((t) => t.back).map((t) => ({ to: t.to, label: t.label || (stageOf(m, t.to)?.title ?? t.to) })) } : {}),
      }
    : { id: node.stage, problem: 'Die Stufe gibt es im Modell nicht mehr: mit action "move" auf eine Stufe setzen.' };
  return {
    model: { key: m.key, title: m.title, version: m.version, ...(node.snapshot ? { frozen: true } : {}) },
    state: node.state,
    ...(node.end ? { end: node.end } : {}),
    current: node.state === 'running' ? current : null,
    ahead:
      node.state === 'running'
        ? predictStages(m, node, vars).map((p) => ('open' in p ? (p.open === 'choice' ? '(hängt von der Entscheidung ab)' : '(hängt vom Ende des Sub-Workflows ab)') : `${stageOf(m, p.id)?.title ?? p.id}${p.skipped ? ' (entfällt)' : p.maybe ? ' (nur wenn …)' : p.loop ? ' (nächste Runde oder weiter)' : ''}`))
        : [],
    passed: [...passedStages(node)].map((s) => stageOf(m, s)?.title ?? s),
    catch_up: catchUpSteps(m, node).map(({ stage, step }) => ({ stage: stage.title, ...stepView(step, node) })),
    model_changes: changedSteps(m, node).map(({ stage, step }) => ({ version: step.since, stage: stage.title, step: step.label, retro: step.retro })),
    variables: node.vars,
  };
}

function runView(r: RunNote, models: Map<string, ProcessModel>) {
  const run = r.run;
  const active = activeNode(run);
  return {
    id: r.note.id,
    title: run.title,
    ticket: run.ticket || null,
    state: run.state,
    target: run.target,
    repos: run.repos,
    branch: run.branch,
    git: run.branch ? `git fetch origin && git switch -c ${run.branch} origin/${run.target || 'main'}` : null,
    created: iso(run.createdAt),
    ...(run.closedAt ? { closed: iso(run.closedAt), frozen_on_version: run.snapshot?.version ?? null } : {}),
    ...(r.space.name ? { group: r.space.name, read_only: r.space.readOnly } : {}),
    run: nodeView(run, run, models),
    ...(active !== run ? { sub_workflow: nodeView(run, active, models) } : {}),
    finished_sub_workflows: run.children.map((c) => ({ model: c.model, end: c.end ?? null, version: c.snapshot?.version ?? null, variables: c.vars })),
    history: run.hist.slice(-40).map((h) => ({ at: iso(h.at), by: h.by, stage: h.stage, ...(h.pick ? { pick: h.pick } : {}), ...(h.skipped ? { skipped: true } : {}), ...(h.back ? { back: true } : {}), ...(h.forced ? { forced: true } : {}), ...(h.subEnd ? { sub_end: h.subEnd } : {}), ...(h.round ? { round: h.round } : {}), ...(h.rounds !== undefined ? { rounds: h.rounds } : {}) })),
    // What the stage scripts asked for; Kladde carries notifications and notes out once after the save
    actions: run.actions.slice(-20).map((a) => ({ at: iso(a.at), by: a.by, stage: a.stage, on: a.on, kind: a.kind, ...(a.to ? { to: a.to } : {}), ...(a.text ? { text: a.text } : {}), ...(a.path ? { path: a.path } : {}), ...(a.template ? { template: a.template } : {}), ...(a.error ? { error: true } : {}) })),
  };
}

function saveRun(ctx: ToolContext, r: RunNote, run: ProcessRun) {
  guardWrite(r.space);
  saveWithContent(ctx, r.note, serializeRun(run));
}

const actor = (ctx: ToolContext) => ({ by: ctx.agent || ctx.notes.usernameOf(ctx.userId) || 'agent', now: Date.now() });

function move<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProcessMoveError) throw new ToolError(MOVE_ERRORS[err.problem] ?? err.message);
    throw err;
  }
}

const groupParam = { group: { type: 'string', description: 'Name of a group to work in; default: the own space' } };

export const PROCESS_TOOLS: ToolDef[] = [
  {
    name: 'process_guide',
    title: 'Prozess-Format',
    description:
      'Explains the JSON format of process models (stages, steps, decisions, conditions, sub-workflows, live checks) and returns an example model. Read it before process_save.',
    inputSchema: { type: 'object', properties: {} },
    write: false,
    run(_args, ctx) {
      cockpitOn(ctx);
      return { format: PROCESS_FORMAT, example: exampleProcesses('de')[1] };
    },
  },
  {
    name: 'process_list',
    title: 'Prozesse auflisten',
    description:
      'Lists the guided development processes: the models (key, title, version, stages) and the runs (a feature or bug walked through a model) with their current stage, target branch, repositories and branch. `state` filters the runs (running by default).',
    inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['running', 'done', 'all'], default: 'running' } } },
    write: false,
    run(args, ctx) {
      cockpitOn(ctx);
      const state = str(args, 'state') ?? 'running';
      const runs = runNotes(ctx).filter((r) => state === 'all' || r.run.state === state);
      const bySpace = new Map<string, Map<string, ProcessModel>>();
      const modelsOf = (id: string) => bySpace.get(id) ?? bySpace.set(id, modelsIn(ctx, id)).get(id)!;
      return {
        models: modelNotes(ctx).map(modelSummary),
        runs: runs.sort((a, b) => b.note.updatedAt - a.note.updatedAt).map((r) => runSummary(r, modelsOf(r.space.id))),
      };
    },
  },
  {
    name: 'process_read',
    title: 'Prozess lesen',
    description:
      'Reads a process model as JSON (`model`: its key, title or id) or a run (`run`: its id, or the ticket or title of a running run) with its current stage, the steps and whether they are done, what lies ahead, steps to catch up, model changes, variables and history. Steps marked `live` (checks, branches, merge requests) are checked in the app with the user\'s GitLab/Jira connections.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, run: { type: 'string' }, ...groupParam } },
    write: false,
    run(args, ctx) {
      cockpitOn(ctx);
      const runRef = str(args, 'run');
      if (runRef) {
        const r = findRun(ctx, runRef);
        return runView(r, modelsIn(ctx, r.space.id));
      }
      const key = str(args, 'model');
      if (!key) throw new ToolError('Gib "model" oder "run" an.');
      const m = findModel(ctx, key, str(args, 'group'));
      return { ...modelSummary(m), model: m.model };
    },
  },
  {
    name: 'process_save',
    title: 'Prozessmodell speichern',
    description:
      'Creates a process model or changes one (matched by its `key` in the space). Pass the whole model as JSON (see process_guide; to change one, read it with process_read first). Kladde checks it and answers what it would drop; with problems nothing is saved unless `accept_problems` is true. Saving raises the version; new steps get it, and running runs follow the new version (steps with "retro": true must be caught up in stages they already left). Finished runs keep their version. `dry_run` only checks.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'object', description: 'The model (or its JSON as text)' },
        dry_run: { type: 'boolean', default: false },
        accept_problems: { type: 'boolean', default: false, description: 'Save even when parts are dropped' },
        ...groupParam,
      },
      required: ['model'],
    },
    write: true,
    run(args, ctx) {
      cockpitOn(ctx);
      const raw = modelArg(args);
      const sp = targetSpace(ctx, str(args, 'group'));
      const known = new Set(modelsIn(ctx, sp.id).keys());
      const parsed = normalizeProcess(raw);
      if (parsed) known.add(parsed.key);
      const problems = processProblems(raw, known);
      if (!parsed) throw new ToolError(`Das Modell ist nicht verwendbar:\n- ${problems.join('\n- ')}`);
      const existing = modelNotes(ctx).find((m) => m.space.id === sp.id && m.model.key === parsed.key);
      const next = nextProcessVersion(existing?.model ?? null, parsed);
      const newSteps = next.stages.flatMap((st) => st.steps.filter((s) => s.since === next.version && (existing ? s.since > existing.model.version : true)).map((s) => `${st.id}/${s.id}`));
      const answer = {
        key: next.key,
        title: next.title,
        version: next.version,
        created: !existing,
        ...(existing ? { new_steps: newSteps, changed: next.version !== existing.model.version } : {}),
        ...(problems.length ? { problems } : {}),
      };
      if (args.dry_run === true) return { ...answer, dry_run: true };
      if (problems.length && args.accept_problems !== true) throw new ToolError(`Nicht gespeichert, das Modell hat Probleme:\n- ${problems.join('\n- ')}\nKorrigiere sie oder speichere mit accept_problems: true.`);
      guardWrite(sp);
      if (existing) {
        guardWrite(existing.space);
        if (next.version !== existing.model.version) saveWithContent(ctx, existing.note, serializeProcess(next));
        return { ...answer, id: existing.note.id };
      }
      const id = createHidden(ctx, sp, processFileName(crypto.randomUUID()), serializeProcess(next));
      return { ...answer, id };
    },
  },
  {
    name: 'process_run_start',
    title: 'Prozesslauf starten',
    description:
      'Starts a run of a process model for a feature or bug: the target branch (`target`) and the affected GitLab repositories (`repos`, "group/project") are required; the work branch is suggested from the model\'s pattern and the ticket and title unless `branch` is given. Returns the run as process_read shows it.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Key, title or id of the model' },
        title: { type: 'string' },
        ticket: { type: 'string', description: 'Jira key or other ticket id, e.g. SHOP-412' },
        target: { type: 'string', description: 'Target branch, e.g. main or release/2.31' },
        repos: { type: 'array', items: { type: 'string' } },
        branch: { type: 'string' },
        ...groupParam,
      },
      required: ['model', 'title', 'target', 'repos'],
    },
    write: true,
    run(args, ctx) {
      cockpitOn(ctx);
      const m = findModel(ctx, str(args, 'model', true)!, str(args, 'group'));
      guardWrite(m.space);
      const repos = strList(args, 'repos') ?? [];
      const bad = repos.find((r) => !/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(r) || r.includes('..'));
      if (bad) throw new ToolError(`„${bad}“ ist kein Repository-Pfad (gruppe/projekt).`);
      if (!repos.length) throw new ToolError('Mindestens ein Repository in "repos" angeben.');
      const target = str(args, 'target', true)!.trim();
      const models = modelsIn(ctx, m.space.id);
      const run = move(() => startRun(m.model, models, { title: str(args, 'title', true)!, ticket: str(args, 'ticket') ?? '', target, repos, branch: str(args, 'branch') }, actor(ctx)));
      const id = createHidden(ctx, m.space, processRunFileName(crypto.randomUUID()), serializeRun(run));
      const created = runNotes(ctx).find((r) => r.note.id === id);
      return created ? runView(created, models) : { id };
    },
  },
  {
    name: 'process_run_update',
    title: 'Prozesslauf fortschreiben',
    description:
      'Moves a run on (`run`: id, or ticket/title of a running run). `action`: "link" saves the URL of a page made elsewhere for a link step (`step`, `value`); "tick"/"untick" a checkbox step; "pick" chooses an option of the current decision (`value`); "next" goes to the next stage (open checkboxes or links block it; live checks that are not recorded need `force`: true, which the history keeps); "back" takes a way back (`value`: the stage id); "move" puts a run whose stage left the model onto a stage (`value`); "close" finishes a run at its end stage and freezes it on the current model; "seen" marks model changes as seen. Works in the running sub-workflow when the run is inside one.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string' },
        action: { type: 'string', enum: ['link', 'tick', 'untick', 'pick', 'next', 'back', 'move', 'close', 'seen'] },
        step: { type: 'string', description: 'Step id (link, tick, untick)' },
        value: { type: 'string', description: 'URL (link), option value (pick), stage id (back, move)' },
        force: { type: 'boolean', default: false },
      },
      required: ['run', 'action'],
    },
    write: true,
    run(args, ctx) {
      cockpitOn(ctx);
      const r = findRun(ctx, str(args, 'run', true)!);
      const models = modelsIn(ctx, r.space.id);
      const action = str(args, 'action', true)!;
      const value = str(args, 'value');
      let run = r.run;
      const node = activeNode(run);
      const m = modelFor(node, models);
      const step = (id: string | undefined) => {
        if (!id) throw new ToolError('Parameter "step" fehlt.');
        const all = [node, run].flatMap((n) => modelFor(n, models)?.stages.flatMap((s) => s.steps) ?? []);
        const s = all.find((x) => x.id === id);
        if (!s) throw new ToolError(`Den Schritt „${id}“ gibt es nicht. Die Schritte stehen in process_read.`);
        return s;
      };
      if (run.state !== 'running' && action !== 'seen') throw new ToolError(MOVE_ERRORS.not_running);
      switch (action) {
        case 'link': {
          const s = step(str(args, 'step'));
          if (s.kind !== 'link') throw new ToolError(`„${s.label}“ ist kein Verweis.`);
          if (!value || !/^https?:\/\/\S+$/i.test(value.trim())) throw new ToolError('"value" muss eine http(s)-Adresse sein.');
          run = setStep(run, models, s.id, { done: true, value: value.trim() });
          break;
        }
        case 'tick':
        case 'untick': {
          const s = step(str(args, 'step'));
          if (s.kind !== 'task') throw new ToolError(`„${s.label}“ ist keine Checkbox${LIVE_KINDS.has(s.kind) ? '; Prüfungen hakt Kladde selbst ab, wenn die Quelle sie erfüllt' : ''}.`);
          run = setStep(run, models, s.id, { done: action === 'tick' });
          break;
        }
        case 'pick':
          if (!value) throw new ToolError('Parameter "value" fehlt (der Wert einer Option).');
          run = move(() => pickOption(run, models, value));
          break;
        case 'next': {
          const st = m && stageOf(m, node.stage);
          if (st?.kind === 'end' && node === run) throw new ToolError('Der Lauf steht am Ende: mit action "close" abschließen.');
          if (st?.kind === 'steps') {
            const open = st.steps.filter((s) => !node.done.includes(s.id));
            const manual = open.filter((s) => !LIVE_KINDS.has(s.kind));
            const live = open.filter((s) => LIVE_KINDS.has(s.kind));
            if (manual.length && args.force !== true) throw new ToolError(`Noch offen: ${manual.map((s) => `„${s.label}“ (${s.id})`).join(', ')}. Erledigen oder mit force: true trotzdem weiter.`);
            if (live.length && args.force !== true)
              throw new ToolError(`Diese Prüfungen wertet Kladde live in der App aus: ${live.map((s) => `„${s.label}“ (${s.id})`).join(', ')}. Wenn sie erfüllt sind, mit force: true weiter (der Verlauf vermerkt es).`);
          }
          run = move(() => advanceRun(run, models, { forced: args.force === true }, actor(ctx)));
          break;
        }
        case 'back':
          if (!value) throw new ToolError('Parameter "value" fehlt (die Stufe, zu der es zurückgeht).');
          run = move(() => advanceRun(run, models, { back: value }, actor(ctx)));
          break;
        case 'move': {
          if (!value) throw new ToolError('Parameter "value" fehlt (die Stufe).');
          run = move(() => moveToStage(run, models, value, actor(ctx)));
          break;
        }
        case 'close': {
          const left = m ? catchUpSteps(m, run) : [];
          if (left.length && args.force !== true) throw new ToolError(`Erst nachholen: ${left.map((x) => `„${x.step.label}“ (${x.stage.title})`).join(', ')}.`);
          run = move(() => closeRun(run, models, actor(ctx)));
          break;
        }
        case 'seen':
          run = markSeen(run, models);
          break;
        default:
          throw new ToolError(`Unbekannte action „${action}“.`);
      }
      saveRun(ctx, r, run);
      return runView({ ...r, run }, models);
    },
  },
];
