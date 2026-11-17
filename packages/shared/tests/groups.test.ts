import { describe, expect, it } from 'vitest';
import { canWriteInGroup, cleanGroupName, groupMovePath, isGroupRole, keepsAnOwner } from '../src/groups';

describe('groups (#58)', () => {
  it('knows the roles and who writes', () => {
    expect(isGroupRole('owner')).toBe(true);
    expect(isGroupRole('admin')).toBe(false);
    expect(isGroupRole(1)).toBe(false);
    expect(canWriteInGroup('owner')).toBe(true);
    expect(canWriteInGroup('editor')).toBe(true);
    expect(canWriteInGroup('reader')).toBe(false);
    expect(canWriteInGroup(null)).toBe(false);
  });

  it('cleans group names', () => {
    expect(cleanGroupName('  Familie   Muster \n')).toBe('Familie Muster');
    expect(cleanGroupName('   ')).toBeNull();
    expect(cleanGroupName(42)).toBeNull();
    expect(cleanGroupName('x'.repeat(100))).toHaveLength(60);
  });

  it('never lets the last owner go', () => {
    const members = [
      { userId: 'a', role: 'owner' as const },
      { userId: 'b', role: 'editor' as const },
    ];
    expect(keepsAnOwner(members, 'a', null)).toBe(false);
    expect(keepsAnOwner(members, 'a', 'reader')).toBe(false);
    expect(keepsAnOwner(members, 'a', 'owner')).toBe(true);
    expect(keepsAnOwner(members, 'b', null)).toBe(true);
    // a second owner frees the first
    expect(keepsAnOwner([...members, { userId: 'c', role: 'owner' }], 'a', null)).toBe(true);
  });

  it('places moved notes in the group', () => {
    // a whole folder keeps its name and inner structure
    expect(groupMovePath('Arbeit/Kunde/Unter/B.md', 'Kunden', 'Arbeit/Kunde')).toBe('Kunden/Kunde/Unter/B.md');
    expect(groupMovePath('Kunde/A.md', '', 'Kunde')).toBe('Kunde/A.md');
    // a single note lands directly in the target
    expect(groupMovePath('Arbeit/Kunde/A.md', '')).toBe('A.md');
    expect(groupMovePath('Arbeit/Kunde/A.md', 'Ziel/Unter/')).toBe('Ziel/Unter/A.md');
  });
});
