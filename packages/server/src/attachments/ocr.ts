import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { Ocr } from './extract.js';

/** Languages whose data ships with the server (npm packages @tesseract.js-data/<lang>) */
export const OCR_LANGUAGES = ['deu', 'eng'] as const;

/** A worker that sits idle this long is shut down to give back its memory */
const IDLE_MS = 2 * 60_000;
const PAGE_TIMEOUT_MS = 120_000;

interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

/**
 * Optional OCR for scanned PDFs and images (#37) with Tesseract compiled to WebAssembly (tesseract.js).
 * Off unless `OCR=true`, because it costs CPU. The language data comes from npm packages and is read
 * from disk: nothing is downloaded from a CDN at runtime.
 */
export function ocrFromEnv(env: NodeJS.ProcessEnv, dataDir: string): Ocr | null {
  const flag = env.OCR?.trim().toLowerCase();
  if (flag !== 'true' && flag !== '1') return null;
  const wanted = (env.OCR_LANGS?.trim() || 'deu+eng')
    .split('+')
    .map((l) => l.trim())
    .filter((l): l is (typeof OCR_LANGUAGES)[number] => (OCR_LANGUAGES as readonly string[]).includes(l));
  const langs = wanted.length ? wanted : [...OCR_LANGUAGES];

  let langPath: string;
  try {
    langPath = prepareLanguageData(langs, path.join(dataDir, 'ocr'));
  } catch (err) {
    console.warn(`OCR bleibt aus: Sprachdaten nicht gefunden (${(err as Error).message}).`);
    return null;
  }

  let worker: Promise<TesseractWorker> | null = null;
  let idle: NodeJS.Timeout | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const getWorker = () => {
    worker ??= (async () => {
      const tesseract = (await import('tesseract.js')) as unknown as {
        createWorker(langs: string[], oem: number, opts: Record<string, unknown>): Promise<TesseractWorker>;
      };
      // OEM 1: LSTM only (the "best_int" data); no cache files in the working directory
      return tesseract.createWorker(langs, 1, { langPath, gzip: true, cacheMethod: 'none' });
    })();
    worker.catch(() => (worker = null));
    return worker;
  };

  const release = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      const w = worker;
      worker = null;
      void w?.then((x) => x.terminate()).catch(() => undefined);
    }, IDLE_MS);
    idle.unref();
  };

  // One page at a time: the worker is single-threaded anyway
  return (image) => {
    const run = queue.then(async () => {
      if (idle) clearTimeout(idle);
      try {
        const w = await getWorker();
        const result = await Promise.race([
          w.recognize(image),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), PAGE_TIMEOUT_MS).unref()),
        ]);
        return result.data.text ?? '';
      } finally {
        release();
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

/** Copies the bundled traineddata files into one folder (tesseract.js reads all languages from one path) */
function prepareLanguageData(langs: string[], dir: string): string {
  const require = createRequire(import.meta.url);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const lang of langs) {
    const target = path.join(dir, `${lang}.traineddata.gz`);
    if (fs.existsSync(target)) continue;
    const pkg = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    fs.copyFileSync(path.join(pkg, '4.0.0_best_int', `${lang}.traineddata.gz`), target);
  }
  return dir;
}
