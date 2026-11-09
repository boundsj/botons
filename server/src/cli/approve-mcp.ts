import { VERSION } from '../../../shared/app-version.mjs';
// `botons mcp`: an MCP server (JSON-RPC over stdio, one message per line) whose one tool, approve, is
// Claude Code's --permission-prompt-tool for a turn with Ask first rules. It asks the Botons server with
// the turn's token, then polls until the owner decides or the call's wait ends.
import { createInterface } from 'node:readline';
import type { ToolCallVerdict } from '../../../shared/types.ts';

/** The MCP version this speaks when the client names none. */
const PROTOCOL = '2025-06-18';
/** Polls that may fail in a row (a server restarting, say) before the call is denied. */
const POLL_FAILURES_MAX = 5;

const APPROVE_TOOL = {
  name: 'approve',
  description: "Asks the Boton's owner whether a tool call one of their Ask first rules covers may run. Called by Claude Code for permission prompts only.",
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

type Answer = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serve until stdin closes. */
export function serveApprovals(opts: { api: string; bot: string; token: string; pollMs?: number }): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const send = (m: unknown): void => {
    process.stdout.write(`${JSON.stringify(m)}\n`);
  };

  async function call(method: string, path: string, body?: unknown): Promise<ToolCallVerdict> {
    const res = await fetch(`${opts.api}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data as ToolCallVerdict;
  }

  async function approve(args: any): Promise<Answer> {
    const input = args?.input ?? {};
    if (!opts.bot || !opts.token) return { behavior: 'deny', message: 'This call needs your owner\'s approval, but this turn has no Botons token to ask with, so it is denied.' };
    try {
      let v = await call('POST', `/api/bots/${encodeURIComponent(opts.bot)}/approvals/tool-call`, { toolName: args?.tool_name, input, toolUseId: args?.tool_use_id });
      let failures = 0;
      // This call's own place on the card: an allow goes to one call only.
      const waiter = v.waiter ?? '';
      while (v.behavior === 'wait' && v.approval) {
        await sleep(pollMs);
        try {
          v = await call('GET', `/api/approvals/${encodeURIComponent(v.approval.id)}/tool-call?waiter=${encodeURIComponent(waiter)}`);
          failures = 0;
        } catch (err) {
          if (++failures >= POLL_FAILURES_MAX) throw err;
        }
      }
      if (v.behavior === 'allow') return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: v.message ?? 'Denied.' };
    } catch (err) {
      return { behavior: 'deny', message: `This call needs your owner's approval, but the Botons server could not be asked (${(err as Error).message}), so it is denied.` };
    }
  }

  async function handle(msg: any): Promise<void> {
    const id = msg?.id;
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });
    switch (msg?.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'botons', version: VERSION },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [APPROVE_TOOL] });
      case 'tools/call': {
        if (msg.params?.name !== APPROVE_TOOL.name) {
          return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${msg.params?.name}` } });
        }
        const answer = await approve(msg.params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
      }
      default:
        // Notifications (no id) need no answer.
        if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg?.method}` } });
    }
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Answered as they finish: a call waiting for the owner holds up nothing else.
    void handle(msg);
  });
  return new Promise((done) => lines.on('close', () => done()));
}
