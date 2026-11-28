/**
 * Stage scripts of guided processes (shared/process.ts): a stage may run a small script when a run enters it
 * (`onEnter`) and when it leaves it (`onExit`). The language is line based and never evaluates JavaScript:
 *
 *     # a comment
 *     notify("owner", "Der Test für {{run.title}} beginnt")
 *     protokoll = note("Projekte/{{run.ticket}}/Testprotokoll", "Testprotokoll")
 *     runde = runde + 1
 *     inc("versuche")
 *     done("t1")
 *     if testergebnis == "fehler": notify("@anna @ben", "Fehler in {{run.title}}")
 *     log("Test gestartet")
 *
 * Statements: a call, an assignment `name = expression`, or `if <condition>: <statement>`. Expressions are strings
 * (`"…"`, `{{run.x}}` is filled in), numbers, run variables (`ticket`, `run.ticket`) and calls, joined with `+` (adds
 * numbers, otherwise joins text) or `-` (numbers). Conditions compare two expressions (`==`, `!=`, `<`, `<=`, `>`,
 * `>=`), test a variable (`bug`, `not bug`) or join such tests with `and`/`or`.
 *
 * The engine evaluates everything that only touches the run (variables, done steps) right away; what reaches out of
 * the run (a notification, a new note, a log line) becomes an **action**: it lands in the run's `actions` with its
 * texts filled in, and the server carries it out once (server/process/ProcessActions.ts).
 */

export type ProcessActionKind = 'notify' | 'note' | 'log';
export const PROCESS_ACTION_KINDS: ProcessActionKind[] = ['notify', 'note', 'log'];

/** Something a script asked for outside the run, kept in the run until the server did it */
export interface ProcessAction {
  /** Unique within the run */
  id: string;
  kind: ProcessActionKind;
  /** The stage whose script asked for it and when (`enter` or `exit`) */
  stage: string;
  on: 'enter' | 'exit';
  at: number;
  by: string;
  /** notify: who (`owner`, `me`, `all`, user names) */
  to?: string;
  /** notify, log: the text */
  text?: string;
  /** note: path of the note inside the run's space (with `.md` left off) */
  path?: string;
  /** note: name or id of a template of the person who moved the run */
  template?: string;
  /** log: a problem of the script (shown in red) */
  error?: boolean;
}

export const SCRIPT_LIMITS = { lines: 60, length: 4000, actions: 20, steps: 400, text: 1000 };

/** The functions a script may call, with their parameters (for the editor's help and for assistants) */
export const SCRIPT_FUNCTIONS: { name: string; args: string; de: string; en: string }[] = [
  { name: 'notify', args: '(an, text)', de: 'Benachrichtigt Personen: "owner" (wer den Lauf gestartet hat), "me" (wer ihn gerade bewegt), "all" (alle, die den Lauf sehen) oder Benutzernamen wie "@anna @ben".', en: 'Notifies people: "owner" (who started the run), "me" (who moves it right now), "all" (everyone who sees the run) or user names like "@anna @ben".' },
  { name: 'note', args: '(pfad, vorlage?)', de: 'Legt eine Notiz an diesem Pfad im Bereich des Laufs an, optional aus einer Vorlage; gibt den Pfad zurück. Gibt es die Notiz schon, bleibt sie, wie sie ist.', en: 'Creates a note at this path in the run’s space, optionally from a template; returns the path. A note that exists already is left as it is.' },
  { name: 'set', args: '(name, wert)', de: 'Setzt eine Variable des Laufs (wie name = wert).', en: 'Sets a run variable (like name = value).' },
  { name: 'inc', args: '(name, schritt?)', de: 'Zählt eine Variable hoch (um 1 oder den Schritt).', en: 'Counts a variable up (by 1 or the step).' },
  { name: 'clear', args: '(name)', de: 'Leert eine Variable.', en: 'Empties a variable.' },
  { name: 'done', args: '(schritt)', de: 'Hakt einen Schritt (seine id) ab.', en: 'Ticks a step (its id) off.' },
  { name: 'undone', args: '(schritt)', de: 'Öffnet einen Schritt wieder.', en: 'Opens a step again.' },
  { name: 'log', args: '(text)', de: 'Schreibt eine Zeile in die Aktionen des Laufs.', en: 'Writes a line into the run’s actions.' },
];

const FUNCTION_NAMES = new Set(SCRIPT_FUNCTIONS.map((f) => f.name));

// ------------------------------------------------------------------ tokens

