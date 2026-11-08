import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Copy, KeyRound, LogOut, Monitor, Moon, Smartphone, Sun, Trash2, Zap } from 'lucide-react';
import { APP_VERSION, Me } from '@kladde/shared';
import { api } from '../lib/api';
import { getTheme, setTheme, ThemeChoice } from '../lib/theme';
import { useVault, vault } from '../data/vault';
import { startupReport, toggleTallPageTest, viewportReport } from '../lib/viewport';

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
  ];
  const linkUrl = link ? `${location.origin}/link/${link.code}` : '';

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <h1 className="text-2xl font-bold tracking-tight anim-fade-up">Einstellungen</h1>

      <section className="card p-5 anim-fade-up">
        <h2 className="mb-3 font-semibold">Erscheinungsbild</h2>
        <div className="grid grid-cols-4 gap-2">
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
              {me.passkeys.length > 1 && (
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
