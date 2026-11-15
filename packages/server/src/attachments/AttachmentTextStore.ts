import { DatabaseSync } from 'node:sqlite';
import { DataCipher } from '../crypto.js';

/** `done`: text extracted (may be empty), `failed`: the file could not be read */
export type AttachmentTextStatus = 'done' | 'failed';

export interface AttachmentText {
  status: AttachmentTextStatus;
  /** Text per page (PDF) or a single entry (image) */
  pages: string[];
  /** OCR was available when the text was extracted */
  ocr: boolean;
  /** At least one page was read by OCR */
  ocrUsed: boolean;
  updatedAt: number;
}

interface Row {
  file_id: string;
  status: string;
  pages: Uint8Array | null;
  ocr: number;
  error: string | null;
  updated_at: number;
}

/** PDFs are always indexed; images only with OCR */
export const PDF_MIME = 'application/pdf';
export const OCR_IMAGE_RE = /^image\/(png|jpeg|webp)$/;

export function indexable(mime: string, ocr: boolean): boolean {
  return mime === PDF_MIME || (ocr && OCR_IMAGE_RE.test(mime));
}

/**
 * Extracted text of attachments (#37), encrypted like the attachment itself (AES-GCM, the attachment id
 * in the AAD), so the search index never holds readable text in the database.
 */
export class AttachmentTextStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: DataCipher
  ) {}

  private aad(fileId: string): string {
    return `filetext:${fileId}`;
  }

  save(fileId: string, result: { status: AttachmentTextStatus; pages: string[]; ocr: boolean; ocrUsed?: boolean; error?: string }, now = Date.now()): void {
    const blob = this.cipher.encryptJson({ pages: result.pages, ocrUsed: !!result.ocrUsed }, this.aad(fileId));
    this.db
      .prepare(
        `INSERT INTO attachment_text (file_id, status, pages, ocr, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET status = excluded.status, pages = excluded.pages, ocr = excluded.ocr, error = excluded.error, updated_at = excluded.updated_at`
      )
      .run(fileId, result.status, blob, result.ocr ? 1 : 0, result.error?.slice(0, 200) ?? null, now);
  }

  get(fileId: string): AttachmentText | null {
    const row = this.db.prepare('SELECT * FROM attachment_text WHERE file_id = ?').get(fileId) as Row | undefined;
    if (!row) return null;
    let pages: string[] = [];
    let ocrUsed = false;
    if (row.pages) {
      try {
        const data = this.cipher.decryptJson<{ pages: unknown; ocrUsed?: unknown }>(row.pages, this.aad(fileId));
        pages = Array.isArray(data.pages) ? data.pages.filter((p): p is string => typeof p === 'string') : [];
        ocrUsed = data.ocrUsed === true;
      } catch {
        pages = [];
      }
    }
    return { status: row.status === 'failed' ? 'failed' : 'done', pages, ocr: row.ocr === 1, ocrUsed, updatedAt: row.updated_at };
  }

  /** Ids of attachments that still need (re-)indexing: never indexed, or indexed before OCR was turned on */
  needsIndex(ocr: boolean): string[] {
    const rows = this.db
      .prepare('SELECT f.id AS id, f.mime AS mime, t.ocr AS ocr FROM files f LEFT JOIN attachment_text t ON t.file_id = f.id ORDER BY f.created_at DESC')
      .all() as { id: string; mime: string; ocr: number | null }[];
    return rows.filter((r) => indexable(r.mime, ocr) && (r.ocr === null || (ocr && r.ocr === 0))).map((r) => r.id);
  }

  has(fileId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM attachment_text WHERE file_id = ?').get(fileId);
  }
}