type Tok =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

class ScriptError extends Error {}

const IDENT_START = /[A-Za-z_]/;
const IDENT = /[A-Za-z0-9_.]/;
const OPS = ['==', '!=', '<=', '>=', '<', '>', '=', '+', '-', '(', ')', ',', ':', '!'];

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') break;
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      let closed = false;
      while (i < line.length) {
        const d = line[i];
        if (d === '\\' && i + 1 < line.length) {
          const e = line[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          i++;
          break;
        }
        s += d;
        i++;
      }
      if (!closed) throw new ScriptError('Text ohne schließendes Anführungszeichen');
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < line.length && /[0-9.]/.test(line[j])) j++;
      const n = Number(line.slice(i, j));
      if (!Number.isFinite(n)) throw new ScriptError(`Zahl „${line.slice(i, j)}“ ist ungültig`);
      out.push({ t: 'num', v: n });
      i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < line.length && IDENT.test(line[j])) j++;
      out.push({ t: 'id', v: line.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => line.startsWith(o, i));
    if (!op) throw new ScriptError(`Unerwartetes Zeichen „${c}“`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

// ------------------------------------------------------------------ syntax

type Expr =
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'bin'; op: '+' | '-'; a: Expr; b: Expr };

type Cond =
  | { k: 'cmp'; op: string; a: Expr; b: Expr }
  | { k: 'truthy'; e: Expr; not: boolean }
  | { k: 'join'; and: boolean; a: Cond; b: Cond };

type Stmt = { k: 'call'; call: Expr & { k: 'call' } } | { k: 'assign'; name: string; e: Expr } | { k: 'if'; cond: Cond; then: Stmt };

const VAR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const varOf = (name: string): string => (name.startsWith('run.') ? name.slice(4) : name);

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && t.v === v;
  }
  private isWord(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'id' && t.v === v;
  }
  private expectOp(v: string): void {
    if (!this.isOp(v)) throw new ScriptError(`„${v}“ erwartet`);
    this.i++;
  }
  end(): void {
    if (this.i < this.toks.length) throw new ScriptError('Zu viel am Ende der Zeile');
  }

  stmt(): Stmt {
    if (this.isWord('if')) {
      this.i++;
      const cond = this.cond();
      this.expectOp(':');
      if (this.i >= this.toks.length) throw new ScriptError('Nach „:“ fehlt die Anweisung');
      return { k: 'if', cond, then: this.stmt() };
    }
    const t = this.peek();
    if (t?.t === 'id' && this.toks[this.i + 1]?.t === 'op' && (this.toks[this.i + 1] as { v: string }).v === '=') {
      const name = varOf(t.v);
      if (!VAR_NAME.test(name)) throw new ScriptError(`„${t.v}“ ist kein gültiger Variablenname`);
      this.i += 2;
      return { k: 'assign', name, e: this.expr() };
    }
    const e = this.primary();
    if (e.k !== 'call') throw new ScriptError('Eine Zeile ist ein Aufruf wie notify(…), eine Zuweisung (name = …) oder if …: …');
    return { k: 'call', call: e };
  }

  cond(): Cond {
    let left = this.condAtom();
    while (this.isWord('and') || this.isWord('or')) {
      const and = (this.peek() as { v: string }).v === 'and';
      this.i++;
      left = { k: 'join', and, a: left, b: this.condAtom() };
    }
    return left;
  }

  private condAtom(): Cond {
    if (this.isWord('not') || this.isOp('!')) {
      this.i++;
      return { k: 'truthy', e: this.expr(), not: true };
    }
    const a = this.expr();
    const t = this.peek();
    if (t?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.i++;
      return { k: 'cmp', op: t.v, a, b: this.expr() };
    }
    return { k: 'truthy', e: a, not: false };
  }

  expr(): Expr {
    let left = this.primary();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.peek() as { v: string }).v as '+' | '-';
      this.i++;
      left = { k: 'bin', op, a: left, b: this.primary() };
    }
    return left;
  }

  private primary(): Expr {
    const t = this.peek();
    if (!t) throw new ScriptError('Ausdruck fehlt');
    this.i++;
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'op' && t.v === '-' && this.peek()?.t === 'num') {
      const n = this.peek() as { v: number };
      this.i++;
      return { k: 'num', v: -n.v };
    }
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.t !== 'id') throw new ScriptError(`Unerwartet: „${t.v}“`);
    if (this.isOp('(')) {
      this.i++;
      if (!FUNCTION_NAMES.has(t.v)) throw new ScriptError(`Die Funktion „${t.v}“ gibt es nicht (${[...FUNCTION_NAMES].join(', ')})`);
      const args: Expr[] = [];
      if (!this.isOp(')')) {
        args.push(this.expr());
        while (this.isOp(',')) {
          this.i++;
          args.push(this.expr());
        }
      }
      this.expectOp(')');
      checkArity(t.v, args.length);
      return { k: 'call', name: t.v, args };
    }
    if (['if', 'and', 'or', 'not'].includes(t.v)) throw new ScriptError(`„${t.v}“ steht hier falsch`);
    const name = varOf(t.v);
    if (!VAR_NAME.test(name)) throw new ScriptError(`„${t.v}“ ist kein gültiger Variablenname`);
    return { k: 'var', name };
  }
}

