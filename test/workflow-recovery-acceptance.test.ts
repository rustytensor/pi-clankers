import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Parent review opt-in ONLY. Skips explicitly are not passing acceptance.
const approved = process.env.CLANKERS_WORKFLOW_ACCEPTANCE === 'parent-approved';
const loader = createRequire(import.meta.url).resolve('tsx');
const safetyUrl = new URL('./fixtures/host-fixture-safety.mjs', import.meta.url).href;
const driver = fileURLToPath(new URL('./fixtures/workflow-recovery-sdk-acceptance.mjs', import.meta.url));
const controllerPath = fileURLToPath(new URL('./fixtures/workflow-recovery-host-pty.py', import.meta.url));
const pinnedPi = join(homedir(), '.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent');

for (const mode of ['sdk', 'regular', 'fullscreen']) {
  test(`actual native recovery acceptance: ${mode}`, {
    skip: approved ? false : 'requires integrating-parent review and CLANKERS_WORKFLOW_ACCEPTANCE=parent-approved; NOT acceptance passed',
    timeout: 200_000,
  }, async () => {
    assert(existsSync(join(pinnedPi, 'package.json')), 'Installed Pi 1.0.2 required; never install or fall back');
    const safety = await import(safetyUrl);
    const root = mkdtempSync(join(tmpdir(), 'clankers-recovery-acceptance-' + mode + '-'));
    safety.assertAncestorIsolation(root); mkdirSync(join(root, 'work')); mkdirSync(join(root, 'evidence'));
    const identity = lstatSync(root);
    writeFileSync(join(root, 'evidence/parent-approval.json'), JSON.stringify({ guard: 'parent-approved', root, uid: identity.uid, dev: identity.dev, ino: identity.ino }), { flag: 'wx', mode: 0o600 });
    // Three nested ownership domains: public pidfd supervisor, outer compiler
    // reaper, HTTP driver + old/fresh controller. All ambient env is discarded.
    const controller = safety.spawnOwnedController('/usr/bin/python3', [controllerPath, root, '--driver', process.execPath, '--import', loader, driver, root, mode, pinnedPi], root, 180_000);
    const output: Buffer[] = []; let bytes = 0;
    for (const stream of [controller.stdout, controller.stderr]) stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 65_536) output.push(chunk); });
    try {
      await controller.fixtureClosed; await safety.settleOwnedController(controller);
      const log = Buffer.concat(output).toString();
      writeFileSync(join(root, 'evidence/test.log'), log);
      assert.equal(controller.exitCode, 0, `acceptance failed; evidence ${root}\n${log}`);
      const proof = JSON.parse(readFileSync(join(root, 'evidence/closed-proof.json'), 'utf8'));
      const supervisor = JSON.parse(readFileSync(join(root, 'supervisor-result.json'), 'utf8'));
      const result = JSON.parse(readFileSync(join(root, 'evidence/pty-result.json'), 'utf8'));
      assert.equal(controller.exitCode, 0, `evidence ${root}\n${log}\n${JSON.stringify(result)}`);
      assert.equal(supervisor.ok, true, `supervisor proof ${root}`); assert.deepEqual(supervisor.remaining, []);
      assert.equal(result.ok, true); assert.deepEqual(result.remaining, []);
      assert.equal(proof.oldHttp.heldClosed, true); assert.equal(proof.oldHttp.sockets, 0); assert.equal(proof.oldHttp.active, 0);
      assert.equal(JSON.parse(readFileSync(join(root, 'evidence/transport.json'), 'utf8')).requests.length, 9);
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'evidence/socket-cleanup.json'), 'utf8')), { listening: false, sockets: 0, responses: 0 });
      assert.deepEqual(readdirSync(root).sort(), ['evidence', 'supervisor-result.json'], 'sandbox project/staging/HOME/config/temp resources removed');
      assert(bytes <= 65_536); assert.match(log, new RegExp('PASS workflow recovery acceptance ' + mode));
      console.log(`Saved ${mode} synthetic process/HTTP/UI proof: ${root}/evidence; owned processes=${supervisor.seen.length}; requests=9`);
    } finally { await safety.settleOwnedController(controller); }
  });
}
