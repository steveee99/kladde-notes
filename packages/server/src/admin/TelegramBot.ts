import {
  AdminCommands,
  COMMANDS,
  AdminActions,
  escapeHtml,
  formatDate,
  formatDuration,
  splitMessage,
} from './AdminCommands.js';

export { escapeHtml, splitMessage };

export interface TelegramBotOptions {
  token: string;
  /** Only these chats are answered; empty = the bot only tells everyone their chat id */
  chatIds: string[];
  /** Optional: only these Telegram users may give commands (for group chats); empty = everyone in an unlocked chat */
  adminUserIds?: string[];
  /** Every command that runs (after confirmation), for the audit log */
  onCommand?: (command: { chatId: string; userId: string | null; text: string }) => void;
  actions: AdminActions;
  /** Base URL for invite links (e.g. https://notes.example.org), optional */
  publicUrl?: string | null;
  fetch?: typeof fetch;
  /** First wait after a failed poll; doubles up to RETRY_MAX_DELAY_MS */
  retryDelayMs?: number;
}

interface TelegramMessage {
  chat: { id: number };
  from?: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

const POLL_TIMEOUT_S = 30;
const RETRY_DELAY_MS = 5000;
const RETRY_MAX_DELAY_MS = 60_000;
/** A request that hangs this long counts as lost: after a network drop the socket may never answer */
const REQUEST_TIMEOUT_MS = 15_000;
const POLL_REQUEST_TIMEOUT_MS = POLL_TIMEOUT_S * 1000 + REQUEST_TIMEOUT_MS;

/**
 * Admin functions in a Telegram chat. Uses long polling (getUpdates), so the server
 * needs no public webhook URL. Messages from other chats are ignored.
 */
export class TelegramAdminBot {
  private readonly api: string;
  private readonly chatIds: Set<string>;
  private readonly adminUserIds: Set<string>;
  private readonly commands: AdminCommands;
  private readonly fetchFn: typeof fetch;
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  /** Start of the current connection loss, null while Telegram answers */
  private offlineSince: number | null = null;
  /** Connection losses Telegram came back from since the start */
  private reconnects = 0;
  private lastReconnect: { at: number; downMs: number } | null = null;

  constructor(private readonly options: TelegramBotOptions) {
    this.api = `https://api.telegram.org/bot${options.token}`;
    this.chatIds = new Set(options.chatIds);
    this.adminUserIds = new Set(options.adminUserIds ?? []);
    this.fetchFn = options.fetch ?? fetch;
    this.commands = new AdminCommands({
      actions: options.actions,
      publicUrl: options.publicUrl,
      onCommand: options.onCommand,
      statusLines: () => [this.statusLine()],
    });
  }

  private statusLine(): string {
    const reconnect = this.lastReconnect
      ? `, zuletzt ${formatDate(this.lastReconnect.at)} (${formatDuration(this.lastReconnect.downMs)} weg)`
      : '';
    return `<b>Telegram</b>: ${this.reconnects} Reconnects seit dem Start${reconnect}`;
  }

  /** TELEGRAM_BOT_TOKEN switches the bot on, TELEGRAM_CHAT_ID (comma separated) unlocks chats */
  static fromEnv(
    actions: AdminActions,
    env: NodeJS.ProcessEnv = process.env,
    onCommand?: TelegramBotOptions['onCommand']
  ): TelegramAdminBot | null {
    const token = env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) return null;
    const list = (value: string | undefined) =>
      (value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    return new TelegramAdminBot({
      token,
      chatIds: list(env.TELEGRAM_CHAT_ID),
      adminUserIds: list(env.TELEGRAM_ADMIN_USER_IDS),
      actions,
      onCommand,
      publicUrl: env.PUBLIC_URL?.trim() || null,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.chatIds.size === 0) {
      console.log('🤖 Telegram bot without TELEGRAM_CHAT_ID: send it any message to learn your chat id');
    }
    this.call('setMyCommands', {
      commands: COMMANDS.map(({ command, description }) => ({ command, description })),
    }).catch((err) => console.error('Telegram: could not set the command menu:', err));
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  /** Message to every unlocked chat (e.g. an invite was used); never throws */
  async notify(html: string): Promise<void> {
    await Promise.all(
      [...this.chatIds].map((chatId) =>
        this.send(chatId, html).catch((err) => console.error(`Telegram: could not notify chat ${chatId}:`, err))
      )
    );
  }

  private async pollLoop(): Promise<void> {
    const firstDelay = this.options.retryDelayMs ?? RETRY_DELAY_MS;
    let delay = firstDelay;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const updates = (await this.call(
          'getUpdates',
          { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          AbortSignal.any([this.abort.signal, AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS)])
        )) as TelegramUpdate[];
        delay = firstDelay;
        if (this.offlineSince !== null) this.reconnected();
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running) return;
        if (this.offlineSince === null) this.offlineSince = Date.now();
        console.error(
          `Telegram: polling failed, retrying in ${Math.round(delay / 1000)} s:`,
          err instanceof Error ? err.message : err
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
      }
    }
  }

  /** Telegram answers again after a connection loss: counted for /status, no message (it happens often) */
  private reconnected(): void {
    const now = Date.now();
    const downMs = now - (this.offlineSince ?? now);
    this.offlineSince = null;
    this.reconnects++;
    this.lastReconnect = { at: now, downMs };
    console.log(`Telegram: connection restored after ${Math.round(downMs / 1000)} s`);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text) return;
    const chatId = String(message.chat.id);
    if (!this.chatIds.has(chatId)) {
      // Setup help only while no chat is unlocked; afterwards strangers get no answer at all
      if (this.chatIds.size === 0) {
        await this.send(chatId, `Dieser Chat ist nicht freigeschaltet. Deine Chat-ID: <code>${chatId}</code>`);
      }
      return;
    }
    const userId = message.from ? String(message.from.id) : null;
    // In a group, only the listed admins (if any are configured) may give commands
    if (this.adminUserIds.size > 0 && (!userId || !this.adminUserIds.has(userId))) return;
    let reply: string;
    try {
      reply = await this.confirmOrRun(chatId, userId, message.text);
    } catch (err) {
      console.error('Telegram: command failed:', err);
      reply = 'Das hat nicht geklappt – Details stehen im Server-Log.';
    }
    await this.send(chatId, reply);
  }

  /** Critical commands are only noted and run on /ja within a minute; everything else runs right away */
  /** Critical commands are only noted and run on /ja within a minute; everything else runs right away */
  async confirmOrRun(chatId: string, userId: string | null, text: string, now = Date.now()): Promise<string> {
    return (await this.commands.execute({ key: chatId, chatId, userId }, text, now)).html;
  }

  /** Answer (Telegram HTML) to one command line, e.g. "/sperren Loki"; slow checks answer asynchronously */
  handleCommand(text: string): string | Promise<string> {
    return this.commands.handleCommand(text);
  }

  private async send(chatId: string, html: string): Promise<void> {
    for (const text of splitMessage(html)) {
      await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    }
  }

  private async call(method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchFn(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`${method}: ${data.description ?? res.status}`);
    return data.result;
  }
}