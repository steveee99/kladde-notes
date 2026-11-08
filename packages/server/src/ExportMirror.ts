import fs from 'fs';
import path from 'path';
import { SYSTEM_PREFIX } from '@kladde/shared';
import type { NoteChangeEvent } from './NoteStore.js';

/**
 * Optional plain Markdown copy of every note below EXPORT_DIR/<username>/ – e.g. a NAS share mounted into
 * the container, picked up by other tools or a backup. Note: this copy is NOT encrypted.
 */
export class ExportMirror {
  constructor(
    private readonly root: string,
    private readonly usernameOf: (userId: string) => string | null
  ) {
    fs.mkdirSync(root, { recursive: true });
  }

  static fromEnv(usernameOf: (userId: string) => string | null, env: NodeJS.ProcessEnv = process.env): ExportMirror | null {
    const dir = env.EXPORT_DIR?.trim();
    return dir ? new ExportMirror(path.resolve(dir), usernameOf) : null;
  }

  private target(userId: string, notePath: string): string | null {
    const user = this.usernameOf(userId);
    if (!user || notePath.startsWith(SYSTEM_PREFIX)) return null;
    const file = path.resolve(this.root, user, notePath.endsWith('.md') ? notePath : `${notePath}.md`);
    // cleanPath already removed "..", this is a second fence
    return file.startsWith(path.resolve(this.root, user) + path.sep) ? file : null;
  }

  apply(event: NoteChangeEvent): void {
    try {
      if (event.previousPath && (event.previousPath !== event.path || event.deleted)) {
        const old = this.target(event.ownerId, event.previousPath);
        if (old) fs.rmSync(old, { force: true });
      }
      if (event.deleted) return;
      const file = this.target(event.ownerId, event.path);
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, event.content);
    } catch (err) {
      console.error('Export: could not write', event.path, err);
    }
  }

  /** Full export of one user, on start-up */
  writeAll(userId: string, notes: { path: string; content: string }[]): void {
    for (const n of notes) {
      this.apply({ noteId: '', ownerId: userId, audience: [], path: n.path, previousPath: null, content: n.content, deleted: false });
    }
  }
}
