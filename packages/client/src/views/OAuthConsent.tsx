import { useEffect, useState } from 'react';
import { Bot, Check, PenLine, X } from '../lib/icons';
import type { Me, OAuthRequestInfo } from '@kladde/shared';
import { api } from '../lib/api';
import { tl, useLang } from '../lib/i18n';
import { Frame } from './Auth';

/**
 * Consent page of the OAuth flow: an AI assistant (MCP client) asks for access to the signed-in user's notes.
 * The server checks the request; on yes it hands out a one-time code and we go back to the app.
 */
export function OAuthConsent({ me }: { me: Me }) {
  const lang = useLang();
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
      <Frame title={tl(lang, 'oauth.errorTitle')} subtitle={tl(lang, 'oauth.errorSubtitle')}>
        <p className="text-sm text-error">{error}</p>
      </Frame>
    );
  }
  if (!info) return <div className="flex h-full items-center justify-center text-on-surface-variant">…</div>;

  return (
    <Frame title={tl(lang, 'oauth.connectTitle', { client: info.clientName })} subtitle={tl(lang, 'oauth.signedInAs', { username: me.username })}>
      <div className="mb-5 space-y-3 text-sm">
        <div className="flex gap-3">
          <Bot size={18} className="mt-0.5 shrink-0 text-primary" />
          <p>
            <b>{info.clientName}</b> {tl(lang, 'oauth.accessPrefix')} <b>{tl(lang, 'oauth.accessTarget')}</b> {tl(lang, 'oauth.accessSuffix')}
          </p>
        </div>
        {info.wantsWrite && (
          <label className="flex cursor-pointer gap-3 rounded-2xl border border-outline-variant p-3">
            <input type="checkbox" className="mt-0.5 accent-accent" checked={allowWrite} onChange={(e) => setAllowWrite(e.target.checked)} />
            <span>
              <span className="flex items-center gap-1.5 font-medium">
                <PenLine size={14} /> {tl(lang, 'oauth.allowWriteTitle')}
              </span>
              <span className="text-on-surface-variant">{tl(lang, 'oauth.allowWriteDesc')}</span>
            </span>
          </label>
        )}
        <p className="text-xs text-on-surface-variant">{tl(lang, 'oauth.redirectHint', { host: info.redirectHost })}</p>
      </div>
      <div className="flex gap-2">
        <button className="btn-ghost flex-1 rounded-full border border-outline-variant" disabled={busy} onClick={() => answer(false)}>
          <X size={16} /> {tl(lang, 'oauth.deny')}
        </button>
        <button className="btn-primary flex-1 rounded-full" disabled={busy} onClick={() => answer(true)}>
          <Check size={16} /> {tl(lang, 'oauth.allow')}
        </button>
      </div>
    </Frame>
  );
}