const ARITY: Record<string, [number, number]> = { notify: [2, 2], note: [1, 2], set: [2, 2], inc: [1, 2], clear: [1, 1], done: [1, 1], undone: [1, 1], log: [1, 1] };

function checkArity(name: string, n: number): void {
  const [min, max] = ARITY[name];
  if (n < min || n > max) throw new ScriptError(`${name}() braucht ${min === max ? min : `${min} bis ${max}`} Angabe${max === 1 ? '' : 'n'}`);
}

export interface ScriptLine {
  line: number;
  stmt: Stmt;
}

export interface ParsedScript {
  lines: ScriptLine[];
  /** Problems by line (1-based), in German like the other model checks */
  errors: { line: number; message: string }[];
}

/** Splits and parses a script; lines with errors are reported and left out */
export function parseScript(source: string): ParsedScript {
  const lines: ScriptLine[] = [];
  const errors: { line: number; message: string }[] = [];
  const all = source.slice(0, SCRIPT_LIMITS.length).split(/\r?\n/);
  if (all.length > SCRIPT_LIMITS.lines) errors.push({ line: SCRIPT_LIMITS.lines + 1, message: `Höchstens ${SCRIPT_LIMITS.lines} Zeilen; der Rest fällt weg` });
  all.slice(0, SCRIPT_LIMITS.lines).forEach((text, i) => {
    try {
      const toks = tokenize(text);
      if (!toks.length) return;
      const p = new Parser(toks);
      const stmt = p.stmt();
      p.end();
      lines.push({ line: i + 1, stmt });
    } catch (err) {
      if (err instanceof ScriptError) errors.push({ line: i + 1, message: err.message });
      else throw err;
    }
  });
  return { lines, errors };
}

/** What is wrong with a script, as sentences (empty when it is fine) */
export function scriptProblems(source: string): string[] {
  return parseScript(source).errors.map((e) => `Zeile ${e.line}: ${e.message}`);
}

// ------------------------------------------------------------------ running

