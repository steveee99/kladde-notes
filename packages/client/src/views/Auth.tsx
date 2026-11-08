import { useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { KeyRound, LogIn, Smartphone, UserPlus, Sparkles } from 'lucide-react';
import { PASSWORD_MIN_LENGTH, type Me } from '@kladde/shared';
import { api } from '../lib/api';
import { navigate } from '../lib/router';

function errorText(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'NotAllowedError') return 'Abgebrochen oder nicht erlaubt.';
  if (e?.name === 'InvalidStateError') return 'Auf diesem Gerät gibt es schon einen Passkey für dieses Konto.';
  return e?.message ?? 'Unbekannter Fehler';
}

/** Passkeys need a secure context: HTTPS or localhost. On a plain-HTTP home network only the password works */
export const passkeysAvailable = () => typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window;

const NO_PASSKEY_HINT = 'Passkeys gehen nur über HTTPS. Hier im lokalen Netz meldest du dich mit Benutzername und Passwort an.';

function Divider({ label }: { label: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-faint">
      <div className="h-px flex-1 bg-line" /> {label} <div className="h-px flex-1 bg-line" />
    </div>
  );
}

function PasswordLogin({ busy, run, primary }: { busy: boolean; run: (fn: () => Promise<Me>) => void; primary: boolean }) {
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
      <input className="input" placeholder="Benutzername" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input className="input" type="password" placeholder="Passwort" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className={`${primary ? 'btn-primary py-3' : 'btn-ghost border border-line'} w-full`} disabled={busy || !username.trim() || !password}>
        <LogIn size={primary ? 18 : 16} /> Mit Passwort anmelden
      </button>
    </form>
  );
}

export function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 [--pad-top:1rem] [--pad-bottom:1rem] safe-top safe-bottom">
      <div className="card w-full max-w-sm p-6 anim-fade-up">
        <img src="/icons/icon.svg" alt="" className="mb-4 h-14 w-14 anim-pop" />
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
  const { busy, error, run } = useAction(onDone);
  const [code, setCode] = useState('');
  const [withPassword, setWithPassword] = useState(false);
  if (!passkeysAvailable()) {
    return (
      <Frame title="Kladde" subtitle="Deine Notizen, Aufgaben und dein Wissen – auf allen Geräten.">
        <PasswordLogin busy={busy} run={run} primary />
        <p className="mt-3 text-xs text-faint">{NO_PASSKEY_HINT}</p>
        {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
      </Frame>
    );
  }
  return (
    <Frame title="Kladde" subtitle="Deine Notizen, Aufgaben und dein Wissen – auf allen Geräten.">
      <button
        className="btn-primary w-full py-3"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const { flowId, options } = await api<{ flowId: string; options: never }>('/auth/login/options', { method: 'POST', json: {} });
            const response = await startAuthentication({ optionsJSON: options });
            return api<Me>('/auth/login/verify', { method: 'POST', json: { flowId, response } });
          })
        }
      >
        <KeyRound size={18} /> Mit Passkey anmelden
      </button>
      {withPassword ? (
        <div className="mt-3 anim-fade-up">
          <PasswordLogin busy={busy} run={run} primary={false} />
        </div>
      ) : (
        <button className="btn-ghost mt-2 w-full text-sm" onClick={() => setWithPassword(true)}>
          Mit Benutzername und Passwort
        </button>
      )}
      <Divider label="neues Gerät" />
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) navigate(`/link/${encodeURIComponent(code.trim())}`);
        }}
      >
        <input className="input" placeholder="Gerätecode, z. B. ABCD-EFGH" value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn-ghost border border-line" type="submit">
          <Smartphone size={16} />
        </button>
      </form>
      <p className="mt-2 text-xs text-faint">Den Code erzeugst du in den Einstellungen eines angemeldeten Geräts.</p>
      {import.meta.env.DEV && (
        <button
          className="btn-ghost mt-4 w-full border border-dashed border-line"
          onClick={() => run(() => api<Me>('/auth/dev-login', { method: 'POST', json: {} }))}
        >
          <Sparkles size={16} /> Dev-Login (nur lokal)
        </button>
      )}
      {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
    </Frame>
  );
}

export function Invite({ code, onDone }: { code: string; onDone: (me: Me) => void }) {
  const { busy, error, run } = useAction((me) => {
    navigate('/', true);
    onDone(me);
  });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const canPasskey = passkeysAvailable();
  const [withPassword, setWithPassword] = useState(!canPasskey);
  if (withPassword) {
    return (
      <Frame title="Einladung annehmen" subtitle={`Wähle einen Benutzernamen und ein Passwort (mindestens ${PASSWORD_MIN_LENGTH} Zeichen).`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api<Me>('/auth/password/register', { method: 'POST', json: { inviteCode: code, username, password } }));
          }}
        >
          <input className="input" autoFocus placeholder="Benutzername" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input className="input" type="password" placeholder="Passwort" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn-primary w-full py-3" disabled={busy || username.trim().length < 3 || password.length < PASSWORD_MIN_LENGTH}>
            <UserPlus size={18} /> Konto erstellen
          </button>
        </form>
        {canPasskey ? (
          <button className="btn-ghost mt-2 w-full text-sm" onClick={() => setWithPassword(false)}>
            Stattdessen mit Passkey
          </button>
        ) : (
          <p className="mt-3 text-xs text-faint">{NO_PASSKEY_HINT} Einen Passkey kannst du später über HTTPS hinzufügen.</p>
        )}
        <p className="mt-3 text-xs text-faint">Einladungscode: {code}</p>
        {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
      </Frame>
    );
  }
  return (
    <Frame title="Einladung annehmen" subtitle="Wähle einen Benutzernamen. Statt eines Passworts legst du einen Passkey an (Face ID, Fingerabdruck oder Geräte-PIN).">
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
        <input className="input" autoFocus placeholder="Benutzername" autoComplete="username webauthn" value={username} onChange={(e) => setUsername(e.target.value)} />
        <button className="btn-primary w-full py-3" disabled={busy || username.trim().length < 3}>
          <UserPlus size={18} /> Konto mit Passkey erstellen
        </button>
      </form>
      <button className="btn-ghost mt-2 w-full text-sm" onClick={() => setWithPassword(true)}>
        Stattdessen mit Passwort
      </button>
      <p className="mt-3 text-xs text-faint">Einladungscode: {code}</p>
      {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
    </Frame>
  );
}

export function LinkDevice({ code, onDone }: { code: string; onDone: (me: Me) => void }) {
  const { busy, error, run } = useAction((me) => {
    navigate('/', true);
    onDone(me);
  });
  return (
    <Frame title="Gerät verbinden" subtitle="Lege auf diesem Gerät einen Passkey für dein bestehendes Konto an.">
      {!passkeysAvailable() && <p className="mb-3 rounded-xl bg-raised p-3 text-sm text-warn">{NO_PASSKEY_HINT}</p>}
      <button
        className="btn-primary w-full py-3"
        disabled={busy || !passkeysAvailable()}
        onClick={() =>
          run(async () => {
            const { flowId, options } = await api<{ flowId: string; options: never }>('/auth/link/options', { method: 'POST', json: { code } });
            const response = await startRegistration({ optionsJSON: options });
            return api<Me>('/auth/link/verify', { method: 'POST', json: { flowId, response } });
          })
        }
      >
        <KeyRound size={18} /> Passkey anlegen
      </button>
      <button className="btn-ghost mt-2 w-full" onClick={() => navigate('/', true)}>
        Zurück
      </button>
      {error && <p className="mt-4 text-sm text-danger anim-fade-in">{error}</p>}
    </Frame>
  );
}
