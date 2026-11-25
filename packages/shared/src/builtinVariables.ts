/**
 * Built-in variables: dates relative to today (`{{var:today}}`, `{{var:nextWeek}}`, …). They need no definition note,
 * work in every folder and are filled in whenever the note is shown or exported, so they always mean the day the note
 * is read. A variable of the same name defined in a folder wins. Every name has a German alias (`{{var:morgen}}`).
 */

import { monthLabel, periodEnd, periodStart, shiftPeriod, weekLabel } from './periodic.js';
import { isoWeek } from './para.js';
import { toDateString } from './tasks.js';

export interface BuiltinVariable {
  /** The name shown first (English) */
  name: string;
  /** German spelling */
  alias: string;
  value(now: Date): string;
}

const addDays = (now: Date, days: number): string => toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
const week = (now: Date, delta: number): string => weekLabel(shiftPeriod('week', now, delta));
const month = (now: Date, delta: number): string => monthLabel(shiftPeriod('month', now, delta));

/** In the order they are offered */
export const BUILTIN_VARIABLES: readonly BuiltinVariable[] = [
  { name: 'today', alias: 'heute', value: (now) => addDays(now, 0) },
  { name: 'tomorrow', alias: 'morgen', value: (now) => addDays(now, 1) },
  { name: 'yesterday', alias: 'gestern', value: (now) => addDays(now, -1) },
  { name: 'week', alias: 'woche', value: (now) => week(now, 0) },
  { name: 'nextWeek', alias: 'nächsteWoche', value: (now) => week(now, 1) },
  { name: 'lastWeek', alias: 'letzteWoche', value: (now) => week(now, -1) },
  { name: 'weekNumber', alias: 'kw', value: (now) => String(isoWeek(now)) },
  { name: 'weekStart', alias: 'wochenstart', value: (now) => periodStart('week', now) },
  { name: 'weekEnd', alias: 'wochenende', value: (now) => periodEnd('week', now) },
  { name: 'nextWeekStart', alias: 'nächsterMontag', value: (now) => shiftPeriod('week', now, 1) },
  { name: 'month', alias: 'monat', value: (now) => month(now, 0) },
  { name: 'nextMonth', alias: 'nächsterMonat', value: (now) => month(now, 1) },
  { name: 'lastMonth', alias: 'letzterMonat', value: (now) => month(now, -1) },
  { name: 'year', alias: 'jahr', value: (now) => String(now.getFullYear()) },
  { name: 'nextYear', alias: 'nächstesJahr', value: (now) => String(now.getFullYear() + 1) },
];

const byKey = new Map<string, BuiltinVariable>();
for (const b of BUILTIN_VARIABLES) for (const n of [b.name, b.alias]) byKey.set(n.normalize('NFC').toLowerCase(), b);

/** The built-in variable of a name (any case, English or German); undefined for any other name */
export const builtinVariable = (name: string): BuiltinVariable | undefined => byKey.get(name.normalize('NFC').toLowerCase());

/** The value of a built-in variable for `now`; undefined for any other name */
export function builtinValue(name: string, now: Date = new Date()): string | undefined {
  return builtinVariable(name)?.value(now);
}
