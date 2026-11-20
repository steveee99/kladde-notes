import { useRef, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import {
  ArrowRight,
  Camera,
  ChevronRight,
  FolderInput,
  Globe,
  Images,
  Inbox,
  Info,
  KeyRound,
  LayoutTemplate,
  Loader2,
  Lock,
  LogOut,
  Maximize2,
  ShieldCheck,
  Smartphone,
  SunMoon,
  Trash2,
  Archive,
  Upload,
  TextFields,
  Extension,
  Palette,
} from '../lib/icons';
import { APP_VERSION, Me, PASSWORD_MIN_LENGTH } from '@kladde/shared';
import { api, deleteAvatar, uploadAvatar } from '../lib/api';
import { useConfluence } from '../lib/confluence';
import { Lang, locale, setLang, tl, useLang } from '../lib/i18n';
import { EDITOR_FONT_SIZES, setEditorFontSize, setInboxZero, setLigatures, useEditorFontSize, useInboxZero, useLigatures } from '../lib/prefs';
import { setColorSchemeChoice, useColorSchemeChoice } from '../lib/theme';
import { DEFAULT_PERCENT, MAX_PERCENT, MIN_PERCENT, setWidescreen, useWidescreen, WIDESCREEN_PRESETS } from '../lib/widescreen';
import { useVault, vault } from '../data/vault';
import { navigate } from '../lib/router';
import { GitLabIcon, passkeysAvailable, useAuthProviders, useRedirectParam } from './Auth';
import { Avatar } from './Avatar';
import { Switch } from './Switch';
import { AccentPicker } from './AccentPicker';
import { DEMO } from '../demo/demoApi';
import { FeaturesDialog, useFeatureCounts } from './FeaturesDialog';
import { PageBody, PageHeader } from './PageHeader';

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
    <section className="card p-5 anim-fade-up">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => !busy && inputRef.current?.click()}
          disabled={busy}
          title={me.avatarUrl ? tl(lang, 'settings.profileChange') : tl(lang, 'settings.profileUpload')}
          aria-label={me.avatarUrl ? tl(lang, 'settings.profileChange') : tl(lang, 'settings.profileUpload')}
          className="group relative self-start rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Avatar name={me.username} avatarUrl={me.avatarUrl} size="xl" />
          <span className="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface-container-low bg-secondary-container text-on-secondary-container shadow-soft transition-transform group-hover:scale-105">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
          </span>
        </button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-title-m text-strong">{tl(lang, 'settings.profileTitle')}</h2>
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

