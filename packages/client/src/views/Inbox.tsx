import { useState } from 'react';
import { Archive, Briefcase, Inbox as InboxIcon, Lightbulb, Library, Target, Trash2 } from 'lucide-react';
import { PARA, excerpt, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { navigate } from '../lib/router';
import { ChipSelect } from './ChipSelect';

/** Actions to file one inbox item: PARA roots, Zettelkasten, any folder, archive, delete */
export function SortActions({ note, compact = false, onDone }: { note: LocalNote; compact?: boolean; onDone?: () => void }) {
  const run = (fn: () => Promise<unknown>) => () => void fn().then(onDone, () => {});
  const btn = (Icon: typeof Archive, label: string, fn: () => Promise<unknown>, cls = '') => (
    <button key={label} className={`chip px-2.5 py-1.5 text-xs transition-colors hover:bg-accent/15 hover:text-accent ${cls}`} onClick={(e) => (e.stopPropagation(), run(fn)())}>
      <Icon size={13} /> {!compact && label}
    </button>
  );
  return (
    <div className="edit-only flex flex-wrap items-center gap-1.5">
      {btn(Briefcase, 'Projekt', () => vault.moveNote(note.id, PARA.projects))}
      {btn(Target, 'Bereich', () => vault.moveNote(note.id, PARA.areas))}
      {btn(Library, 'Ressource', () => vault.moveNote(note.id, PARA.resources))}
      {btn(Lightbulb, 'Zettel', () => vault.toZettel(note.id))}
      {btn(Archive, 'Archiv', () => vault.archiveNote(note.id))}
      <ChipSelect
        className="max-w-[9rem] shrink-0 text-xs"
        value=""
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => e.target.value && run(() => vault.moveNote(note.id, e.target.value))()}
      >
        <option value="">Ordner …</option>
        {vault
          .folders()
          .filter((f) => f !== PARA.inbox)
          .map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
      </ChipSelect>
      {btn(
        Trash2,
        'Löschen',
        async () => {
          if (!confirm(`„${splitPath(note.path).name}“ löschen?`)) throw new Error('cancelled');
          await vault.remove(note.id);
        },
        'hover:!bg-danger/15 hover:!text-danger'
      )}
    </div>
  );
}

function InboxItem({ note }: { note: LocalNote }) {
  const [leaving, setLeaving] = useState(false);
  return (
    <li className={`card p-4 transition-all duration-300 ${leaving ? 'translate-x-8 opacity-0' : ''}`}>
      <button className="block w-full text-left" onClick={() => navigate(`/n/${note.id}`)}>
        <div className="font-medium">{splitPath(note.path).name}</div>
        {excerpt(note.content) && <div className="mt-1 line-clamp-3 text-sm text-muted">{excerpt(note.content, 240)}</div>}
        <div className="mt-1 text-xs text-faint">{new Date(note.createdAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</div>
      </button>
      <div className="mt-3">
        <SortActions note={note} onDone={() => setLeaving(true)} />
      </div>
    </li>
  );
}

/** Inbox zero: everything captured is filed into PARA or the Zettelkasten, one item at a time */
export function InboxView() {
  useVault();
  const items = vault
    .list()
    .filter((n) => n.access === 'owner' && splitPath(n.path).folder === PARA.inbox)
    .sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 anim-fade-up">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <InboxIcon size={24} className="text-accent" /> Inbox
        </h1>
        <p className="mt-1 text-muted">
          {items.length ? `${items.length} Einträge zum Einsortieren – älteste zuerst.` : 'Alles einsortiert. Inbox Zero ✨'}
        </p>
      </div>
      <ul className="stagger space-y-3">
        {items.map((n) => (
          <InboxItem key={n.id} note={n} />
        ))}
      </ul>
    </div>
  );
}
