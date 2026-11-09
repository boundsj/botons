// A stand-in for a local (stdio) MCP server, run as `node fake-stdio-mcp.ts [options]`: newline-delimited JSON-RPC
// on stdin and stdout, as the MCP stdio transport has it. Options:
//   --need NAME=SHA256 refuse to start (exit 1, a message on stderr) unless the variable's value has that sha256 (hex),
//                      so the secret itself is never on a command line
//   --tools a,b        the tools it lists (default: lookup)
// tools/call answers with the call's arguments and the tool's name as structuredContent.
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = opt('--need');
const tools = (opt('--tools') ?? 'lookup').split(',').filter(Boolean);

if (need) {
  const eq = need.indexOf('=');
  const [name, sha] = [need.slice(0, eq), need.slice(eq + 1)];
  if (createHash('sha256').update(process.env[name] ?? '').digest('hex') !== sha) {
    process.stderr.write(`fake stdio MCP: ${name} is not set to what it needs\n`);
    process.exit(1);
  }
}

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: { id?: number | string; method?: string; params?: { name?: string; arguments?: unknown } };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // a notification
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1' } } });
  }
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })) } });
  if (msg.method === 'tools/call') {
    const structured = { tool: msg.params?.name ?? null, arguments: msg.params?.arguments ?? null };
    return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
