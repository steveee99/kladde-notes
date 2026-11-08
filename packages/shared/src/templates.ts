import { toDateString } from './tasks.js';

/** A user-made template for new notes; kept in the synced settings, there are none at first */
export interface Template {
  id: string;
  label: string;
  /** Folder new notes from this template go to */
  folder: string;
  content: string;
}

/** Settings key the templates are stored under */
export const TEMPLATES_SETTING = 'templates';

export const TEMPLATE_PLACEHOLDERS: { token: string; label: string }[] = [
  { token: '{{title}}', label: 'Titel der neuen Notiz' },
  { token: '{{date}}', label: 'heutiges Datum (YYYY-MM-DD)' },
  { token: '{{zid}}', label: 'Zettel-ID; die Notiz bekommt sie auch vor den Titel' },
];

/** Reads stored templates defensively: synced settings may come from older or broken clients */
export function normalizeTemplates(value: unknown): Template[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Template[] = [];
  for (const t of value) {
    if (!t || typeof t !== 'object') continue;
    const { id, label, folder, content } = t as Record<string, unknown>;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: typeof label === 'string' && label.trim() ? label.trim() : 'Ohne Namen',
      folder: typeof folder === 'string' ? folder : '',
      content: typeof content === 'string' ? content : '',
    });
  }
  return out;
}

export function templateUsesZettelId(content: string): boolean {
  return content.includes('{{zid}}');
}

export function fillTemplate(content: string, vars: { title: string; date?: string; zid?: string }): string {
  const date = vars.date ?? toDateString(new Date());
  return content.replace(/\{\{title\}\}/g, vars.title).replace(/\{\{date\}\}/g, date).replace(/\{\{zid\}\}/g, vars.zid ?? '');
}
