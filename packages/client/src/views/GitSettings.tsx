import { useEffect, useState } from 'react';
import { ArrowLeft, GitBranch, RefreshCw, Trash2 } from 'lucide-react';
import { DEFAULT_GIT_MESSAGE, GitSyncSettings } from '@kladde/shared';
import { api } from '../lib/api';
import { navigate } from '../lib/router';

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'noch nie');

/** Pushes the user's own notes as plain Markdown to a Git repository (branch main) */
export function GitSettingsView() {
  const [current, setCurrent] = useState<GitSyncSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState(DEFAULT_GIT_MESSAGE);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const apply = (s: GitSyncSettings | null) => {
    setCurrent(s);
    if (s) {
      setUrl(s.url);
      setEmail(s.email);
      setMessage(s.message);
      setEnabled(s.enabled);
    }
    setToken('');
  };

  useEffect(() => {
    api<GitSyncSettings | null>('/git').then(
      (s) => {
        apply(s);
        setLoaded(true);
      },
      (err) => setError((err as Error).message)
    );
  }, []);

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      apply(await api<GitSyncSettings>('/git', { method: 'PUT', json: { url, email, token, message, enabled } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setError('');
    setBusy(true);
    try {
      apply(await api<GitSyncSettings>('/git/sync', { method: 'POST' }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('Git-Sync entfernen? Das Repository selbst bleibt unverändert.')) return;
    await api('/git', { method: 'DELETE' });
    apply(null);
    setUrl('');
    setEmail('');
    setMessage(DEFAULT_GIT_MESSAGE);
    setEnabled(true);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title="Zurück zu den Einstellungen">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">Git-Sync</h1>
      </div>
      <p className="text-sm text-muted anim-fade-up">
        Deine eigenen Notizen (keine geteilten) werden als Markdown-Dateien in ein Git-Repository auf den Branch <code>main</code> übertragen – ein Commit pro Sync, etwa zwei Minuten nach
        der letzten Änderung. Die Dateien im Repository sind unverschlüsselt. Das Token bleibt verschlüsselt auf dem Server und wird nie wieder angezeigt.
      </p>

      <form
        className="card space-y-3 p-5 anim-fade-up"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium">Git-Adresse</span>
          <input className="input" type="url" required placeholder="https://github.com/name/notizen.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">E-Mail</span>
          <input className="input" type="email" required autoComplete="off" placeholder="du@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <span className="text-xs text-faint">Anmeldename am Git-Dienst und Autor der Commits.</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Access-Token</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required={!current?.hasToken}
            placeholder={current?.hasToken ? '•••••• (gespeichert – leer lassen zum Behalten)' : 'Token mit Schreibrecht auf das Repository'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Commit-Nachricht</span>
          <input className="input" maxLength={200} value={message} onChange={(e) => setMessage(e.target.value)} />
          <span className="text-xs text-faint">
            <code>{'{date}'}</code> wird zum aktuellen Datum (2026-11-09), <code>{'{time}'}</code> zur Uhrzeit.
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Automatisch nach Änderungen synchronisieren
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy || !loaded}>
            <GitBranch size={16} /> Speichern
          </button>
          {current && (
            <>
              <button type="button" className="btn-ghost border border-line" disabled={busy} onClick={() => void syncNow()}>
                <RefreshCw size={16} className={busy ? 'animate-spin' : ''} /> Jetzt synchronisieren
              </button>
              <button type="button" className="btn-ghost ml-auto text-danger" onClick={() => void remove()}>
                <Trash2 size={16} /> Entfernen
              </button>
            </>
          )}
        </div>
      </form>

      {current && (
        <p className={`text-sm anim-fade-up ${current.lastStatus === 'error' ? 'text-danger' : 'text-muted'}`}>
          Letzter Lauf: {when(current.lastRunAt)}
          {current.lastStatus === 'ok' && ' – übertragen'}
          {current.lastStatus === 'unchanged' && ' – keine Änderungen'}
          {current.lastStatus === 'error' && ` – Fehler: ${current.lastError}`}
        </p>
      )}
    </div>
  );
}
