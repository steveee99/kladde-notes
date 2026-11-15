/**
 * Optional transcription of voice notes (#33) through a speech-to-text server the admin runs, e.g. a
 * local Whisper with an OpenAI-compatible `/v1/audio/transcriptions` endpoint. Off unless `TRANSCRIBE_URL`
 * is set: recordings never go to a third-party service by default.
 */
export type Transcriber = (audio: { data: Buffer; mime: string; name: string }, lang?: string) => Promise<string>;

const TIMEOUT_MS = 180_000;

export function transcriberFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Transcriber | null {
  const raw = env.TRANSCRIBE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.warn('TRANSCRIBE_URL is not a valid URL – transcription stays off.');
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const model = env.TRANSCRIBE_MODEL?.trim() || 'whisper-1';
  const key = env.TRANSCRIBE_API_KEY?.trim();
  return async (audio, lang) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio.data)], { type: audio.mime }), audio.name || 'aufnahme.webm');
    form.append('model', model);
    form.append('response_format', 'json');
    if (lang && /^[a-z]{2}$/.test(lang)) form.append('language', lang);
    const res = await fetchImpl(url, {
      method: 'POST',
      body: form,
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Transkription fehlgeschlagen (HTTP ${res.status}).`);
    const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== 'string') throw new Error('Transkription fehlgeschlagen (unerwartete Antwort).');
    return body.text.trim();
  };
}