export function SettingsView({ me, onMe, onLogout }: { me: Me; onMe: (me: Me) => void; onLogout: () => void }) {
  // Loads the Confluence state once; hides the entry when the server has no Confluence (demo)
  useConfluence();
  useVault();
  const lang = useLang();
  const loc = locale(lang);
  const widescreen = useWidescreen();
  const inboxZero = useInboxZero();
  const ligatures = useLigatures();
  const editorFontSize = useEditorFontSize();
  const colorScheme = useColorSchemeChoice();
  const [link, setLink] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const linkUrl = link ? `${location.origin}/link/${link.code}` : '';

  const templatesCount = vault.templates().length;
  const navCards = [
    ...(me.isAdmin
      ? [
          {
            path: '/admin',
            Icon: ShieldCheck,
            title: tl(lang, 'settings.adminTitle'),
            desc: tl(lang, 'settings.adminDesc'),
          },
        ]
      : []),
    ...(!me.standalone
      ? [
          {
            path: '/settings/import',
            Icon: FolderInput,
            title: tl(lang, 'settings.importTitle'),
            desc: tl(lang, 'settings.importDesc'),
          },
        ]
      : []),
    {
      path: '/settings/templates',
      Icon: LayoutTemplate,
      title: tl(lang, 'settings.templatesTitle'),
      desc: templatesCount ? tl(lang, 'settings.templatesDescCount', { n: templatesCount }) : tl(lang, 'settings.templatesDescEmpty'),
    },
    {
      path: '/files',
      Icon: Images,
      title: tl(lang, 'settings.filesTitle'),
      desc: tl(lang, 'settings.filesDesc'),
    },
    {
      path: '/trash',
      Icon: Trash2,
      title: tl(lang, 'settings.trashTitle'),
      desc: tl(lang, 'settings.trashDesc'),
    },
    ...(!DEMO
      ? [
          {
            path: '/settings/export',
            Icon: Archive,
            title: tl(lang, 'accountExport.title'),
            desc: tl(lang, 'accountExport.cardDesc'),
          },
        ]
      : []),
  ];

  const linkTextParts = link
    ? tl(lang, 'settings.deviceLinkText', {
        time: new Date(link.expiresAt).toLocaleTimeString(loc, { timeStyle: 'short' }),
      }).split(/(\{url\}|\{code\})/)
    : [];

  return (
    <div>
      <PageHeader title={tl(lang, 'settings.title')} subtitle={me.username} />
      <PageBody className="max-w-[960px] space-y-5 !mx-0">

      <ProfileSection me={me} onMe={onMe} />

      {!me.standalone && (
        <section className="card p-5 anim-fade-up" data-security-section>
          <h2 className="mb-4 text-title-m text-strong">{tl(lang, 'settings.securityTitle')}</h2>
          <div className="divide-y divide-outline-variant [&>*:first-child]:pt-0 [&>*:last-child]:pb-0 [&>*]:py-5">
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

            <PasswordSection me={me} onMe={onMe} />
            <GitLabSection me={me} onMe={onMe} />
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {navCards.map(({ path, Icon, title, desc }) => (
          <button
            key={path}
            type="button"
            className="card flex h-full w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors hover:border-line2 hover:bg-raised anim-fade-up"
            onClick={() => navigate(path)}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line2 bg-raised text-soft">
              <Icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-title-s text-strong">{title}</div>
              <div className="line-clamp-2 text-body-m text-muted">{desc}</div>
            </div>
            <ChevronRight size={16} className="shrink-0 text-muted" />
          </button>
        ))}
      </div>

      {/* Layout, Language, Inbox Zero & Widescreen (Material 3) */}
      <section className="card p-5 anim-fade-up">
        <h2 className="mb-4 text-title-m text-strong">{tl(lang, 'settings.appearanceTitle')}</h2>

        {/* Accent color (per account) */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <Palette size={18} className="mt-0.5 shrink-0 text-muted" />
            <div>
              <div className="text-sm font-medium">{tl(lang, 'settings.accentTitle')}</div>
              <div className="text-xs text-on-surface-variant">{tl(lang, 'settings.accentDesc')}</div>
            </div>
          </div>
          <AccentPicker onMe={onMe} />
        </div>

        <hr className="my-5 border-outline-variant" />

        {/* Color scheme selector */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <SunMoon size={18} className="mt-0.5 shrink-0 text-muted" />
            <div>
              <div className="text-sm font-medium">{tl(lang, 'settings.colorSchemeTitle')}</div>
              <div className="text-xs text-on-surface-variant">{tl(lang, 'settings.colorSchemeDesc')}</div>
            </div>
          </div>
          <div className="segmented grid w-full grid-cols-3 sm:inline-flex sm:w-auto sm:shrink-0" role="group" aria-label={tl(lang, 'settings.colorSchemeTitle')}>
            {(
              [
                ['dark', 'settings.colorSchemeDark'],
                ['light', 'settings.colorSchemeLight'],
                ['system', 'settings.colorSchemeSystem'],
              ] as const
            ).map(([choice, label]) => {
              const active = colorScheme === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setColorSchemeChoice(choice)}
                  className="min-w-0"
                >
                  <span className="truncate">{tl(lang, label)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <hr className="my-5 border-outline-variant" />

        {/* Language selector (M3 Segmented Pill Button) */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <Globe size={18} className="mt-0.5 shrink-0 text-muted" />
            <div>
              <div className="text-sm font-medium">{tl(lang, 'common.language')}</div>
              <div className="text-xs text-on-surface-variant">{tl(lang, 'common.languageDesc')}</div>
            </div>
          </div>
          <div className="segmented max-w-full shrink-0" role="group" aria-label={tl(lang, 'common.language')}>
            {(['de', 'en'] as Lang[]).map((code) => {
              const active = lang === code;
              const label = code === 'de' ? tl(lang, 'common.langDe') : tl(lang, 'common.langEn');
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setLang(code)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <hr className="my-5 border-outline-variant" />

        {/* Inbox Zero opt-in (M3 Switch) */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Inbox size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <label htmlFor="inbox-zero-switch" className="cursor-pointer text-sm font-medium">
                {tl(lang, 'settings.inboxZeroTitle')}
              </label>
              <p className="text-xs text-on-surface-variant">{tl(lang, 'settings.inboxZeroDesc')}</p>
            </div>
          </div>
          <Switch
            id="inbox-zero-switch"
            checked={inboxZero}
            label={tl(lang, 'settings.inboxZeroLabel')}
            onChange={setInboxZero}
          />
        </div>

        <hr className="my-5 border-outline-variant" />

        {/* Editor font size (per device) */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <TextFields size={18} className="mt-0.5 shrink-0 text-muted" />
            <div>
              <div className="text-sm font-medium">{tl(lang, 'settings.editorFontTitle')}</div>
              <div className="text-xs text-on-surface-variant">{tl(lang, 'settings.editorFontDesc')}</div>
            </div>
          </div>
          <div className="segmented max-w-full shrink-0" role="group" aria-label={tl(lang, 'settings.editorFontTitle')}>
            {EDITOR_FONT_SIZES.map((size) => {
              const active = editorFontSize === size;
              return (
                <button
                  key={size}
                  type="button"
                  aria-pressed={active}
                  aria-label={`${size} px`}
                  title={`${size} px`}
                  onClick={() => setEditorFontSize(size)}
                  className="min-w-[2.5rem] tabular-nums"
                  style={{ fontSize: `${Math.round(size * 0.8)}px` }}
                >
                  {size}
                </button>
              );
            })}
          </div>
        </div>

        <hr className="my-5 border-outline-variant" />

        {/* Ligatures in the editor (display only) */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <ArrowRight size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <label htmlFor="ligatures-switch" className="cursor-pointer text-sm font-medium">
                {tl(lang, 'settings.ligaturesTitle')}
              </label>
              <p className="text-xs text-on-surface-variant">{tl(lang, 'settings.ligaturesDesc')}</p>
            </div>
          </div>
          <Switch id="ligatures-switch" checked={ligatures} label={tl(lang, 'settings.ligaturesLabel')} onChange={setLigatures} />
        </div>

        <hr className="my-5 border-outline-variant" />

        {/* Widescreen: one slider from 50 to 100 %, snapping to the presets */}
        <div className="mb-3 flex items-center gap-2.5">
          <Maximize2 size={18} className="mt-0.5 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <label htmlFor="widescreen-slider" className="text-sm font-medium">
              {tl(lang, 'settings.widescreenTitle')}
            </label>
            <p className="text-xs text-on-surface-variant">{tl(lang, 'settings.widescreenDesc')}</p>
          </div>
          <span className="shrink-0 text-title-m tabular-nums">{widescreen.percent} %</span>
        </div>
        <WidescreenSlider />
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-surface-container-high/60 px-3.5 py-2.5 text-xs text-on-surface-variant">
          <Info size={15} className="mt-0.5 shrink-0 text-primary" />
          <span>{tl(lang, 'settings.widescreenSmallScreenHint')}</span>
        </div>
      </section>

      <FeaturesCard />

      <section className="card p-5 anim-fade-up">
        <h2 className="mb-1 font-medium">{me.standalone ? tl(lang, 'settings.standaloneTitle') : tl(lang, 'settings.syncTitle')}</h2>
        <p className="text-sm text-on-surface-variant">
          {me.standalone
            ? tl(lang, 'settings.standaloneStats', {
                notes: vault.list().length,
                pending: vault.pendingCount(),
              })
            : tl(lang, 'settings.syncStats', {
                notes: vault.list().length,
                pending: vault.pendingCount(),
                last: vault.lastSync
                  ? tl(lang, 'settings.syncLast', { time: new Date(vault.lastSync).toLocaleTimeString(loc, { timeStyle: 'short' }) })
                  : '',
              })}
        </p>
        {me.standalone && me.dataDir && (
          <div className="mt-3 space-y-1">
            <div className="text-xs font-medium text-on-surface-variant">{tl(lang, 'settings.standaloneDataDir')}</div>
            <code className="block rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2 font-mono text-xs break-all text-on-surface">{me.dataDir}</code>
          </div>
        )}
        <p className="mt-2 text-xs text-on-surface-variant">{me.standalone ? tl(lang, 'settings.standaloneNote') : tl(lang, 'settings.syncOfflineNote')}</p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {!me.standalone ? (
          <button className="btn-ghost text-error" onClick={onLogout}>
            <LogOut size={16} /> {tl(lang, 'settings.logout')}
          </button>
        ) : (
          <span className="text-xs text-on-surface-variant">Standalone Desktop</span>
        )}
        <span className="text-xs text-on-surface-variant">Kladde {APP_VERSION}</span>
      </div>
      </PageBody>
    </div>
  );
}

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
  const canUnlink = me.passkeys.length > 0 || me.hasPassword || (me.externalLogins?.length ?? 0) > 1;
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
const WIDESCREEN_SNAP = 4;

/** Slider for the content width: 50–100 %, snaps to the presets and marks them with dots */
function WidescreenSlider() {
  const lang = useLang();
  const { percent } = useWidescreen();
  const pos = (v: number) => ((v - MIN_PERCENT) / (MAX_PERCENT - MIN_PERCENT)) * 100;
  const set = (raw: number) => {
    const snap = WIDESCREEN_PRESETS.find((p) => Math.abs(p - raw) <= WIDESCREEN_SNAP);
    const next = snap ?? raw;
    setWidescreen({ percent: next, custom: !(WIDESCREEN_PRESETS as readonly number[]).includes(next) });
  };
  return (
    <div className="px-1">
      <div className="relative h-6">
        {/* Track, active part and preset dots, drawn under the native thumb */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-secondary-container">
          <div className="h-full rounded-full bg-primary" style={{ width: `calc(10px + (100% - 20px) * ${pos(percent) / 100})` }} />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-[10px] top-1/2 -translate-y-1/2">
          {WIDESCREEN_PRESETS.map((p) => (
            <span
              key={p}
              className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${p <= percent ? 'bg-on-primary' : 'bg-primary'}`}
              style={{ left: `${pos(p)}%` }}
            />
          ))}
        </div>
        <input
          id="widescreen-slider"
          type="range"
          min={MIN_PERCENT}
          max={MAX_PERCENT}
          step={1}
          value={percent}
          list="widescreen-presets"
          onChange={(e) => set(Number(e.target.value))}
          aria-valuetext={`${percent} %`}
          aria-label={tl(lang, 'settings.widescreenSliderAria')}
          className="m3-slider relative w-full"
        />
        <datalist id="widescreen-presets">
          {WIDESCREEN_PRESETS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <div className="relative mx-[10px] mt-1 h-4 text-[11px] text-on-surface-variant tabular-nums">
        {WIDESCREEN_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => set(p)}
            className={`absolute -translate-x-1/2 whitespace-nowrap hover:text-on-surface ${p === percent ? 'font-semibold text-on-surface' : ''}`}
            style={{ left: `${pos(p)}%` }}
          >
            {p} %{p === DEFAULT_PERCENT ? ` · ${tl(lang, 'settings.widescreenDefaultTag')}` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Entry to the features dialog: how many features are on and how many more there are */
function FeaturesCard() {
  const lang = useLang();
  const { active, available } = useFeatureCounts();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="card flex w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors hover:border-line2 hover:bg-raised anim-fade-up"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        data-open-features
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line2 bg-raised text-soft">
          <Extension size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-title-s text-strong">{tl(lang, 'features.title')}</div>
          <div className="text-body-m text-muted">{tl(lang, 'features.cardDesc', { active, available })}</div>
        </div>
        <ChevronRight size={16} className="shrink-0 text-muted" />
      </button>
      {open && <FeaturesDialog onClose={() => setOpen(false)} />}
    </>
  );
}
