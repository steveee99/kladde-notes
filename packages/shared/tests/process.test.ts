import { describe, expect, it } from 'vitest';
import {
  activeNode,
  advanceRun,
  catchUpSteps,
  changedSteps,
  closeRun,
  exampleProcesses,
  fillQuery,
  isHiddenPath,
  isProcessModelPath,
  isProcessRunPath,
  markSeen,
  modelFor,
  newBranchUrl,
  nextProcessVersion,
  normalizeProcess,
  parseProcessNote,
  parseRunNote,
  pickOption,
  processProblems,
  runVars,
  predictStages,
  serializeProcess,
  serializeRun,
  setStep,
  startRun,
  suggestBranch,
  type ProcessModel,
} from '../src/index';

const by = { by: 'anna', now: 1000 };
const models = (list: ProcessModel[]) => new Map(list.map((m) => [m.key, m]));

describe('process notes', () => {
  it('tells model and run notes apart and hides both', () => {
    expect(isProcessModelPath('_process-7f3c9a1b-0000.md')).toBe(true);
    expect(isProcessModelPath('_process-run-7f3c9a1b-0000.md')).toBe(false);
    expect(isProcessRunPath('_process-run-7f3c9a1b-0000.md')).toBe(true);
    expect(isProcessRunPath('Ordner/Prozess.md')).toBe(false);
    expect(isHiddenPath('_process-run-7f3c9a1b-0000.md')).toBe(true);
    expect(isHiddenPath('_process-7f3c9a1b.md')).toBe(true);
  });

  it('round-trips the example models and drops ways to missing stages', () => {
    for (const m of exampleProcesses('de')) expect(parseProcessNote(serializeProcess(m))).toEqual(m);
    const m = normalizeProcess({ title: 'X', stages: [{ id: 'a', next: [{ to: 'b' }, { to: 'nowhere' }] }, { id: 'b', kind: 'end' }] })!;
    expect(m.stages[0].next).toEqual([{ to: 'b', label: '', back: false, end: '' }]);
    expect(m.key).toBe('x');
    expect(normalizeProcess({ stages: [] })).toBeNull();
    expect(parseProcessNote('---\ntype: dashboard\n---\n```process\n{}\n```')).toBeNull();
  });

  it('names what a model would lose, and finds nothing in the examples', () => {
    const keys = new Set(['wasserfall', 'fehlerbehebung']);
    for (const m of exampleProcesses('en')) expect(processProblems(JSON.parse(JSON.stringify(m)), keys)).toEqual([]);
    const problems = processProblems({ title: 'X', start: 'z', stages: [{ id: 'a', kind: 'choice', options: [{ value: 'v', to: 'b' }] }, { id: 'b', kind: 'sub', process: 'fehlt', next: [{ to: 'a', back: true }] }] }, keys);
    expect(problems).toEqual([
      'Keine Stufe mit "kind": "end": ein Lauf kann nie abgeschlossen werden.',
      '"start" verweist auf "z", die Stufe gibt es nicht; der Lauf beginnt in der ersten Stufe.',
      'Stufe "a": eine Entscheidung braucht mindestens zwei "options".',
      'Stufe "b": das Modell "fehlt" gibt es in diesem Bereich nicht.',
    ]);
    expect(processProblems('x')).toEqual(['Das Modell muss ein JSON-Objekt sein.']);
  });

  it('refuses steps without what they need', () => {
    const m = normalizeProcess({
      title: 'X',
      stages: [{ id: 'a', steps: [{ id: 's1', kind: 'link', label: 'no var' }, { id: 's2', kind: 'check', label: 'no query' }, { id: 's3', kind: 'task', label: 'ok' }, { id: 'bad id!', label: 'x' }] }],
    })!;
    expect(m.stages[0].steps.map((s) => s.id)).toEqual(['s3']);
  });
});

