import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { KeyRound, LogIn, Smartphone, Sparkles, UserPlus } from 'lucide-react';
import { PASSWORD_MIN_LENGTH, type AuthProviders, type Me } from '@kladde/shared';
import { api } from '../lib/api';
import { Lang, setLang, t, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';

function errorText(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'NotAllowedError') return t('auth.notAllowedError');
  if (e?.name === 'InvalidStateError') return t('auth.invalidStateError');
  return e?.message ?? t('common.unknownError');
}

/** Passkeys need a secure context: HTTPS or localhost. On a plain-HTTP home network only the password works */
export const passkeysAvailable = () => typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window;

let providersRequest: Promise<AuthProviders | null> | null = null;

/** Sign-in options of the server (GitLab), fetched once */
export function useAuthProviders(): AuthProviders | null {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  useEffect(() => {
    let alive = true;
    providersRequest ??= api<AuthProviders>('/auth/providers').catch(() => null);
    void providersRequest.then((p) => alive && setProviders(p));
    return () => {
      alive = false;
    };
  }, []);
  return providers;
}

/** A query parameter set by a server redirect (e.g. `login_error`), removed from the address bar once read */
export function useRedirectParam(name: string): string {
  const [value] = useState(() => new URLSearchParams(window.location.search).get(name) ?? '');
  useEffect(() => {
    if (!value) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [name, value]);
  return value;
}

/** GitLab mark (simplified tanuki), in the current text color */
export function GitLabIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="m23.6 9.6-.03-.09-3.27-8.53a.85.85 0 0 0-1.62.06l-2.2 6.75H7.52L5.32 1.04A.85.85 0 0 0 3.7.98L.43 9.5l-.03.09a6.07 6.07 0 0 0 2.01 7.01l.01.01.03.02 4.98 3.73 2.46 1.87 1.5 1.13a1 1 0 0 0 1.22 0l1.5-1.13 2.46-1.87 5.01-3.75.01-.01a6.07 6.07 0 0 0 2.01-7z" />
    </svg>
  );
}

/** Full-page redirect into the GitLab OAuth flow */
function GitLabButton({ label, query, primary }: { label: string; query?: Record<string, string>; primary?: boolean }) {
  const q = query ? `?${new URLSearchParams(query)}` : '';
  return (
    <a
      href={`/api/auth/gitlab/start${q}`}
      className={`${primary ? 'btn-primary py-3' : 'btn-ghost border border-line'} w-full rounded-full`}
      data-gitlab-login
    >
      <GitLabIcon /> {label}
    </a>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-faint">
      <div className="h-px flex-1 bg-line" /> {label} <div className="h-px flex-1 bg-line" />
    </div>
  );
}

function PasswordLogin({ busy, run, primary }: { busy: boolean; run: (fn: () => Promise<Me>) => void; primary: boolean }) {
  const lang = useLang();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => api<Me>('/auth/password/login', { method: 'POST', json: { username, password } }));
      }}
    >
      <input
        className="input"
        placeholder={tl(lang, 'auth.username')}
        autoComplete="username"
        autoCapitalize="none"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        className="input"
        type="password"
        placeholder={tl(lang, 'auth.password')}
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className={`${primary ? 'btn-primary rounded-full py-3' : 'btn-ghost rounded-full border border-line'} w-full`} disabled={busy || !username.trim() || !password}>
        <LogIn size={primary ? 18 : 16} /> {tl(lang, 'auth.passwordLogin')}
      </button>
    </form>
  );
}

