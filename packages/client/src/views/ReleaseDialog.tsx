import { useEffect, useState, type ReactNode } from 'react';
import { contentHash, nextVersion, suggestedBump, MAX_RELEASE_NOTE, type NoteRelease, type ReleaseBump } from '@kladde/shared';
import { ArrowLeft, Loader2, NewReleases } from '../lib/icons';
import { api } from '../lib/api';
import { useVariables } from '../data/variables';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { editorHost } from '../editor/host';
import { Editor } from '../editor/Editor';
import { locale, t, useLang, type I18nKey } from '../lib/i18n';
import { Sheet } from './Dialogs';
import { DiffStats, DiffView, useDiff } from './DiffView';

/** `viewing` value of the draft (the note as it is now) */
const DRAFT = '\u0000draft';

/** What changed in one release (or the draft): a line diff with its numbers, or the text as it reads */
function ReleaseChanges({ title, meta, before, after, rendered }: { title: string; meta: string | null; before: string; after: string; rendered: ReactNode }) {
  const [mode, setMode] = useState<'diff' | 'rendered'>('diff');
  const { lines, stats } = useDiff(before, after);
  return (
    <div className="mb-6" data-release-changes>
      {meta && <p className="mb-3 text-body-s text-on-surface-variant">{meta}</p>}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="segmented" role="group" aria-label={t('release.viewAria')}>
          {(['diff', 'rendered'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'diff' ? t('history.tabDiff') : t('history.tabRendered')}
            </button>
          ))}
        </div>
        <span className="text-body-s text-muted">{title}</span>
        {mode === 'diff' && (
          <span className="ml-auto">
            <DiffStats stats={stats} />
          </span>
        )}
      </div>
      {mode === 'diff' ? (
        <div className="overflow-auto rounded-lg border border-line bg-bg">
          <DiffView lines={lines} context={3} />
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-bg px-4 py-2">{rendered}</div>
      )}
    </div>
  );
}

/** The draft (the note as it is) differs from the latest release */
export function draftChanged(note: LocalNote): boolean {
  return !!note.releaseHash && note.access !== 'read' && contentHash(note.content) !== note.releaseHash;
}

/** Short label for the note header: "v1.2.0 · Draft", "Draft" before the first release */
export function releaseChipLabel(note: LocalNote): string {
  const latest = note.releases?.[0]?.version;
  if (note.access === 'read') return latest ? `v${latest}` : t('release.draft');
  if (!latest) return t('release.draft');
  return draftChanged(note) ? `v${latest} · ${t('release.draft')}` : `v${latest}`;
}

/**
 * Release versioning of one note (#53): turn it on or off, release the draft as the next SemVer version,
 * look at earlier releases and discard the draft. Only the owner turns it on and releases.
 */
