import { APP_VERSION } from '@kladde/shared';
import { ToolContext, ToolError, TOOLS, toolsFor } from './tools.js';

/** Newest first; an unknown version requested by the client gets the newest */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Kladde is the user\'s personal Markdown notes app (PARA folders, Zettelkasten, tasks).',
  'You only see the notes the user owns. Find notes with semantic_search (conceptual, stemmed, link-aware), search_notes (exact words), or list_notes, then read_note.',
  'Before update_note, read the note and pass its version. Prefer append_to_note for small additions.',
  'Write in the language of the user\'s notes (usually German).',
].join(' ');

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const error = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function isRequest(msg: unknown): msg is RpcRequest {
  return !!msg && typeof msg === 'object' && (msg as RpcRequest).jsonrpc === '2.0' && typeof (msg as RpcRequest).method === 'string';
}

/** One JSON-RPC message; null for notifications (no answer) */
export function handleMessage(msg: unknown, ctx: ToolContext): RpcResponse | null {
  if (!isRequest(msg)) return error((msg as RpcRequest)?.id, -32600, 'Invalid request');
  const isNotification = !('id' in msg) || msg.id === undefined;
  if (isNotification) return null;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: msg.id ?? null, result });

  switch (msg.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kladde', title: 'Kladde', version: APP_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: toolsFor(ctx.canWrite).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: t.name === 'update_note', idempotentHint: !t.write, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(msg.id, -32602, `Unknown tool: ${String(name)}`);
      if (tool.write && !ctx.canWrite) {
        return ok({ content: [{ type: 'text', text: 'Diese Verbindung darf nur lesen. Für Schreibzugriff die App neu verbinden und Schreiben erlauben (bzw. ein Token mit Schreibrecht erstellen).' }], isError: true });
      }
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      try {
        const result = tool.run(args, ctx);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result });
      } catch (err) {
        if (err instanceof ToolError) return ok({ content: [{ type: 'text', text: err.message }], isError: true });
        console.error('MCP tool failed:', err);
        return ok({ content: [{ type: 'text', text: 'Interner Fehler im Kladde-Server.' }], isError: true });
      }
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return error(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** A single message or a batch (2025-03-26); null when nothing needs an answer */
export function handleBody(body: unknown, ctx: ToolContext): RpcResponse | RpcResponse[] | null {
  if (Array.isArray(body)) {
    if (!body.length) return error(null, -32600, 'Empty batch');
    const answers = body.slice(0, 50).map((m) => handleMessage(m, ctx)).filter((a): a is RpcResponse => a !== null);
    return answers.length ? answers : null;
  }
  return handleMessage(body, ctx);
}
