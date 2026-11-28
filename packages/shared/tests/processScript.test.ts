import { describe, expect, it } from 'vitest';
import {
  advanceRun,
  normalizeProcess,
  parseRunNote,
  pickOption,
  predictStages,
  processProblems,
  runScript,
  scriptProblems,
  serializeRun,
  startRun,
  type ProcessModel,
} from '../src/index';

const by = { by: 'anna', now: 1000 };
const models = (list: ProcessModel[]) => new Map(list.map((m) => [m.key, m]));

describe('stage scripts', () => {
  it('sets, counts and tests variables and fills {{run.x}}', () => {
    const fx = runScript(
      [
        '# Kommentar',
        'versuch = versuch + 1',
        'inc("zaehler", 2)',
        'name = "Test " + ticket',
        'if versuch >= 2 and not fertig: set("stufe", "zweiter Versuch")',
        'if run.ticket == "ABC-1": log("Ticket {{run.ticket}} in Runde {{run.versuch}}")',
        'clear("alt")',
      ].join('\n'),
      { versuch: '1', ticket: 'ABC-1', alt: 'x' }
    );
    expect(fx.errors).toEqual([]);
    expect(fx.changed).toEqual({ versuch: '2', zaehler: '2', name: 'Test ABC-1', stufe: 'zweiter Versuch', alt: '' });
    expect(fx.actions).toEqual([{ kind: 'log', text: 'Ticket ABC-1 in Runde 2' }]);
  });

  it('turns notifications and notes into actions, a note into its path', () => {
    const fx = runScript('protokoll = note("Projekte/{{run.ticket}}/../Protokoll.md", "Testprotokoll")\nnotify("@ben, owner", "Siehe {{run.protokoll}}")\ndone("t1")\nundone("t2")', { ticket: 'ABC-1' });
    expect(fx.actions).toEqual([
      { kind: 'note', path: 'Projekte/ABC-1/Protokoll', template: 'Testprotokoll' },
      { kind: 'notify', to: '@ben, owner', text: 'Siehe Projekte/ABC-1/Protokoll' },
    ]);
    expect(fx.done).toEqual(['t1']);
    expect(fx.undone).toEqual(['t2']);
  });

  it('reports wrong lines with their number and runs the rest', () => {
    expect(scriptProblems('notify("a")\nfoo("x")\nx = "offen\nif x: \nok = 1')).toEqual([
      'Zeile 1: notify() braucht 2 Angaben',
      'Zeile 2: Die Funktion „foo“ gibt es nicht (notify, note, set, inc, clear, done, undone, log)',
      'Zeile 3: Text ohne schließendes Anführungszeichen',
      'Zeile 4: Nach „:“ fehlt die Anweisung',
    ]);
    const fx = runScript('foo()\nok = 1', {});
    expect(fx.changed).toEqual({ ok: '1' });
    expect(fx.errors).toHaveLength(1);
  });

  it('stops at the action limit', () => {
    const fx = runScript(Array.from({ length: 30 }, (_, i) => `log("${i}")`).join('\n'), {});
    expect(fx.actions).toHaveLength(20);
    expect(fx.errors[0]).toContain('Höchstens 20 Aktionen');
  });
});

const review = (): ProcessModel =>
  normalizeProcess({
    key: 'review',
    title: 'Review',
    start: 'start',
    stages: [
      { id: 'start', title: 'Start', steps: [{ id: 's1', kind: 'task', label: 'Los' }], onExit: 'notify("all", "{{run.title}} geht ins Review")', next: [{ to: 'runden' }] },
      { id: 'runden', kind: 'loop', title: 'Review-Runden', body: 'pruefen', var: 'runde', max: 3, until: { var: 'ergebnis', op: 'eq', value: 'ok' }, onEnter: 'log("Runde {{run.runde}}")', next: [{ to: 'ende' }] },
      {
        id: 'pruefen',
        title: 'Prüfen',
        steps: [{ id: 'p1', kind: 'task', label: 'Geprüft' }],
        onEnter: 'notiz = note("Reviews/{{run.ticket}} Runde {{run.runde}}", "Review")',
        next: [{ to: 'urteil' }],
      },
      {
        id: 'urteil',
        kind: 'choice',
        title: 'Urteil',
        var: 'ergebnis',
        options: [
          { value: 'ok', label: 'Passt', to: 'runden' },
          { value: 'nochmal', label: 'Nochmal', to: 'runden' },
        ],
      },
      { id: 'ende', kind: 'end', title: 'Fertig', onEnter: 'notify("owner", "Review nach {{run.runde}} Runden fertig")' },
    ],
  })!;

