import type { AttachmentInfo, DeleteFilesResponse, Me, TrashList } from '@kladde/shared';
import { t } from './i18n';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** The JSON body of the error response */
    public readonly data: unknown = {}
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? t('common.errorStatus', { status: res.status }), res.status, data);
  return data as T;
}

export async function uploadFile(file: File): Promise<{ url: string; name: string; mime: string }> {
  return api('/files', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
  });
}

async function prepareAvatarPayload(file: File): Promise<{ body: Blob; type: string }> {
  // Keep animated GIFs as-is and small files untouched unless canvas scaling helps oversized images
  if (file.type === 'image/gif' || typeof document === 'undefined') {
    return { body: file, type: file.type || 'image/png' };
  }
  try {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('decode'));
        el.src = url;
      });
      const size = Math.min(512, Math.max(img.naturalWidth, img.naturalHeight));
      const minSide = Math.min(img.naturalWidth, img.naturalHeight);
      if (!minSide || (file.size <= 350_000 && Math.max(img.naturalWidth, img.naturalHeight) <= 512)) {
        return { body: file, type: file.type || 'image/png' };
      }
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { body: file, type: file.type || 'image/png' };
      const sx = Math.floor((img.naturalWidth - minSide) / 2);
      const sy = Math.floor((img.naturalHeight - minSide) / 2);
      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
      const outMime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outMime, 0.9));
      if (blob && blob.size > 0 && blob.size <= 5 * 1024 * 1024) {
        return { body: blob, type: blob.type || outMime };
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // Fallback to uploading original file and let server validate
  }
  return { body: file, type: file.type || 'image/png' };
}

export async function uploadAvatar(file: File): Promise<Me> {
  const payload = await prepareAvatarPayload(file);
  if (payload.body.size > 5 * 1024 * 1024) {
    throw new ApiError(t('settings.profileTooLarge'), 400);
  }
  return api<Me>('/me/avatar', {
    method: 'POST',
    body: payload.body,
    headers: { 'Content-Type': payload.type },
  });
}

export function deleteAvatar(): Promise<Me> {
  return api<Me>('/me/avatar', { method: 'DELETE' });
}

export function listFiles(): Promise<AttachmentInfo[]> {
  return api<AttachmentInfo[]>('/files');
}

export function deleteFile(id: string): Promise<{ ok: true; id: string }> {
  return api(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function deleteFiles(ids: string[]): Promise<DeleteFilesResponse> {
  return api<DeleteFilesResponse>('/files/delete', { method: 'POST', json: { ids } });
}

// ---------------------------------------------------------------- trash (#25)

export function listTrash(): Promise<TrashList> {
  return api<TrashList>('/trash');
}

export type RestoreResult = { restored: { id: string; path: string }[] };

/** Puts a note back; a 409 `ApiError` carries a `TrashConflict` (the path is taken) in `data` */
export function restoreTrash(id: string, path?: string): Promise<RestoreResult> {
  return api<RestoreResult>(`/trash/${encodeURIComponent(id)}/restore`, { method: 'POST', json: path ? { path } : {} });
}

export function restoreTrashBatch(batch: string): Promise<RestoreResult> {
  return api<RestoreResult>(`/trash/batch/${encodeURIComponent(batch)}/restore`, { method: 'POST', json: {} });
}

export function purgeTrash(id: string): Promise<{ purged: number }> {
  return api(`/trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function emptyTrash(): Promise<{ purged: number }> {
  return api('/trash', { method: 'DELETE' });
}
