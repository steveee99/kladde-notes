import { describe, expect, it } from 'vitest';
import { cleanIcon, dropFolderIcons, folderIconKey, normalizeFeatures, normalizeFolderIcons, noteIconOf, renameFolderIcons } from '../src/index.js';

describe('icons', () => {
  it('accepts single emoji, including sequences', () => {
    expect(cleanIcon('🚀')).toBe('🚀');
    expect(cleanIcon(' ⭐ ')).toBe('⭐');
    expect(cleanIcon('🧑‍💻')).toBe('🧑‍💻');
    expect(cleanIcon('👍🏽')).toBe('👍🏽');
    expect(cleanIcon('🇩🇪')).toBe('🇩🇪');
    expect(cleanIcon('1️⃣')).toBe('1️⃣');
    expect(cleanIcon('⚠️')).toBe('⚠️');
  });

  it('rejects text, markup and long values', () => {
    expect(cleanIcon('rocket')).toBeNull();
    expect(cleanIcon('🚀 rocket')).toBeNull();
    expect(cleanIcon('<b>🚀</b>')).toBeNull();
    expect(cleanIcon('12')).toBeNull();
    expect(cleanIcon('#')).toBeNull();
    expect(cleanIcon('🚀'.repeat(10))).toBeNull();
    expect(cleanIcon('')).toBeNull();
    expect(cleanIcon(42)).toBeNull();
  });

  it('reads the icon from the frontmatter', () => {
    expect(noteIconOf('---\nicon: 📚\n---\n# Bücher')).toBe('📚');
    expect(noteIconOf('---\nicon: "🍳"\ntags: x\n---\n')).toBe('🍳');
    expect(noteIconOf('---\nicon: book\n---\n')).toBeNull();
    expect(noteIconOf('icon: 📚\n')).toBeNull();
  });

  it('keeps folder icons with renamed folders and drops them with deleted ones', () => {
    const icons = normalizeFolderIcons({ Projekte: '🚀', 'Projekte/Web': '💻', Privat: '🏠', bad: 'x', [folderIconKey('A', 'g1')]: '👥' });
    expect(icons).toEqual({ Projekte: '🚀', 'Projekte/Web': '💻', Privat: '🏠', 'g:g1/A': '👥' });
    expect(renameFolderIcons(icons, 'Projekte', 'Archiv/Projekte')).toEqual({
      'Archiv/Projekte': '🚀',
      'Archiv/Projekte/Web': '💻',
      Privat: '🏠',
      'g:g1/A': '👥',
    });
    expect(renameFolderIcons({ Pro: '1️⃣', Projekte: '🚀' }, 'Pro', 'X')).toEqual({ X: '1️⃣', Projekte: '🚀' });
    expect(dropFolderIcons(icons, 'Projekte')).toEqual({ Privat: '🏠', 'g:g1/A': '👥' });
  });

  it('is an opt-in feature', () => {
    expect(normalizeFeatures({}).icons.enabled).toBe(false);
    expect(normalizeFeatures({ icons: { enabled: true } }).icons.enabled).toBe(true);
  });
});
