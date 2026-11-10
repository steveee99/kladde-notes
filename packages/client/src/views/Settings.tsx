import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  GitBranch,
  Globe,
  Images,
  Inbox,
  Info,
  KeyRound,
  LayoutTemplate,
  Lock,
  LogOut,
  Maximize2,
  Monitor,
  ShieldCheck,
  Smartphone,
  SlidersHorizontal,
  Trash2,
  Zap,
} from 'lucide-react';
import { APP_VERSION, Me, PASSWORD_MIN_LENGTH } from '@kladde/shared';
import { api } from '../lib/api';
import { Lang, locale, setLang, tl, useLang } from '../lib/i18n';
import { setInboxZero, useInboxZero } from '../lib/prefs';
import { DEFAULT_PERCENT, MAX_PERCENT, MIN_PERCENT, setWidescreen, useWidescreen, WIDESCREEN_PRESETS } from '../lib/widescreen';
import { useVault, vault } from '../data/vault';
import { startupReport, toggleTallPageTest, viewportReport } from '../lib/viewport';
import { navigate } from '../lib/router';
import { passkeysAvailable } from './Auth';

export function SettingsView({ me, onMe, onLogout }: { me: Me; onMe: (me: Me) => void; onLogout: () => void }) {
  useVault();
  const lang = useLang();
  const loc = locale(lang);
  const widescreen = useWidescreen();
  const inboxZero = useInboxZero();
  const [customInput, setCustomInput] = useState(String(widescreen.percent));
  const [link, setLink] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const linkUrl = link ? `${location.origin}/link/${link.code}` : '';

  useEffect(() => {
    setCustomInput(String(widescreen.percent));
  }, [widescreen.percent]);

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
    {
      path: '/settings/mcp',
      Icon: Bot,
      title: tl(lang, 'settings.mcpTitle'),
      desc: tl(lang, 'settings.mcpDesc'),
    },
    {
      path: '/settings/git',
      Icon: GitBranch,
      title: tl(lang, 'settings.gitTitle'),
      desc: tl(lang, 'settings.gitDesc'),
    },
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
  ];

  const linkTextParts = link
    ? tl(lang, 'settings.deviceLinkText', {
        time: new Date(link.expiresAt).toLocaleTimeString(loc, { timeStyle: 'short' }),
      }).split(/(\{url\}|\{code\})/)
    : [];

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <h1 className="text-2xl font-bold tracking-tight anim-fade-up">{tl(lang, 'settings.title')}</h1>

      <div className="space-y-3">
        {navCards.map(({ path, Icon, title, desc }) => (
          <button
            key={path}
            type="button"
            className="card flex w-full items-center gap-3.5 p-4 text-left transition-colors hover:border-accent/40 hover:bg-raised/40 anim-fade-up"
            onClick={() => navigate(path)}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-container/60 text-accent">
              <Icon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{title}</div>
              <div className="text-sm text-muted">{desc}</div>
            </div>
            <ChevronRight size={18} className="shrink-0 text-faint" />
          </button>
        ))}
      </div>

      {/* Layout, Language, Inbox Zero & Widescreen (Material 3) */}
      <section className="card p-5 anim-fade-up">
        <h2 className="mb-4 text-base font-semibold">{tl(lang, 'settings.appearanceTitle')}</h2>

        {/* Language selector (M3 Segmented Pill Button) */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <Globe size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <div className="text-sm font-semibold">{tl(lang, 'common.language')}</div>
              <div className="text-xs text-muted">{tl(lang, 'common.languageDesc')}</div>
            </div>
          </div>
          <div className="inline-flex rounded-full border border-line bg-raised p-1 shrink-0" role="group" aria-label={tl(lang, 'common.language')}>
            {(['de', 'en'] as Lang[]).map((code) => {
              const active = lang === code;
              const label = code === 'de' ? tl(lang, 'common.langDe') : tl(lang, 'common.langEn');
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setLang(code)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                    active ? 'bg-accent-container text-on-accent-container shadow-sm' : 'text-muted hover:text-ink'
                  }`}
                >
                  {active && <Check size={14} strokeWidth={2.5} />}
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <hr className="my-5 border-line" />

        {/* Inbox Zero opt-in (M3 Switch) */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Inbox size={18} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <label htmlFor="inbox-zero-switch" className="cursor-pointer text-sm font-semibold">
                {tl(lang, 'settings.inboxZeroTitle')}
              </label>
              <p className="text-xs text-muted">{tl(lang, 'settings.inboxZeroDesc')}</p>
            </div>
          </div>
          <button
            id="inbox-zero-switch"
            type="button"
            role="switch"
            aria-checked={inboxZero}
            aria-label={tl(lang, 'settings.inboxZeroLabel')}
            onClick={() => setInboxZero(!inboxZero)}
            className={`relative inline-flex h-8 w-[52px] shrink-0 cursor-pointer items-center rounded-full border-2 p-0.5 transition-colors ${
              inboxZero ? 'border-accent bg-accent' : 'border-faint/60 bg-raised'
            }`}
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full transition-transform duration-150 ${
                inboxZero ? 'translate-x-5 bg-on-accent text-accent' : 'translate-x-0 scale-75 bg-muted text-surface'
              }`}
            >
              {inboxZero && <Check size={14} strokeWidth={3} />}
            </span>
          </button>
        </div>

        <hr className="my-5 border-line" />

        {/* Widescreen percentage options (50%, 80% Default, 100%, Custom) */}
        <div className="mb-3 flex items-start gap-2.5">
          <Maximize2 size={18} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <h3 className="text-sm font-semibold">{tl(lang, 'settings.widescreenTitle')}</h3>
            <p className="text-xs text-muted">{tl(lang, 'settings.widescreenDesc')}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {WIDESCREEN_PRESETS.map((pct) => {
            const active = !widescreen.custom && widescreen.percent === pct;
            return (
              <button
                key={pct}
                type="button"
                aria-pressed={active}
                onClick={() => setWidescreen({ percent: pct, custom: false })}
                className={`flex flex-col items-center justify-center gap-0.5 rounded-2xl border px-3 py-3 text-sm transition-all ${
                  active
                    ? 'border-accent/60 bg-accent-container text-on-accent-container shadow-sm'
                    : 'border-line bg-raised/30 text-muted hover:border-faint hover:text-ink'
                }`}
              >
                <span className="font-semibold tabular-nums">{pct} %</span>
                {pct === DEFAULT_PERCENT && (
                  <span className={`text-[11px] ${active ? 'text-on-accent-container/80' : 'text-faint'}`}>
                    {tl(lang, 'settings.widescreenDefaultTag')}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={widescreen.custom}
            onClick={() => setWidescreen({ percent: widescreen.percent, custom: true })}
            className={`flex flex-col items-center justify-center gap-0.5 rounded-2xl border px-3 py-3 text-sm transition-all ${
              widescreen.custom
                ? 'border-accent/60 bg-accent-container text-on-accent-container shadow-sm'
                : 'border-line bg-raised/30 text-muted hover:border-faint hover:text-ink'
            }`}
          >
            <span className="inline-flex items-center gap-1.5 font-semibold">
              <SlidersHorizontal size={14} />
              {tl(lang, 'settings.widescreenCustom')}
            </span>
            {widescreen.custom && <span className="text-[11px] tabular-nums text-on-accent-container/80">{widescreen.percent} %</span>}
          </button>
        </div>

        {widescreen.custom && (
          <div className="mt-3 space-y-3 rounded-2xl border border-line bg-raised/50 p-4 anim-fade-in">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted">{tl(lang, 'settings.widescreenCustom')}</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={MIN_PERCENT}
                  max={MAX_PERCENT}
                  step={1}
                  value={customInput}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setCustomInput(raw);
                    const n = Number(raw);
                    if (Number.isFinite(n) && n >= MIN_PERCENT && n <= MAX_PERCENT) {
                      setWidescreen({ percent: Math.round(n), custom: true });
                    }
                  }}
                  onBlur={() => {
                    const n = Number(customInput);
                    const clamped = Number.isFinite(n) ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(n))) : DEFAULT_PERCENT;
                    setWidescreen({ percent: clamped, custom: true });
                    setCustomInput(String(clamped));
                  }}
                  className="input h-8 w-20 py-1 text-right font-mono text-sm tabular-nums"
                  aria-label={tl(lang, 'settings.widescreenCustomAria')}
                />
                <span className="text-sm font-medium text-muted">%</span>
              </div>
            </div>
            <input
              type="range"
              min={MIN_PERCENT}
              max={MAX_PERCENT}
              step={1}
              value={widescreen.percent}
              onChange={(e) => setWidescreen({ percent: Number(e.target.value), custom: true })}
              className="w-full cursor-pointer accent-accent"
              aria-label={tl(lang, 'settings.widescreenSliderAria')}
            />
            <div className="flex justify-between text-[11px] text-faint tabular-nums">
              <span>{MIN_PERCENT} %</span>
              <span>{MAX_PERCENT} %</span>
            </div>
          </div>
        )}

        <div className="mt-3 flex items-start gap-2 rounded-xl bg-raised/60 px-3.5 py-2.5 text-xs text-muted">
          <Info size={15} className="mt-0.5 shrink-0 text-accent" />
          <span>{tl(lang, 'settings.widescreenSmallScreenHint')}</span>
        </div>
      </section>

      {!me.standalone && (
        <>
          <section className="card p-5 anim-fade-up">
            <h2 className="mb-1 font-semibold">{tl(lang, 'settings.passkeysTitle', { username: me.username })}</h2>
            <p className="mb-3 text-sm text-muted">{tl(lang, 'settings.passkeysDesc')}</p>
            {!me.passkeys.length && <p className="mb-3 text-sm text-faint">{tl(lang, 'settings.passkeysEmpty')}</p>}
            <ul className="mb-3 divide-y divide-line">
              {me.passkeys.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <KeyRound size={16} className="text-accent" />
                  <div className="flex-1">
                    <div className="text-sm">{p.name}</div>
                    <div className="text-xs text-faint">
                      {tl(lang, 'settings.passkeyMeta', {
                        created: new Date(p.createdAt).toLocaleDateString(loc),
                        last: p.lastUsedAt ? tl(lang, 'settings.passkeyLastUsed', { date: new Date(p.lastUsedAt).toLocaleDateString(loc) }) : '',
                      })}
                    </div>
                  </div>
                  {(me.passkeys.length > 1 || me.hasPassword) && (
                    <button
                      className="btn-icon h-8 w-8"
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
                className="btn-ghost border border-line"
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
              <button className="btn-ghost border border-line" onClick={async () => setLink(await api('/auth/device-link', { method: 'POST', json: {} }))}>
                <Smartphone size={16} /> {tl(lang, 'settings.deviceConnect')}
              </button>
            </div>
            {link && (
              <div className="mt-3 rounded-xl bg-raised p-3 text-sm anim-fade-up">
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
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          </section>

          <PasswordSection me={me} onMe={onMe} />
        </>
      )}

      <section className="card p-5 anim-fade-up">
        <h2 className="mb-1 font-semibold">{me.standalone ? tl(lang, 'settings.standaloneTitle') : tl(lang, 'settings.syncTitle')}</h2>
        <p className="text-sm text-muted">
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
            <div className="text-xs font-medium text-faint">{tl(lang, 'settings.standaloneDataDir')}</div>
            <code className="block rounded-xl border border-line bg-raised px-3 py-2 font-mono text-xs break-all text-ink">{me.dataDir}</code>
          </div>
        )}
        <p className="mt-2 text-xs text-faint">{me.standalone ? tl(lang, 'settings.standaloneNote') : tl(lang, 'settings.syncOfflineNote')}</p>
      </section>

      <Diagnostics />

      <div className="flex items-center justify-between">
        {!me.standalone ? (
          <button className="btn-ghost text-danger" onClick={onLogout}>
            <LogOut size={16} /> {tl(lang, 'settings.logout')}
          </button>
        ) : (
          <span className="text-xs text-faint">Standalone Desktop</span>
        )}
        <span className="text-xs text-faint">Kladde {APP_VERSION}</span>
      </div>
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
    <section className="card p-5 anim-fade-up">
      <h2 className="mb-1 font-semibold">{tl(lang, 'settings.passwordTitle')}</h2>
      <p className="mb-3 text-sm text-muted">
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
          {mismatch && <p className="text-sm text-danger">{tl(lang, 'settings.passwordMismatch')}</p>}
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
          <button className="btn-ghost border border-line" onClick={() => setOpen(true)}>
            <Lock size={16} /> {me.hasPassword ? tl(lang, 'settings.passwordChange') : tl(lang, 'settings.passwordSet')}
          </button>
          {me.hasPassword && me.passkeys.length > 0 && (
            <button
              className="btn-ghost text-danger"
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
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-accent' : 'text-danger'}`}>{message.text}</p>}
    </section>
  );
}

/** Layout measurements for support: the iOS home-screen app has no Web Inspector at hand */
function Diagnostics() {
  const lang = useLang();
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [tall, setTall] = useState(false);
  const measure = () => setText(JSON.stringify({ version: APP_VERSION, now: viewportReport(), atStart: startupReport }, null, 2));
  return (
    <details className="card p-5 anim-fade-up" onToggle={(e) => (e.currentTarget.open ? measure() : setText(''))}>
      <summary className="cursor-pointer font-semibold">{tl(lang, 'settings.diagTitle')}</summary>
      <p className="mt-2 text-sm text-muted">{tl(lang, 'settings.diagDesc')}</p>
      <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-raised p-3 font-mono text-xs leading-snug whitespace-pre-wrap break-all">{text}</pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-ghost border border-line" onClick={measure}>
          <Zap size={16} /> {tl(lang, 'settings.diagRemeasure')}
        </button>
        <button
          className="btn-ghost border border-line"
          onClick={() => {
            setTall(toggleTallPageTest());
            setTimeout(measure, 400);
          }}
        >
          <Monitor size={16} /> {tall ? tl(lang, 'settings.diagStopTest') : tl(lang, 'settings.diagStartTest')}
        </button>
        <button
          className="btn-ghost border border-line"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked: the text can still be selected */
            }
          }}
        >
          <Copy size={16} /> {copied ? tl(lang, 'common.copied') : tl(lang, 'common.copy')}
        </button>
      </div>
    </details>
  );
}
