import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { AttachmentInfo, DeleteFilesResponse, SYSTEM_PREFIX } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';

let tmpDir = '';
let server: Server;
let base = '';

const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
const notes = new NoteStore(db, cipher);
let files: FileStore;

const anna = users.createUser('anna');
const ben = users.createUser('ben');
const annaCookie = `kladde_session=${users.createSession(anna.id)}`;
const benCookie = `kladde_session=${users.createSession(ben.id)}`;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-files-test-'));
  files = new FileStore(db, cipher, tmpDir);

  const app = express();
  // Mirror packages/server/src/index.ts JSON middleware condition so /files upload skips express.json
  app.use('/api', (req, res, next) => (req.path === '/sync' || req.path === '/files' ? next() : express.json({ limit: '256kb' })(req, res, next)));
  app.use('/api', apiRouter(users, notes, files, new LiveUpdates()));

  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Files / attachment management API', () => {
  it('requires authentication for listing and deleting attachments', async () => {
    const listRes = await fetch(`${base}/api/files`);
    expect(listRes.status).toBe(401);

    const delRes = await fetch(`${base}/api/files/nonexistent000000000000`, { method: 'DELETE' });
    expect(delRes.status).toBe(401);

    const bulkRes = await fetch(`${base}/api/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['nonexistent000000000000'] }),
    });
    expect(bulkRes.status).toBe(401);
  });

  it('lists owner attachments with note usage and blocks deletion of referenced attachments', async () => {
    const usedImg = files.save(anna.id, 'sketch.png', 'image/png', Buffer.from([1, 2, 3]));
    const galleryImg = files.save(anna.id, 'holiday.webp', 'image/webp', Buffer.from([4, 5, 6]));
    const unusedPdf = files.save(anna.id, 'old-doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    const removedNoteImg = files.save(anna.id, 'deleted-note.png', 'image/png', Buffer.from([7, 8]));
    const benFile = files.save(ben.id, 'ben-secret.png', 'image/png', Buffer.from([9, 10]));

    const now = Date.now();
    notes.push(anna.id, [
      {
        id: 'note-gallery-1',
        baseVersion: 0,
        path: 'Reisen/Sommer.md',
        content: `# Sommer\n![Skizze](/api/files/${usedImg.id})\n\n\`\`\`gallery\n/api/files/${galleryImg.id}\n\`\`\`\n`,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'note-deleted-2',
        baseVersion: 0,
        path: 'Papierkorb/Alt.md',
        content: `![Alt](/api/files/${removedNoteImg.id})`,
        deleted: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'note-system-3',
        baseVersion: 0,
        path: `${SYSTEM_PREFIX}cache.json`,
        content: `/api/files/${unusedPdf.id}`,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const res = await fetch(`${base}/api/files`, { headers: { Cookie: annaCookie } });
    expect(res.status).toBe(200);
    const list = (await res.json()) as AttachmentInfo[];
    expect(list.map((f) => f.id).sort()).toEqual([usedImg.id, galleryImg.id, unusedPdf.id, removedNoteImg.id].sort());
    // Does not include Ben's file
    expect(list.some((f) => f.id === benFile.id)).toBe(false);

    const byId = new Map(list.map((f) => [f.id, f]));
    expect(byId.get(usedImg.id)?.usedIn).toEqual([{ id: 'note-gallery-1', path: 'Reisen/Sommer.md', title: 'Sommer' }]);
    expect(byId.get(galleryImg.id)?.usedIn).toEqual([{ id: 'note-gallery-1', path: 'Reisen/Sommer.md', title: 'Sommer' }]);
    // Deleted and system notes do not count as active references
    expect(byId.get(unusedPdf.id)?.usedIn).toEqual([]);
    expect(byId.get(removedNoteImg.id)?.usedIn).toEqual([]);

    // Trying to delete a used attachment fails with 409 and preserves encrypted file on disk
    const blocked = await fetch(`${base}/api/files/${usedImg.id}`, { method: 'DELETE', headers: { Cookie: annaCookie } });
    expect(blocked.status).toBe(409);
    expect(fs.existsSync(path.join(tmpDir, 'files', usedImg.id))).toBe(true);

    // Trying to delete someone else's attachment returns 404
    const foreign = await fetch(`${base}/api/files/${benFile.id}`, { method: 'DELETE', headers: { Cookie: annaCookie } });
    expect(foreign.status).toBe(404);
    expect(files.load(benFile.id)).not.toBeNull();

    // Bulk delete deletes only unused attachments and skips used/foreign ones
    const bulk = await fetch(`${base}/api/files/delete`, {
      method: 'POST',
      headers: { Cookie: annaCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [usedImg.id, unusedPdf.id, removedNoteImg.id, benFile.id] }),
    });
    expect(bulk.status).toBe(200);
    const bulkData = (await bulk.json()) as DeleteFilesResponse;
    expect(bulkData.deleted.sort()).toEqual([unusedPdf.id, removedNoteImg.id].sort());
    expect(bulkData.skippedUsed).toEqual([usedImg.id]);
    expect(bulkData.notFound).toEqual([benFile.id]);

    expect(fs.existsSync(path.join(tmpDir, 'files', unusedPdf.id))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'files', usedImg.id))).toBe(true);
    expect(files.load(benFile.id)).not.toBeNull();

    // Once removed from the note, single DELETE succeeds
    notes.push(anna.id, [
      {
        id: 'note-gallery-1',
        baseVersion: 1,
        path: 'Reisen/Sommer.md',
        content: '# Sommer\nKein Anhang mehr.',
        deleted: false,
        createdAt: now,
        updatedAt: Date.now(),
      },
    ]);
    const okDel = await fetch(`${base}/api/files/${usedImg.id}`, { method: 'DELETE', headers: { Cookie: annaCookie } });
    expect(okDel.status).toBe(200);
    expect(fs.existsSync(path.join(tmpDir, 'files', usedImg.id))).toBe(false);
  });
});
