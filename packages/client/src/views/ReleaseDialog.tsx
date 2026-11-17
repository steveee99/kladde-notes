import { useEffect, useState } from 'react';
import { contentHash, nextVersion, suggestedBump, MAX_RELEASE_NOTE, type NoteRelease, type ReleaseBump } from '@kladde/shared';
import { ArrowLeft, Loader2, NewReleases } from '../lib/icons';
import { api } from '../lib/api';
import { vault } from '../data/vault';
import type { LocalNote } from '../data/db';
import { editorHost } from '../editor/host';
import { Editor } from '../editor/Editor';
import { locale, t, useLang, type I18nKey } from '../lib/i18n';
import { Sheet } from './Dialogs';

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
    if (viewing) fetchRelease(viewing).catch((e: Error) => setError(e.message));
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
    const r = loaded[viewing];
    return (
      <Sheet title={`v${viewing}`} onClose={onClose}>
        <button type="button" className="btn-text -ml-3 mb-2" onClick={() => setViewing(null)}>
          <ArrowLeft size={16} /> {t('release.backToList')}
        </button>
        {r ? (
          <>
            <p className="mb-3 text-body-s text-on-surface-variant">
              {t('release.releasedMeta', { date: fmt(r.releasedAt), user: r.releasedBy || '—' })}
              {r.note ? ` · ${r.note}` : ''}
            </p>
            <div className="mb-6 rounded-2xl border border-outline-variant bg-surface px-4 py-2">
              <Editor docKey={`release:${note.id}:${viewing}`} value={r.content} readOnly releases={releases} />
            </div>
          </>
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
            <h3 className="mb-2 text-title-s">{t('release.listTitle')}</h3>
            {releases.length === 0 ? (
              <p className="text-body-s text-on-surface-variant">{t('release.listEmpty')}</p>
            ) : (
              <ul className="space-y-1">
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