describe('loops', () => {
  it('are checked: a body, a way back to the loop and valid scripts', () => {
    expect(processProblems(review())).toEqual([]);
    const broken = { title: 'X', stages: [{ id: 'l', kind: 'loop', onEnter: 'nope(', next: [{ to: 'e' }] }, { id: 'a', steps: [], next: [{ to: 'e' }] }, { id: 'e', kind: 'end' }] };
    const problems = processProblems(broken);
    expect(problems).toContain('Stufe "l": eine Schleife braucht "body" (die erste Stufe einer Runde).');
    expect(problems.some((p) => p.startsWith('Stufe "l", onEnter: Zeile 1:'))).toBe(true);
    expect(processProblems({ ...broken, stages: [{ ...broken.stages[0], body: 'a', onEnter: '' }, ...broken.stages.slice(1)] })).toContain('Stufe "l": keine Stufe ab "a" führt zurück zur Schleife; es gäbe nur eine Runde.');
  });

  it('runs rounds until the condition holds, with scripts and actions on the way', () => {
    const m = review();
    const all = models([m]);
    let run = startRun(m, all, { title: 'Login', ticket: 'ABC-7', target: 'main', repos: [] }, by);
    run = advanceRun(run, all, { forced: true }, { by: 'ben', now: 2000 });
    expect(run.stage).toBe('pruefen');
    expect(run.vars.runde).toBe('1');
    expect(run.vars.notiz).toBe('Reviews/ABC-7 Runde 1');
    expect(run.actions.map((a) => [a.kind, a.stage, a.on, a.by])).toEqual([
      ['notify', 'start', 'exit', 'ben'],
      ['log', 'runden', 'enter', 'ben'],
      ['note', 'pruefen', 'enter', 'ben'],
    ]);
    expect(new Set(run.actions.map((a) => a.id)).size).toBe(3);
    // A second round: the step is open again, the decision is made again
    run = advanceRun({ ...run, done: ['p1'] }, all, {}, by);
    run = advanceRun(pickOption(run, all, 'nochmal'), all, {}, by);
    expect(run.stage).toBe('pruefen');
    expect(run.vars.runde).toBe('2');
    expect(run.done).not.toContain('p1');
    expect(run.hist.filter((h) => h.stage === 'runden').map((h) => h.round)).toEqual([1, 2]);
    // Passed: out of the loop, the end's script sees the rounds
    run = advanceRun(run, all, { forced: true }, by);
    run = advanceRun(pickOption(run, all, 'ok'), all, {}, by);
    expect(run.stage).toBe('ende');
    expect(run.hist.at(-1)).toMatchObject({ stage: 'runden', rounds: 2 });
    expect(run.actions.at(-1)).toMatchObject({ kind: 'notify', to: 'owner', text: 'Review nach 2 Runden fertig' });
    // The actions survive the note
    expect(parseRunNote(serializeRun(run))!.actions).toEqual(run.actions);
  });

  it('stops after max rounds and goes through a list with over', () => {
    const m = normalizeProcess({ ...review(), stages: review().stages.map((s) => (s.id === 'runden' ? { ...s, until: null, over: 'repos', max: 5 } : s)) })!;
    const all = models([m]);
    let run = startRun(m, all, { title: 'X', ticket: '', target: 'main', repos: ['a/one', 'a/two'] }, by);
    run = advanceRun(run, all, { forced: true }, by);
    expect(run.vars.runde_item).toBe('a/one');
    const round = () => {
      run = advanceRun(run, all, { forced: true }, by);
      run = advanceRun(pickOption(run, all, 'nochmal'), all, {}, by);
    };
    round();
    expect(run.vars.runde_item).toBe('a/two');
    round();
    expect(run.stage).toBe('ende');
  });

  it('predicts the round and the way out', () => {
    const m = review();
    const all = models([m]);
    const run = startRun(m, all, { title: 'X', ticket: '', target: 'main', repos: [] }, by);
    expect(predictStages(m, run)).toEqual([{ id: 'runden' }, { id: 'pruefen' }, { id: 'urteil' }, { id: 'runden', loop: true }, { id: 'ende' }]);
    const inRound = advanceRun(run, all, { forced: true }, by);
    expect(predictStages(m, { ...inRound, vars: { ...inRound.vars, ergebnis: 'ok' } })).toEqual([{ id: 'urteil' }, { id: 'runden' }, { id: 'ende' }]);
  });

  it('keeps scripts from overwriting the run’s own fields', () => {
    const m = normalizeProcess({ title: 'T', stages: [{ id: 'a', onEnter: 'title = "anders"\nticket = "X"\nok = "ja"', steps: [], next: [{ to: 'e' }] }, { id: 'e', kind: 'end' }] })!;
    const run = startRun(m, models([m]), { title: 'Echt', ticket: 'T-1', target: 'main', repos: [] }, by);
    expect(run.vars).toEqual({ ok: 'ja' });
    expect(run.title).toBe('Echt');
  });
});
