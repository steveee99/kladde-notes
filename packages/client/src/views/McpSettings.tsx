import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { McpConnection, McpTokenCreated } from '@kladde/shared';
import { api } from '../lib/api';
import { navigate } from '../lib/router';

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString('de-DE', { dateStyle: 'medium' }) : 'nie');

function CopyField({ value, label }: { value: string; label?: string }) {
  return (
    <div className="flex gap-2">
      <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-raised px-3 py-2 text-xs" title={value}>
        {value}
      </code>
      <button className="btn-ghost border border-line" title={label ?? 'Kopieren'} onClick={() => navigator.clipboard?.writeText(value)}>
        <Copy size={15} />
      </button>
    </div>
  );
}

/** AI assistants (Claude, ChatGPT, Cursor …) talk to the user's own notes over MCP */
export function McpSettingsView() {
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [created, setCreated] = useState<McpTokenCreated | null>(null);
  const [name, setName] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [error, setError] = useState('');
  const url = `${location.origin}/mcp`;

  useEffect(() => {
    api<McpConnection[]>('/mcp/connections').then(setConnections, (err) => setError((err as Error).message));
  }, []);

  const createToken = async () => {
    setError('');
    try {
      const result = await api<McpTokenCreated>('/mcp/tokens', { method: 'POST', json: { name, canWrite } });
      setCreated(result);
      setName('');
      setConnections((list) => [result.connection, ...(list ?? [])]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (c: McpConnection) => {
    if (!confirm(`„${c.name}“ trennen? Die App kommt danach nicht mehr an deine Notizen.`)) return;
    setConnections(await api<McpConnection[]>(`/mcp/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }));
    if (created?.connection.id === c.id) setCreated(null);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title="Zurück zu den Einstellungen">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">KI-Assistenten</h1>
      </div>
      <p className="text-sm text-muted anim-fade-up">
        Über das Model Context Protocol (MCP) sprechen KI-Assistenten wie Claude mit deinen Notizen: suchen, lesen, Aufgaben auflisten und – wenn du es
        erlaubst – Notizen anlegen und ergänzen. Jede Verbindung meldet sich mit deinem Konto an und sieht nur deine eigenen Notizen.
      </p>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="font-semibold">Verbinden</h2>
        <p className="text-sm text-muted">
          Trage diese Adresse in deinem Assistenten als MCP-Server bzw. Connector ein (z. B. claude.ai → Einstellungen → Connectors → „Benutzerdefinierten Connector
          hinzufügen“). Beim ersten Aufruf öffnet sich Kladde, du meldest dich an und bestätigst den Zugriff.
        </p>
        <CopyField value={url} label="Adresse kopieren" />
        <p className="text-xs text-faint">Claude Code:</p>
        <CopyField value={`claude mcp add --transport http kladde ${url}`} />
      </section>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="font-semibold">Zugriffstoken</h2>
        <p className="text-sm text-muted">Für Programme ohne Anmeldefenster: ein fester Schlüssel, den das Programm als „Authorization: Bearer …“ mitschickt.</p>
        {created ? (
          <div className="space-y-2 rounded-lg border border-accent/40 p-3 anim-fade-up">
            <p className="text-sm font-medium">Token für „{created.connection.name}“ – wird nur jetzt angezeigt:</p>
            <CopyField value={created.token} label="Token kopieren" />
            <p className="text-xs text-faint">Claude Code:</p>
            <CopyField value={`claude mcp add --transport http kladde ${url} --header "Authorization: Bearer ${created.token}"`} />
            <button className="btn-ghost text-sm" onClick={() => setCreated(null)}>
              Fertig
            </button>
          </div>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void createToken();
            }}
          >
            <input className="input" placeholder="Name, z. B. „Claude Code am Laptop“" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} /> Darf Notizen anlegen und ändern
            </label>
            <button className="btn-ghost border border-line" type="submit">
              <Plus size={16} /> Token erstellen
            </button>
          </form>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </section>

      <section className="card divide-y divide-line anim-fade-up">
        <h2 className="p-5 pb-3 font-semibold">Verbindungen</h2>
        {connections && !connections.length && <p className="p-5 pt-3 text-sm text-faint">Noch keine KI-Assistenten verbunden.</p>}
        {connections?.map((c) => (
          <div key={c.id} className="flex items-center gap-3 p-4">
            {c.kind === 'oauth' ? <Bot size={18} className="shrink-0 text-accent" /> : <KeyRound size={18} className="shrink-0 text-accent" />}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{c.name}</div>
              <div className="truncate text-xs text-faint">
                {c.kind === 'oauth' ? 'Angemeldet' : 'Token'} · {c.canWrite ? 'lesen und schreiben' : 'nur lesen'} · seit {when(c.createdAt)} · zuletzt {when(c.lastUsedAt)}
              </div>
            </div>
            <button className="btn-icon h-8 w-8" title="Trennen" onClick={() => void revoke(c)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
