import { useCallback, useEffect, useState } from 'react';
import { Ban, Check, Copy, KeyRound, Mail, RotateCcw, ScrollText, ShieldCheck, ShieldOff, Smartphone, Trash2, UserCheck, Users } from 'lucide-react';
import type { AdminAuditEntry, AdminInvite, AdminStatus, AdminUser, Me } from '@kladde/shared';
import { api } from '../lib/api';

type Tab = 'users' | 'invites' | 'audit';

const date = (ms: number) => new Date(ms).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTime = (ms: number) => new Date(ms).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

function since(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} Tagen`;
}

function CopyButton({ text, label = 'Kopieren' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn-ghost border border-line px-2.5 py-1 text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? 'Kopiert' : label}
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
  return (
    <div className="card mb-4 border-accent/40 bg-accent/5 p-4 anim-fade-up">
      <div className="mb-1 text-sm font-semibold">{secret.title}</div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all rounded-lg bg-raised px-2.5 py-1.5 font-mono text-[15px]">{secret.value}</code>
        <CopyButton text={secret.value} />
      </div>
      <p className="mt-2 text-xs text-muted">{secret.hint}</p>
      <button className="btn-ghost mt-2 px-0 text-xs" onClick={onClose}>
        Ausblenden
      </button>
    </div>
  );
}

function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

function UsersTab({ me, onError }: { me: Me; onError: (msg: string) => void }) {
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
                <span className="font-semibold">{u.username}</span>
                {self && <Badge>du</Badge>}
                {u.isAdmin && (
                  <Badge tone="text-accent">
                    <ShieldCheck size={11} /> Admin
                  </Badge>
                )}
                {u.bannedAt && (
                  <Badge tone="text-danger">
                    <Ban size={11} /> gesperrt
                  </Badge>
                )}
                <Badge>
                  <KeyRound size={11} /> {u.passkeys} Passkey{u.passkeys === 1 ? '' : 's'}
                </Badge>
                {u.hasPassword && <Badge>Passwort</Badge>}
              </div>
              <p className="mt-1 text-xs text-faint">
                seit {date(u.createdAt)} · {u.notes} Notizen{u.lastSeenAt ? ` · aktiv vor ${since(u.lastSeenAt)}` : ' · nicht angemeldet'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {!self && (
                  <button
                    className="btn-ghost border border-line px-2.5 py-1 text-xs"
                    disabled={busy === u.id}
                    onClick={() =>
                      confirm(`Neues Passwort für ${u.username} erzeugen? Das alte gilt dann nicht mehr und alle Geräte werden abgemeldet.`) &&
                      act(u.id, async () => {
                        const r = await api<{ username: string; password: string }>(`/admin/users/${u.id}/password-reset`, { method: 'POST', json: {} });
                        setSecret({ title: `Neues Passwort für ${r.username}`, value: r.password, hint: 'Wird nur jetzt angezeigt. Gib es sicher weiter; ändern lässt es sich danach in den Einstellungen.' });
                        setUsers(await api<AdminUser[]>('/admin/users'));
                      })
                    }
                  >
                    <RotateCcw size={13} /> Passwort zurücksetzen
                  </button>
                )}
                {!u.bannedAt && (
                  <button
                    className="btn-ghost border border-line px-2.5 py-1 text-xs"
                    disabled={busy === u.id}
                    title="Einmal-Code, mit dem das Konto auf einem neuen Gerät einen Passkey anlegt (braucht HTTPS)"
                    onClick={() =>
                      act(u.id, async () => {
                        const r = await api<{ username: string; code: string; expiresAt: number }>(`/admin/users/${u.id}/device-link`, { method: 'POST', json: {} });
                        setSecret({
                          title: `Gerätecode für ${r.username}`,
                          value: `${location.origin}/link/${r.code}`,
                          hint: `Code ${r.code}, gültig bis ${new Date(r.expiresAt).toLocaleTimeString('de-DE', { timeStyle: 'short' })}. Damit legt ${r.username} auf einem Gerät einen neuen Passkey an.`,
                        });
                      })
                    }
                  >
                    <Smartphone size={13} /> Gerätecode
                  </button>
                )}
                <button
                  className="btn-ghost border border-line px-2.5 py-1 text-xs"
                  disabled={busy === u.id}
                  onClick={() =>
                    (u.isAdmin ? confirm(`${u.username} die Admin-Rolle nehmen?`) : confirm(`${u.username} zum Admin machen? Admins verwalten alle Konten.`)) &&
                    act(u.id, async () => setUsers(await api<AdminUser[]>(`/admin/users/${u.id}/admin`, { method: 'POST', json: { admin: !u.isAdmin } })))
                  }
                >
                  {u.isAdmin ? <ShieldOff size={13} /> : <ShieldCheck size={13} />} {u.isAdmin ? 'Admin entfernen' : 'Zum Admin machen'}
                </button>
                {!self && (
                  <button
                    className={`btn-ghost border border-line px-2.5 py-1 text-xs ${u.bannedAt ? '' : 'text-danger'}`}
                    disabled={busy === u.id}
                    onClick={() =>
                      (u.bannedAt || confirm(`${u.username} sperren? Das Konto wird überall abgemeldet; die Notizen bleiben erhalten.`)) &&
                      act(u.id, async () => setUsers(await api<AdminUser[]>(`/admin/users/${u.id}/ban`, { method: 'POST', json: { banned: !u.bannedAt } })))
                    }
                  >
                    {u.bannedAt ? <UserCheck size={13} /> : <Ban size={13} />} {u.bannedAt ? 'Entsperren' : 'Sperren'}
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
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const load = useCallback(() => api<AdminInvite[]>('/admin/invites').then(setInvites, (e) => onError(e.message)), [onError]);
  useEffect(() => void load(), [load]);
  const url = (code: string) => `${location.origin}/invite/${code}`;

  return (
    <>
      <form
        className="card mb-4 flex flex-wrap items-center gap-2 p-1.5 pl-3"
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
        <input className="min-w-0 flex-1 bg-transparent py-2 outline-none placeholder:text-faint" placeholder="Für wen? (optional)" maxLength={80} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn-primary">Einladung erstellen</button>
      </form>
      {invites === null ? (
        <div className="py-10 text-center text-faint">…</div>
      ) : invites.length === 0 ? (
        <div className="py-10 text-center text-faint">Noch keine Einladungen.</div>
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
                      ? `angenommen von ${i.usedBy}${i.usedAt ? ` am ${date(i.usedAt)}` : ''}`
                      : state === 'expired'
                        ? `abgelaufen am ${date(i.expiresAt)}`
                        : `offen bis ${date(i.expiresAt)}`}
                  </div>
                </div>
                {state === 'open' && <CopyButton text={url(i.code)} label="Link kopieren" />}
                {state !== 'used' && (
                  <button
                    className="btn-icon h-8 w-8"
                    title="Einladung löschen"
                    onClick={async () => {
                      if (!confirm(`Einladung ${i.code} löschen?`)) return;
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

const EVENT_LABELS: Record<string, string> = {
  login: 'Anmeldung',
  login_failed: 'Fehlgeschlagen',
  login_blocked: 'Blockiert',
  register: 'Neues Konto',
  logout: 'Abmeldung',
  password_changed: 'Passwort geändert',
  account_deleted: 'Konto gelöscht',
  admin_command: 'Admin',
};

function AuditTab({ onError }: { onError: (msg: string) => void }) {
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  useEffect(() => {
    api<AdminAuditEntry[]>('/admin/audit').then(setEntries, (e) => onError(e.message));
  }, [onError]);
  if (!entries) return <div className="py-10 text-center text-faint">…</div>;
  if (!entries.length) return <div className="py-10 text-center text-faint">Noch keine Einträge.</div>;
  return (
    <ul className="card divide-y divide-line/60 p-1 text-sm">
      {entries.map((e, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
          <span className="w-28 shrink-0 text-xs text-faint">{dateTime(e.at)}</span>
          <span className={`font-medium ${e.event === 'login_failed' || e.event === 'login_blocked' ? 'text-danger' : e.event === 'admin_command' ? 'text-accent' : ''}`}>
            {EVENT_LABELS[e.event] ?? e.event}
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
  const [tab, setTab] = useState<Tab>('users');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<AdminStatus>('/admin/status').then(setStatus, (e) => setError(e.message));
  }, []);

  if (!me.isAdmin) return <div className="py-16 text-center text-faint">Nur für Admins.</div>;

  const tabs: { id: Tab; label: string; Icon: typeof Users }[] = [
    { id: 'users', label: 'Konten', Icon: Users },
    { id: 'invites', label: 'Einladungen', Icon: Mail },
    { id: 'audit', label: 'Protokoll', Icon: ScrollText },
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <header className="mb-5 anim-fade-up">
        <h1 className="text-2xl font-bold tracking-tight">Verwaltung</h1>
        {status && (
          <p className="mt-1 text-sm text-muted">
            Kladde {status.version} · {status.users} Konten · {status.notes} Notizen · {status.connections} Geräte verbunden · läuft seit {since(status.startedAt)}
          </p>
        )}
      </header>
      <div className="mb-5 grid grid-cols-3 gap-1 rounded-xl border border-line bg-surface p-1 anim-fade-up">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setError('');
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${tab === id ? 'bg-accent/12 text-accent' : 'text-muted hover:text-ink'}`}
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
