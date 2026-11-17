import { parseFrontmatter } from './markdown.js';

/*
 * Note and folder icons (opt-in feature `icons`): a single emoji. A note keeps it in its frontmatter
 * (`icon: 🚀`), so it travels with the note through shares, exports and imports; folder icons live in
 * the user's synced settings (`folderIcons`), keyed by folder path (group folders: `g:<group id>/<folder>`).
 */

/** Frontmatter key of a note's icon */
export const ICON_KEY = 'icon';

/** Synced setting with the folder icons */
export const FOLDER_ICONS_SETTING = 'folderIcons';

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/**
 * A usable icon from user or note input, or null: one short emoji (sequences with skin tones, ZWJ
 * and flags included), no letters, digits, spaces or markup.
 */
export function cleanIcon(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 16 || !PICTOGRAPHIC.test(value)) return null;
  // Digits and # are allowed only as keycap emoji (1️⃣, #️⃣)
  if (/[\s<>"'`&\p{L}]/u.test(value) || /[\d#*](?!️?⃣)/u.test(value)) return null;
  return value;
}

/** The icon a note sets in its frontmatter, or null */
export function noteIconOf(content: string): string | null {
  if (!content.startsWith('---')) return null;
  return cleanIcon(parseFrontmatter(content).data[ICON_KEY]);
}

/** Setting key of a folder icon: own folders by path, group folders (#58) as `g:<group id>/<folder>` */
export function folderIconKey(folder: string, groupId?: string): string {
  return groupId ? `g:${groupId}/${folder}` : folder;
}

/** The folder icon map from the synced setting, keeping only valid entries */
export function normalizeFolderIcons(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const icon = cleanIcon(value);
    if (key && icon) out[key] = icon;
  }
  return out;
}

/** Folder icons after renaming or moving `from` to `to`: the folder and every subfolder keep their icons */
export function renameFolderIcons(icons: Record<string, string>, from: string, to: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, icon] of Object.entries(icons)) {
    const moved = key === from || key.startsWith(`${from}/`) ? to + key.slice(from.length) : key;
    out[moved] = icon;
  }
  return out;
}

/** Folder icons without `folder` and its subfolders (after deleting it) */
export function dropFolderIcons(icons: Record<string, string>, folder: string): Record<string, string> {
  return Object.fromEntries(Object.entries(icons).filter(([key]) => key !== folder && !key.startsWith(`${folder}/`)));
}

/** A small choice of icons for the picker; any other emoji can be typed or pasted */
export const ICON_CHOICES = [
  '📁', '📂', '🗂️', '📝', '📄', '📌', '📎', '📚', '📖', '🔖',
  '💡', '⭐', '🔥', '🚀', '🎯', '✅', '❗', '❓', '⚠️', '🔒',
  '🏠', '🏢', '💼', '🧑‍💻', '👥', '❤️', '🎉', '🎓', '🧪', '🔬',
  '💰', '📈', '📊', '🛒', '🍳', '🍽️', '☕', '🏃', '🧘', '🩺',
  '✈️', '🗺️', '🚗', '🌱', '🌍', '☀️', '🌙', '🎵', '🎨', '📷',
  '🎮', '⚽', '🛠️', '⚙️', '💻', '📱', '🐛', '🤖', '🧠', '📅',
] as const;
