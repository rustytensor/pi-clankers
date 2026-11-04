// Synthetic MCP SERVER, not a client stub. New process for each owned transport.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [root, scenario] = process.argv.slice(2);
assert(root?.startsWith('/srv/devops/scratch/'));
assert(['NORMAL', 'ABORT', 'PARENTLOSS'].includes(scenario));
process.umask(0o077);
const audit = row => fs.appendFileSync(path.join(root, 'mcp-audit.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
const stamp = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
audit({ kind: 'spawn', pid: process.pid, start: stamp });
let initialized = false, notified = false, pending = '', requests = 0;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const schema = { type: 'object', properties: { project: { type: 'string' }, pattern: { type: 'string' } }, required: ['project', 'pattern'] };
async function request(m) {
  assert(m.jsonrpc === '2.0');
  if (m.method === 'notifications/initialized') { assert(initialized); notified = true; audit({ kind: 'initialized' }); return; }
  if (m.method === 'notifications/cancelled') return;
  assert(m.id !== undefined);
  if (m.method === 'initialize') {
    assert(!initialized); initialized = true;
    audit({ kind: 'initialize' });
    send(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'synthetic-larra', version: '1' } });
  } else if (m.method === 'tools/list') {
    assert(notified); audit({ kind: 'list' });
    send(m.id, { tools: ['search_text', 'delete_symbol', 'clankers_control', 'zerg_control'].map(name => ({ name, description: 'Synthetic gate operation', inputSchema: schema })) });
  } else if (m.method === 'tools/call') {
    assert(notified);
    // Audit BEFORE any dispatch, including forbidden or malformed requests.
    const name = m.params?.name, args = m.params?.arguments;
    audit({ kind: 'call', name, args, pid: process.pid, start: stamp });
    if (name !== 'search_text') { send(m.id, { content: [{ type: 'text', text: 'FORBIDDEN_EXECUTED' }], isError: false }); return; }
    assert(args.project === 'synthetic');
    if (scenario !== 'NORMAL') {
      assert(args.pattern === 'pending');
      fs.writeFileSync(path.join(root, 'server-started.json'), JSON.stringify({ pid: process.pid, start: stamp }), { mode: 0o600 });
      const end = Date.now() + 20000;
      while (!fs.existsSync(path.join(root, 'release-mcp'))) {
        if (Date.now() >= end) throw Error('latch deadline');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      send(m.id, { content: [{ type: 'text', text: 'UNEXPECTED_RELEASE' }], isError: false });
    } else {
      const text = { gateway: 'GATEWAY_OK', alias: 'ALIAS_OK', named: 'NAMED_OK' }[args.pattern];
      assert(text);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'fixture', data: 'synthetic progress; not a tool result' } }) + '\n');
      send(m.id, { content: [{ type: 'text', text }], isError: false });
    }
  } else if (m.method === 'ping') send(m.id, {});
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unknown method' } }) + '\n');
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  if (Buffer.byteLength(pending) > 65536) process.exit(2);
  while (pending.includes('\n')) {
    const pos = pending.indexOf('\n'), line = pending.slice(0, pos); pending = pending.slice(pos + 1);
    if (++requests > 64) process.exit(2);
    try { void request(JSON.parse(line)).catch(() => process.exit(2)); } catch { process.exit(2); }
  }
});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(2), 30000).unref();
