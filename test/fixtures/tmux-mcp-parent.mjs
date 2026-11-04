// Real public controller for ALL scenarios, including pending-call parent loss.
import { createJiti } from 'jiti';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = process.env.TMUX_GATE_ROOT, scenario = process.env.TMUX_MCP_SCENARIO;
assert(root?.startsWith('/srv/devops/scratch/'));
assert(['NORMAL', 'ABORT', 'PARENTLOSS'].includes(scenario));
const sdk = process.env.TMUX_GATE_SDK;
assert(sdk && path.isAbsolute(sdk) && fs.statSync(sdk).isFile());
const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdk), '../package.json'), 'utf8'));
assert(pkg.name === '@earendil-works/pi-coding-agent' && pkg.version === '1.4.0');
const { ProjectTrustStore } = await import(pathToFileURL(sdk).href);
new ProjectTrustStore(path.join(root, 'agent')).set(path.join(root, 'workspace'), true);
const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createZergControl } = await jiti.import(path.resolve(here, '../../index.ts'));
const control = createZergControl({ mode: { automation: 'automatic', readOnly: false } }, {
  cwd: path.join(root, 'workspace'), trustedTmux: {
    rootDir: path.join(root, 'workers'), agentDir: path.join(root, 'agent'), sdkModulePath: sdk,
    fixtureNodeImportPath: path.join(root, 'no-network.mjs'),
    fixtureExtensionPaths: [path.join(root, 'provider.ts'), path.join(root, 'observer.ts')],
    fixtureMcpCommand: { command: process.execPath, args: ['--import', path.join(root, 'no-network.mjs'), path.join(here, 'tmux-mcp-server.mjs'), root, scenario] },
  },
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    assert(Buffer.byteLength(line) <= 65536);
    const request = JSON.parse(line);
    let response;
    if (request.action === '__dispose') {
      control.dispose(); await control.drain(); response = { ok: true, disposed: true };
    } else response = await control.execute(request);
    const encoded = JSON.stringify(response); assert(Buffer.byteLength(encoded) <= 262144);
    process.stdout.write(encoded + '\n');
  }
} finally { control.dispose(); await control.drain(); }
