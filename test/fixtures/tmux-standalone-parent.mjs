// JSON-line harness around the REAL public controller; no replacement adapter.
import { createJiti } from 'jiti';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
const root = process.env.TMUX_GATE_ROOT;
if (!root?.startsWith('/srv/devops/scratch/')) throw Error('Private gate root required');
const sdkPath = process.env.TMUX_GATE_SDK;
if (!sdkPath || !path.isAbsolute(sdkPath) || !fs.statSync(sdkPath).isFile()) throw Error('Absolute TMUX_GATE_SDK file required');
const sdkPackage = JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdkPath), '../package.json'), 'utf8'));
if (sdkPackage.name !== '@earendil-works/pi-coding-agent' || sdkPackage.version !== '1.4.0') throw Error('Pi 1.4.0 SDK required');
const { ProjectTrustStore } = await import(pathToFileURL(sdkPath).href);
// Trust only this gate-owned synthetic workspace in its isolated agentDir.
new ProjectTrustStore(path.join(root, 'agent')).set(path.join(root, 'workspace'), true);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createZergControl } = await jiti.import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.ts'));
const control = createZergControl({ mode: { automation: 'automatic', readOnly: false } }, {
  cwd: path.join(root, 'workspace'),
  trustedTmux: { rootDir: path.join(root, 'workers'), agentDir: path.join(root, 'agent'),
    sdkModulePath: sdkPath,
    fixtureNodeImportPath: path.join(root, 'no-network.mjs'), fixtureExtensionPaths: [path.join(root, 'provider.ts'), path.join(root, 'observer.ts')] },
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 65536) throw Error('Request cap');
    const request = JSON.parse(line);
    if (request.action === '__dispose') {
      control.dispose(); await control.drain();
      process.stdout.write(JSON.stringify({ ok: true, disposed: true }) + '\n'); break;
    }
    const response = await control.execute(request);
    const encoded = JSON.stringify(response);
    if (Buffer.byteLength(encoded) > 262144) throw Error('Response cap');
    process.stdout.write(encoded + '\n');
  }
} finally { control.dispose(); await control.drain(); }
