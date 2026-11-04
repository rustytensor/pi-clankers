// Observes public Pi lifecycle only; cannot grant ownership or synthesize outcomes.
import fs from 'node:fs';
import path from 'node:path';
export default function (pi: any) {
  const root = process.env.TMUX_GATE_ROOT!;
  pi.on('session_start', (_event: any, ctx: any) => {
    // No UI proof unless the preload ran in this exact interactive process.
    if ((globalThis as any)[Symbol.for('tmux-gate-network-guard')] !== process.pid) throw Error('Child network preload missing');
    fs.writeFileSync(path.join(root, 'ui-proof.json'), JSON.stringify({ pid: process.pid,
      mode: ctx.mode, hasUI: ctx.hasUI, stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true }), { mode: 0o600 });
  });
  // Command execution is independently observed without reading terminal text.
  // The fixture command runs after the actual takeover/return on the same PTY.
  let barriers = 0;
  pi.registerCommand('gate-barrier', { description: 'Fixture PTY ordering barrier', handler: async () => {
    fs.writeFileSync(path.join(root, 'barrier.json'), JSON.stringify({ count: ++barriers }), { mode: 0o600 });
  } });
}
