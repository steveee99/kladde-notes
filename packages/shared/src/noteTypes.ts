/**
 * Custom note types: a hidden note `_type-<uuid>.md` models how notes with `type: custom:<name>` look:
 *
 *   ---
 *   type: note-type
 *   name: Meeting
 *   frontmatter: hide
 *   position: right
 *   properties:
 *     - name: Date
 *       type: date
 *       default: "{{date}}"
 *     - name: Status
 *       type: select
 *       options: [planned, done]
 *       position: top
 *   ---
 *
 * `frontmatter` says whether the raw properties row stays visible, `position` where the modelled properties show (each
 * property may have its own). Values stay plain frontmatter of the notes. A type belongs to its space (own notes or one
 * group). A renamed type keeps its old names in `aliases`, so notes that use them need no change.
 */

import { parseProperties, propertyYaml, readValue, setCell, writeValue, type DbProperty, type DbValue } from './database.js';
import { parseFrontmatter, setFrontmatter } from './markdown.js';
import { isNoteTypePath } from './noteTypePath.js';
import { fillTemplate } from './templates.js';
import { readFrontmatterYaml, setFrontmatterValues, type YamlMap } from './yaml.js';

export const CUSTOM_TYPE_PREFIX = 'custom:';
export const PANEL_POSITIONS = ['top', 'right', 'bottom', 'hidden'] as const;
export type PanelPosition = (typeof PANEL_POSITIONS)[number];

export interface TypeProperty extends DbProperty {
  /** Empty: where the type puts its properties */
  position: PanelPosition | '';
}

export interface NoteType {
  name: string;
  /** Names the type had before */
  aliases: string[];
  /** Whether the notes' raw frontmatter row shows besides the modelled properties */
  showFrontmatter: boolean;
  position: PanelPosition;
  properties: TypeProperty[];
}

const NAME = /^[\p{L}\p{N}_](?:[\p{L}\p{N}\p{M}_ .-]{0,62}[\p{L}\p{N}\p{M}_.-])?$/u;

/** Names that can be written as `type: custom:<name>` without quotes */
export const isNoteTypeName = (name: string): boolean => NAME.test(name);

/** Names match whatever their case and Unicode form */
export const noteTypeKey = (name: string): string => name.trim().normalize('NFC').toLowerCase();

/** `type` is what makes a note of the type, so it cannot be one of its properties */
export const isTypePropertyName = (name: string): boolean => !!name.trim() && name.trim().toLowerCase() !== 'type' && !/[\r\n]/.test(name);

/** The `<name>` of a note's `type: custom:<name>`; null without one */
export function customTypeOf(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const m = /^custom:(.+)$/i.exec(parseFrontmatter(content).data.type ?? '');
  return m ? m[1].trim() || null : null;
}

/** Makes a note one of a custom type (`null`: of none; other values of `type` are left alone then) */
export function setCustomType(content: string, name: string | null): string {
  if (name === null) return customTypeOf(content) === null ? content : setFrontmatter(content, { type: null });
  return setFrontmatter(content, { type: `${CUSTOM_TYPE_PREFIX}${name}` });
}

const position = (v: unknown): PanelPosition | '' => {
  const p = typeof v === 'string' ? (v.trim().toLowerCase() as PanelPosition) : '';
  return p && PANEL_POSITIONS.includes(p) ? p : '';
};

/** Parses a definition note; null when it is none or its name is unusable */
export function parseNoteType(content: string): NoteType | null {
  const fm = readFrontmatterYaml(content);
  if (!fm || typeof fm.data.type !== 'string' || fm.data.type.toLowerCase() !== 'note-type') return null;
  const name = typeof fm.data.name === 'string' ? fm.data.name.trim() : '';
  if (!isNoteTypeName(name)) return null;
  const raw = Array.isArray(fm.data.properties) ? fm.data.properties : [];
  const positions = new Map<string, PanelPosition | ''>();
  for (const p of raw) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.name !== 'string') continue;
    const key = p.name.trim().toLowerCase();
    if (!positions.has(key)) positions.set(key, position(p.position));
  }
  const aliases = Array.isArray(fm.data.aliases) ? fm.data.aliases : [fm.data.aliases];
  return {
    name,
    aliases: aliases.filter((a): a is string => typeof a === 'string' && isNoteTypeName(a)),
    showFrontmatter: fm.data.frontmatter === 'show',
    position: position(fm.data.position) || 'top',
    properties: parseProperties(fm.data.properties)
      .filter((p) => isTypePropertyName(p.name))
      .map((p) => ({ ...p, position: positions.get(p.name.toLowerCase()) ?? '' })),
  };
}

/** Writes a definition into its note, keeping other frontmatter and the body */
export function writeNoteType(content: string, type: NoteType): string {
  return setFrontmatterValues(content, {
    type: 'note-type',
    name: type.name,
    aliases: type.aliases.length ? type.aliases : undefined,
    frontmatter: type.showFrontmatter ? 'show' : 'hide',
    position: type.position,
    properties: type.properties.map((p): YamlMap => (p.position ? { ...propertyYaml(p), position: p.position } : propertyYaml(p))),
  });
}

/** The types the definition notes among `notes` (one space) describe, by path; of two with the same name the first counts */
export function noteTypesOf(notes: Iterable<{ path: string; content: string }>): NoteType[] {
  const found = [...notes].filter((n) => isNoteTypePath(n.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out: NoteType[] = [];
  for (const n of found) {
    const type = parseNoteType(n.content);
    if (type && !out.some((t) => noteTypeKey(t.name) === noteTypeKey(type.name))) out.push(type);
  }
  return out;
}

/** The type called `name`; a current name wins over a former one */
export function findNoteType<T extends NoteType>(types: readonly T[], name: string): T | null {
  const key = noteTypeKey(name);
  return types.find((t) => noteTypeKey(t.name) === key) ?? types.find((t) => t.aliases.some((a) => noteTypeKey(a) === key)) ?? null;
}

export const propertyPosition = (type: NoteType, p: TypeProperty): PanelPosition => p.position || type.position;

/** The properties of a type that show at a position, in order */
export const propertiesAt = (type: NoteType, where: PanelPosition): TypeProperty[] => type.properties.filter((p) => propertyPosition(type, p) === where);

/** A note's values of the modelled properties, by property name */
export function typeValues(type: NoteType, content: string): Record<string, DbValue> {
  const data = readFrontmatterYaml(content)?.data ?? {};
  const keys = Object.keys(data);
  const values: Record<string, DbValue> = {};
  for (const p of type.properties) {
    const key = keys.find((k) => k === p.name) ?? keys.find((k) => k.toLowerCase() === p.name.toLowerCase());
    values[p.name] = readValue(p.type, key === undefined ? undefined : data[key]);
  }
  return values;
}

/** Fills the defaults of a type in a new note: only for properties the note does not mention yet */
export function applyTypeDefaults(content: string, type: NoteType, vars: { title: string; date?: string; zid?: string }): string {
  const present = new Set(Object.keys(readFrontmatterYaml(content)?.data ?? {}).map((k) => k.toLowerCase()));
  for (const p of type.properties) {
    if (!p.default || present.has(p.name.toLowerCase())) continue;
    const text = fillTemplate(p.default, vars);
    const value: DbValue = p.type === 'multiselect' ? text.split(',').map((s) => s.trim()).filter(Boolean) : p.type === 'checkbox' ? /^(true|yes|ja|1)$/i.test(text) : text;
    if (writeValue(p.type, value) !== undefined) content = setCell(content, p, value);
  }
  return content;
}
