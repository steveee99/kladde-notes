// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSyncServer } from './support/syncServer';

// The offline store and sync engine (data/vault.ts) against the real server: offline edits, two devices,
// three-way merges, conflict copies, deletions and renames (AGENTS.md, rule 3: conflicts never lose text)

let s: Awaited<ReturnType<typeof startSyncServer>>;
beforeEach(async () => {
  s = await startSyncServer();
});
afterEach(() => s.stop());

/** The user's own notes, without the system notes (settings, folders) */
const own = <N extends { access: string }>(vault: { list(): N[] }) => vault.list().filter((n) => n.access === 'owner');

describe('vault sync', () => {
  it('seeds a new space once: folders, settings and welcome notes', async () => {
    const a = await s.device();
    expect(a.vault.state).toBe('idle');
    const paths = own(a.vault).map((n) => n.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(a.vault.features().para.enabled).toBe(true);
    // Everything reached the server
    expect(a.vault.list().every((n) => !n.dirty)).toBe(true);

    // A second device finds the space and does not seed it again
    const b = await s.device();
    expect(own(b.vault).map((n) => n.path).sort()).toEqual([...paths].sort());
  });

  it('brings a note to the other device and keeps it on the device across restarts', async () => {
    const a = await s.device();
    const b = await s.device();
    const note = await a.vault.create('Projekte', 'Plan', '# Plan\nErster Schritt');
    await a.vault.sync();
    expect(s.serverNote(note.id)?.content).toBe('# Plan\nErster Schritt');

    await b.vault.sync();
    expect(b.vault.get(note.id)?.path).toBe('Projekte/Plan.md');

    // Restart without a network: the notes come from IndexedDB
    a.vault.close();
    s.setOffline(true);
    const again = await s.device(a.idb);
    expect(again.vault.state).toBe('offline');
    expect(again.vault.get(note.id)?.content).toBe('# Plan\nErster Schritt');
  });

  it('keeps offline edits on the device and pushes them once back online', async () => {
    const a = await s.device();
    const note = await a.vault.create('', 'Unterwegs', 'Start');
    await a.vault.sync();

    s.setOffline(true);
    await a.vault.update(note.id, { content: 'Start\nIm Zug geschrieben' });
    await a.vault.sync();
    expect(a.vault.state).toBe('offline');
    expect(a.vault.pendingCount()).toBe(1);
    expect(s.serverNote(note.id)?.content).toBe('Start');

    // The edit survives a restart while still offline
    a.vault.close();
    const restarted = await s.device(a.idb);
    expect(restarted.vault.get(note.id)?.dirty).toBe(true);

    s.setOffline(false);
    await restarted.vault.sync();
    expect(restarted.vault.state).toBe('idle');
    expect(restarted.vault.pendingCount()).toBe(0);
    expect(s.serverNote(note.id)?.content).toBe('Start\nIm Zug geschrieben');
  });

  it('merges edits of two devices to different lines', async () => {
    const a = await s.device();
    const note = await a.vault.create('', 'Einkauf', 'Milch\nBrot\nKäse');
    await a.vault.sync();
    const b = await s.device();

    await a.vault.update(note.id, { content: 'Hafermilch\nBrot\nKäse' });
    await b.vault.update(note.id, { content: 'Milch\nBrot\nBergkäse' });
    await a.vault.sync();
    await b.vault.sync();
    await a.vault.sync();

    expect(s.serverNote(note.id)?.content).toBe('Hafermilch\nBrot\nBergkäse');
    expect(a.vault.get(note.id)?.content).toBe('Hafermilch\nBrot\nBergkäse');
    expect(b.vault.get(note.id)?.content).toBe('Hafermilch\nBrot\nBergkäse');
    // No conflict copy was needed
    expect(own(b.vault).filter((n) => n.path.includes('Einkauf'))).toHaveLength(1);
  });

  it('keeps the losing text as a copy when both devices change the same words', async () => {
    const a = await s.device();
    const note = await a.vault.create('Notizen', 'Termin', 'Treffen am Montag');
    await a.vault.sync();
    const b = await s.device();

    await a.vault.update(note.id, { content: 'Treffen am Dienstag' });
    await b.vault.update(note.id, { content: 'Treffen am Mittwoch' });
    await a.vault.sync();
    await b.vault.sync();

    // The server's version wins on the note itself
    expect(b.vault.get(note.id)?.content).toBe('Treffen am Dienstag');
    const copies = own(b.vault).filter((n) => n.path.startsWith('Notizen/') && n.path !== 'Notizen/Termin.md');
    expect(copies).toHaveLength(1);
    expect(b.vault.get(copies[0].id)?.content).toBe('Treffen am Mittwoch');
    // The copy is synced too
    await b.vault.sync();
    expect(s.serverNote(copies[0].id)?.content).toBe('Treffen am Mittwoch');
  });

  it('deletes on every device and keeps an edit made meanwhile as a copy', async () => {
    const a = await s.device();
    const gone = await a.vault.create('', 'Alt', 'Kann weg');
    const edited = await a.vault.create('', 'Entwurf', 'Erste Fassung');
    await a.vault.sync();
    const b = await s.device();

    await a.vault.remove(gone.id);
    await a.vault.remove(edited.id);
    await b.vault.update(edited.id, { content: 'Zweite Fassung, auf dem Tablet' });
    await a.vault.sync();
    await b.vault.sync();

    expect(b.vault.get(gone.id)).toBeUndefined();
    expect(b.vault.get(edited.id)).toBeUndefined();
    const copy = b.vault.list().find((n) => n.content === 'Zweite Fassung, auf dem Tablet');
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(edited.id);
    // In the server's trash, not purged
    expect(s.ctx.notes.trash(s.user.id).map((e) => e.id).sort()).toEqual([gone.id, edited.id].sort());
  });

  it('rewrites links after a rename and syncs the linking notes', async () => {
    const a = await s.device();
    const target = await a.vault.create('', 'Alte Idee', 'Inhalt');
    const linking = await a.vault.create('', 'Übersicht', 'Siehe [[Alte Idee]] und [[Alte Idee|hier]]');
    await a.vault.sync();
    const b = await s.device();

    await a.vault.update(target.id, { title: 'Neue Idee' });
    expect(a.vault.get(linking.id)?.content).toBe('Siehe [[Neue Idee]] und [[Neue Idee|hier]]');
    await a.vault.sync();
    await b.vault.sync();
    expect(b.vault.get(target.id)?.path).toBe('Neue Idee.md');
    expect(b.vault.get(linking.id)?.content).toBe('Siehe [[Neue Idee]] und [[Neue Idee|hier]]');
  });

  it('gives a new note a free name in its folder', async () => {
    const a = await s.device();
    const first = await a.vault.create('Ordner', 'Doppelt', 'eins');
    const second = await a.vault.create('Ordner', 'Doppelt', 'zwei');
    expect(first.path).toBe('Ordner/Doppelt.md');
    expect(second.path).toBe('Ordner/Doppelt 2.md');
  });

  it('reports a session that ended on the server', async () => {
    const a = await s.device();
    const onUnauthorized = vi.fn();
    a.vault.onUnauthorized = onUnauthorized;
    await a.vault.create('', 'Nach dem Abmelden', 'Text');
    s.signOut();
    await a.vault.sync();
    expect(a.vault.state).toBe('error');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    // The edit is not lost: it waits on the device
    expect(a.vault.pendingCount()).toBe(1);
  });
});
