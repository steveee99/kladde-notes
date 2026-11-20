/**
 * Groups (#58): a group owns notes, and every member sees them according to their role. Pure rules shared by
 * server and client: roles, the "last owner" guard and where moved notes land in the group.
 */
import type { GroupFeatures, GroupRole } from './types.js';

export const GROUP_ROLES: readonly GroupRole[] = ['owner', 'editor', 'reader'];
export const GROUP_NAME_MAX = 60;

export function isGroupRole(value: unknown): value is GroupRole {
  return typeof value === 'string' && (GROUP_ROLES as readonly string[]).includes(value);
}

/** Owners and editors create, edit, move and delete the group's notes; readers only read them */
export function canWriteInGroup(role: GroupRole | null | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

/** A trimmed group name without control characters, or null when it is empty */
export function cleanGroupName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX).trim();
  return clean || null;
}

/**
 * Whether a membership change keeps at least one owner. `role` is the member's new role, null removes the
 * member. The last owner can neither leave, be removed nor lose the role: promote someone else first.
 */
export function keepsAnOwner(members: { userId: string; role: GroupRole }[], userId: string, role: GroupRole | null): boolean {
  const owners = members.filter((m) => m.role === 'owner' && m.userId !== userId).length;
  return owners > 0 || role === 'owner';
}

/**
 * Where a note lands when it moves into a group. With `folder` (a whole folder moves) the folder keeps its
 * name and inner structure below `target`; otherwise the note lands directly in `target`.
 */
export function groupMovePath(path: string, target: string, folder?: string): string {
  // Split instead of a /\/+$/ regex: that backtracks polynomially on long runs of slashes
  const base = target.split('/').filter(Boolean).join('/');
  let rel: string;
  if (folder) {
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    rel = parent && path.startsWith(`${parent}/`) ? path.slice(parent.length + 1) : path;
  } else {
    rel = path.slice(path.lastIndexOf('/') + 1);
  }
  return base ? `${base}/${rel}` : rel;
}

/** Features of a group as stored on the server (JSON); everything off when missing or unreadable */
export function parseGroupFeatures(raw: unknown): GroupFeatures {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  const o = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
  return { tickets: o.tickets === true };
}
