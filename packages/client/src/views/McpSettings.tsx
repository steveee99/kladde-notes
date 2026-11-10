import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import type { McpConnection, McpTokenCreated } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';

function CopyField({ value, label }: { value: string; label?: string }) {
  const lang = useLang();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <code className="min-w-0 flex-1 truncate rounded-xl border border-line bg-raised px-3 py-2 text-xs" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="btn-ghost shrink-0 rounded-full border border-line px-3"
        title={label ?? tl(lang, 'common.copy')}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={15} className="text-ok" /> : <Copy size={15} />}
      </button>
    </div>
  );
}

/** AI assistants (Claude, ChatGPT, Cursor …) talk to the user's own notes over MCP */
export function McpSettingsView() {
  const lang = useLang();
  const loc = locale(lang);
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(loc, { dateStyle: 'medium' }) : tl(lang, 'mcp.never'));

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
    if (!confirm(tl(lang, 'mcp.revokeConfirm', { name: c.name }))) return;
    setConnections(await api<McpConnection[]>(`/mcp/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }));
    if (created?.connection.id === c.id) setCreated(null);
  };

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">{tl(lang, 'mcp.title')}</h1>
      </div>
      <p className="text-sm text-muted anim-fade-up">{tl(lang, 'mcp.intro')}</p>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="font-semibold">{tl(lang, 'mcp.connectTitle')}</h2>
        <p className="text-sm text-muted">{tl(lang, 'mcp.connectDesc')}</p>
        <CopyField value={url} label={tl(lang, 'mcp.copyUrlTitle')} />
        <p className="text-xs text-faint">Claude Code:</p>
        <CopyField value={`claude mcp add --transport http kladde ${url}`} />
      </section>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="font-semibold">{tl(lang, 'mcp.tokensTitle')}</h2>
        <p className="text-sm text-muted">{tl(lang, 'mcp.tokensDesc')}</p>
        {created ? (
          <div className="space-y-2 rounded-2xl border border-accent/40 bg-accent-container/15 p-3.5 anim-fade-up">
            <p className="text-sm font-medium">{tl(lang, 'mcp.tokenCreatedTitle', { name: created.connection.name })}</p>
            <CopyField value={created.token} label={tl(lang, 'mcp.copyTokenTitle')} />
            <p className="text-xs text-faint">Claude Code:</p>
            <CopyField value={`claude mcp add --transport http kladde ${url} --header "Authorization: Bearer ${created.token}"`} />
            <button className="btn-ghost rounded-full px-4 text-sm" onClick={() => setCreated(null)}>
              {tl(lang, 'common.done')}
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
            <input className="input" placeholder={tl(lang, 'mcp.tokenNamePlaceholder')} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-accent" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} /> {tl(lang, 'mcp.tokenCanWrite')}
            </label>
            <button className="btn-ghost rounded-full border border-line px-4" type="submit">
              <Plus size={16} /> {tl(lang, 'mcp.tokenCreateBtn')}
            </button>
          </form>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </section>

      <section className="card divide-y divide-line anim-fade-up">
        <h2 className="p-5 pb-3 font-semibold">{tl(lang, 'mcp.connectionsTitle')}</h2>
        {connections && !connections.length && <p className="p-5 pt-3 text-sm text-faint">{tl(lang, 'mcp.connectionsEmpty')}</p>}
        {connections?.map((c) => (
          <div key={c.id} className="flex items-center gap-3 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-container/60 text-accent">
              {c.kind === 'oauth' ? <Bot size={18} /> : <KeyRound size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{c.name}</div>
              <div className="truncate text-xs text-faint">
                {c.kind === 'oauth' ? tl(lang, 'mcp.connOAuth') : tl(lang, 'mcp.connToken')} ·{' '}
                {c.canWrite ? tl(lang, 'mcp.connReadWrite') : tl(lang, 'mcp.connReadOnly')} · {tl(lang, 'mcp.connSince')} {when(c.createdAt)} ·{' '}
                {tl(lang, 'mcp.connLast')} {when(c.lastUsedAt)}
              </div>
            </div>
            <button className="btn-icon h-8 w-8 shrink-0" title={tl(lang, 'common.disconnect')} onClick={() => void revoke(c)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
