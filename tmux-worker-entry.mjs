import { createJiti } from 'jiti';

// Child-local only. Suppress automatic catalog/update/download/telemetry work before SDK import.
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PI_TELEMETRY = '0';
process.env.AI_AGENT = 'pi';
process.env.PI_CODING_AGENT = 'true';
process.umask(0o077);

try {
  if (process.argv.length !== 3) throw new Error('Expected one manifest path');
  const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: false, tryNative: true });
  const { readTmuxWorkerManifest } = await jiti.import('./tmux-worker-config.ts');
  const config = await readTmuxWorkerManifest(process.argv[2]);
  process.env.PI_CODING_AGENT_DIR = config.agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = config.sessionDir;
  const { startTmuxWorker } = await jiti.import('./tmux-worker-bootstrap.ts');
  await startTmuxWorker(config);
} catch {
  // Never serialize exceptions, manifest contents, paths, credentials, or nonce to the pane.
  process.stderr.write('Clankers worker could not start or lost its policy.\n');
  process.exit(1);
}
