// Author-only lifecycle harness. No fake runner, adapter, transport, or provider.
import { createJiti } from 'jiti';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = process.env.TMUX_GATE_ROOT;
const scenario = process.env.TMUX_LIFECYCLE_SCENARIO;
assert(root?.startsWith('/srv/devops/scratch/'));
assert(['PUBLICDISPOSE', 'SETUPREFUSAL', 'PARENTLOSS'].includes(scenario));
const sdkPath = process.env.TMUX_GATE_SDK;
assert(sdkPath && path.isAbsolute(sdkPath) && fs.statSync(sdkPath).isFile());
const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdkPath), '../package.json'), 'utf8'));
assert.equal(pkg.name, '@earendil-works/pi-coding-agent');
assert.equal(pkg.version, '1.4.0');
const { ProjectTrustStore } = await import(pathToFileURL(sdkPath).href);
new ProjectTrustStore(path.join(root, 'agent')).set(path.join(root, 'workspace'), true);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const trusted = { rootDir: path.join(root, 'workers'), agentDir: path.join(root, 'agent'),
  sdkModulePath: sdkPath, fixtureNodeImportPath: path.join(root, 'no-network.mjs'),
  fixtureExtensionPaths: [path.join(root, 'provider.ts'), path.join(root, 'observer.ts')] };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (scenario === 'PARENTLOSS') {
  const { createTmuxWorker } = await jiti.import(path.join(repo, 'tmux-runner.ts'));
  const worker = await createTmuxWorker({ ...trusted, cwd: path.join(root, 'workspace'),
    modelSpec: 'standalone-fixture/fixed:off', definitionPrompt: 'Synthetic offline gate only.',
    tools: [], disallowedTools: [] });
  // Never serialize the private handle/identity, and never submit a prompt.
  emit({ ready: true, coordinatorPid: process.pid, workerId: worker.workerId, sessionId: worker.sessionId });
  setInterval(() => {}, 1000); // SIGKILL must bypass the runner's normal exit hook.
} else {
  const { createZergControl } = await jiti.import(path.join(repo, 'index.ts'));
  if (scenario === 'SETUPREFUSAL') trusted.sdkModulePath = path.join(root, 'nonexistent-sdk.mjs');
  const control = createZergControl({ mode: { automation: 'automatic', readOnly: false } }, {
    cwd: path.join(root, 'workspace'), trustedTmux: trusted,
  }); // Omitted subagentAdapter deliberately selects the genuine owned native adapter.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      assert(Buffer.byteLength(line) <= 65536);
      const request = JSON.parse(line);
      if (request.action === '__dispose') {
        // Pin the actual public AgentResult before disposal, then re-read the same tuple.
        const before = request.resultQuery ? await control.execute(request.resultQuery) : null;
        if (before) assert(before.ok && before.data.status === 'found');
        const bytes = before ? JSON.stringify(before.data.result) : null;
        control.dispose();
        await control.drain();
        const after = request.resultQuery ? await control.execute(request.resultQuery) : null;
        if (after) {
          assert(after.ok && after.data.status === 'found');
          assert.equal(JSON.stringify(after.data.result), bytes);
        }
        emit({ ok: true, disposed: true, stableResult: before !== null });
        continue; // Stay alive: process-exit cleanup must not mask dispose/drain.
      }
      const response = await control.execute(request);
      assert(Buffer.byteLength(JSON.stringify(response)) <= 262144);
      emit(response);
    }
  } finally { control.dispose(); await control.drain(); }
}
