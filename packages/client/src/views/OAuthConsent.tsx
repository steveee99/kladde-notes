import { useEffect, useState } from 'react';
import { Bot, Check, PenLine, X } from 'lucide-react';
import type { Me, OAuthRequestInfo } from '@kladde/shared';
import { api } from '../lib/api';
import { Frame } from './Auth';

/**
 * Consent page of the OAuth flow: an AI assistant (MCP client) asks for access to the signed-in user's notes.
 * The server checks the request; on yes it hands out a one-time code and we go back to the app.
 */
export function OAuthConsent({ me }: { me: Me }) {
  const [info, setInfo] = useState<OAuthRequestInfo | null>(null);
  const [error, setError] = useState('');
  const [allowWrite, setAllowWrite] = useState(true);
  const [busy, setBusy] = useState(false);
  const params = Object.fromEntries(new URLSearchParams(location.search));

  useEffect(() => {
    api<OAuthRequestInfo>(`/mcp/authorize${location.search}`).then(
      (i) => {
        setInfo(i);
        setAllowWrite(i.wantsWrite);
      },
      (err) => setError((err as Error).message)
    );
  }, []);

  const answer = async (approve: boolean) => {
    setBusy(true);
    try {
      const { redirect } = await api<{ redirect: string }>('/mcp/authorize', { method: 'POST', json: { params, approve, allowWrite } });
      location.href = redirect;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Frame title="Verbindung nicht möglich" subtitle="Die Anfrage der App ist ungültig.">
        <p className="text-sm text-danger">{error}</p>
      </Frame>
    );
  }
  if (!info) return <div className="flex h-full items-center justify-center text-faint">…</div>;

  return (
    <Frame title={`${info.clientName} verbinden?`} subtitle={`Angemeldet als ${me.username}`}>
      <div className="mb-5 space-y-3 text-sm">
        <div className="flex gap-3">
          <Bot size={18} className="mt-0.5 shrink-0 text-accent" />
          <p>
            <b>{info.clientName}</b> möchte über MCP auf <b>deine eigenen Notizen</b> zugreifen: lesen, durchsuchen und Aufgaben auflisten. Freigaben anderer
            Personen und deine Einstellungen bleiben außen vor.
          </p>
        </div>
        {info.wantsWrite && (
          <label className="flex cursor-pointer gap-3 rounded-lg border border-line p-3">
            <input type="checkbox" className="mt-0.5" checked={allowWrite} onChange={(e) => setAllowWrite(e.target.checked)} />
            <span>
              <span className="flex items-center gap-1.5 font-medium">
                <PenLine size={14} /> Auch schreiben erlauben
              </span>
              <span className="text-muted">Notizen anlegen, ändern, ergänzen und Aufgaben abhaken. Löschen und Umbenennen geht nicht.</span>
            </span>
          </label>
        )}
        <p className="text-xs text-faint">
          Danach geht es zurück zu {info.redirectHost}. Die Verbindung entfernst du jederzeit unter Einstellungen → KI-Assistenten.
        </p>
      </div>
      <div className="flex gap-2">
        <button className="btn-ghost flex-1 border border-line" disabled={busy} onClick={() => answer(false)}>
          <X size={16} /> Ablehnen
        </button>
        <button className="btn-primary flex-1" disabled={busy} onClick={() => answer(true)}>
          <Check size={16} /> Erlauben
        </button>
      </div>
    </Frame>
  );
}