export function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  const lang = useLang();
  return (
    <div className="flex min-h-full items-center justify-center px-4 [--pad-top:1rem] [--pad-bottom:1rem] safe-top safe-bottom">
      <div className="card w-full max-w-sm rounded-3xl p-6 anim-fade-up">
        <div className="mb-4 flex items-start justify-between gap-2">
          <img src="/icons/icon.svg" alt="" className="h-14 w-14 anim-pop" />
          <div className="inline-flex rounded-full border border-line bg-raised p-0.5" role="group" aria-label={tl(lang, 'common.language')}>
            {(['de', 'en'] as Lang[]).map((code) => (
              <button
                key={code}
                type="button"
                aria-pressed={lang === code}
                onClick={() => setLang(code)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium uppercase transition-colors ${
                  lang === code ? 'bg-accent-container text-on-accent-container' : 'text-muted hover:text-ink'
                }`}
              >
                {code}
              </button>
            ))}
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 mb-6 text-sm text-muted">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

function useAction(onDone: (me: Me) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<Me>) => {
    setBusy(true);
    setError('');
    try {
      onDone(await fn());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function Login({ onDone }: { onDone: (me: Me) => void }) {
  const lang = useLang();
  const { busy, error: actionError, run } = useAction(onDone);
  const redirectError = useRedirectParam('login_error');
  const error = actionError || (busy ? '' : redirectError);
  const providers = useAuthProviders();
  const [code, setCode] = useState('');
  const [withPassword, setWithPassword] = useState(false);
  const gitlab = providers?.gitlab.enabled ? (
    <div className="mt-2">
      <GitLabButton label={tl(lang, 'auth.gitlabLogin', { name: providers.gitlab.label })} />
    </div>
  ) : null;
  if (!passkeysAvailable()) {
    return (
      <Frame title="Kladde" subtitle={tl(lang, 'auth.subtitle')}>
        <PasswordLogin busy={busy} run={run} primary />
        {gitlab}
        <p className="mt-3 text-xs text-faint">{tl(lang, 'auth.noPasskeyHint')}</p>
        {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
      </Frame>
    );
  }
  return (
    <Frame title="Kladde" subtitle={tl(lang, 'auth.subtitle')}>
      <button
        className="btn-primary w-full rounded-full py-3"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const { flowId, options } = await api<{ flowId: string; options: never }>('/auth/login/options', { method: 'POST', json: {} });
            const response = await startAuthentication({ optionsJSON: options });
            return api<Me>('/auth/login/verify', { method: 'POST', json: { flowId, response } });
          })
        }
      >
        <KeyRound size={18} /> {tl(lang, 'auth.passkeyLogin')}
      </button>
      {withPassword ? (
        <div className="mt-3 anim-fade-up">
          <PasswordLogin busy={busy} run={run} primary={false} />
        </div>
      ) : (
        <button className="btn-ghost mt-2 w-full rounded-full text-sm" onClick={() => setWithPassword(true)}>
          {tl(lang, 'auth.usePassword')}
        </button>
      )}
      {gitlab}
      <Divider label={tl(lang, 'auth.newDevice')} />
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) navigate(`/link/${encodeURIComponent(code.trim())}`);
        }}
      >
        <input className="input min-w-0 flex-1" placeholder={tl(lang, 'auth.deviceCodePlaceholder')} value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn-ghost shrink-0 rounded-xl border border-line" type="submit">
          <Smartphone size={16} />
        </button>
      </form>
      <p className="mt-2 text-xs text-faint">{tl(lang, 'auth.deviceCodeHint')}</p>
      {import.meta.env.DEV && (
        <button
          className="btn-ghost mt-4 w-full rounded-full border border-dashed border-line"
          onClick={() => run(() => api<Me>('/auth/dev-login', { method: 'POST', json: {} }))}
        >
          <Sparkles size={16} /> {tl(lang, 'auth.devLogin')}
        </button>
      )}
      {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
    </Frame>
  );
}

export function Invite({ code, onDone }: { code: string; onDone: (me: Me) => void }) {
  const lang = useLang();
  const { busy, error, run } = useAction((me) => {
    navigate('/', true);
    onDone(me);
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const canPasskey = passkeysAvailable();
  const [withPassword, setWithPassword] = useState(!canPasskey);
  const providers = useAuthProviders();
  const gitlab = providers?.gitlab.enabled ? (
    <>
      <Divider label={tl(lang, 'auth.or')} />
      <GitLabButton label={tl(lang, 'auth.gitlabRegister', { name: providers.gitlab.label })} query={{ invite: code }} />
    </>
  ) : null;
  if (withPassword) {
    return (
      <Frame title={tl(lang, 'auth.inviteTitle')} subtitle={tl(lang, 'auth.invitePwSubtitle', { min: PASSWORD_MIN_LENGTH })}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api<Me>('/auth/password/register', { method: 'POST', json: { inviteCode: code, username, password } }));
          }}
        >
          <input
            className="input"
            autoFocus
            placeholder={tl(lang, 'auth.username')}
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder={tl(lang, 'auth.password')}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="btn-primary w-full rounded-full py-3" disabled={busy || username.trim().length < 3 || password.length < PASSWORD_MIN_LENGTH}>
            <UserPlus size={18} /> {tl(lang, 'auth.createAccount')}
          </button>
        </form>
        {canPasskey ? (
          <button className="btn-ghost mt-2 w-full rounded-full text-sm" onClick={() => setWithPassword(false)}>
            {tl(lang, 'auth.usePasskeyInstead')}
          </button>
        ) : (
          <p className="mt-3 text-xs text-faint">
            {tl(lang, 'auth.noPasskeyHint')} {tl(lang, 'auth.addPasskeyLaterHint')}
          </p>
        )}
        {gitlab}
        <p className="mt-3 text-xs text-faint">{tl(lang, 'auth.inviteCodeLabel', { code })}</p>
        {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
      </Frame>
    );
  }
  return (
    <Frame title={tl(lang, 'auth.inviteTitle')} subtitle={tl(lang, 'auth.invitePasskeySubtitle')}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const { flowId, options } = await api<{ flowId: string; options: never }>('/auth/register/options', {
              method: 'POST',
              json: { inviteCode: code, username },
            });
            const response = await startRegistration({ optionsJSON: options });
            return api<Me>('/auth/register/verify', { method: 'POST', json: { flowId, response } });
          });
        }}
      >
        <input
          className="input"
          autoFocus
          placeholder={tl(lang, 'auth.username')}
          autoComplete="username webauthn"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <button className="btn-primary w-full rounded-full py-3" disabled={busy || username.trim().length < 3}>
          <UserPlus size={18} /> {tl(lang, 'auth.createWithPasskey')}
        </button>
      </form>
      <button className="btn-ghost mt-2 w-full rounded-full text-sm" onClick={() => setWithPassword(true)}>
        {tl(lang, 'auth.usePasswordInstead')}
      </button>
      {gitlab}
      <p className="mt-3 text-xs text-faint">{tl(lang, 'auth.inviteCodeLabel', { code })}</p>
      {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
    </Frame>
  );
}

export function LinkDevice({ code, onDone }: { code: string; onDone: (me: Me) => void }) {
  const lang = useLang();
  const { busy, error, run } = useAction((me) => {
    navigate('/', true);
    onDone(me);
  });
  return (
    <Frame title={tl(lang, 'auth.linkTitle')} subtitle={tl(lang, 'auth.linkSubtitle')}>
      {!passkeysAvailable() && <p className="mb-3 rounded-xl bg-raised p-3 text-sm text-warn">{tl(lang, 'auth.noPasskeyHint')}</p>}
      <button
        className="btn-primary w-full rounded-full py-3"
        disabled={busy || !passkeysAvailable()}
        onClick={() =>
          run(async () => {
            const { flowId, options } = await api<{ flowId: string; options: never }>('/auth/link/options', { method: 'POST', json: { code } });
            const response = await startRegistration({ optionsJSON: options });
            return api<Me>('/auth/link/verify', { method: 'POST', json: { flowId, response } });
          })
        }
      >
        <KeyRound size={18} /> {tl(lang, 'auth.createPasskeyBtn')}
      </button>
      <button className="btn-ghost mt-2 w-full rounded-full" onClick={() => navigate('/', true)}>
        {tl(lang, 'common.back')}
      </button>
      {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
    </Frame>
  );
}
