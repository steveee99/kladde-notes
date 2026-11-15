import type { FileStore } from '../FileStore.js';
import { AttachmentTextStore, indexable, OCR_IMAGE_RE, PDF_MIME } from './AttachmentTextStore.js';
import { extractImageText, extractPdfText, type ExtractedText, type Ocr } from './extract.js';

/**
 * Background job that extracts the text of attachments (#37): new uploads are queued right away,
 * existing attachments by `backfill()` after the start. One file at a time, so a large PDF or OCR
 * never blocks the server for long.
 */
export class AttachmentIndexer {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly files: FileStore,
    private readonly texts: AttachmentTextStore,
    readonly ocr: Ocr | null = null
  ) {}

  /** Queues a new or changed attachment (ignored when its type has no text to extract) */
  enqueue(fileId: string, mime?: string): void {
    if (mime !== undefined && !indexable(mime, !!this.ocr)) return;
    if (this.queued.has(fileId)) return;
    this.queued.add(fileId);
    this.queue.push(fileId);
    this.kick();
  }

  /** Queues every attachment that was never indexed (or before OCR was turned on); returns how many */
  backfill(): number {
    const ids = this.texts.needsIndex(!!this.ocr);
    for (const id of ids) this.enqueue(id);
    return ids.length;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Resolves when the queue is empty (tests, CLI) */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private kick(): void {
    if (this.running) return;
    this.running = (async () => {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        this.queued.delete(id);
        try {
          await this.index(id);
        } catch (err) {
          console.error('Attachment indexing failed:', err);
        }
        // Give requests a turn between files
        await new Promise((r) => setImmediate(r));
      }
    })().finally(() => {
      this.running = null;
    });
  }

  /** Extracts and stores the text of one attachment */
  async index(fileId: string): Promise<void> {
    const file = this.files.load(fileId);
    if (!file) return;
    const ocr = !!this.ocr;
    let result: ExtractedText;
    try {
      if (file.mime === PDF_MIME) result = await extractPdfText(file.data, this.ocr);
      else if (this.ocr && OCR_IMAGE_RE.test(file.mime)) result = await extractImageText(file.data, this.ocr);
      else return;
    } catch (err) {
      // The file may have been deleted meanwhile (the row then is gone with it)
      if (this.files.exists(fileId)) this.texts.save(fileId, { status: 'failed', pages: [], ocr, error: (err as Error).message });
      return;
    }
    if (this.files.exists(fileId)) this.texts.save(fileId, { status: 'done', pages: result.pages, ocr, ocrUsed: result.ocrUsed });
  }
}
