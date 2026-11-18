import { useState } from 'react';
import { MEMORY_TYPES, checkMemoryNote, isReservedMemoryNote, memoryMeta, memoryOverview, safeUrl, splitPath } from '@kladde/shared';
import { AlertTriangle, Archive, ArchiveRestore, Bot, ChevronDown, FolderInput, Psychology, ShieldCheck, Clock } from '../lib/icons';
import { locale, t, useLang, type I18nKey } from '../lib/i18n';
import { navigate } from '../lib/router';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';

/**
 * Header of a note in the AI memory (#94): kind, who changed it when, trust level, status, problems and sources,
 * with the user's actions (confirm, deprecate, copy to own notes). On the memory's root index: the overview.
 */
export function MemoryPanel({ note, readOnly }: { note: LocalNote; readOnly: boolean }) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const folder = vault.memoryFolder();
  if (!folder) return null;
  if (isReservedMemoryNote(note.path)) return splitPath(note.path).folder === folder && splitPath(note.path).name.toLowerCase() === 'index' ? <MemoryOverview folder={folder} /> : null;

  const meta = memoryMeta(note.content, note.path);
  const index = vault.links();
  const problems = checkMemoryNote(note.path, note.content, { resolveLink: (target) => !!index.resolve(target) });
  const errors = problems.filter((p) => p.level === 'error');
  const me = vault.humanActor();
  const when = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' });
  };
  const confirmedByMe = meta.verified.some((v) => v.by === me) && !meta.changedSinceVerified;
  const adopt = async () => {
    const features = vault.features();
    const suggestion = features.para.enabled ? features.para.folders.resources : '';
    const target = prompt(t('memory.adoptPrompt'), suggestion);
    if (target === null) return;
    const copy = await vault.adoptMemoryNote(note.id, target.trim());
    if (copy) navigate(`/n/${copy.id}`);
  };

  return (
    <section className="no-print mb-3 rounded-2xl bg-surface-container-low p-3 anim-fade-in" data-memory-panel aria-label={t('memory.chip')}>
      <div className="flex flex-wrap items-center gap-1.5 text-label-l">
        <span className="chip bg-secondary-container text-on-secondary-container">
          <Psychology size={14} /> {t('memory.chip')}
        </span>
        {meta.type ? (
          <span className="chip" data-memory-type>
            {meta.type}
          </span>
        ) : (
          !readOnly && (
            <label className="chip text-error">
              <AlertTriangle size={14} /> {t('memory.setType')}
              <select
                className="bg-transparent outline-none"
                value=""
                onChange={(e) => e.target.value && void vault.setMemoryNoteType(note.id, e.target.value)}
                aria-label={t('memory.setType')}
              >
                <option value="">…</option>
                {MEMORY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
          )
        )}
        {meta.status !== 'stable' && (meta.status === 'draft' || meta.status === 'deprecated') && (
          <span className={`chip ${meta.status === 'deprecated' ? 'text-error' : ''}`}>{t(`memory.status.${meta.status}` as I18nKey)}</span>
        )}
        {meta.stale && (
          <span className="chip text-warn">
            <Clock size={14} /> {t('memory.stale', { date: meta.staleAfter })}
          </span>
        )}
        <span className={`chip ${meta.trust === 'human-reviewed' ? 'text-ok' : ''}`} data-memory-trust={meta.trust}>
          <ShieldCheck size={14} /> {t(`memory.trust.${meta.trust}` as I18nKey)}
        </span>
        {meta.changedSinceVerified && <span className="chip text-warn">{t('memory.changedSinceVerified')}</span>}
        {meta.generated && (
          <span className="flex items-center gap-1 px-1 text-on-surface-variant">
            {meta.generated.by === me ? null : <Bot size={14} />}
            {meta.generated.by === me ? t('memory.byYou', { when: when(meta.generated.at) }) : t('memory.by', { by: meta.generated.by, when: when(meta.generated.at) })}
          </span>
        )}
        {(problems.length > 0 || meta.sources.length > 0) && (
          <button type="button" className={`chip ${errors.length ? 'text-error' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
            {problems.length > 0 && <AlertTriangle size={14} />}
            {errors.length ? t('memory.errors', { n: errors.length }) : problems.length ? t('memory.problems', { n: problems.length }) : t('memory.sources')}
            <ChevronDown size={14} className={open ? 'rotate-180' : ''} />
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2 text-body-m">
          {problems.length > 0 && (
            <ul className="space-y-1" data-memory-problems>
              {problems.map((p) => (
                <li key={p.code + p.message} className={p.level === 'error' ? 'text-error' : 'text-on-surface-variant'}>
                  {p.message}
                </li>
              ))}
            </ul>
          )}
          {meta.sources.length > 0 && (
            <div>
              <h3 className="text-title-s text-on-surface-variant">{t('memory.sources')}</h3>
              <ul className="mt-1 space-y-0.5">
                {meta.sources.map((s) => {
                  const href = safeUrl(s.resource);
                  const label = s.title || s.resource || s.id;
                  return (
                    <li key={s.id || s.resource} className="min-w-0 truncate">
                      <span className="text-on-surface-variant">{s.id ? `[${s.id}] ` : ''}</span>
                      {href && /^https?:/i.test(href) ? (
                        <a className="text-primary hover:underline" href={href} target="_blank" rel="noopener noreferrer">
                          {label}
                        </a>
                      ) : (
                        label
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {!readOnly && (
        <div className="mt-2 flex flex-wrap gap-2">
          {!confirmedByMe && (
            <button type="button" className="btn-tonal" onClick={() => void vault.verifyMemoryNote(note.id)} data-memory-verify>
              <ShieldCheck size={16} /> {t('memory.verify')}
            </button>
          )}
          {meta.status === 'deprecated' ? (
            <button type="button" className="btn-outlined" onClick={() => void vault.setMemoryNoteStatus(note.id, 'stable')}>
              <ArchiveRestore size={16} /> {t('memory.undeprecate')}
            </button>
          ) : (
            <button type="button" className="btn-outlined" onClick={() => void vault.setMemoryNoteStatus(note.id, 'deprecated')}>
              <Archive size={16} /> {t('memory.deprecate')}
            </button>
          )}
          <button type="button" className="btn-text" onClick={() => void adopt()}>
            <FolderInput size={16} /> {t('memory.adopt')}
          </button>
        </div>
      )}
    </section>
  );
}

/** Counts and the notes with problems, shown above the memory's root index */
function MemoryOverview({ folder }: { folder: string }) {
  const index = vault.links();
  const o = memoryOverview(vault.list(), folder, { resolveLink: (target) => !!index.resolve(target) });
  const bad = o.notes.filter((n) => n.problems.length || n.stale);
  return (
    <section className="no-print mb-3 rounded-2xl bg-surface-container-low p-3 anim-fade-in" data-memory-overview>
      <h2 className="flex items-center gap-1.5 text-title-s">
        <Psychology size={16} /> {t('memory.overviewTitle')}
      </h2>
      <p className="mt-1 text-body-m text-on-surface-variant">{t('memory.overviewStats', { total: o.total, rules: o.rules, unverified: o.unverified, stale: o.stale, deprecated: o.deprecated })}</p>
      {bad.length === 0 ? (
        <p className="mt-1 text-body-m text-ok">{t('memory.overviewOk')}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-body-m">
          {bad.map((n) => {
            const errors = n.problems.filter((p) => p.level === 'error').length;
            return (
              <li key={n.id} className="flex min-w-0 items-baseline gap-2">
                <button type="button" className="min-w-0 truncate text-left text-primary hover:underline" onClick={() => navigate(`/n/${n.id}`)}>
                  {n.title}
                </button>
                <span className={`shrink-0 text-label-m ${errors ? 'text-error' : 'text-on-surface-variant'}`}>
                  {errors ? t('memory.errors', { n: errors }) : n.problems.length ? t('memory.problems', { n: n.problems.length }) : t('memory.staleShort')}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