const RUN_VAR = /\{\{\s*run\.([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;

export interface ScriptEffects {
  /** Variables after the script (the caller writes them into the node) */
  vars: Record<string, string>;
  /** Variables the script changed or cleared (`''` = cleared) */
  changed: Record<string, string>;
  /** Step ids ticked off and opened again */
  done: string[];
  undone: string[];
  actions: Omit<ProcessAction, 'id' | 'stage' | 'on' | 'at' | 'by'>[];
  /** Problems while running (a too long script, too many actions) */
  errors: string[];
}

const numberOf = (s: string): number | null => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));
const cut = (s: string): string => s.slice(0, SCRIPT_LIMITS.text);

/**
 * Runs a script against the run's variables (`vars`: what `{{run.x}}` sees). Pure: changed variables and steps come
 * back for the caller to write into the node, side effects as `actions`.
 */
export function runScript(source: string, vars: Record<string, string>): ScriptEffects {
  const scope: Record<string, string> = { ...vars };
  const fx: ScriptEffects = { vars: scope, changed: {}, done: [], undone: [], actions: [], errors: [] };
  const parsed = parseScript(source);
  let budget = SCRIPT_LIMITS.steps;
  const fill = (s: string) => s.replace(RUN_VAR, (_, name: string) => scope[name] ?? '');
  const assign = (name: string, value: string) => {
    if (!VAR_NAME.test(name)) return;
    const v = cut(value);
    if (v) scope[name] = v;
    else delete scope[name];
    fx.changed[name] = v;
  };
  const value = (e: Expr): string => {
    if (--budget < 0) throw new ScriptError('Das Skript ist zu lang');
    switch (e.k) {
      case 'str':
        return cut(fill(e.v));
      case 'num':
        return fmt(e.v);
      case 'var':
        return scope[e.name] ?? '';
      case 'bin': {
        const a = value(e.a);
        const b = value(e.b);
        const na = numberOf(a);
        const nb = numberOf(b);
        if (e.op === '-') return na !== null && nb !== null ? fmt(na - nb) : a;
        return na !== null && nb !== null ? fmt(na + nb) : cut(a + b);
      }
      case 'call':
        return call(e);
    }
  };
  const act = (a: ScriptEffects['actions'][number]) => {
    if (fx.actions.length >= SCRIPT_LIMITS.actions) throw new ScriptError(`Höchstens ${SCRIPT_LIMITS.actions} Aktionen je Skript`);
    fx.actions.push(a);
  };
  const call = (e: Expr & { k: 'call' }): string => {
    const args = e.args.map(value);
    switch (e.name) {
      case 'notify': {
        if (args[0].trim() && args[1].trim()) act({ kind: 'notify', to: args[0].trim().slice(0, 300), text: args[1] });
        return '';
      }
      case 'note': {
        const path = cleanNotePath(args[0]);
        if (!path) throw new ScriptError('note() braucht einen Pfad');
        act({ kind: 'note', path, ...(args[1]?.trim() ? { template: args[1].trim().slice(0, 160) } : {}) });
        return path;
      }
      case 'log': {
        if (args[0].trim()) act({ kind: 'log', text: args[0] });
        return '';
      }
      case 'set':
        assign(varOf(args[0].trim()), args[1]);
        return args[1];
      case 'inc': {
        const name = varOf(args[0].trim());
        const next = fmt((numberOf(scope[name] ?? '') ?? 0) + (numberOf(args[1] ?? '') ?? 1));
        assign(name, next);
        return next;
      }
      case 'clear':
        assign(varOf(args[0].trim()), '');
        return '';
      case 'done':
      case 'undone': {
        const id = args[0].trim();
        if (/^[A-Za-z0-9_-]{1,60}$/.test(id)) (e.name === 'done' ? fx.done : fx.undone).push(id);
        return '';
      }
    }
    return '';
  };
  const test = (c: Cond): boolean => {
    if (c.k === 'join') return c.and ? test(c.a) && test(c.b) : test(c.a) || test(c.b);
    if (c.k === 'truthy') {
      const v = value(c.e);
      const yes = v !== '' && v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'nein';
      return c.not ? !yes : yes;
    }
    const a = value(c.a);
    const b = value(c.b);
    const na = numberOf(a);
    const nb = numberOf(b);
    const cmp = na !== null && nb !== null ? na - nb : a < b ? -1 : a > b ? 1 : 0;
    switch (c.op) {
      case '==':
        return na !== null && nb !== null ? na === nb : a === b;
      case '!=':
        return na !== null && nb !== null ? na !== nb : a !== b;
      case '<':
        return cmp < 0;
      case '<=':
        return cmp <= 0;
      case '>':
        return cmp > 0;
      default:
        return cmp >= 0;
    }
  };
  const exec = (s: Stmt) => {
    if (s.k === 'if') {
      if (test(s.cond)) exec(s.then);
    } else if (s.k === 'assign') assign(s.name, value(s.e));
    else call(s.call);
  };
  for (const { line, stmt } of parsed.lines) {
    try {
      exec(stmt);
    } catch (err) {
      if (!(err instanceof ScriptError)) throw err;
      fx.errors.push(`Zeile ${line}: ${err.message}`);
      if (budget < 0 || fx.actions.length >= SCRIPT_LIMITS.actions) break;
    }
  }
  for (const e of parsed.errors) fx.errors.push(`Zeile ${e.line}: ${e.message}`);
  return fx;
}

/** A note path from a script: folders and a name, no `..`, no leading `/`, without `.md` */
export function cleanNotePath(raw: string): string {
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    // eslint-disable-next-line no-control-regex
    .map((p) => p.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  const path = parts.join('/').slice(0, 300);
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}

/** The script text from a model's JSON: a string or a list of lines */
export function scriptText(raw: unknown): string {
  if (typeof raw === 'string') return raw.slice(0, SCRIPT_LIMITS.length);
  if (Array.isArray(raw)) return raw.filter((l) => typeof l === 'string').join('\n').slice(0, SCRIPT_LIMITS.length);
  return '';
}
