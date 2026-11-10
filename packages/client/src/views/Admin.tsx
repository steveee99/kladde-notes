import { useCallback, useEffect, useState } from 'react';
import { Ban, Check, Copy, KeyRound, Mail, RotateCcw, ScrollText, ShieldCheck, ShieldOff, Smartphone, Trash2, UserCheck, Users } from 'lucide-react';
import type { AdminAuditEntry, AdminInvite, AdminStatus, AdminUser, Me } from '@kladde/shared';
import { api } from '../lib/api';
import { I18nKey, Lang, locale, tl, useLang } from '../lib/i18n';
import { Avatar } from './Avatar';

type Tab = 'users' | 'invites' | 'audit';

function since(ms: number, lang: Lang): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  const days = Math.round(min / 1440);
  return days === 1 ? tl(lang, 'admin.daySingle') : tl(lang, 'admin.days', { n: days });
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const lang = useLang();
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn-ghost rounded-full border border-line px-3 py-1 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? tl(lang, 'common.copied') : (label ?? tl(lang, 'common.copy'))}
    </button>
  );
}

/** One-time secret (new password, device code): shown once, with copy button */
interface Secret {
  title: string;
  value: string;
  hint: string;
}

function SecretBox({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const lang = useLang();
  return (
    <div className="card mb-4 border-accent/40 bg-accent-container/20 p-4 anim-fade-up">
      <div className="mb-1 text-sm font-semibold">{secret.title}</div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded-xl bg-raised px-2.5 py-1.5 font-mono text-[15px]">{secret.value}</code>
        <CopyButton text={secret.value} />
      </div>
      <p className="mt-2 text-xs text-muted">{secret.hint}</p>
      <button className="btn-ghost mt-2 px-0 text-xs" onClick={onClose}>
        {tl(lang, 'common.hide')}
      </button>
    </div>
  );
}

function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

function UsersTab({ me, onError }: { me: Me; onError: (msg: string) => void }) {
  const lang = useLang();
  const loc = locale(lang);
  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<AdminUser[]>('/admin/users').then(setUsers, (e) => onError(e.message));
  }, [onError]);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    onError('');
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!users) return <div className="py-10 text-center text-faint">…</div>;
  return (
    <>
      {secret && <SecretBox secret={secret} onClose={() => setSecret(null)} />}
      <ul className="stagger space-y-3">
        {users.map((u) => {
          const self = u.id === me.id;
          return (
            <li key={u.id} className={`card p-4 ${u.bannedAt ? 'opacity-70' : ''}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Avatar name={u.username} avatarUrl={u.avatarUrl} size="sm" />
                <span className="font-semibold">{u.username}</span>
                {self && <Badge>{tl(lang, 'admin.selfBadge')}</Badge>}
                {u.isAdmin && (
                  <Badge tone="text-accent">
                    <ShieldCheck size={11} /> {tl(lang, 'admin.adminBadge')}
                  </Badge>
                )}
                {u.bannedAt && (
                  <Badge tone="text-danger">
                    <Ban size={11} /> {tl(lang, 'admin.bannedBadge')}
                  </Badge>
                )}
                <Badge>
                  <KeyRound size={11} /> {u.passkeys === 1 ? tl(lang, 'admin.passkeySingle') : tl(lang, 'admin.passkeyPlural', { n: u.passkeys })}
                </Badge>
                {u.hasPassword && <Badge>{tl(lang, 'admin.passwordBadge')}</Badge>}
              </div>
              <p className="mt-1 text-xs text-faint">
                {tl(lang, 'admin.userMeta', {
                  created: fmtDate(u.createdAt),
                  notes: u.notes,
                  activity: u.lastSeenAt ? tl(lang, 'admin.activeAgo', { since: since(u.lastSeenAt, lang) }) : tl(lang, 'admin.notLoggedIn'),
                })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {!self && (
                  <button
                    className="btn-ghost rounded-full border border-line px-3 py-1 text-xs"
                    disabled={busy === u.id}
                    onClick={() =>
                      confirm(tl(lang, 'admin.resetPwConfirm', { username: u.username })) &&
                      act(u.id, async () => {
                        const r = await api<{ username: string; password: string }>(`/admin/users/${u.id}/password-reset`, { method: 'POST', json: {} });
                        setSecret({
                          title: tl(lang, 'admin.resetPwSecretTitle', { username: r.username }),
                          value: r.password,
                          hint: tl(lang, 'admin.resetPwSecretHint'),
                        });
                        setUsers(await api<AdminUser[]>('/admin/users'));
                      })
                    }
                  >
                    <RotateCcw size={13} /> {tl(lang, 'admin.resetPwBtn')}
                  </button>
                )}
                {!u.bannedAt && (
                  <button
                    className="btn-ghost rounded-full border border-line px-3 py-1 text-xs"
                    disabled={busy === u.id}
                    title={tl(lang, 'admin.deviceCodeTooltip')}
                    onClick={() =>
                      act(u.id, async () => {
                        const r = await api<{ username: string; code: string; expiresAt: number }>(`/admin/users/${u.id}/device-link`, { method: 'POST', json: {} });
                        setSecret({
                          title: tl(lang, 'admin.deviceCodeSecretTitle', { username: r.username }),
                          value: `${location.origin}/link/${r.code}`,
                          hint: tl(lang, 'admin.deviceCodeSecretHint', {
                            code: r.code,
                            time: new Date(r.expiresAt).toLocaleTimeString(loc, { timeStyle: 'short' }),
                            username: r.username,
                          }),
                        });
                      })
                    }
                  >
                    <Smartphone size={13} /> {tl(lang, 'admin.deviceCodeBtn')}
                  </button>
                )}
                <button
                  className="btn-ghost rounded-full border border-line px-3 py-1 text-xs"
                  disabled={busy === u.id}
                  onClick={() =>
                    (u.isAdmin ? confirm(tl(lang, 'admin.removeAdminConfirm', { username: u.username })) : confirm(tl(lang, 'admin.makeAdminConfirm', { username: u.username }))) &&
                    act(u.id, async () => setUsers(await api<AdminUser[]>(`/admin/users/${u.id}/admin`, { method: 'POST', json: { admin: !u.isAdmin } })))
                  }
                >
                  {u.isAdmin ? <ShieldOff size={13} /> : <ShieldCheck size={13} />} {u.isAdmin ? tl(lang, 'admin.removeAdminBtn') : tl(lang, 'admin.makeAdminBtn')}
                </button>
                {!self && (
                  <button
                    className={`btn-ghost rounded-full border border-line px-3 py-1 text-xs ${u.bannedAt ? '' : 'text-danger'}`}
                    disabled={busy === u.id}
                    onClick={() =>
                      (u.bannedAt || confirm(tl(lang, 'admin.banConfirm', { username: u.username }))) &&
                      act(u.id, async () => setUsers(await api<AdminUser[]>(`/admin/users/${u.id}/ban`, { method: 'POST', json: { banned: !u.bannedAt } })))
                    }
                  >
                    {u.bannedAt ? <UserCheck size={13} /> : <Ban size={13} />} {u.bannedAt ? tl(lang, 'admin.unbanBtn') : tl(lang, 'admin.banBtn')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function InvitesTab({ onError }: { onError: (msg: string) => void }) {
  const lang = useLang();
  const loc = locale(lang);
  const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const load = useCallback(() => api<AdminInvite[]>('/admin/invites').then(setInvites, (e) => onError(e.message)), [onError]);
  useEffect(() => void load(), [load]);
  const url = (code: string) => `${location.origin}/invite/${code}`;

  return (
    <>
      <form
        className="card mb-4 flex flex-wrap items-center gap-2 p-1.5 pl-4"
        onSubmit={async (e) => {
          e.preventDefault();
          onError('');
          try {
            const invite = await api<AdminInvite>('/admin/invites', { method: 'POST', json: { note } });
            setNote('');
            setFresh(invite.code);
            await load();
          } catch (err) {
            onError((err as Error).message);
          }
        }}
      >
        <Mail size={17} className="text-faint" />
        <input
          className="min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-faint"
          placeholder={tl(lang, 'admin.invitePlaceholder')}
          maxLength={80}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn-primary rounded-full px-5">{tl(lang, 'admin.inviteCreateBtn')}</button>
      </form>
      {invites === null ? (
        <div className="py-10 text-center text-faint">…</div>
      ) : invites.length === 0 ? (
        <div className="py-10 text-center text-faint">{tl(lang, 'admin.invitesEmpty')}</div>
      ) : (
        <ul className="card divide-y divide-line/60 p-1">
          {invites.map((i) => {
            const state = i.usedBy ? 'used' : i.expiresAt < Date.now() ? 'expired' : 'open';
            return (
              <li key={i.code} className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 ${fresh === i.code ? 'bg-accent/5' : ''}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm">{i.code}</code>
                    {i.note && <span className="truncate text-sm">{i.note}</span>}
                  </div>
                  <div className="text-xs text-faint">
                    {state === 'used'
                      ? tl(lang, 'admin.inviteUsed', {
                          user: i.usedBy ?? '',
                          at: i.usedAt ? tl(lang, 'admin.inviteUsedAt', { date: fmtDate(i.usedAt) }) : '',
                        })
                      : state === 'expired'
                        ? tl(lang, 'admin.inviteExpired', { date: fmtDate(i.expiresAt) })
                        : tl(lang, 'admin.inviteOpen', { date: fmtDate(i.expiresAt) })}
                  </div>
                </div>
                {state === 'open' && <CopyButton text={url(i.code)} label={tl(lang, 'admin.copyLink')} />}
                {state !== 'used' && (
                  <button
                    className="btn-icon h-8 w-8"
                    title={tl(lang, 'admin.deleteInviteTitle')}
                    onClick={async () => {
                      if (!confirm(tl(lang, 'admin.deleteInviteConfirm', { code: i.code }))) return;
                      await api(`/admin/invites/${encodeURIComponent(i.code)}`, { method: 'DELETE' }).catch((e) => onError(e.message));
                      await load();
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const EVENT_KEYS: Record<string, I18nKey> = {
  login: 'admin.event.login',
  login_failed: 'admin.event.login_failed',
  login_blocked: 'admin.event.login_blocked',
  register: 'admin.event.register',
  logout: 'admin.event.logout',
  password_changed: 'admin.event.password_changed',
  account_deleted: 'admin.event.account_deleted',
  admin_command: 'admin.event.admin_command',
};

function AuditTab({ onError }: { onError: (msg: string) => void }) {
  const lang = useLang();
  const loc = locale(lang);
  const dateTime = (ms: number) => new Date(ms).toLocaleString(loc, { dateStyle: 'short', timeStyle: 'short' });
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  useEffect(() => {
    api<AdminAuditEntry[]>('/admin/audit').then(setEntries, (e) => onError(e.message));
  }, [onError]);
  if (!entries) return <div className="py-10 text-center text-faint">…</div>;
  if (!entries.length) return <div className="py-10 text-center text-faint">{tl(lang, 'admin.auditEmpty')}</div>;
  return (
    <ul className="card divide-y divide-line/60 p-1 text-sm">
      {entries.map((e, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
          <span className="w-28 shrink-0 text-xs text-faint">{dateTime(e.at)}</span>
          <span className={`font-medium ${e.event === 'login_failed' || e.event === 'login_blocked' ? 'text-danger' : e.event === 'admin_command' ? 'text-accent' : ''}`}>
            {EVENT_KEYS[e.event] ? tl(lang, EVENT_KEYS[e.event]) : e.event}
          </span>
          {e.username && <span>{e.username}</span>}
          {e.detail && <span className="min-w-0 break-words text-muted">{e.detail}</span>}
          {e.ip && <span className="ml-auto text-xs text-faint">{e.ip}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Admin area: accounts (reset, ban, roles), invites and the audit log */
export function AdminView({ me }: { me: Me }) {
  const lang = useLang();
  const [tab, setTab] = useState<Tab>('users');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<AdminStatus>('/admin/status').then(setStatus, (e) => setError(e.message));
  }, []);

  if (!me.isAdmin) return <div className="py-16 text-center text-faint">{tl(lang, 'admin.onlyAdmin')}</div>;

  const tabs: { id: Tab; label: string; Icon: typeof Users }[] = [
    { id: 'users', label: tl(lang, 'admin.tabUsers'), Icon: Users },
    { id: 'invites', label: tl(lang, 'admin.tabInvites'), Icon: Mail },
    { id: 'audit', label: tl(lang, 'admin.tabAudit'), Icon: ScrollText },
  ];

  return (
    <div className="content-container px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-5 anim-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">{tl(lang, 'admin.title')}</h1>
        {status && (
          <p className="mt-1 text-sm text-muted">
            {tl(lang, 'admin.statusSummary', {
              version: status.version,
              users: status.users,
              notes: status.notes,
              connections: status.connections,
              since: since(status.startedAt, lang),
            })}
          </p>
        )}
      </header>
      <div className="mb-5 grid grid-cols-3 gap-1 rounded-full border border-line bg-surface p-1 anim-fade-up">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setError('');
            }}
            className={`flex items-center justify-center gap-1.5 rounded-full py-2 text-sm font-medium transition-colors ${
              tab === id ? 'bg-accent-container text-on-accent-container shadow-sm' : 'text-muted hover:text-ink'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
      {error && <p className="mb-4 text-sm text-danger anim-fade-in">{error}</p>}
      {tab === 'users' && <UsersTab me={me} onError={setError} />}
      {tab === 'invites' && <InvitesTab onError={setError} />}
      {tab === 'audit' && <AuditTab onError={setError} />}
    </div>
  );
}
