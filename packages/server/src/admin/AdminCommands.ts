import type { InviteInfo, UserRecord } from '../UserStore.js';
import type { AuditEntry } from '../security/AuditLog.js';

export interface AdminActions {
  createInvite(note: string): InviteInfo;
  listInvites(): InviteInfo[];
  deleteInvite(code: string): boolean;
  listUsers(): UserRecord[];
  setBanned(username: string, banned: boolean): boolean;
  /** New random password (null if the account does not exist); signs the account out everywhere */
  resetPassword(username: string): Promise<string | null>;
  setAdmin(username: string, admin: boolean): boolean;
  auditLog(): AuditEntry[];
  status(): { version: string; startedAt: number; users: number; notes: number; shares: number; connections: number };
}

/** Shown in the command menu of Telegram; order = order in /hilfe */
export const COMMANDS: { command: string; args?: string; description: string }[] = [
  { command: 'status', description: 'Server, Konten und Notizen' },
  { command: 'einladen', args: '[Notiz]', description: 'Neuen Einladungscode erstellen' },
  { command: 'einladungen', description: 'Alle Einladungscodes' },
  { command: 'einladung_loeschen', args: 'CODE', description: 'Einladungscode löschen' },
  { command: 'konten', description: 'Alle Konten' },
  { command: 'sperren', args: 'BENUTZER', description: 'Konto sperren und abmelden' },
  { command: 'entsperren', args: 'BENUTZER', description: 'Konto wieder freigeben' },
  { command: 'passwort', args: 'BENUTZER', description: 'Neues Zufallspasswort setzen und abmelden' },
  { command: 'admin', args: 'BENUTZER [an|aus]', description: 'Admin-Rolle geben oder nehmen' },
  { command: 'protokoll', description: 'Letzte Anmeldungen und Admin-Aktionen' },
  { command: 'hilfe', description: 'Alle Befehle' },
];

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const formatDate = (ms: number) => new Date(ms).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} Tage`;
}

/** Telegram messages are limited to 4096 characters: splits at line breaks */
export function splitMessage(html: string, max = 4000): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of html.split('\n')) {
    if (current && current.length + line.length + 1 > max) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line.slice(0, max);
  }
  if (current) parts.push(current);
  return parts;
}

export interface AdminCommandOptions {
  actions: AdminActions;
  publicUrl?: string | null;
  onCommand?: (command: { chatId: string; userId: string | null; text: string }) => void;
  statusLines?: () => string[];
}

/** Admin chat commands (Telegram). Answers are Telegram HTML */
export class AdminCommands {
  constructor(private readonly options: AdminCommandOptions) {}

  async execute(ctx: { key: string; chatId: string; userId: string | null }, text: string, _now = Date.now()): Promise<{ html: string }> {
    this.options.onCommand?.({ chatId: ctx.chatId, userId: ctx.userId, text });
    return { html: await this.handleCommand(text) };
  }

  inviteLink(code: string): string {
    return this.options.publicUrl ? `${this.options.publicUrl.replace(/\/$/, '')}/invite/${code}` : code;
  }

  async handleCommand(text: string): Promise<string> {
    const [rawCommand, ...rest] = text.trim().split(/\s+/);
    const command = rawCommand.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
    const arg = rest.join(' ').trim();
    const a = this.options.actions;
    switch (command) {
      case 'status': {
        const s = a.status();
        return [
          `<b>Kladde ${escapeHtml(s.version)}</b>`,
          `Läuft seit ${formatDuration(Date.now() - s.startedAt)}`,
          `${s.users} Konten, ${s.notes} Notizen, ${s.shares} Freigaben`,
          `${s.connections} verbundene Geräte`,
          ...(this.options.statusLines?.() ?? []),
        ].join('\n');
      }
      case 'einladen': {
        const invite = a.createInvite(arg);
        return `Neue Einladung${invite.note ? ` für <b>${escapeHtml(invite.note)}</b>` : ''} (14 Tage gültig):\n<code>${escapeHtml(this.inviteLink(invite.code))}</code>`;
      }
      case 'einladungen': {
        const list = a.listInvites();
        if (!list.length) return 'Keine Einladungen.';
        return list
          .map((i) => `<code>${i.code}</code> ${escapeHtml(i.note)} – ${i.usedBy ? `benutzt von ${escapeHtml(i.usedBy)}` : i.expiresAt < Date.now() ? 'abgelaufen' : 'offen'}`)
          .join('\n');
      }
      case 'einladung_loeschen':
        return a.deleteInvite(arg) ? 'Einladung gelöscht.' : 'Diesen Code gibt es nicht.';
      case 'konten': {
        const list = a.listUsers();
        return list.length ? list.map((u) => `${escapeHtml(u.username)}${u.bannedAt ? ' (gesperrt)' : ''} – seit ${formatDate(u.createdAt)}`).join('\n') : 'Noch keine Konten.';
      }
      case 'sperren':
      case 'entsperren':
        return a.setBanned(arg, command === 'sperren') ? `${escapeHtml(arg)} ${command === 'sperren' ? 'gesperrt' : 'entsperrt'}.` : 'Dieses Konto gibt es nicht.';
      case 'passwort': {
        if (!arg) return 'Bitte einen Benutzernamen angeben: /passwort BENUTZER';
        const password = await a.resetPassword(arg);
        return password
          ? `Neues Passwort für <b>${escapeHtml(arg)}</b> (alle Geräte abgemeldet):\n<code>${escapeHtml(password)}</code>`
          : 'Dieses Konto gibt es nicht.';
      }
      case 'admin': {
        const [name, mode = 'an'] = arg.split(/\s+/);
        if (!name) return 'Bitte einen Benutzernamen angeben: /admin BENUTZER [an|aus]';
        const on = mode.toLowerCase() !== 'aus';
        try {
          return a.setAdmin(name, on) ? `${escapeHtml(name)} ist ${on ? 'jetzt Admin' : 'kein Admin mehr'}.` : 'Dieses Konto gibt es nicht.';
        } catch (err) {
          return escapeHtml((err as Error).message);
        }
      }
      case 'protokoll': {
        const entries = a.auditLog();
        return entries.length
          ? entries.map((e) => `${formatDate(e.at)} ${e.event} ${escapeHtml(e.username ?? '')} ${escapeHtml(e.ip ?? '')}`).join('\n')
          : 'Leer.';
      }
      case 'hilfe':
      case 'start':
      case 'help':
        return COMMANDS.map((c) => `/${c.command}${c.args ? ` ${c.args}` : ''} – ${c.description}`).join('\n');
      default:
        return 'Unbekannter Befehl – /hilfe zeigt alle.';
    }
  }
}
