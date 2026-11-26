import { vault } from '../data/vault';
import { t } from './i18n';
import { showToast } from './toast';

/**
 * "Deleted · Undo" after notes went to the trash (#131). `label` names what was deleted (the note's or the
 * folder's name, or the number of notes); `batch` is the trash batch of a deleted folder.
 */
export function toastDeleted(ids: string[], label: string, batch?: string): void {
  if (!ids.length) return;
  showToast(label, 'ok', {
    label: t('undo.action'),
    run: async () => {
      try {
        const n = await vault.undoDelete(ids, batch);
        showToast(n === 1 ? t('undo.restoredOne') : t('undo.restoredMany', { n }), 'ok');
      } catch (err) {
        showToast(t('undo.failed', { error: (err as Error).message }), 'danger');
      }
    },
  });
}
