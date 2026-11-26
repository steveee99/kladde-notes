import { completeParents, parseTasks, setTaskStatus, toggleTask, type TaskStatus } from '@kladde/shared';
import { getCompleteParents } from './prefs';

/**
 * A task's new status in a note's text, with the device's "complete parent tasks" setting (#75): when the task is
 * done afterwards, a parent whose subtasks are now all done is finished too. `status` undefined toggles.
 */
export function changeTask(content: string, line: number, status?: TaskStatus): string {
  const before = content.split('\n').length;
  const next = status === undefined ? toggleTask(content, line) : setTaskStatus(content, line, status);
  if (!getCompleteParents() || next === content) return next;
  // A repeating task gets its next occurrence inserted above it: the finished one moved down
  const at = line + (next.split('\n').length - before);
  return parseTasks(next).find((t) => t.line === at)?.done ? completeParents(next, at) : next;
}
