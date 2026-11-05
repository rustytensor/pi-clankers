// Public controller from the WORKING TREE, not the installed release.
import { createJiti } from 'jiti';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = process.env.TMUX_GATE_ROOT, sdk = process.env.TMUX_GATE_SDK;
assert(root?.startsWith('/srv/devops/scratch/'));
assert(sdk && path.isAbsolute(sdk) && fs.statSync(sdk).isFile());
const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdk), '../package.json'), 'utf8'));
assert(pkg.name === '@earendil-works/pi-coding-agent' && pkg.version === '1.5.0');
const { ProjectTrustStore } = await import(pathToFileURL(sdk).href);
new ProjectTrustStore(path.join(root, 'agent')).set(path.join(root, 'workspace'), true);
const hostJiti = createJiti(sdk, { fsCache: false });
const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: true, alias: {
  '@earendil-works/pi-tui': hostJiti.esmResolve('@earendil-works/pi-tui'), '@earendil-works/pi-coding-agent': sdk,
} });
const { createZergControl } = await jiti.import(fileURLToPath(new URL('../../index.ts', import.meta.url)));
const control = createZergControl({ mode: { automation: 'automatic', readOnly: false } }, {
  cwd: path.join(root, 'workspace'), trustedTmux: {
    rootDir: path.join(root, 'workers'), agentDir: path.join(root, 'agent'), sdkModulePath: sdk,
    fixtureNodeImportPath: path.join(root, 'no-network.mjs'), fixtureExtensionPaths: [path.join(root, 'provider.ts')],
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
