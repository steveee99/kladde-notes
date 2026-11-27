import { useEffect, useRef, useState, type ReactNode } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import {
  ArrowLeft,
  RefreshCw,
  Camera,
  Images,
  KeyRound,
  LayoutTemplate,
  Loader2,
  Lock,
  LogOut,
  Smartphone,
  Trash2,
  Upload,
} from '../lib/icons';
import { APP_VERSION, Me, PASSWORD_MIN_LENGTH, type LoginMethod } from '@kladde/shared';
import { api, deleteAvatar, setDisplayName, uploadAvatar } from '../lib/api';
import { useConfluence } from '../lib/confluence';
import { Lang, locale, setLang, tl, useLang, type I18nKey } from '../lib/i18n';
import { Dropdown } from './Dropdown';
import { CODE_COLLAPSE_OPTIONS, setCompleteParents, useCompleteParents, EDITOR_FONT_SIZES, NOTE_WIDTHS, setNoteWidth, useNoteWidth, type NoteWidth, setCodeBlockPrefs, setEditorFontSize, setInboxZero, setLigatures, setPinchZoom, useCodeBlockPrefs, useEditorFontSize, useInboxZero, useLigatures, usePinchZoom } from '../lib/prefs';
import { setColorSchemeChoice, useColorSchemeChoice } from '../lib/theme';
import { CODE_THEMES, setCodeTheme, useCodeTheme } from '../lib/codeTheme';
import { useVault, vault } from '../data/vault';
import { navigate, usePath } from '../lib/router';
import { GitLabIcon, passkeysAvailable, useAuthProviders, useRedirectParam } from './Auth';
import { Avatar } from './Avatar';
import { Switch } from './Switch';
import { AccentPicker } from './AccentPicker';
import { DEMO } from '../demo/demoApi';
import { SettingsNav, useSettingsNavInPanel, type SettingsSection } from './SettingsNav';
import { PageBody, PageHeader } from './PageHeader';

/** Optional display name, shown instead of the username (GitLab sign-in fills it in while it is empty) */
function DisplayNameField({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const lang = useLang();
  const [value, setValue] = useState(me.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => setValue(me.displayName ?? ''), [me.displayName]);
  const dirty = value.trim() !== (me.displayName ?? '');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      onMe(await setDisplayName(value.trim() || null));
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) void save();
      }}
    >
      <label htmlFor="display-name" className="block text-label-l text-muted">
        {tl(lang, 'settings.displayNameTitle')}
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          id="display-name"
          className="input min-w-0 flex-1 sm:max-w-sm"
          value={value}
          maxLength={80}
          autoComplete="name"
          placeholder={me.username}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          data-display-name
        />
        <button type="submit" className="btn-tonal" disabled={busy || !dirty}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {tl(lang, 'common.save')}
        </button>
        {saved && !dirty && <span className="text-body-s text-muted">{tl(lang, 'settings.displayNameSaved')}</span>}
      </div>
      <p className="mt-1 text-body-s text-muted">{tl(lang, 'settings.displayNameHint')}</p>
      {err && <p className="pt-1 text-sm text-error">{err}</p>}
    </form>
  );
}

