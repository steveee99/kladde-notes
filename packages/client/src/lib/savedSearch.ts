import { searchNotes, searchTerms, searchableText, isHiddenPath, projectTitleOf } from '@kladde/shared';
import { vault, type SavedSearch } from '../data/vault';
import { navigate } from './router';
import { openSearch } from '../views/SearchDialog';

/** Event the task page listens to: a saved task view (#78) was opened */
export const TASK_VIEW_EVENT = 'kladde:task-view';
/** Where the task page keeps its filters (views/TasksView.tsx) */
export const TASK_PREFS_KEY = 'kladde.tasksPage';

/** Opens a saved search (#78): the search overlay with its query, or the task page with its filters */
export function openSavedSearch(saved: SavedSearch): void {
  if (saved.kind === 'tasks') {
    try {
      localStorage.setItem(TASK_PREFS_KEY, JSON.stringify(saved.filters ?? {}));
    } catch {
      // the event below still applies them
    }
    navigate('/tasks');
    window.dispatchEvent(new CustomEvent(TASK_VIEW_EVENT, { detail: saved.filters ?? {} }));
    return;
  }
  openSearch(saved.q);
}

/** How many notes a saved search finds on this device; null in online mode, where the server searches */
export function savedSearchCount(saved: SavedSearch): number | null {
  if (saved.kind !== 'notes' || vault.online) return null;
  const terms = searchTerms(saved.q);
  if (!terms.length) return null;
  const rc = vault.roleConfig();
  const list = vault.list().filter((n) => !isHiddenPath(n.path));
  return searchNotes(list, terms, (n) => projectTitleOf(n.path, n.content, rc), undefined, searchableText).length;
}
