import { Archive, ArchiveRestore, CheckCircle2, Hash, Lightbulb, Unlink } from 'lucide-react';
import { PROJECT_STATUSES, ZETTEL_TYPES, extractMeta, restoreTarget, roleOfPath, splitPath } from '@kladde/shared';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { SortActions } from './Inbox';

const STATUS_TONE: Record<string, string> = { aktiv: 'text-ok', pausiert: 'text-warn', fertig: 'text-faint' };

/** Context actions by PARA role: project status, archive/restore, Zettel type, inbox filing */
export function ParaBar({ note }: { note: LocalNote }) {
  if (note.access !== 'owner') return null;
  const role = roleOfPath(note.path);
  const meta = extractMeta(note.path, note.content);
  const folder = splitPath(note.path).folder;
  const archived = restoreTarget(folder) !== null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm anim-fade-in">
      {role === 'inbox' && (
        <>
          <span className="text-xs font-semibold uppercase tracking-wider text-faint">Einsortieren</span>
          <SortActions note={note} compact />
        </>
      )}

      {role === 'projects' && (
        <>
          <span className="chip">Projekt</span>
          <select
            className={`chip cursor-pointer bg-raised py-1 outline-none ${STATUS_TONE[meta.frontmatter.status ?? 'aktiv'] ?? ''}`}
            value={meta.frontmatter.status ?? 'aktiv'}
            onChange={(e) => void vault.setFrontmatter(note.id, { status: e.target.value })}
          >
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {meta.frontmatter.frist && <span className="chip">Frist {meta.frontmatter.frist}</span>}
          <button className="btn-ghost ml-auto py-1 text-ok" onClick={() => confirm('Projekt abschließen und ins Archiv verschieben?') && void vault.archiveNote(note.id, true)}>
            <CheckCircle2 size={15} /> Abschließen
          </button>
        </>
      )}

      {role === 'zettel' && (
        <>
          <span className="chip">
            <Lightbulb size={12} /> Zettel
          </span>
          {meta.frontmatter.id && (
            <span className="chip font-mono" title="Feste ID – [[ID]] verlinkt diesen Zettel unabhängig vom Titel">
              <Hash size={11} />
              {meta.frontmatter.id}
            </span>
          )}
          <select
            className="chip cursor-pointer bg-raised py-1 outline-none"
            value={meta.frontmatter.typ ?? ''}
            onChange={(e) => void vault.setFrontmatter(note.id, { typ: e.target.value || null })}
          >
            <option value="">Typ …</option>
            {ZETTEL_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {vault.links().isOrphan(note.id) && (
            <span className="chip text-warn" title="Ein Zettel entfaltet seinen Wert erst durch Verbindungen">
              <Unlink size={12} /> noch nicht verbunden
            </span>
          )}
        </>
      )}

      {archived ? (
        <button className="btn-ghost ml-auto py-1" onClick={() => void vault.restoreNote(note.id)}>
          <ArchiveRestore size={15} /> Wiederherstellen nach {restoreTarget(folder) || 'oben'}
        </button>
      ) : (
        role !== 'inbox' &&
        role !== 'projects' && (
          <button className="btn-ghost ml-auto py-1 text-faint" onClick={() => void vault.archiveNote(note.id)} title="Ins Archiv verschieben">
            <Archive size={15} /> Archivieren
          </button>
        )
      )}
    </div>
  );
}
