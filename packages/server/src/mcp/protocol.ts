import { APP_VERSION, memoryInstructions, memoryRulesText } from '@kladde/shared';
import { memoryRulesOf, ToolContent, ToolContext, ToolError, TOOLS, toolsFor } from './tools.js';

/** Newest first; an unknown version requested by the client gets the newest */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'Kladde is the user\'s personal Markdown notes app (PARA folders, Zettelkasten, tasks).',
  'You see the notes the user owns and the notes of their groups (paths start with the group name, `group` names the group; readers of a group may not change its notes). Find notes with semantic_search (conceptual, stemmed, link-aware), search_notes (exact words), or list_notes, then read_note.',
  'Before update_note, read the note and pass its version. Prefer append_to_note for small additions.',
  'Write in the language of the user\'s notes (usually German).',
].join(' ');

const RULES_URI = 'kladde://memory/rules';
const RULE_URI = 'kladde://memory/rule/';

/** The fixed instructions plus, with the AI memory on (#94), what it is and the user's rules for assistants */
function instructionsFor(ctx: ToolContext): string {
  const memory = memoryRulesOf(ctx);
  return memory ? `${INSTRUCTIONS}\n\n${memoryInstructions(memory.folder, memory.rules)}` : INSTRUCTIONS;
}

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
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'kladde', title: 'Kladde', version: APP_VERSION },
        instructions: instructionsFor(ctx),
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
        if (result instanceof ToolContent) return ok({ content: result.content });
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result });
      } catch (err) {
        if (err instanceof ToolError) return ok({ content: [{ type: 'text', text: err.message }], isError: true });
        console.error('MCP tool failed:', err);
        return ok({ content: [{ type: 'text', text: 'Interner Fehler im Kladde-Server.' }], isError: true });
      }
    }
    // The rules of the AI memory (#94) also as a resource and a prompt, for clients that do not show instructions
    case 'resources/list': {
      const memory = memoryRulesOf(ctx);
      if (!memory) return ok({ resources: [] });
      return ok({
        resources: [
          { uri: RULES_URI, name: 'memory_rules', title: 'Regeln aus dem KI-Gedächtnis', description: 'Instructions the user gives to AI assistants', mimeType: 'text/markdown' },
          ...memory.rules.map((r) => ({ uri: `${RULE_URI}${r.id}`, name: r.title, title: r.title, description: r.description || undefined, mimeType: 'text/markdown' })),
        ],
      });
    }
    case 'resources/read': {
      const memory = memoryRulesOf(ctx);
      const uri = typeof params.uri === 'string' ? params.uri : '';
      if (memory && uri === RULES_URI) return ok({ contents: [{ uri, mimeType: 'text/markdown', text: memoryRulesText(memory.rules, Infinity) || 'Keine Regeln.' }] });
      const rule = memory?.rules.find((r) => `${RULE_URI}${r.id}` === uri);
      if (rule) return ok({ contents: [{ uri, mimeType: 'text/markdown', text: `# ${rule.title}\n\n${rule.body}` }] });
      return error(msg.id, -32002, `Resource not found: ${uri}`);
    }
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'prompts/list': {
      const memory = memoryRulesOf(ctx);
      return ok({ prompts: memory ? [{ name: 'memory_rules', title: 'Regeln aus dem KI-Gedächtnis', description: 'Loads the rules from the AI memory into the conversation' }] : [] });
    }
    case 'prompts/get': {
      const memory = memoryRulesOf(ctx);
      if (!memory || params.name !== 'memory_rules') return error(msg.id, -32602, `Unknown prompt: ${String(params.name)}`);
      return ok({
        description: 'Rules from the AI memory',
        messages: [{ role: 'user', content: { type: 'text', text: memoryInstructions(memory.folder, memory.rules) } }],
      });
    }
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
