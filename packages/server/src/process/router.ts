import express from 'express';
import { isProcessRunPath } from '@kladde/shared';
import type { UserRecord, UserStore } from '../UserStore.js';
import type { NoteStore } from '../NoteStore.js';
import { requireUser } from '../http.js';
import type { ProcessActions } from './ProcessActions.js';

/**
 * `/api/process-actions/:noteId`: what became of the actions of a run's stage scripts (sent, created, skipped,
 * failed), for everyone who can open the run note
 */
export function processActionsRouter(opts: { users: UserStore; notes: NoteStore; actions: ProcessActions; standaloneUser?: UserRecord }): express.Router {
  const router = express.Router();
  router.use(requireUser(opts.users, opts.standaloneUser));
  router.get('/:noteId', (req, res) => {
    const noteId = req.params.noteId;
    const path = opts.notes.spaceOf(req.user!.id, noteId) ? opts.notes.pathOf(noteId) : null;
    if (!path || !isProcessRunPath(path)) {
      res.status(404).json({ error: 'Nicht gefunden' });
      return;
    }
    res.json({ outcomes: opts.actions.outcomes(noteId) });
  });
  return router;
}
