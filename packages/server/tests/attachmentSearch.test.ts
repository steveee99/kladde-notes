import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { AttachmentSearchResponse } from '@kladde/shared';
import { apiRouter, LiveUpdates } from '../src/api';
import { DataCipher } from '../src/crypto';
import { openDatabase } from '../src/db';
import { FileStore } from '../src/FileStore';
import { NoteStore } from '../src/NoteStore';
import { UserStore } from '../src/UserStore';
import { AttachmentTextStore } from '../src/attachments/AttachmentTextStore';
import { AttachmentIndexer } from '../src/attachments/AttachmentIndexer';
import { extractPdfText } from '../src/attachments/extract';
import { TOOLS } from '../src/mcp/tools';

/** A small but valid PDF with one line of text per page (Helvetica, WinAnsi) */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1;
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const text of pages) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let tmpDir = '';
let server: Server;
let base = '';

const db = openDatabase(':memory:');
const cipher = new DataCipher(crypto.randomBytes(32));
const users = new UserStore(db);
const notes = new NoteStore(db, cipher);
const texts = new AttachmentTextStore(db, cipher);
let files: FileStore;
let indexer: AttachmentIndexer;

const anna = users.createUser('anna');
const ben = users.createUser('ben');
const annaCookie = `kladde_session=${users.createSession(anna.id)}`;
const benCookie = `kladde_session=${users.createSession(ben.id)}`;

const note = (id: string, path: string, content: string) => ({ id, baseVersion: 0, path, content, deleted: false, createdAt: 1, updatedAt: 1 });

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-attsearch-test-'));
  files = new FileStore(db, cipher, tmpDir);
  // A fake OCR: images contain their own "text" as bytes
  indexer = new AttachmentIndexer(files, texts, async (image) => image.toString('utf8'));
  files.onSaved((id, mime) => indexer.enqueue(id, mime));

  const app = express();
  app.use('/api', (req, res, next) => (req.path === '/sync' || req.path === '/files' ? next() : express.json({ limit: '256kb' })(req, res, next)));
  app.use('/api', apiRouter(users, notes, files, new LiveUpdates(), { attachmentSearch: { files, texts, ocr: true } }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await indexer?.idle();
  server?.close();
  db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PDF text extraction (#37)', () => {
  it('reads the text of every page', async () => {
    const { pages, ocrUsed } = await extractPdfText(makePdf(['Rechnung Nr. 4711', 'Garantienummer GX-99 bis 2028']));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('Rechnung Nr. 4711');
    expect(pages[1]).toContain('GX-99');
    expect(ocrUsed).toBe(false);
  });

  it('rejects files that are not PDFs', async () => {
    await expect(extractPdfText(Buffer.from('kein pdf'))).rejects.toThrow();
  });
});

describe('Attachment text index and search', () => {
  let pdfId = '';
  let imageId = '';

  it('indexes new uploads in the background and stores the text encrypted', async () => {
    pdfId = files.save(anna.id, 'Rechnung.pdf', 'application/pdf', makePdf(['Waschmaschine Modell WM 300', 'Garantienummer GX-4711-B'])).id;
    imageId = files.save(anna.id, 'Kassenbon.png', 'image/png', Buffer.from('Bauhaus Schrauben 12,99 EUR')).id;
    await indexer.idle();
    const pdf = texts.get(pdfId)!;
    expect(pdf.status).toBe('done');
    expect(pdf.pages[1]).toContain('GX-4711-B');
    expect(texts.get(imageId)!.ocrUsed).toBe(true);
    // Encrypted at rest: the plain text is nowhere in the row
    const row = db.prepare('SELECT pages FROM attachment_text WHERE file_id = ?').get(pdfId) as { pages: Uint8Array };
    expect(Buffer.from(row.pages).toString('latin1')).not.toContain('Garantienummer');
    expect(indexer.backfill()).toBe(0);
  });

  it('finds matches only in attachments of notes the user can read, with page and embedding note', async () => {
    notes.push(anna.id, [
      note('n-geraete', 'Haushalt/Geräte.md', `# Waschmaschine\n\n![[Rechnung]](/api/files/${pdfId})\n`),
      note('n-baumarkt', 'Haushalt/Baumarkt.md', `![Bon](/api/files/${imageId})`),
    ]);
    const res = await fetch(`${base}/api/attachments/search?q=${encodeURIComponent('garantienummer gx-4711')}`, { headers: { cookie: annaCookie } });
    const body = (await res.json()) as AttachmentSearchResponse;
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({ fileId: pdfId, page: 2, name: 'Rechnung.pdf', ocr: false });
    expect(body.hits[0].snippet).toContain('GX-4711-B');
    expect(body.hits[0].notes.map((n) => n.id)).toEqual(['n-geraete']);

    const ocrHit = (await (await fetch(`${base}/api/attachments/search?q=schrauben`, { headers: { cookie: annaCookie } })).json()) as AttachmentSearchResponse;
    expect(ocrHit.hits[0]).toMatchObject({ fileId: imageId, ocr: true });

    const other = (await (await fetch(`${base}/api/attachments/search?q=garantienummer`, { headers: { cookie: benCookie } })).json()) as AttachmentSearchResponse;
    expect(other.hits).toEqual([]);
  });

  it('follows shares: a shared note makes its attachments searchable for the recipient', async () => {
    notes.share(anna.id, 'n-geraete', ben.id, false);
    const body = (await (await fetch(`${base}/api/attachments/search?q=garantienummer`, { headers: { cookie: benCookie } })).json()) as AttachmentSearchResponse;
    expect(body.hits.map((h) => h.fileId)).toEqual([pdfId]);
  });

  it('drops the text together with the attachment', () => {
    const id = files.save(anna.id, 'Alt.pdf', 'application/pdf', makePdf(['weg']), ).id;
    texts.save(id, { status: 'done', pages: ['weg'], ocr: false });
    files.delete(anna.id, id);
    expect(texts.has(id)).toBe(false);
  });

  it('MCP search_notes and semantic_search report attachment matches', async () => {
    const ctx = { userId: anna.id, canWrite: false, notes, files, attachmentTexts: { texts, ocr: true } };
    const search = TOOLS.find((t) => t.name === 'search_notes')!;
    const result = (await search.run({ query: 'GX-4711' }, ctx)) as { results: unknown[]; attachments: { file: string; page: number; notes: { id: string }[] }[] };
    expect(result.attachments[0]).toMatchObject({ file: 'Rechnung.pdf', page: 2 });
    expect(result.attachments[0].notes[0].id).toBe('n-geraete');

    const semantic = TOOLS.find((t) => t.name === 'semantic_search')!;
    const sem = (await semantic.run({ query: 'Garantienummer' }, ctx)) as { attachments: { file: string; page: number }[] };
    expect(sem.attachments[0]).toMatchObject({ file: 'Rechnung.pdf', page: 2 });

    // Without the text store the tools behave as before
    const plain = (await search.run({ query: 'GX-4711' }, { userId: anna.id, canWrite: false, notes })) as { attachments: unknown[] };
    expect(plain.attachments).toEqual([]);
  });
});
