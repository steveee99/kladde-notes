import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Bot, ChevronRight, Copy, GitBranch, KeyRound, LayoutTemplate, Lock, LogOut, Monitor, Moon, Palette, ShieldCheck, Smartphone, Sun, Trash2, Zap } from 'lucide-react';
import { APP_VERSION, Me, PASSWORD_MIN_LENGTH } from '@kladde/shared';
import { api } from '../lib/api';
import { getTheme, setTheme, ThemeChoice } from '../lib/theme';
import { useVault, vault } from '../data/vault';
import { startupReport, toggleTallPageTest, viewportReport } from '../lib/viewport';
import { navigate } from '../lib/router';
import { passkeysAvailable } from './Auth';

export function SettingsView({ me, onMe, onLogout }: { me: Me; onMe: (me: Me) => void; onLogout: () => void }) {
  useVault();
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [link, setLink] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const themes: { id: ThemeChoice; label: string; Icon: typeof Sun }[] = [
    { id: 'system', label: 'System', Icon: Monitor },
    { id: 'light', label: 'Hell', Icon: Sun },
    { id: 'dark', label: 'Dunkel', Icon: Moon },
    { id: 'oled', label: 'OLED', Icon: Zap },
    { id: 'material', label: 'Material', Icon: Palette },
  ];
  const linkUrl = link ? `${location.origin}/link/${link.code}` : '';

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <h1 className="text-2xl font-bold tracking-tight anim-fade-up">Einstellungen</h1>

      {me.isAdmin && (
        <button className="card flex w-full items-center gap-3 p-4 text-left transition-colors hover:border-accent/40 anim-fade-up" onClick={() => navigate('/admin')}>
          <ShieldCheck size={20} className="text-accent" />
          <div className="flex-1">
            <div className="font-semibold">Verwaltung</div>
            <div className="text-sm text-muted">Konten, Einladungen, Passwörter zurücksetzen</div>
          </div>
          <ChevronRight size={18} className="text-faint" />
        </button>
      )}

      <button className="card flex w-full items-center gap-3 p-4 text-left transition-colors hover:border-accent/40 anim-fade-up" onClick={() => navigate('/settings/mcp')}>
        <Bot size={20} className="text-accent" />
        <div className="flex-1">
          <div className="font-semibold">KI-Assistenten</div>
          <div className="text-sm text-muted">Claude & Co. per MCP mit deinen Notizen verbinden</div>
        </div>
        <ChevronRight size={18} className="text-faint" />
      </button>

      <button className="card flex w-full items-center gap-3 p-4 text-left transition-colors hover:border-accent/40 anim-fade-up" onClick={() => navigate('/settings/git')}>
        <GitBranch size={20} className="text-accent" />
        <div className="flex-1">
          <div className="font-semibold">Git-Sync</div>
          <div className="text-sm text-muted">Deine Notizen automatisch in ein Git-Repository übertragen</div>
        </div>
        <ChevronRight size={18} className="text-faint" />
      </button>

      <button className="card flex w-full items-center gap-3 p-4 text-left transition-colors hover:border-accent/40 anim-fade-up" onClick={() => navigate('/settings/templates')}>
        <LayoutTemplate size={20} className="text-accent" />
        <div className="flex-1">
          <div className="font-semibold">Vorlagen</div>
          <div className="text-sm text-muted">
            {vault.templates().length ? `${vault.templates().length} eigene Vorlagen für neue Notizen` : 'Eigene Vorlagen für Projekte, Besprechungen und mehr'}
          </div>
        </div>
        <ChevronRight size={18} className="text-faint" />
      </button>

      <section className="card p-5 anim-fade-up">
        <h2 className="mb-3 font-semibold">Erscheinungsbild</h2>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {themes.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => {
                setTheme(id);
                setThemeState(id);
              }}
              className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-sm transition-all duration-200 ${theme === id ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:border-faint'}`}
            >
              <Icon size={20} /> {label}
            </button>
          ))}
        </div>
      </section>

      <section className="card p-5 anim-fade-up">
        <h2 className="mb-1 font-semibold">Passkeys von {me.username}</h2>
        <p className="mb-3 text-sm text-muted">Jedes Gerät meldet sich mit seinem eigenen Passkey an (oder einem, den dein Passwort-Manager synchronisiert).</p>
        {!me.passkeys.length && <p className="mb-3 text-sm text-faint">Noch kein Passkey – du meldest dich mit deinem Passwort an.</p>}
        <ul className="mb-3 divide-y divide-line">
          {me.passkeys.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <KeyRound size={16} className="text-accent" />
              <div className="flex-1">
                <div className="text-sm">{p.name}</div>
                <div className="text-xs text-faint">
                  angelegt {new Date(p.createdAt).toLocaleDateString('de-DE')}
                  {p.lastUsedAt ? ` · zuletzt ${new Date(p.lastUsedAt).toLocaleDateString('de-DE')}` : ''}
                </div>
              </div>
              {(me.passkeys.length > 1 || me.hasPassword) && (
                <button
                  className="btn-icon h-8 w-8"
                  onClick={async () => {
                    if (confirm('Diesen Passkey entfernen?')) onMe(await api<Me>(`/auth/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' }));
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
            title={passkeysAvailable() ? undefined : 'Passkeys gehen nur über HTTPS'}
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
            <KeyRound size={16} /> Passkey hier hinzufügen
          </button>
          <button className="btn-ghost border border-line" onClick={async () => setLink(await api('/auth/device-link', { method: 'POST', json: {} }))}>
            <Smartphone size={16} /> Neues Gerät verbinden
          </button>
        </div>
        {link && (
          <div className="mt-3 rounded-xl bg-raised p-3 text-sm anim-fade-up">
            Öffne auf dem neuen Gerät <b className="break-all">{linkUrl}</b> oder gib dort den Code <b className="font-mono">{link.code}</b> ein. Gültig bis{' '}
            {new Date(link.expiresAt).toLocaleTimeString('de-DE', { timeStyle: 'short' })}.
          </div>
        )}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </section>

      <PasswordSection me={me} onMe={onMe} />

      <section className="card p-5 anim-fade-up">
        <h2 className="mb-1 font-semibold">Synchronisierung</h2>
        <p className="text-sm text-muted">
          {vault.list().length} Notizen auf diesem Gerät · {vault.pendingCount()} noch nicht hochgeladen
          {vault.lastSync ? ` · zuletzt ${new Date(vault.lastSync).toLocaleTimeString('de-DE', { timeStyle: 'short' })}` : ''}
        </p>
        <p className="mt-2 text-xs text-faint">
          Alles funktioniert offline; Änderungen werden übertragen, sobald du wieder online bist. Auf dem Server liegen die Notizen verschlüsselt.
        </p>
      </section>

      <Diagnostics />

      <div className="flex items-center justify-between">
        <button className="btn-ghost text-danger" onClick={onLogout}>
          <LogOut size={16} /> Abmelden
        </button>
        <span className="text-xs text-faint">Kladde {APP_VERSION}</span>
      </div>
    </div>
  );
}

/** Optional password: for devices on a plain-HTTP home network, where passkeys do not work */
function PasswordSection({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
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
      setMessage({ ok: true, text: me.hasPassword ? 'Passwort geändert. Andere Geräte sind abgemeldet.' : 'Passwort gesetzt.' });
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
      <h2 className="mb-1 font-semibold">Passwort</h2>
      <p className="mb-3 text-sm text-muted">
        {me.hasPassword
          ? 'Du kannst dich auch mit Benutzername und Passwort anmelden.'
          : 'Optional: Mit einem Passwort meldest du dich auch dort an, wo Passkeys nicht gehen (Kladde ohne HTTPS im lokalen Netz).'}
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
            <input className="input" type="password" placeholder="Aktuelles Passwort" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          )}
          <input className="input" type="password" placeholder={`Neues Passwort (mind. ${PASSWORD_MIN_LENGTH} Zeichen)`} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <input className="input" type="password" placeholder="Neues Passwort wiederholen" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          {mismatch && <p className="text-sm text-danger">Die Passwörter sind nicht gleich.</p>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || next.length < PASSWORD_MIN_LENGTH || next !== repeat || (me.hasPassword && !current)}>
              Speichern
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Abbrechen
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost border border-line" onClick={() => setOpen(true)}>
            <Lock size={16} /> {me.hasPassword ? 'Passwort ändern' : 'Passwort festlegen'}
          </button>
          {me.hasPassword && me.passkeys.length > 0 && (
            <button
              className="btn-ghost text-danger"
              onClick={async () => {
                if (!confirm('Passwort entfernen? Danach meldest du dich nur noch mit Passkey an.')) return;
                try {
                  onMe(await api<Me>('/auth/password', { method: 'DELETE' }));
                  setMessage({ ok: true, text: 'Passwort entfernt.' });
                } catch (e) {
                  setMessage({ ok: false, text: (e as Error).message });
                }
              }}
            >
              <Trash2 size={16} /> Entfernen
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
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [tall, setTall] = useState(false);
  const measure = () => setText(JSON.stringify({ version: APP_VERSION, now: viewportReport(), atStart: startupReport }, null, 2));
  return (
    <details className="card p-5 anim-fade-up" onToggle={(e) => (e.currentTarget.open ? measure() : setText(''))}>
      <summary className="cursor-pointer font-semibold">Diagnose</summary>
      <p className="mt-2 text-sm text-muted">Messwerte zur Bildschirmdarstellung. Zum Weitergeben kopieren.</p>
      <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-raised p-3 font-mono text-xs leading-snug whitespace-pre-wrap break-all">{text}</pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-ghost border border-line" onClick={measure}>
          <Zap size={16} /> Neu messen
        </button>
        <button
          className="btn-ghost border border-line"
          onClick={() => {
            setTall(toggleTallPageTest());
            setTimeout(measure, 400);
          }}
        >
          <Monitor size={16} /> {tall ? 'Test beenden' : 'Test: volle Höhe'}
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
          <Copy size={16} /> {copied ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
    </details>
  );
}
