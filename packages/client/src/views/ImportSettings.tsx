import { useEffect, useState } from 'react';
import { ArrowLeft, KeyRound, Plus, Trash2 } from 'lucide-react';
import { IMPORT_TOKEN_DAYS, type ImportToken, type ImportTokenCreated } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';
import { ChipSelect } from './ChipSelect';
import { CopyField } from './McpSettings';

/** Tokens for the import CLI (`npm run import`), which brings a local folder such as an Obsidian vault into the space */
export function ImportSettingsView() {
  const lang = useLang();
  const loc = locale(lang);
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(loc, { dateStyle: 'medium' }) : tl(lang, 'import.never'));

  const [tokens, setTokens] = useState<ImportToken[] | null>(null);
  const [created, setCreated] = useState<ImportTokenCreated | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number>(IMPORT_TOKEN_DAYS[0]);
  const [error, setError] = useState('');
  // Over http the token travels in cleartext: the CLI insists on --allow-insecure
  const command = `npm run import -- <ordner> --url ${location.origin}${location.protocol === 'http:' ? ' --allow-insecure' : ''}`;

  useEffect(() => {
    api<ImportToken[]>('/import-tokens').then(setTokens, (err) => setError((err as Error).message));
  }, []);

  const createToken = async () => {
    setError('');
    try {
      const result = await api<ImportTokenCreated>('/import-tokens', { method: 'POST', json: { name, days } });
      setCreated(result);
      setName('');
      setTokens((list) => [result.token, ...(list ?? [])]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (token: ImportToken) => {
    if (!confirm(tl(lang, 'import.revokeConfirm', { name: token.name }))) return;
    setError('');
    try {
      setTokens(await api<ImportToken[]>(`/import-tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' }));
      if (created?.token.id === token.id) setCreated(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">{tl(lang, 'import.title')}</h1>
      </div>
      <p className="text-sm text-muted anim-fade-up">{tl(lang, 'import.intro')}</p>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="font-semibold">{tl(lang, 'import.cliTitle')}</h2>
        <p className="text-sm text-muted">{tl(lang, 'import.cliDesc')}</p>
        <CopyField value={command} />
        {location.protocol === 'http:' && <p className="text-xs text-danger">{tl(lang, 'import.insecureHint')}</p>}
      </section>

      <section className="card space-y-3 p-5 anim-fade-up">
        <h2 className="font-semibold">{tl(lang, 'import.createTitle')}</h2>
        <p className="text-sm text-muted">{tl(lang, 'import.createDesc')}</p>
        {created ? (
          <div className="space-y-2 rounded-2xl border border-accent/40 bg-accent-container/15 p-3.5 anim-fade-up">
            <p className="text-sm font-medium">{tl(lang, 'import.tokenCreatedTitle', { name: created.token.name })}</p>
            <CopyField value={created.secret} label={tl(lang, 'import.copyTokenTitle')} />
            <CopyField value={`KLADDE_IMPORT_TOKEN=${created.secret}`} />
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
            <input className="input" placeholder={tl(lang, 'import.tokenNamePlaceholder')} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <label className="flex flex-wrap items-center gap-2 text-sm">
              {tl(lang, 'import.validFor')}
              <ChipSelect
                className="text-sm"
                value={String(days)}
                aria-label={tl(lang, 'import.validFor')}
                onChange={(v) => setDays(Number(v))}
                options={[...IMPORT_TOKEN_DAYS].sort((a, b) => a - b).map((d) => ({ value: String(d), label: tl(lang, 'import.days', { n: d }) }))}
              />
            </label>
            <button className="btn-ghost rounded-full border border-line px-4" type="submit">
              <Plus size={16} /> {tl(lang, 'import.tokenCreateBtn')}
            </button>
          </form>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </section>

      <section className="card divide-y divide-line anim-fade-up">
        <h2 className="p-5 pb-3 font-semibold">{tl(lang, 'import.tokensTitle')}</h2>
        {tokens && !tokens.length && <p className="p-5 pt-3 text-sm text-faint">{tl(lang, 'import.tokensEmpty')}</p>}
        {tokens?.map((token) => (
          <div key={token.id} className="flex items-center gap-3 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-container/60 text-accent">
              <KeyRound size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{token.name}</div>
              <div className="truncate text-xs text-faint">
                {tl(lang, 'import.created')} {when(token.createdAt)} ·{' '}
                {token.expiresAt <= Date.now() ? (
                  <span className="text-danger">{tl(lang, 'import.expired')}</span>
                ) : (
                  `${tl(lang, 'import.expires')} ${when(token.expiresAt)}`
                )}{' '}
                · {tl(lang, 'import.lastUsed')} {when(token.lastUsedAt)}
              </div>
            </div>
            <button className="btn-icon h-8 w-8 shrink-0" title={tl(lang, 'import.revoke')} onClick={() => void revoke(token)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