export function ReleaseDialog({ note, locked = false, onClose }: { note: LocalNote; locked?: boolean; onClose: () => void }) {
  const lang = useLang();
  const fmt = (ms: number) => new Date(ms).toLocaleString(locale(lang), { dateStyle: 'medium', timeStyle: 'short' });
  const variables = useVariables(note);
  // Owners, and owners and editors of the group a note belongs to (#58)
  const isOwner = (note.access === 'owner' || vault.managesGroupNote(note)) && !locked;
  const canEdit = note.access !== 'read' && !locked;
  const releases = note.releases ?? [];
  const latest = releases[0]?.version ?? null;
  const [bump, setBump] = useState<ReleaseBump>(suggestedBump(latest));
  const [releaseNote, setReleaseNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<string, NoteRelease>>({});
  const changed = draftChanged(note);

  // The suggestion follows the latest release (e.g. after releasing, the next one is a minor version again)
  useEffect(() => setBump(suggestedBump(latest)), [latest]);

  const fetchRelease = async (version: string): Promise<NoteRelease> => {
    if (loaded[version]) return loaded[version];
    const r = await api<NoteRelease>(`/notes/${note.id}/releases/${encodeURIComponent(version)}`);
    setLoaded((l) => ({ ...l, [version]: r }));
    return r;
  };

  useEffect(() => {
    if (!viewing) return;
    const at = releases.findIndex((r) => r.version === viewing);
    const previous = viewing === DRAFT ? latest : releases[at + 1]?.version;
    for (const v of [viewing === DRAFT ? null : viewing, previous]) if (v) fetchRelease(v).catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (enabled: boolean) => {
    if (!enabled && !confirm(t('release.offConfirm'))) return;
    void run(() => vault.setVersioning(note.id, enabled));
  };

  const release = () =>
    run(async () => {
      editorHost.flush();
      await vault.release(note.id, bump, releaseNote);
      setReleaseNote('');
    });

  const discard = () => {
    if (!latest || !confirm(t('release.discardConfirm', { version: latest }))) return;
    void run(async () => {
      const r = await fetchRelease(latest);
      editorHost.flush();
      await vault.update(note.id, { content: r.content });
    });
  };

  const addHistory = () => {
    editorHost.flush();
    const body = note.content.replace(/\s*$/, '');
    void vault.update(note.id, { content: `${body}\n\n## ${t('release.historyHeading')}\n\n\`\`\`versions\n\`\`\`\n` });
  };

  if (viewing) {
    // The draft is compared with the latest release, every release with the one before it (the first with an empty note)
    const draft = viewing === DRAFT;
    const at = releases.findIndex((r) => r.version === viewing);
    const previousVersion = draft ? latest : (releases[at + 1]?.version ?? null);
    const r = draft ? null : loaded[viewing];
    const previous = previousVersion ? loaded[previousVersion] : null;
    const ready = (draft || !!r) && (!previousVersion || !!previous);
    const after = ready ? (draft ? note.content : r!.content) : null;
    return (
      <Sheet title={draft ? t('release.draftTitle') : `v${viewing}`} onClose={onClose}>
        <button type="button" className="btn-text -ml-3 mb-2" onClick={() => setViewing(null)}>
          <ArrowLeft size={16} /> {t('release.backToList')}
        </button>
        {ready ? (
          <ReleaseChanges
            key={viewing}
            title={draft ? t('release.draftSince', { version: latest ?? '' }) : previousVersion ? t('release.changesSince', { version: previousVersion }) : t('release.firstRelease')}
            meta={r ? `${t('release.releasedMeta', { date: fmt(r.releasedAt), user: r.releasedBy || '—' })}${r.note ? ` · ${r.note}` : ''}` : null}
            before={previous?.content ?? ''}
            after={after!}
            rendered={<Editor docKey={`release:${note.id}:${viewing}`} value={after!} readOnly releases={releases} variables={variables} />}
          />
        ) : (
          <div className="mb-6 flex justify-center py-8 text-on-surface-variant">{error || <Loader2 size={20} className="animate-spin" />}</div>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet title={t('release.title')} onClose={onClose}>
      {!note.versioning ? (
        <div className="mb-6 space-y-4">
          <p className="text-body-m text-on-surface-variant">{t('release.intro')}</p>
          {isOwner ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => toggle(true)}>
              <NewReleases size={18} /> {t('release.turnOn')}
            </button>
          ) : (
            <p className="text-body-s text-on-surface-variant">{t('release.ownerOnly')}</p>
          )}
        </div>
      ) : (
        <div className="mb-6 space-y-5">
          <div className="rounded-2xl bg-surface-container px-4 py-3 text-body-m" data-release-status>
            {note.access === 'read' ? (
              latest ? t('release.readerSees', { version: latest }) : t('release.readerDraft')
            ) : latest ? (
              <>
                <span className="font-medium">{t('release.releasedVersion', { version: latest })}</span>
                {' · '}
                {changed ? t('release.draftInProgress', { version: nextVersion(latest, bump) }) : t('release.noChanges')}
              </>
            ) : (
              t('release.noReleaseYet')
            )}
          </div>

          {isOwner && (
            <section className="space-y-3">
              <h3 className="text-title-s">{t('release.newTitle')}</h3>
              <div className="segmented" role="group" aria-label={t('release.bumpAria')}>
                {(['major', 'minor', 'patch'] as const).map((b) => (
                  <button key={b} type="button" aria-pressed={bump === b} onClick={() => setBump(b)}>
                    {t(`release.bump.${b}` as I18nKey)} <span className="tabular-nums opacity-80">{nextVersion(latest, b)}</span>
                  </button>
                ))}
              </div>
              <input
                className="input"
                maxLength={MAX_RELEASE_NOTE}
                placeholder={t('release.notePlaceholder')}
                value={releaseNote}
                onChange={(e) => setReleaseNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && void release()}
              />
              {latest && !changed && <p className="text-body-s text-on-surface-variant">{t('release.unchangedHint', { version: latest })}</p>}
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void release()}>
                {busy ? <Loader2 size={18} className="animate-spin" /> : <NewReleases size={18} />} {t('release.releaseAs', { version: nextVersion(latest, bump) })}
              </button>
            </section>
          )}

          <section>
            <h3 className="mb-1 text-title-s">{t('release.listTitle')}</h3>
            {releases.length > 0 && <p className="mb-2 text-body-s text-on-surface-variant">{t('release.listHint')}</p>}
            {releases.length === 0 ? (
              <p className="text-body-s text-on-surface-variant">{t('release.listEmpty')}</p>
            ) : (
              <ul className="space-y-1">
                {changed && latest && (
                  <li>
                    <button type="button" className="flex w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left hover:bg-surface-container" onClick={() => setViewing(DRAFT)} data-release-draft>
                      <span className="chip shrink-0">{t('release.draft')}</span>
                      <span className="min-w-0 flex-1 truncate text-body-m text-on-surface-variant">{t('release.draftSince', { version: latest })}</span>
                    </button>
                  </li>
                )}
                {releases.map((r) => (
                  <li key={r.version}>
                    <button type="button" className="flex w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left hover:bg-surface-container" onClick={() => setViewing(r.version)}>
                      <span className="chip shrink-0 tabular-nums">v{r.version}</span>
                      <span className="min-w-0 flex-1 truncate text-body-m">{r.note || <span className="text-on-surface-variant">—</span>}</span>
                      <span className="shrink-0 text-body-s text-on-surface-variant">
                        {new Date(r.releasedAt).toLocaleDateString(locale(lang), { dateStyle: 'medium' })} · {r.releasedBy}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canEdit && (
            <section className="space-y-2">
              <h3 className="text-title-s">{t('release.placeholdersTitle')}</h3>
              <p className="text-body-s text-on-surface-variant">{t('release.placeholdersDesc')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-tonal" onClick={addHistory}>
                  {t('release.addHistory')}
                </button>
                {latest && changed && (
                  <button type="button" className="btn-outlined" disabled={busy} onClick={discard}>
                    {t('release.discard')}
                  </button>
                )}
                {isOwner && (
                  <button type="button" className="btn-text" disabled={busy} onClick={() => toggle(false)}>
                    {t('release.turnOff')}
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mb-4 text-body-s text-error">
          {error}
        </p>
      )}
    </Sheet>
  );
}
