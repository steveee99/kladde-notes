/**
 * Voice notes (#33): records with MediaRecorder and hands back an audio file, which is then stored like any
 * attachment (encrypted on the server, queued while offline). `recordVoice()` opens the recorder as a
 * bottom sheet from anywhere (slash command); Quick Capture embeds `VoiceRecorderPanel` directly.
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Loader2, Mic, StopCircle, X } from '../lib/icons';
import { tl, useLang } from '../lib/i18n';

/** Longest recording; a voice note is a thought, not a meeting */
const MAX_SECONDS = 30 * 60;

/** A format this browser can record: Opus in WebM (Chrome, Firefox), AAC in MP4 (Safari) */
function recorderMime(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) ?? '';
}

export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (s: number) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

function fileName(mime: string): string {
  const d = new Date();
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  return `Sprachnotiz ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}.${ext}`;
}

/** The recorder: starts at once, shows the time and a level meter, "Stop" returns the file, "Cancel" returns null */
export function VoiceRecorderPanel({ onDone }: { onDone: (file: File | null) => void }) {
  const lang = useLang();
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const [state, setState] = useState<'starting' | 'recording' | 'saving'>('starting');
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let frame = 0;
    let audio: AudioContext | null = null;
    let stopped = false;
    const chunks: Blob[] = [];
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError(tl(lang, 'voice.noMic'));
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mime = recorderMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.current = rec;
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop());
        if (cancelled.current) return done.current(null);
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        done.current(new File(chunks, fileName(type), { type }));
      };
      rec.start(1000);
      setState('recording');
      const started = Date.now();
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setSeconds(s);
        if (s >= MAX_SECONDS && rec.state === 'recording') rec.stop();
      }, 250);
      // Level meter, so it is visible that the microphone hears something
      try {
        audio = new AudioContext();
        const analyser = audio.createAnalyser();
        analyser.fftSize = 256;
        audio.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(1, peak / 64));
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        /* no meter */
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      cancelAnimationFrame(frame);
      void audio?.close().catch(() => {});
      if (recorder.current?.state === 'recording') {
        cancelled.current = true;
        recorder.current.stop();
      } else stream?.getTracks().forEach((t) => t.stop());
    };
    // Runs once per panel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    if (recorder.current?.state === 'recording') {
      setState('saving');
      recorder.current.stop();
    }
  };
  const cancel = () => {
    cancelled.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else onDone(null);
  };

  return (
    <div className="flex items-center gap-3 rounded-2xl bg-surface-container-highest p-3" role="group" aria-label={tl(lang, 'voice.title')}>
      {error ? (
        <p role="alert" className="min-w-0 flex-1 text-body-m text-error">
          {error}
        </p>
      ) : (
        <>
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-error-container text-on-error-container">
            <span
              aria-hidden
              className="absolute inset-0 rounded-full bg-error/30 transition-transform duration-100"
              style={{ transform: `scale(${1 + level * 0.6})` }}
            />
            <Mic size={22} className="relative" filled />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-title-m tabular-nums" aria-live="off">
              {clock(seconds)}
            </div>
            <div className="text-body-s text-on-surface-variant">{state === 'starting' ? tl(lang, 'voice.starting') : state === 'saving' ? tl(lang, 'voice.saving') : tl(lang, 'voice.recording')}</div>
          </div>
          <button type="button" className="btn-primary px-4" onClick={stop} disabled={state !== 'recording'}>
            {state === 'saving' ? <Loader2 size={18} className="animate-spin" /> : <StopCircle size={18} />} {tl(lang, 'voice.stop')}
          </button>
        </>
      )}
      <button type="button" className="btn-icon shrink-0" onClick={cancel} title={tl(lang, 'voice.cancel')} aria-label={tl(lang, 'voice.cancel')}>
        <X size={20} />
      </button>
    </div>
  );
}

/** Opens the recorder as a sheet; resolves with the recording, or null when cancelled */
export function recordVoice(): Promise<File | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const finish = (file: File | null) => {
      resolve(file);
      // Unmount after this render pass
      setTimeout(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(
      <div className="fixed inset-0 z-[95] flex items-end justify-center sm:items-center">
        <div className="fixed inset-0 bg-scrim/[0.32] anim-fade-in" />
        <div className="relative w-full max-w-md p-3 anim-sheet [--pad-bottom:0.75rem] safe-bottom">
          <VoiceRecorderPanel onDone={finish} />
        </div>
      </div>
    );
  });
}
