import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { advanceRun, normalizeProcess, pickOption, processProblems, startRun } from '../src/index';

// The V-Model in docs/PROCESS_SCRIPTS.md is checked like a saved model and walked as the page describes it

const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/PROCESS_SCRIPTS.md'), 'utf8');
const block = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((b) => b.includes('"key": "v-model"'))!;

describe('docs: the V-Model example', () => {
  it('is a valid model and runs as described', () => {
    const raw = JSON.parse(block);
    expect(processProblems(raw)).toEqual([]);
    const m = normalizeProcess(raw)!;
    const all = new Map([[m.key, m]]);
    const t = { by: 'anna', now: Date.now() };
    let r = startRun(m, all, { title: 'Voucher', ticket: 'SHOP-412', target: 'main', repos: ['shop/web', 'shop/api'] }, t);
    const go = () => (r = advanceRun(r, all, { forced: true }, t));
    for (let i = 0; i < 7; i++) go();
    expect(r.stage).toBe('integrationtest');
    go();
    r = pickOption(r, all, 'failed');
    go();
    expect(r.vars.integrationround).toBe('2');
    go();
    r = pickOption(r, all, 'passed');
    go();
    expect(r.stage).toBe('systemtest');
    go();
    go();
    go();
    expect(r.stage).toBe('done');
    expect(r.actions.map((a) => a.kind)).toEqual(['note', 'notify', 'log', 'note', 'notify', 'note', 'notify', 'log', 'note', 'notify', 'note', 'log', 'notify', 'notify']);
    expect(r.actions.some((a) => a.error)).toBe(false);
  });
});
