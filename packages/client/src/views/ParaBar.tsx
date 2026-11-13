import { Archive, ArchiveRestore, Briefcase, Hash, Library, Lightbulb, Target, Unlink } from '../lib/icons';
import { DEFAULT_PARA_FOLDERS, PROJECT_STATUSES, ZETTEL_TYPES, extractMeta, isProjectNote, restoreTarget, roleOfPath, splitPath } from '@kladde/shared';
import { useVault, vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { ChipSelect } from './ChipSelect';
import { folderDisplayName, folderLeafDisplayName, projectStatusLabel, t, useLang, zettelTypeLabel } from '../lib/i18n';

const STATUS_TONE: Record<string, string> = { aktiv: 'text-ok', pausiert: 'text-warn', fertig: 'text-on-surface-variant' };

/** Context actions by PARA role inside an open note: inbox quick-file, project status, archive/restore, Zettel type */
export function ParaBar({ note }: { note: LocalNote }) {
  useVault();
  const lang = useLang();
  if (note.access !== 'owner') return null;
  const features = vault.features();
  const roleConfig = vault.roleConfig();
  const role = roleOfPath(note.path, roleConfig);
  const meta = extractMeta(note.path, note.content);
  const folder = splitPath(note.path).folder;
  const archiveRoot = features.para.folders.archive;
  const restoreDest = features.para.enabled ? restoreTarget(folder, archiveRoot) : null;
  const archived = restoreDest !== null;
  const isProject = features.para.enabled && isProjectNote(note.path, roleConfig);

  const showInboxActions = role === 'inbox' && (features.para.enabled || features.zettel.enabled);
  const showProjectControls = isProject;
  const showZettelControls = role === 'zettel' && features.zettel.enabled;
  const showRestoreBtn = archived;
  const showArchiveBtn = !archived && features.para.enabled && role !== 'inbox' && !isProject && role !== 'archive' && folder !== archiveRoot;

  if (!showInboxActions && !showProjectControls && !showZettelControls && !showRestoreBtn && !showArchiveBtn) return null;

  const shortLabel = (f: string) => folderLeafDisplayName(f, lang).replace(/^\d+\s+/, '') || folderLeafDisplayName(f, lang);
  const projectsLabel = features.para.folders.projects === DEFAULT_PARA_FOLDERS.projects ? t('para.projectBadge') : shortLabel(features.para.folders.projects);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm anim-fade-in">
      {showInboxActions && (
        <>
          <span className="text-title-s text-on-surface-variant">{t('para.sortLabel')}</span>
          <div className="edit-only flex flex-wrap items-center gap-1.5">
            {features.para.enabled && (
              <>
                <button className="chip" onClick={() => void vault.moveNote(note.id, features.para.folders.projects)}>
                  <Briefcase size={13} /> {projectsLabel}
                </button>
                <button className="chip" onClick={() => void vault.moveNote(note.id, features.para.folders.areas)}>
                  <Target size={13} /> {shortLabel(features.para.folders.areas)}
                </button>
                <button className="chip" onClick={() => void vault.moveNote(note.id, features.para.folders.resources)}>
                  <Library size={13} /> {shortLabel(features.para.folders.resources)}
                </button>
              </>
            )}
            {features.zettel.enabled && (
              <button className="chip" onClick={() => void vault.toZettel(note.id)}>
                <Lightbulb size={13} /> {t('para.zettelBtn')}
              </button>
            )}
            {features.para.enabled && (
              <button className="chip" onClick={() => void vault.archiveNote(note.id)}>
                <Archive size={13} /> {t('para.archiveBtn')}
              </button>
            )}
          </div>
        </>
      )}

      {showProjectControls && (
        <>
          <span className="chip">{t('para.projectBadge')}</span>
          <ChipSelect
            className={STATUS_TONE[meta.frontmatter.status ?? 'aktiv'] ?? ''}
            value={meta.frontmatter.status ?? 'aktiv'}
            aria-label={t('para.projectStatusLabel')}
            onChange={(val) => void vault.setFrontmatter(note.id, { status: val })}
          >
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {projectStatusLabel(s, lang)}
              </option>
            ))}
          </ChipSelect>
          {meta.frontmatter.frist && <span className="chip">{t('para.deadlineBadge', { date: meta.frontmatter.frist })}</span>}
        </>
      )}

      {showZettelControls && (
        <>
          <span className="chip">
            <Lightbulb size={12} /> {t('para.zettelBtn')}
          </span>
          {meta.frontmatter.id && (
            <span className="chip font-mono" title={t('para.zettelIdTitle')}>
              <Hash size={11} />
              {meta.frontmatter.id}
            </span>
          )}
          <ChipSelect
            value={meta.frontmatter.typ ?? ''}
            aria-label={t('para.zettelTypeLabel')}
            onChange={(val) => void vault.setFrontmatter(note.id, { typ: val || null })}
          >
            <option value="">{t('para.typePlaceholder')}</option>
            {ZETTEL_TYPES.map((zt) => (
              <option key={zt.id} value={zt.id}>
                {zettelTypeLabel(zt.id, lang).label}
              </option>
            ))}
          </ChipSelect>
          {vault.links().isOrphan(note.id) && (
            <span className="chip text-warn" title={t('para.zettelOrphanTitle')}>
              <Unlink size={12} /> {t('para.zettelOrphanBadge')}
            </span>
          )}
        </>
      )}

      {showRestoreBtn ? (
        <button className="btn-ghost ml-auto py-1" onClick={() => void vault.restoreNote(note.id)}>
          <ArchiveRestore size={15} /> {t('para.restoreToBtn', { folder: restoreDest ? folderDisplayName(restoreDest, lang) : t('common.topLevelPlain') })}
        </button>
      ) : (
        showArchiveBtn && (
          <button className="btn-ghost ml-auto py-1 text-on-surface-variant" onClick={() => void vault.archiveNote(note.id)} title={t('para.finishTitle')}>
            <Archive size={15} /> {t('para.archiveBtn')}
          </button>
        )
      )}
    </div>
  );
}
