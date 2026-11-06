// Opt-in registered public host. No transport/runtime mocks or loader preloads.
import { createJiti } from 'jiti';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.env.TMUX_GATE_ROOT, sdk = process.env.TMUX_GATE_SDK;
assert(root.startsWith('/srv/devops/scratch/'));
assert.equal(JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdk), '../package.json'))).version, '1.5.0');
const host = createJiti(sdk, { fsCache: false });
const jiti = createJiti(import.meta.url, { fsCache: false, alias: { '@earendil-works/pi-coding-agent': sdk, '@earendil-works/pi-tui': host.esmResolve('@earendil-works/pi-tui') } });
const { registerZergSwarmExtension } = await jiti.import('../../index.ts');
const { createZergState, replaceSharedZergState } = await jiti.import('../../state.ts');
replaceSharedZergState(createZergState({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } }));
let nr = 0, nt = 0, offset = 0, timer;
const realNow = Date.now;
Date.now = () => realNow() + offset;
const commands = new Map(), tools = new Map();
const registration = registerZergSwarmExtension({ registerCommand(name, def) { commands.set(name, def); }, registerTool(def) { tools.set(def.name, def); } }, { cwd: path.join(root, 'workspace'), idFactory: { runId: () => `continuation-${++nr}`, taskId: () => `continuation-${++nt}` }, trustedTmux: { sdkModulePath: sdk, agentDir: path.join(root, 'agent'), rootDir: path.join(root, 'w'), fixtureExtensionPaths: [path.join(root, 'provider.js')] } });
const control = registration.control;
assert(commands.has('clankers') && tools.has('clankers_control'));
function descendants() {
  const result = [], todo = [process.pid];
  while (todo.length) {
    const pid = todo.pop();
    let children = [];
    try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch {}
    for (const child of children) { if (result.includes(child)) continue; result.push(child); todo.push(child); assert(result.length < 100); }
  }
  return result;
}
const actualNode = fs.realpathSync(process.execPath);
const workerEntry = fs.realpathSync(new URL('../../tmux-worker-entry.mjs', import.meta.url));
let stopped;
function procIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { pid, start: tail[19], parent: Number(tail[1]), group: Number(tail[2]) };
}
function argvFor(pid) { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1); }
function resumeStopped() {
  if (!stopped) return;
  try { if (procIdentity(stopped.pid).start === stopped.start) process.kill(stopped.pid, 'SIGCONT'); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  finally { stopped = undefined; }
}
process.once('exit', resumeStopped);
async function operatorReadOnly(value) {
  const notifications = [];
  await commands.get('clankers').handler(`control readonly ${value ? 'on' : 'off'}`, { hasUI: false, ui: { notify: (text, type) => notifications.push({ text, type }) } });
  assert(notifications.length && notifications.every(row => row.type !== 'error'));
  assert.equal(control.getState().mode.readOnly, value, 'registration owner authority not changed');
  return { ok: true, readOnly: control.getState().mode.readOnly, notifications };
}
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    assert(Buffer.byteLength(line) < 131072);
    const q = JSON.parse(line); let r;
    if (q.fixture === 'state') r = { ok: true, data: control.getState() };
    else if (q.fixture === 'clock') { offset += 300001; r = { ok: true, offset }; }
    else if (q.fixture === 'readonly') r = await operatorReadOnly(q.value);
    else if (q.fixture === 'armRevocation') {
      assert(!timer); const before = descendants();
      timer = setInterval(async () => {
        for (const pid of descendants()) {
          if (before.includes(pid)) continue;
          let argv;
          try { argv = argvFor(pid); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          // Never match a tmux new-session client whose later arguments contain the entry.
          if (argv[0] !== actualNode || argv[1] !== workerEntry || argv.length !== 3) continue;
          clearInterval(timer); timer = undefined;
          let record = { pid, argv, before };
          let guard;
          try {
            const pane = procIdentity(pid), server = procIdentity(pane.parent), broker = procIdentity(server.parent);
            const manifest = argv[2], runDir = path.dirname(manifest), serverSocket = path.join(runDir, 'tmux.sock');
            assert.equal(path.dirname(runDir), path.join(root, 'w'));
            assert.equal(path.basename(manifest), 'config.json');
            const config = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            assert.equal(config.parentPid, process.pid); assert.equal(config.runDir, runDir);
            assert.equal(fs.readlinkSync(`/proc/${pid}/exe`), actualNode);
            assert.equal(fs.readlinkSync(`/proc/${server.pid}/exe`), fs.realpathSync('/usr/bin/tmux'));
            assert.equal(broker.parent, process.pid);
            const brokerArgv = argvFor(broker.pid);
            assert.equal(brokerArgv[0], actualNode); assert.equal(brokerArgv[1], '-e');
            assert.deepEqual(brokerArgv.slice(3), [serverSocket, manifest]);
            assert(fs.lstatSync(serverSocket).isSocket());
            assert.equal(pane.group, pid); assert.equal(server.group, server.pid);
            assert.deepEqual(procIdentity(pid), pane); assert.deepEqual(procIdentity(server.pid), server);
            record = { ...record, pane, server, broker, manifest, serverSocket, networkNamespace: fs.readlinkSync(`/proc/${pid}/ns/net`) };
            stopped = pane; process.kill(pid, 'SIGSTOP');
            guard = setTimeout(resumeStopped, 2000);
            const operator = await operatorReadOnly(true);
            assert.equal(control.getState().mode.readOnly, true);
            record = { ...record, operator, canonicalReadOnly: true };
          } catch (error) { record.error = String(error); }
          finally { clearTimeout(guard); resumeStopped(); record.resumed = true; }
          fs.writeFileSync(path.join(root, 'revocation.json'), JSON.stringify(record), { mode: 0o600 });
          return;
        }
      }, 2);
      r = { ok: true };
    }
    else if (q.fixture === 'dispose') { registration.dispose(); await control.drain(); r = { ok: true }; }
    else if (q.fixture === 'slash') { const notifications = []; await commands.get('clankers').handler(q.text, { hasUI: false, ui: { notify: (text, type) => notifications.push({ text, type }) } }); r = { ok: true, notifications }; }
    else { const v = await tools.get('clankers_control').execute('continuation-gate', q); assert.equal(v.isError, !v.details.ok); r = v.details; }
    fs.appendFileSync(path.join(root, 'responses.jsonl'), JSON.stringify({ q, r }) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify(r) + '\n');
  }
} finally { if (timer) clearInterval(timer); resumeStopped(); registration.dispose(); await control.drain(); Date.now = realNow; }
