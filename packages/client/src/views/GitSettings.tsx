import { useEffect, useState } from 'react';
import { ArrowLeft, GitBranch, RefreshCw, Trash2 } from 'lucide-react';
import { DEFAULT_GIT_MESSAGE, GitSyncSettings } from '@kladde/shared';
import { api } from '../lib/api';
import { locale, tl, useLang } from '../lib/i18n';
import { navigate } from '../lib/router';

/** Pushes the user's own notes as plain Markdown to a Git repository (branch main) */
export function GitSettingsView() {
  const lang = useLang();
  const loc = locale(lang);
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' }) : tl(lang, 'git.never'));

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
    if (!confirm(tl(lang, 'git.removeConfirm'))) return;
    await api('/git', { method: 'DELETE' });
    apply(null);
    setUrl('');
    setEmail('');
    setMessage(DEFAULT_GIT_MESSAGE);
    setEnabled(true);
  };

  return (
    <div className="content-container space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <div className="flex items-center gap-2 anim-fade-up">
        <button className="btn-icon -ml-2" onClick={() => navigate('/settings')} title={tl(lang, 'templates.backToSettings')}>
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-2xl font-bold tracking-tight">{tl(lang, 'git.title')}</h1>
      </div>
      <p className="text-sm text-muted anim-fade-up">{tl(lang, 'git.intro')}</p>

      <form
        className="card space-y-3 p-5 anim-fade-up"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="block space-y-1">
          <span className="text-sm font-medium">{tl(lang, 'git.repoUrl')}</span>
          <input className="input" type="url" required placeholder="https://github.com/name/notes.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{tl(lang, 'git.email')}</span>
          <input className="input" type="email" required autoComplete="off" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <span className="text-xs text-faint">{tl(lang, 'git.emailHint')}</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{tl(lang, 'git.token')}</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required={!current?.hasToken}
            placeholder={current?.hasToken ? tl(lang, 'git.tokenKeepPlaceholder') : tl(lang, 'git.tokenNewPlaceholder')}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">{tl(lang, 'git.commitMsg')}</span>
          <input className="input" maxLength={200} value={message} onChange={(e) => setMessage(e.target.value)} />
          <span className="text-xs text-faint">
            <code>{'{date}'}</code> {tl(lang, 'git.commitMsgHintDate')} <code>{'{time}'}</code> {tl(lang, 'git.commitMsgHintTime')}
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-accent" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {tl(lang, 'git.autoSync')}
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary rounded-full px-5" disabled={busy || !loaded}>
            <GitBranch size={16} /> {tl(lang, 'common.save')}
          </button>
          {current && (
            <>
              <button type="button" className="btn-ghost rounded-full border border-line px-4" disabled={busy} onClick={() => void syncNow()}>
                <RefreshCw size={16} className={busy ? 'animate-spin' : ''} /> {tl(lang, 'git.syncNow')}
              </button>
              <button type="button" className="btn-ghost ml-auto rounded-full px-4 text-danger" onClick={() => void remove()}>
                <Trash2 size={16} /> {tl(lang, 'common.remove')}
              </button>
            </>
          )}
        </div>
      </form>

      {current && (
        <p className={`text-sm anim-fade-up ${current.lastStatus === 'error' ? 'text-danger' : 'text-muted'}`}>
          {tl(lang, 'git.lastRun', { when: when(current.lastRunAt) })}
          {current.lastStatus === 'ok' && tl(lang, 'git.statusOk')}
          {current.lastStatus === 'unchanged' && tl(lang, 'git.statusUnchanged')}
          {current.lastStatus === 'error' && tl(lang, 'git.statusError', { error: current.lastError ?? '' })}
        </p>
      )}
    </div>
  );
}