describe('branches', () => {
  it('suggests a branch from the pattern, ticket and title', () => {
    expect(suggestBranch({ branchPrefix: 'feature', branchPattern: '{{prefix}}/{{ticket}}-{{slug}}' }, { ticket: 'SHOP-412', title: 'Gutschein im Checkout einlösen' })).toBe('feature/SHOP-412-gutschein-im-checkout-einlosen');
    expect(suggestBranch({ branchPrefix: 'bugfix', branchPattern: '{{prefix}}/{{ticket}}-{{slug}}' }, { ticket: '', title: 'Größe..falsch' })).toBe('bugfix/grosse-falsch');
    expect(suggestBranch({ branchPrefix: 'x', branchPattern: '{{prefix}}//{{ticket}}..lock' }, { ticket: 'A-1', title: '' })).toBe('x/A-1');
  });

  it('stays fast on long runs of separators', () => {
    const t = Date.now();
    expect(suggestBranch({ branchPrefix: 'x', branchPattern: `${'/-'.repeat(50000)}{{slug}}${'-/'.repeat(50000)}` }, { ticket: '', title: `${'-'.repeat(50000)}a` })).toBe('a');
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('builds the GitLab links with the branch and the ref', () => {
    expect(newBranchUrl('https://git.example.com/', 'team/api', 'feature/A-1', 'release/2.31')).toBe('https://git.example.com/team/api/-/branches/new?branch_name=feature%2FA-1&ref=release%2F2.31');
  });
});

describe('running a process', () => {
  const [waterfall, bugfix] = exampleProcesses('de');
  const all = models([waterfall, bugfix]);
  const start = () => startRun(waterfall, all, { title: 'Gutschein', ticket: 'SHOP-1', target: 'main', repos: ['team/api', 'team/web'] }, by);

  it('starts at the first stage with the suggested branch', () => {
    const run = start();
    expect(run.stage).toBe('anforderung');
    expect(run.branch).toBe('feature/SHOP-1-gutschein');
    expect(parseRunNote(serializeRun(run))).toEqual(run);
  });

  it('fills run variables into check queries, the repositories into lists', () => {
    const run = start();
    const test = waterfall.stages.find((s) => s.id === 'test')!.steps.find((s) => s.kind === 'check')!;
    const { query, missing } = fillQuery(test.query!, { repos: run.repos.join(','), branch: run.branch });
    expect(query.params.projects).toEqual(['team/api', 'team/web']);
    expect(query.params.ref).toBe('feature/SHOP-1-gutschein');
    expect(missing).toEqual([]);
    expect(fillQuery({ source: 'jira.issues', params: { jql: 'key = "{{run.ticket}}"' }, filters: [] }, {}).missing).toEqual(['ticket']);
  });

  it('walks a decision into a sub-workflow and back into the test', () => {
    let run = start();
    for (const stage of ['anforderung', 'konzept', 'design', 'umsetzung', 'test']) {
      expect(run.stage).toBe(stage);
      run = advanceRun(run, all, { forced: true }, by);
    }
    expect(run.stage).toBe('testergebnis');
    expect(() => advanceRun(run, all, {}, by)).toThrow('no_choice');
    run = advanceRun(pickOption(run, all, 'fehler'), all, {}, by);
    expect(run.stage).toBe('fehler');
    const child = activeNode(run);
    expect(child.model).toBe('fehlerbehebung');
    expect(child.stage).toBe('bug');
    run = setStep(run, all, 'b1', { done: true, value: 'https://jira.example.com/browse/SHOP-9' });
    expect(activeNode(run).vars.bug).toBe('https://jira.example.com/browse/SHOP-9');
    run = advanceRun(run, all, { forced: true }, by);
    // Normal severity: the hotfix approval is passed over; nested: the merge stage too
    run = advanceRun(pickOption(run, all, 'normal'), all, {}, by);
    expect(activeNode(run).stage).toBe('umsetzung');
    expect(predictStages(bugfix, activeNode(run), runVars(run, activeNode(run)))).toEqual([{ id: 'hotfix', skipped: true }, { id: 'abnahme' }, { id: 'merge', skipped: true }, { id: 'behoben' }]);
    run = advanceRun(run, all, { forced: true }, by);
    expect(activeNode(run).hist.at(-1)).toMatchObject({ stage: 'hotfix', skipped: true });
    run = advanceRun(run, all, { forced: true }, by);
    // The sub-workflow ended: frozen, its bug went to the caller, the test runs again with its decision open
    expect(run.child).toBeUndefined();
    expect(run.children).toHaveLength(1);
    expect(run.children[0]).toMatchObject({ state: 'done', end: 'behoben' });
    expect(run.children[0].snapshot?.key).toBe('fehlerbehebung');
    expect(run.vars.fehlerticket).toBe('https://jira.example.com/browse/SHOP-9');
    expect(run.stage).toBe('test');
    expect(run.hist.at(-1)).toMatchObject({ stage: 'fehler', subEnd: 'behoben' });
    run = advanceRun(run, all, { forced: true }, by);
    expect(run.vars.testergebnis).toBeUndefined();
  });

  it('goes back and opens the steps again, links stay', () => {
    let run = start();
    run = setStep(run, all, 'a1', { done: true, value: 'https://jira.example.com/browse/SHOP-1' });
    run = advanceRun(run, all, { passing: ['a2'] }, by);
    run = setStep(run, all, 'k1', { done: true, value: 'https://wiki.example.com/x/1' });
    run = setStep(run, all, 'k2', { done: true });
    run = advanceRun(run, all, {}, by);
    expect(run.stage).toBe('design');
    run = advanceRun(run, all, { back: 'konzept' }, by);
    expect(run.stage).toBe('konzept');
    expect(run.done).toContain('k1');
    expect(run.done).not.toContain('k2');
    expect(run.hist.at(-1)).toMatchObject({ stage: 'design', back: true });
  });

  it('follows changes to the model while running, keeps its model once finished', () => {
    let run = start();
    run = advanceRun(run, all, { forced: true }, by);
    // A new step in the stage the run left (to catch up) and one ahead
    const edited = JSON.parse(JSON.stringify(waterfall)) as ProcessModel;
    edited.stages[0].steps.push({ ...edited.stages[0].steps[0], id: 'a3', kind: 'task', label: 'Datenschutz-Check', retro: true });
    edited.stages[8].steps.push({ ...edited.stages[8].steps[0], id: 'r3', kind: 'task', label: 'Security-Scan' });
    const v2 = nextProcessVersion(waterfall, edited);
    expect(v2.version).toBe(2);
    expect(v2.stages[0].steps.map((s) => s.since)).toEqual([1, 1, 2]);
    expect(nextProcessVersion(v2, v2).version).toBe(2);
    const live = models([v2, bugfix]);
    expect(catchUpSteps(v2, run).map((c) => c.step.id)).toEqual(['a3']);
    expect(changedSteps(v2, run).map((c) => c.step.id)).toEqual(['a3', 'r3']);
    expect(changedSteps(v2, markSeen(run, live))).toEqual([]);
    run = setStep(run, live, 'a3', { done: true });
    expect(catchUpSteps(v2, run)).toEqual([]);
    while (run.stage !== 'ende') run = run.stage === 'testergebnis' ? advanceRun(pickOption(run, live, 'bestanden'), live, {}, by) : advanceRun(run, live, { forced: true }, by);
    const done = closeRun(run, live, { by: 'anna', now: 5000 });
    expect(done).toMatchObject({ state: 'done', end: 'fertig', closedAt: 5000 });
    // A later version does not reach the finished run
    const v3 = nextProcessVersion(v2, { ...v2, title: 'Neu' });
    expect(modelFor(done, models([v3, bugfix]))?.title).toBe(waterfall.title);
    expect(modelFor(run, models([v3, bugfix]))?.title).toBe('Neu');
    expect(() => advanceRun(done, live, {}, by)).toThrow('not_running');
  });
});
