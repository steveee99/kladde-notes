import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Me } from '@kladde/shared';
import { createKladdeApp } from '../src/app';
import { openDatabase } from '../src/db';
import { handleMessage } from '../src/mcp/protocol';
import { transcriberFromEnv } from '../src/transcribe';

// A fake speech-to-text server with the OpenAI-compatible API
const received: { model?: string; language?: string; size: number; type: string }[] = [];
let whisper: Server;
let whisperUrl = '';

const db = openDatabase(':memory:');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kladde-voice-'));
let ctx: ReturnType<typeof createKladdeApp>;
let server: Server;
let base = '';
let cookie = '';
let annaId = '';
const AUDIO = crypto.randomBytes(5000);

beforeAll(async () => {
  const fake = express();
  fake.post('/v1/audio/transcriptions', async (req, res) => {
    const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': String(req.headers['content-type']) }, body: req as unknown as BodyInit, duplex: 'half' } as RequestInit).formData();
    const file = form.get('file') as File;
    received.push({ model: String(form.get('model')), language: form.get('language') ? String(form.get('language')) : undefined, size: file.size, type: file.type });
    res.json({ text: ' Milch und Brot kaufen. ' });
  });
  whisper = fake.listen(0);
  await new Promise((r) => whisper.once('listening', r));
  whisperUrl = `http://127.0.0.1:${(whisper.address() as AddressInfo).port}/v1/audio/transcriptions`;

  ctx = createKladdeApp({
    db,
    dataDir,
    env: { DATA_KEY: crypto.randomBytes(32).toString('base64'), TRANSCRIBE_URL: whisperUrl, TRANSCRIBE_MODEL: 'small' },
    standalone: false,
    isProduction: false,
    publicUrl: null,
    trustProxy: false,
  });
  const anna = ctx.users.createUser('anna');
  annaId = anna.id;
  cookie = `kladde_session=${ctx.users.createSession(anna.id)}`;
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  whisper.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function uploadAudio(type = 'audio/webm;codecs=opus') {
  const res = await fetch(`${base}/api/files`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': type, 'X-Filename': 'Sprachnotiz.webm' }, body: AUDIO });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; url: string; mime: string };
}

describe('voice notes', () => {
  it('stores recordings as attachments and serves byte ranges (Safari needs them)', async () => {
    const saved = await uploadAudio();
    expect(saved.mime).toBe('audio/webm');
    const full = await fetch(`${base}${saved.url}`);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer()).equals(AUDIO)).toBe(true);
    const part = await fetch(`${base}${saved.url}`, { headers: { Range: 'bytes=0-1' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-1/${AUDIO.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(AUDIO.subarray(0, 2))).toBe(true);
    const tail = await fetch(`${base}${saved.url}`, { headers: { Range: 'bytes=-10' } });
    expect(Buffer.from(await tail.arrayBuffer()).equals(AUDIO.subarray(-10))).toBe(true);
    expect((await fetch(`${base}${saved.url}`, { headers: { Range: `bytes=${AUDIO.length}-` } })).status).toBe(416);
    // Other types are still refused
    const exe = await fetch(`${base}/api/files`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-msdownload' }, body: AUDIO });
    expect(exe.status).toBe(400);
  });

  it('transcribes through the configured server only for the owner', async () => {
    const me = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as Me;
    expect(me.transcription).toBe(true);
    const saved = await uploadAudio('audio/mp4');
    const res = await fetch(`${base}/api/files/${saved.id}/transcribe`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'de' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Milch und Brot kaufen.' });
    expect(received.at(-1)).toEqual({ model: 'small', language: 'de', size: AUDIO.length, type: 'audio/mp4' });

    const ben = ctx.users.createUser('ben');
    const benCookie = `kladde_session=${ctx.users.createSession(ben.id)}`;
    expect((await fetch(`${base}/api/files/${saved.id}/transcribe`, { method: 'POST', headers: { Cookie: benCookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/files/${saved.id}/transcribe`, { method: 'POST' })).status).toBe(401);
  });

  it('is off without TRANSCRIBE_URL', () => {
    expect(transcriberFromEnv({})).toBeNull();
    expect(transcriberFromEnv({ TRANSCRIBE_URL: 'ftp://x' })).toBeNull();
  });

  it('hands the recording to an AI assistant over MCP', async () => {
    const saved = await uploadAudio();
    const now = Date.now();
    ctx.notes.push(annaId, [{ id: 'voice-0001', baseVersion: 0, path: '0 Inbox/Sprachnotiz.md', content: `Vom Spaziergang\n\n![Sprachnotiz.webm](/api/files/${saved.id})\n`, deleted: false, createdAt: now, updatedAt: now }]);
    const answer = (await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_voice_note', arguments: { id: 'voice-0001' } } },
      { userId: annaId, canWrite: false, notes: ctx.notes, files: ctx.files }
    )) as { result: { content: { type: string; data?: string; mimeType?: string; text?: string }[] } };
    const [info, audio] = answer.result.content;
    expect(JSON.parse(info.text!)).toMatchObject({ note_id: 'voice-0001', line: 2, mime: 'audio/webm' });
    expect(audio).toEqual({ type: 'audio', data: AUDIO.toString('base64'), mimeType: 'audio/webm' });
  });
});

describe('microphone permission', () => {
  it('lets the app itself use the microphone, nothing embedded', async () => {
    const res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(self), geolocation=()');
  });
});
