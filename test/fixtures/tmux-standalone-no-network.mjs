// Defense in depth, not an OS sandbox. Allow local Unix transport only.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof first === 'object' && first !== null && typeof first.path === 'string') ||
      (typeof first === 'string' && first.startsWith('/'))) return original.apply(this, args);
  throw Error('Gate network guard: TCP denied');
};
tls.connect = () => { throw Error('Gate network guard: TLS denied'); };
dgram.createSocket = () => { throw Error('Gate network guard: UDP denied'); };
globalThis.fetch = async () => { throw Error('Gate network guard: fetch denied'); };
// Observe actual process creation without replacing the runner or subprocess.
const spawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  const root = process.env.TMUX_GATE_ROOT;
  if (root?.startsWith('/srv/devops/scratch/')) {
    fs.appendFileSync(root + '/spawn-proof.jsonl', JSON.stringify({ parent: process.pid, pid: child.pid ?? null }) + '\n', { mode: 0o600 });
  }
  return child;
};
syncBuiltinESMExports();
// Per-PID proof is emitted only after the real preload installs all guards.
const root = process.env.TMUX_GATE_ROOT;
if (!root?.startsWith('/srv/devops/scratch/')) throw Error('Private gate root required');
Object.defineProperty(globalThis, Symbol.for('tmux-gate-network-guard'), { value: process.pid });
fs.writeFileSync(`${root}/network-guard-${process.pid}.json`, JSON.stringify({ pid: process.pid, installed: true }), { mode: 0o600 });
