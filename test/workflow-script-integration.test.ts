import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Exact opt-in is a review gate, not a claim that skipped tests passed.
const approved = process.env.CLANKERS_WORKFLOW_SCRIPT_ACCEPTANCE === 'parent-approved';
const safetyURL = new URL('./fixtures/host-fixture-safety.mjs', import.meta.url).href;
const driver = fileURLToPath(new URL('./fixtures/workflow-script-sdk-acceptance.mjs', import.meta.url));
const controller = fileURLToPath(new URL('./fixtures/workflow-script-host-pty.py', import.meta.url));
const pinnedPi = join(homedir(), '.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent');

for (const mode of ['sdk', 'regular', 'fullscreen', 'packed']) {
  test(`restricted script actual isolated acceptance: ${mode}`, {
    skip: approved ? false : 'requires parent fixture review and CLANKERS_WORKFLOW_SCRIPT_ACCEPTANCE=parent-approved; NOT acceptance passed',
    timeout: 200_000,
  }, async () => {
    assert(existsSync(join(pinnedPi, 'package.json')), 'Pinned installed Pi 1.0.2 required; no install/fallback');
    const safety = await import(safetyURL);
    const root = mkdtempSync(join(tmpdir(), `clankers-script-acceptance-${mode}-`));
    safety.assertAncestorIsolation(root);
    mkdirSync(join(root, 'work')); mkdirSync(join(root, 'evidence'));
    const identity = lstatSync(root);
    writeFileSync(join(root, 'evidence/parent-approval.json'), JSON.stringify({ guard: 'parent-approved', root, uid: identity.uid, dev: identity.dev, ino: identity.ino }), { flag: 'wx', mode: 0o600 });
    const process = safety.spawnOwnedController('/usr/bin/python3', [controller, root, '--driver', globalThis.process.execPath, '--max-old-space-size=512', driver, root, mode, pinnedPi], root, 180_000);
    const chunks: Buffer[] = []; let bytes = 0;
    for (const stream of [process.stdout, process.stderr]) stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 65_536) chunks.push(chunk); });
    try {
      await process.fixtureClosed; await safety.settleOwnedController(process);
      const log = Buffer.concat(chunks).toString();
      writeFileSync(join(root, 'evidence/test.log'), log);
      assert.equal(process.exitCode, 0, `failed; retained synthetic evidence ${root}\n${log}`);
      const read = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8'));
      assert.equal(read('supervisor-result.json').ok, true);
      assert.deepEqual(read('supervisor-result.json').remaining, []);
      assert.equal(read('evidence/pty-result.json').ok, true);
      assert.deepEqual(read('evidence/pty-result.json').remaining, []);
      const result = read('evidence/result.json'); assert.equal(result.ok, true);
      assert.equal(result.actualNative, 8); assert.equal(result.disposed, 8); assert.equal(result.requests, 8);
      const instrumentation = read('evidence/sdk-instrumentation.json');
      assert(instrumentation.watchedClasses >= 1 && instrumentation.watchedClasses <= 2);
      assert.equal(instrumentation.nativeStarts, 8); assert.equal(instrumentation.nativeDisposals, 8);
      assert.equal(instrumentation.sessions.length, 8);
      assert.equal(new Set(instrumentation.sessions.map((session: any) => session.sessionId)).size, 8);
      assert(instrumentation.sessions.every((session: any) => session.disposed && session.sessionFile));
      assert.deepEqual(read('evidence/recovery-drain.json'), { ok: true, rejected: 'Native cleanup settlement is uncertain', recordedCleanupSettled: false, historicalSettlementNotClaimed: true });
      assert.equal(read('evidence/driver-supervision.json').ok, true);
      if (mode === 'regular' || mode === 'fullscreen') {
        const slash = read('evidence/slash-routes.json'); assert.equal(slash.ok, true);
        for (const action of ['workflows.scripts.validate', 'workflows.scripts.compile', 'workflows.scripts.save', 'workflows.scripts.inspect', 'workflows.start']) assert(slash.routes.some((route: any) => route.action === action && route.actualHostContext));
        assert.equal(read('evidence/ui-live.json').ok, true);
      }
      if (mode === 'packed') { const layout = read('evidence/package-layout.json'); assert.equal(layout.ok, true); assert.equal(layout.noCheckoutFallback, true); assert(layout.inventory.some((pkg: any) => pkg.name === 'typescript' && pkg.version === '5.9.3')); }
      assert.equal(read('evidence/transport.json').requests.length, 8);
      assert.deepEqual(read('evidence/socket-cleanup.json'), { listening: false, sockets: 0, responses: 0 });
      assert.deepEqual(readdirSync(root).sort(), ['evidence', 'supervisor-result.json'], 'owned home/auth/work/pack/temp removed only after process closure');
      assert(bytes <= 65_536);
      assert.match(log, /PASS restricted script acceptance/);
      console.log(`${mode}: bounded synthetic evidence ${root}/evidence; NOT real-model quality or manual visual acceptance`);
    } finally { await safety.settleOwnedController(process); }
  });
}
