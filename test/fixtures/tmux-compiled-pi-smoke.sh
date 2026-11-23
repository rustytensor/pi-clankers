#!/usr/bin/env bash
# Run from the checkout root with compiled Pi, npm, Node and tmux on PATH.
# Exercises a packed production install; never prompts a model or reads user auth.
set -euo pipefail
root=$(mktemp -d /tmp/cl-pi.XXXXXXXX)
trap 'rm -rf -- "$root"' EXIT
pkg=$(npm pack --silent --pack-destination "$root")
cd "$root"
npm install --omit=dev --legacy-peer-deps --no-audit --no-fund "./$pkg"
mkdir agent workspace
cat > probe.ts <<'TS'
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { createTmuxWorker } from './node_modules/pi-clankers/tmux-runner.ts';
import { preflightTmuxWorkerPolicy } from './node_modules/pi-clankers/tmux-worker-policy.ts';
export default function(pi) {
  pi.on('session_start', async () => {
    assert.ok(process.versions.bun, 'expected compiled Pi');
    const sdkModulePath = fileURLToPath(createJiti(import.meta.url).esmResolve('@earendil-works/pi-coding-agent'));
    const options = { sdkModulePath, agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(),
      rootDir: fileURLToPath(new URL('./workers', import.meta.url)), modelSpec: 'openai/gpt-6.2-astra:high', fallbackModels: [],
      definitionPrompt: 'Offline startup check', tools: [], disallowedTools: [] };
    const modelSelection = await preflightTmuxWorkerPolicy(sdkModulePath, options);
    const worker = await createTmuxWorker({ ...options, modelSelection });
    try { await worker.inspect(); } finally { assert.equal((await worker.close()).closed, true); }
    writeFileSync('../passed', 'ok');
  });
}
TS
cd workspace
PI_OFFLINE=1 PI_CODING_AGENT_DIR="$root/agent" timeout 60 pi --no-session --no-extensions --no-mcp -e "$root/probe.ts" --mode rpc </dev/null
test -f ../passed