function ProfileSection({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!navigator.onLine && !me.standalone) {
      setErr(tl(lang, 'settings.profileOnlineOnly'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      onMe(await uploadAvatar(file));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!navigator.onLine && !me.standalone) {
      setErr(tl(lang, 'settings.profileOnlineOnly'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      onMe(await deleteAvatar());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-b border-line py-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => !busy && inputRef.current?.click()}
          disabled={busy}
          title={me.avatarUrl ? tl(lang, 'settings.profileChange') : tl(lang, 'settings.profileUpload')}
          aria-label={me.avatarUrl ? tl(lang, 'settings.profileChange') : tl(lang, 'settings.profileUpload')}
          className="group relative self-start rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Avatar name={me.displayName || me.username} avatarUrl={me.avatarUrl} size="xl" />
          <span className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-container-low bg-secondary-container text-on-secondary-container shadow-soft transition-transform group-hover:scale-105">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
          </span>
        </button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-body-m font-medium text-text">{tl(lang, 'settings.profileTitle')}</h2>
            {me.displayName && <span className="text-body-m text-text">{me.displayName}</span>}
            <span className="chip">{me.username}</span>
          </div>
          <p className="text-xs text-on-surface-variant">{tl(lang, 'settings.profileHint')}</p>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="btn-tonal"
            >
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
              {busy ? tl(lang, 'settings.profileUploading') : me.avatarUrl ? tl(lang, 'settings.profileChange') : tl(lang, 'settings.profileUpload')}
            </button>
            {me.avatarUrl && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleRemove()}
                className="btn-outlined px-4 py-2 text-sm text-error hover:bg-error/10"
              >
                <Trash2 size={15} /> {tl(lang, 'settings.profileRemove')}
              </button>
            )}
          </div>
          {err && <p className="pt-1 text-sm text-error">{err}</p>}
        </div>
      </div>
      {!me.standalone && <DisplayNameField me={me} onMe={onMe} />}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        hidden
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </section>
  );
}

/** One setting: title and description on the left, the control on the right (below it on narrow screens) */
function SettingRow({ title, desc, htmlFor, children, stacked }: { title: ReactNode; desc?: ReactNode; htmlFor?: string; children?: ReactNode; stacked?: boolean }) {
  return (
    <div className={`flex gap-x-6 gap-y-3 border-b border-line py-4 ${stacked ? 'flex-col' : 'flex-col sm:flex-row sm:items-center'}`}>
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="cursor-pointer text-body-m font-medium text-text">
            {title}
          </label>
        ) : (
          <div className="text-body-m font-medium text-text">{title}</div>
        )}
        {desc && <div className="mt-0.5 text-body-s text-muted">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/** A setting with a switch: the switch stays on the right on every screen */
function SwitchRow({ id, title, desc, label, checked, onChange }: { id: string; title: string; desc: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-6 border-b border-line py-4">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="cursor-pointer text-body-m font-medium text-text">
          {title}
        </label>
        <div className="mt-0.5 text-body-s text-muted">{desc}</div>
      </div>
      <Switch id={id} checked={checked} label={label} onChange={onChange} />
    </div>
  );
}

/** Caption above a group of settings */
function GroupLabel({ children }: { children: ReactNode }) {
  return <h2 className="section-label pb-1 pt-7 first:pt-2">{children}</h2>;
}

/**
 * Settings (Werkbank): one page per section (`/settings/account`, `appearance`, `editor`, `sync`), picked in the
 * settings navigation. On phones (and with the side panel collapsed) `/settings` shows that navigation as a list.
 */
export function SettingsView({ me, onMe, onLogout, section }: { me: Me; onMe: (me: Me) => void; onLogout: () => void; section: SettingsSection | null }) {
  // Loads the Confluence state once; hides the entry when the server has no Confluence (demo)
  useConfluence();
  useVault();
  const lang = useLang();
  const loc = locale(lang);
  const inboxZero = useInboxZero();
  const pinchZoom = usePinchZoom();
  const completeParents = useCompleteParents();
  const ligatures = useLigatures();
  const codeBlocks = useCodeBlockPrefs();
  const editorFontSize = useEditorFontSize();
  const noteWidth = useNoteWidth();
  const colorScheme = useColorSchemeChoice();
  const codeTheme = useCodeTheme();
  const inPanel = useSettingsNavInPanel();
  const path = usePath();
  const [link, setLink] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const linkUrl = link ? `${location.origin}/link/${link.code}` : '';

  // The overview: the navigation as a list, where it is not in the side panel
  if (!section || (!inPanel && path === '/settings')) {
    return (
      <div>
        <PageHeader title={tl(lang, 'settings.title')} subtitle={me.displayName || me.username} />
        <PageBody className="max-w-[760px] !mx-0">
          <SettingsNav me={me} />
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            {!me.standalone ? (
              <button className="btn-text text-red" onClick={onLogout}>
                <LogOut size={16} /> {tl(lang, 'settings.logout')}
              </button>
            ) : (
              <span className="text-body-s text-muted">Standalone Desktop</span>
            )}
            <span className="font-mono text-[11px] text-muted">Kladde {APP_VERSION}</span>
          </div>
        </PageBody>
      </div>
    );
  }

  const linkTextParts = link
    ? tl(lang, 'settings.deviceLinkText', {
        time: new Date(link.expiresAt).toLocaleTimeString(loc, { timeStyle: 'short' }),
      }).split(/(\{url\}|\{code\})/)
    : [];

  const titles: Record<SettingsSection, [I18nKey, I18nKey]> = {
    account: ['settings.navAccount', 'settings.navAccountDesc'],
    appearance: ['settings.navAppearance', 'settings.navAppearanceDesc'],
    editor: ['settings.navEditor', 'settings.navEditorDesc'],
    sync: ['settings.navSync', 'settings.navSyncDesc'],
  };
  const [titleKey, descKey] = titles[section];

  return (
    <div data-settings-section={section}>
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            {!inPanel && (
              <button className="btn-icon -ml-2 h-8 w-8" onClick={() => navigate('/settings')} title={tl(lang, 'settings.backToOverview')} aria-label={tl(lang, 'settings.backToOverview')}>
                <ArrowLeft size={18} />
              </button>
            )}
            {tl(lang, titleKey)}
          </span>
        }
        subtitle={tl(lang, descKey)}
      />
      <PageBody className="max-w-[760px] !mx-0 !pt-2">
        {section === 'account' && (
          <>
            <ProfileSection me={me} onMe={onMe} />
            {!me.standalone && (
              <section data-security-section>
                <GroupLabel>{tl(lang, 'settings.securityTitle')}</GroupLabel>
                <div className="divide-y divide-line [&>*]:py-4">
          {offers(me, 'passkey') && (
          <div>
            <h3 className="mb-1 text-sm font-medium">{tl(lang, 'settings.passkeysTitle', { username: me.username })}</h3>
            <p className="mb-3 text-sm text-on-surface-variant">{tl(lang, 'settings.passkeysDesc')}</p>
            {!me.passkeys.length && <p className="mb-3 text-sm text-on-surface-variant">{tl(lang, 'settings.passkeysEmpty')}</p>}
            <ul className="mb-3 divide-y divide-outline-variant">
              {me.passkeys.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <KeyRound size={16} className="shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{p.name}</div>
                    <div className="text-xs text-on-surface-variant">
                      {tl(lang, 'settings.passkeyMeta', {
                        created: new Date(p.createdAt).toLocaleDateString(loc),
                        last: p.lastUsedAt ? tl(lang, 'settings.passkeyLastUsed', { date: new Date(p.lastUsedAt).toLocaleDateString(loc) }) : '',
                      })}
                    </div>
                  </div>
                  {(me.passkeys.length > 1 || me.hasPassword || !!me.externalLogins?.length) && (
                    <button
                      className="btn-icon h-8 w-8 shrink-0"
                      onClick={async () => {
                        if (confirm(tl(lang, 'settings.passkeyRemoveConfirm'))) onMe(await api<Me>(`/auth/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }));
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-outlined"
                disabled={!passkeysAvailable()}
                title={passkeysAvailable() ? undefined : tl(lang, 'settings.passkeyHttpsOnly')}
                onClick={async () => {
                  setError('');
                  try {
                    const { flowId, options } = await api<{ flowId: string; options: never }>('/auth/passkeys/options', { method: 'POST', json: {} });
                    const response = await startRegistration({ optionsJSON: options });
                    onMe(await api<Me>('/auth/passkeys/verify', { method: 'POST', json: { flowId, response } }));
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <KeyRound size={16} /> {tl(lang, 'settings.passkeyAddHere')}
              </button>
              <button className="btn-outlined" onClick={async () => setLink(await api('/auth/device-link', { method: 'POST', json: {} }))}>
                <Smartphone size={16} /> {tl(lang, 'settings.deviceConnect')}
              </button>
            </div>
            {link && (
              <div className="mt-3 rounded-xl bg-surface-container-high p-3 text-sm anim-fade-up">
                {linkTextParts.map((part, i) =>
                  part === '{url}' ? (
                    <b key={i} className="break-all">
                      {linkUrl}
                    </b>
                  ) : part === '{code}' ? (
                    <b key={i} className="font-mono">
                      {link.code}
                    </b>
                  ) : (
                    <span key={i}>{part}</span>
                  )
                )}
              </div>
            )}
            {error && <p className="mt-2 text-sm text-error">{error}</p>}
          </div>
          )}

            {offers(me, 'password') && <PasswordSection me={me} onMe={onMe} />}
            <GitLabSection me={me} onMe={onMe} />
                </div>
              </section>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
              {!me.standalone ? (
                <button className="btn-text -ml-2.5 text-red" onClick={onLogout}>
                  <LogOut size={16} /> {tl(lang, 'settings.logout')}
                </button>
              ) : (
                <span className="text-body-s text-muted">Standalone Desktop</span>
              )}
              <span className="font-mono text-[11px] text-muted">Kladde {APP_VERSION}</span>
            </div>
          </>
        )}

        {section === 'appearance' && (
          <>
            <div className="border-b border-line py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-body-m font-medium text-text">{tl(lang, 'settings.accentTitle')}</div>
              </div>
              <div className="mb-4 mt-0.5 text-body-s text-muted">{tl(lang, 'settings.accentDesc')}</div>
              <AccentPicker onMe={onMe} />
            </div>
            <SettingRow title={tl(lang, 'settings.colorSchemeTitle')} desc={tl(lang, 'settings.colorSchemeDesc')}>
              <div className="segmented grid w-full grid-cols-4 sm:inline-flex sm:w-auto sm:shrink-0" role="group" aria-label={tl(lang, 'settings.colorSchemeTitle')}>
                {(
                  [
                    ['dark', 'settings.colorSchemeDark'],
                    ['mocha', 'settings.colorSchemeMocha'],
                    ['light', 'settings.colorSchemeLight'],
                    ['system', 'settings.colorSchemeSystem'],
                  ] as const
                ).map(([choice, label]) => (
                  <button key={choice} type="button" aria-pressed={colorScheme === choice} onClick={() => setColorSchemeChoice(choice)} className="min-w-0">
                    <span className="truncate">{tl(lang, label)}</span>
                  </button>
                ))}
              </div>
            </SettingRow>
            <SettingRow title={tl(lang, 'settings.codeThemeTitle')} desc={tl(lang, 'settings.codeThemeDesc')}>
              <div className="segmented grid w-full grid-cols-2 min-[420px]:grid-cols-4 sm:inline-flex sm:w-auto sm:shrink-0" role="group" aria-label={tl(lang, 'settings.codeThemeTitle')}>
                {CODE_THEMES.map((theme) => (
                  <button key={theme} type="button" aria-pressed={codeTheme === theme} onClick={() => setCodeTheme(theme)} className="min-w-0" data-code-theme-choice={theme}>
                    <span className="truncate">{tl(lang, `settings.codeTheme.${theme}`)}</span>
                  </button>
                ))}
              </div>
            </SettingRow>
            <SettingRow title={tl(lang, 'common.language')} desc={tl(lang, 'common.languageDesc')}>
              <div className="segmented max-w-full shrink-0 self-start sm:self-auto" role="group" aria-label={tl(lang, 'common.language')}>
                {(['de', 'en'] as Lang[]).map((code) => (
                  <button key={code} type="button" aria-pressed={lang === code} onClick={() => setLang(code)}>
                    {code === 'de' ? tl(lang, 'common.langDe') : tl(lang, 'common.langEn')}
                  </button>
                ))}
              </div>
            </SettingRow>
            <GroupLabel>{tl(lang, 'settings.workTitle')}</GroupLabel>
            <SwitchRow
              id="inbox-zero-switch"
              title={tl(lang, 'settings.inboxZeroTitle')}
              desc={tl(lang, 'settings.inboxZeroDesc')}
              label={tl(lang, 'settings.inboxZeroLabel')}
              checked={inboxZero}
              onChange={setInboxZero}
            />
            <SwitchRow
              id="complete-parents-switch"
              title={tl(lang, 'settings.completeParentsTitle')}
              desc={tl(lang, 'settings.completeParentsDesc')}
              label={tl(lang, 'settings.completeParentsLabel')}
              checked={completeParents}
              onChange={setCompleteParents}
            />
          </>
        )}

        {section === 'editor' && (
          <>
            <SettingRow title={tl(lang, 'settings.editorFontTitle')} desc={tl(lang, 'settings.editorFontDesc')}>
              <div className="segmented max-w-full shrink-0 self-start sm:self-auto" role="group" aria-label={tl(lang, 'settings.editorFontTitle')}>
                {EDITOR_FONT_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    aria-pressed={editorFontSize === size}
                    aria-label={`${size} px`}
                    title={`${size} px`}
                    onClick={() => setEditorFontSize(size)}
                    className="min-w-[2.5rem] tabular-nums"
                    style={{ fontSize: `${Math.round(size * 0.8)}px` }}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </SettingRow>
            <SettingRow title={tl(lang, 'settings.noteWidthTitle')} desc={tl(lang, 'settings.noteWidthDesc')}>
              <Dropdown
                className="shrink-0 self-start sm:w-56 sm:self-auto"
                aria-label={tl(lang, 'settings.noteWidthTitle')}
                value={noteWidth}
                options={NOTE_WIDTHS.map((w) => ({ value: w, label: tl(lang, `settings.noteWidth.${w}` as I18nKey) }))}
                onChange={(v) => setNoteWidth(v as NoteWidth)}
              />
            </SettingRow>
            <SwitchRow
              id="pinch-zoom-switch"
              title={tl(lang, 'settings.pinchZoomTitle')}
              desc={tl(lang, 'settings.pinchZoomDesc')}
              label={tl(lang, 'settings.pinchZoomLabel')}
              checked={pinchZoom}
              onChange={setPinchZoom}
            />
            <SwitchRow
              id="ligatures-switch"
              title={tl(lang, 'settings.ligaturesTitle')}
              desc={tl(lang, 'settings.ligaturesDesc')}
              label={tl(lang, 'settings.ligaturesLabel')}
              checked={ligatures}
              onChange={setLigatures}
            />
            <GroupLabel>{tl(lang, 'settings.codeBlocksTitle')}</GroupLabel>
            <SwitchRow
              id="code-line-numbers-switch"
              title={tl(lang, 'settings.codeLineNumbersTitle')}
              desc={tl(lang, 'settings.codeLineNumbersDesc')}
              label={tl(lang, 'settings.codeLineNumbersTitle')}
              checked={codeBlocks.lineNumbers}
              onChange={(on) => setCodeBlockPrefs({ lineNumbers: on })}
            />
            <SwitchRow
              id="code-copy-switch"
              title={tl(lang, 'settings.codeCopyTitle')}
              desc={tl(lang, 'settings.codeCopyDesc')}
              label={tl(lang, 'settings.codeCopyTitle')}
              checked={codeBlocks.copy}
              onChange={(on) => setCodeBlockPrefs({ copy: on })}
            />
            <SwitchRow
              id="code-language-switch"
              title={tl(lang, 'settings.codeLanguageTitle')}
              desc={tl(lang, 'settings.codeLanguageDesc')}
              label={tl(lang, 'settings.codeLanguageTitle')}
              checked={codeBlocks.language}
              onChange={(on) => setCodeBlockPrefs({ language: on })}
            />
            <SettingRow title={tl(lang, 'settings.codeCollapseTitle')} desc={tl(lang, 'settings.codeCollapseDesc')}>
              <div className="segmented grid w-full grid-cols-4 sm:inline-flex sm:w-auto sm:shrink-0" role="group" aria-label={tl(lang, 'settings.codeCollapseTitle')}>
                {CODE_COLLAPSE_OPTIONS.map((n) => (
                  <button key={n} type="button" aria-pressed={codeBlocks.collapseAfter === n} onClick={() => setCodeBlockPrefs({ collapseAfter: n })} className="min-w-0 tabular-nums">
                    {n === 0 ? tl(lang, 'settings.codeCollapseNever') : tl(lang, 'settings.codeCollapseLines', { n: String(n) })}
                  </button>
                ))}
              </div>
            </SettingRow>
            <div className="border-b border-line py-4 text-body-s text-muted">
              {tl(lang, 'settings.codeInfoHint')}
              <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-panel px-3 py-2 font-mono text-[12.5px] text-body">```ts title="vault.ts" {'{3-4}'} showLineNumbers</pre>
            </div>
            <SettingRow title={tl(lang, 'settings.templatesTitle')} desc={tl(lang, 'settings.navTemplatesDesc')}>
              <button className="btn-outlined self-start sm:self-auto" onClick={() => navigate('/settings/templates')}>
                <LayoutTemplate size={16} /> {tl(lang, 'settings.templatesTitle')}
              </button>
            </SettingRow>
          </>
        )}

        {section === 'sync' && (
          <>
            <SettingRow
              title={me.standalone ? tl(lang, 'settings.standaloneTitle') : tl(lang, 'settings.syncTitle')}
              desc={
                <>
                  {me.standalone
                    ? tl(lang, 'settings.standaloneStats', { notes: vault.list().length, pending: vault.pendingCount() })
                    : tl(lang, 'settings.syncStats', {
                        notes: vault.list().length,
                        pending: vault.pendingCount(),
                        last: vault.lastSync ? tl(lang, 'settings.syncLast', { time: new Date(vault.lastSync).toLocaleTimeString(loc, { timeStyle: 'short' }) }) : '',
                      })}
                  <br />
                  {me.standalone ? tl(lang, 'settings.standaloneNote') : tl(lang, 'settings.syncOfflineNote')}
                </>
              }
            >
              {!me.standalone && !DEMO && (
                <button className="btn-outlined self-start sm:self-auto" onClick={() => vault.kick()}>
                  <RefreshCw size={16} /> {tl(lang, 'cmd.syncNow')}
                </button>
              )}
            </SettingRow>
            {me.standalone && me.dataDir && (
              <SettingRow title={tl(lang, 'settings.standaloneDataDir')} stacked>
                <code className="block rounded-md border border-line2 bg-sunken px-3 py-2 font-mono text-xs break-all text-text">{me.dataDir}</code>
              </SettingRow>
            )}
            <SettingRow title={tl(lang, 'settings.filesTitle')} desc={tl(lang, 'settings.filesDesc')}>
              <button className="btn-outlined self-start sm:self-auto" onClick={() => navigate('/settings/files')}>
                <Images size={16} /> {tl(lang, 'settings.filesTitle')}
              </button>
            </SettingRow>
            <SettingRow title={tl(lang, 'settings.trashTitle')} desc={tl(lang, 'settings.trashDesc')}>
              <button className="btn-outlined self-start sm:self-auto" onClick={() => navigate('/settings/trash')}>
                <Trash2 size={16} /> {tl(lang, 'settings.trashTitle')}
              </button>
            </SettingRow>
          </>
        )}
      </PageBody>
    </div>
  );
}

/** Whether the server offers this way to sign in (LOGIN_METHODS; older servers send nothing: all) */
const offers = (me: Me, method: LoginMethod) => !me.loginMethods || me.loginMethods.includes(method);

/** Link a GitLab account for "Sign in with GitLab" (only when the server has GitLab configured) */
function GitLabSection({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const lang = useLang();
  const providers = useAuthProviders();
  const linkedParam = useRedirectParam('gitlab');
  const errorParam = useRedirectParam('gitlab_error');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(() =>
    errorParam ? { ok: false, text: errorParam } : linkedParam === 'linked' ? { ok: true, text: tl(lang, 'settings.gitlabLinked') } : null
  );
  if (!providers?.gitlab.enabled) return null;
  const name = providers.gitlab.label;
  const linked = me.externalLogins?.find((l) => l.provider === 'gitlab');
  const canUnlink = (offers(me, 'passkey') && me.passkeys.length > 0) || (offers(me, 'password') && me.hasPassword) || (me.externalLogins?.length ?? 0) > 1;
  return (
    <div data-gitlab-section>
      <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
        <GitLabIcon size={18} /> {tl(lang, 'settings.gitlabTitle', { name })}
      </h3>
      <p className="mb-3 text-sm text-on-surface-variant">
        {linked
          ? tl(lang, 'settings.gitlabLinkedAs', { name, username: linked.username, date: new Date(linked.createdAt).toLocaleDateString(locale(lang)) })
          : tl(lang, 'settings.gitlabDesc', { name })}
      </p>
      <div className="flex flex-wrap gap-2">
        {linked ? (
          <button
            className="btn-outlined text-error"
            disabled={!canUnlink}
            title={canUnlink ? undefined : tl(lang, 'settings.gitlabUnlinkBlocked')}
            onClick={async () => {
              if (!confirm(tl(lang, 'settings.gitlabUnlinkConfirm', { name }))) return;
              try {
                onMe(await api<Me>('/auth/gitlab', { method: 'DELETE' }));
                setMessage({ ok: true, text: tl(lang, 'settings.gitlabUnlinked') });
              } catch (e) {
                setMessage({ ok: false, text: (e as Error).message });
              }
            }}
          >
            <Trash2 size={16} /> {tl(lang, 'common.disconnect')}
          </button>
        ) : (
          <a className="btn-outlined" href="/api/auth/gitlab/start?intent=link">
            <GitLabIcon size={16} /> {tl(lang, 'settings.gitlabLink', { name })}
          </a>
        )}
      </div>
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-primary' : 'text-error'}`}>{message.text}</p>}
    </div>
  );
}

/** Optional password: for devices on a plain-HTTP home network, where passkeys do not work */
function PasswordSection({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = repeat.length > 0 && next !== repeat;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      onMe(await api<Me>('/auth/password', { method: 'POST', json: { currentPassword: current, newPassword: next } }));
      setMessage({ ok: true, text: me.hasPassword ? tl(lang, 'settings.passwordChanged') : tl(lang, 'settings.passwordCreated') });
      setOpen(false);
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{tl(lang, 'settings.passwordTitle')}</h3>
      <p className="mb-3 text-sm text-on-surface-variant">
        {me.hasPassword ? tl(lang, 'settings.passwordHasHint') : tl(lang, 'settings.passwordNoHint')}
      </p>
      {open ? (
        <form
          className="space-y-2 anim-fade-up"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {/* Hidden username field so password managers file the password under the right account */}
          <input type="text" className="hidden" autoComplete="username" value={me.username} readOnly />
          {me.hasPassword && (
            <input
              className="input"
              type="password"
              placeholder={tl(lang, 'settings.passwordCurrent')}
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
          <input
            className="input"
            type="password"
            placeholder={tl(lang, 'settings.passwordNew', { min: PASSWORD_MIN_LENGTH })}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder={tl(lang, 'settings.passwordRepeat')}
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
          {mismatch && <p className="text-sm text-error">{tl(lang, 'settings.passwordMismatch')}</p>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || next.length < PASSWORD_MIN_LENGTH || next !== repeat || (me.hasPassword && !current)}>
              {tl(lang, 'common.save')}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              {tl(lang, 'common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className="btn-outlined" onClick={() => setOpen(true)}>
            <Lock size={16} /> {me.hasPassword ? tl(lang, 'settings.passwordChange') : tl(lang, 'settings.passwordSet')}
          </button>
          {me.hasPassword && (me.passkeys.length > 0 || !!me.externalLogins?.length) && (
            <button
              className="btn-ghost text-error"
              onClick={async () => {
                if (!confirm(tl(lang, 'settings.passwordRemoveConfirm'))) return;
                try {
                  onMe(await api<Me>('/auth/password', { method: 'DELETE' }));
                  setMessage({ ok: true, text: tl(lang, 'settings.passwordRemoved') });
                } catch (e) {
                  setMessage({ ok: false, text: (e as Error).message });
                }
              }}
            >
              <Trash2 size={16} /> {tl(lang, 'common.remove')}
            </button>
          )}
        </div>
      )}
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-primary' : 'text-error'}`}>{message.text}</p>}
    </div>
  );
}

/** Snap distance (percent points) around the presets */
