import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat, open, link, unlink, readFile } from 'node:fs/promises';
import { lstatSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AgentSession, AgentSessionRuntime, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { boundTmuxToolEvidence, type TmuxTelemetry, captureTmuxText, encodeTmuxFrame, parseTmuxRequest, TmuxFrameDecoder, TmuxWorkerLedger, TMUX_FRAME_BYTES, TMUX_TEXT_BYTES, type TmuxRequest } from './tmux-protocol.js';
import { preflightTmuxWorkerConfig, TMUX_LEASE_MS, type TmuxWorkerConfig } from './tmux-worker-config.js';
import { createTmuxWorkerPolicy, type TmuxWorkerPolicy } from './tmux-worker-policy.js';

import { createTmuxMcp } from './tmux-mcp.js';
import { createWriteEvidence } from './agent-results.js';

type OwnedFile = { path: string; ino: number; dev: number };
async function parentIdentity(pid: number): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  if (text.length > 8192) throw new Error('Invalid parent process');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  if (fields.length < 20 || fields[0] === 'Z') throw new Error('Worker parent exited');
  return `${pid}:${fields[19]}`;
}
/** Linux, same UID, trusted extensions: ownership policy, not a security sandbox. */
export async function startTmuxWorker(input: TmuxWorkerConfig): Promise<void> {
  const config = await preflightTmuxWorkerConfig(input);
  if (process.platform !== 'linux' || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Worker requires Linux interactive TTY');
  process.umask(0o077);
  process.chdir(config.cwd);
  const parent = await parentIdentity(config.parentPid);
  const owned: OwnedFile[] = [];
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let runtime: AgentSessionRuntime | undefined;
  let session: AgentSession | undefined;
  let policy: TmuxWorkerPolicy | undefined;
  let ledger: TmuxWorkerLedger | undefined;
  let context: ExtensionContext | undefined;
  let stopping = false, armed = false;
  let startupPhase = 'sdk-import';
  let lease = performance.now();
  let watcher: NodeJS.Timeout | undefined;
  let emergency: NodeJS.Timeout | undefined;
  let finalText = { text: '', clipped: false };
  let partialText = { text: '', clipped: false };
  let lastStop: string | undefined;
  let writeEvidence = createWriteEvidence(config.cwd, undefined);
  let evidenceFailed = false;
  const captureEvidence = () => {
    if (evidenceFailed) return 'unavailable' as const;
    try { return boundTmuxToolEvidence(writeEvidence.snapshot()); }
    catch { evidenceFailed = true; return 'unavailable' as const; }
  };
  let baselineTokens: ReturnType<AgentSession['getSessionStats']>['tokens'] | undefined;
  let startedAt = performance.now();
  const resetCapture = () => {
    policy!.beginJob();
    finalText = { text: '', clipped: false }; partialText = { text: '', clipped: false }; lastStop = undefined;
    writeEvidence = createWriteEvidence(config.cwd, undefined); evidenceFailed = false;
    baselineTokens = undefined; startedAt = performance.now();
    try { baselineTokens = session?.getSessionStats().tokens; } catch { /* Optional telemetry stays unknown. */ }
  };
  const captureTelemetry = (): TmuxTelemetry => {
    const telemetry: { tokens: TmuxTelemetry['tokens']; context_percent: number | null; elapsed_seconds: number | null } = {
      tokens: { input: null, output: null, cache_read: null, cache_write: null }, context_percent: null,
      elapsed_seconds: Math.max(0, performance.now() - startedAt) / 1000,
    };
    try {
      const after = session!.getSessionStats().tokens;
      const delta = (key: keyof typeof after) => baselineTokens && Number.isFinite(after[key]) && Number.isFinite(baselineTokens[key]) && after[key] >= baselineTokens[key] && after[key] <= Number.MAX_SAFE_INTEGER ? after[key] - baselineTokens[key] : null;
      telemetry.tokens = { input: delta('input'), output: delta('output'), cache_read: delta('cacheRead'), cache_write: delta('cacheWrite') };
      const percent = session!.getContextUsage()?.percent;
      telemetry.context_percent = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= Number.MAX_SAFE_INTEGER ? percent : null;
    } catch { /* Optional telemetry stays unknown. */ }
    return telemetry;
  };
  const cleanupSync = () => {
    for (const resource of owned) {
      try {
        const actual = lstatSync(resource.path);
        if (actual.ino === resource.ino && actual.dev === resource.dev) unlinkSync(resource.path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.exitCode = 1; }
    }
  };
  const mcp = createTmuxMcp(config, () => {
    if (!armed || stopping || !ledger?.snapshot().job) throw new Error('Worker MCP call outside active job');
    policy!.assertCurrent();
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true; armed = false; ledger?.invalidate();
    if (watcher) clearInterval(watcher);
    for (const socket of sockets) socket.destroy();
    server?.close();
    cleanupSync();
    // Public shutdown is the normal path; self-exit is only a bounded fail-closed fallback.
    emergency = setTimeout(() => { cleanupSync(); process.exit(1); }, 5000);
    emergency.unref();
    // Abort MCP ownership immediately, and reap it before requesting process shutdown.
    const drained = mcp.dispose();
    if (session && !session.isIdle) void session.abort().catch(() => { process.exitCode = 1; });
    void drained.finally(() => {
      if (context) context.shutdown();
      else { void runtime?.dispose(); process.exitCode = 1; }
    });
  };
  process.once('exit', cleanupSync);
  process.once('SIGTERM', shutdown);
  process.once('SIGHUP', shutdown);
  // Supervise setup as well as the ready/idle lifetime; a stuck factory gets no orphan lease.
  let checking = false;
  watcher = setInterval(() => {
    if (checking || stopping) return;
    checking = true;
    void parentIdentity(config.parentPid).then(value => {
      if (value !== parent || performance.now() - lease > TMUX_LEASE_MS || (armed && runtime?.session !== session)) shutdown();
      else if (armed) policy!.assertCurrent();
    }).catch(shutdown).finally(() => { checking = false; });
  }, 1000);
  const requireIdle = () => !!session && session.isIdle && session.pendingMessageCount === 0 && ledger?.snapshot().phase === 'idle';
  const extension: ExtensionFactory = pi => {
    mcp.register(pi); // Definitions exist before session creation, readiness and policy pinning.
    pi.registerCommand('clankers-control', {
      description: 'Human control: idle-only takeover | return; close also stops busy work',
      handler: async (args, ctx) => {
        context = ctx;
        if (!armed || stopping || !ledger) { ctx.ui.notify('Worker control refused: unavailable.', 'warning'); return; }
        if (args.trim() === 'close') { ctx.ui.notify('Worker shutdown requested; unfinished work has no settled result.', 'info'); shutdown(); return; }
        if (!requireIdle()) { ctx.ui.notify('Worker control refused: not idle.', 'warning'); return; }
        const target = args.trim() === 'takeover' ? 'human' : args.trim() === 'return' ? 'coordinator' : undefined;
        if (!target) { ctx.ui.notify('Use takeover, return, or close.', 'warning'); return; }
        const refusal = ledger.humanOwnership(target, ledger.snapshot().identity);
        ctx.ui.notify(refusal ? `Worker control refused: ${refusal}.` : `Worker ownership: ${target}.`, refusal ? 'warning' : 'info');
        ctx.ui.setStatus('clankers-worker', `Clankers worker · ${ledger.snapshot().ownership}`);
      },
    });
    pi.on('session_start', (event, ctx) => {
      if (context || event.reason !== 'startup' || ctx.mode !== 'tui' || !ctx.hasUI) { shutdown(); return; }
      context = ctx;
      ctx.ui.setStatus('clankers-worker', 'Clankers worker · coordinator');
    });
    pi.on('session_shutdown', async () => { shutdown(); await mcp.dispose(); });
    pi.on('session_before_switch', () => { shutdown(); return { cancel: true }; });
    pi.on('session_before_fork', () => { shutdown(); return { cancel: true }; });
    pi.on('session_before_tree', () => { shutdown(); return { cancel: true }; });
    pi.on('session_before_compact', () => ({ cancel: true }));
    pi.on('cache_warming_decision', () => ({ action: 'stop' }));
    pi.on('model_select', () => { if (armed) shutdown(); });
    pi.on('thinking_level_select', () => { if (armed) shutdown(); });
    pi.on('user_bash', () => ({ result: { output: 'Shell input is disabled in a delegated worker; use declared tools in a human-owned task.', exitCode: 1, cancelled: false, truncated: false } }));
    pi.on('input', (event, ctx) => {
      // Return the gate result rather than throwing into Pi's recoverable event dispatcher.
      try {
        if (!armed || stopping || !ledger || !session || event.source !== 'interactive' || ledger.snapshot().ownership !== 'human' || !requireIdle() || !event.text.trim() || Buffer.byteLength(event.text) > TMUX_TEXT_BYTES || event.images?.length) {
          ctx.ui.notify('Human input refused: take ownership while idle; text only.', 'warning');
          return { action: 'handled' };
        }
        policy!.assertCurrent();
        ledger.beginHuman(`human-${randomUUID()}`, ledger.snapshot().identity);
        resetCapture();
        return { action: 'continue' };
      } catch { shutdown(); return { action: 'handled' }; }
    });
    pi.on('tool_call', event => {
      if (!armed || stopping || !ledger?.snapshot().job || !config.tools.includes(event.toolName) || config.disallowedTools.includes(event.toolName)) return { block: true, reason: 'Worker tool policy refused this call' };
      try { policy!.assertCurrent(); } catch { return { block: true, reason: 'Worker policy invalidated' }; }
      return undefined;
    });
  };
  try {
    const sdk = await import(pathToFileURL(config.sdkModulePath).href) as typeof import('@earendil-works/pi-coding-agent');
    for (const name of ['createAgentSessionServices', 'createAgentSessionFromServices', 'createAgentSessionRuntime', 'InteractiveMode', 'DefaultPackageManager', 'DefaultResourceLoader', 'ModelRuntime', 'SettingsManager', 'SessionManager', 'ProjectTrustStore', 'hasTrustRequiringProjectResources'] as const) {
      if (typeof sdk[name] !== 'function') throw new Error('Unsupported worker SDK');
    }
    startupPhase = 'resource-policy';
    policy = await createTmuxWorkerPolicy(sdk, config, extension, shutdown);
    const selection = policy.selection;
    const model = policy.services.modelRuntime.getPhysicalModel(selection.provider, selection.modelId);
    if (!model) throw new Error('Exact physical worker model is unavailable');
    let created = false;
    startupPhase = 'session-create';
    runtime = await sdk.createAgentSessionRuntime(async ({ sessionManager }) => {
      if (created || stopping) { shutdown(); throw new Error('Worker session replacement is unsupported'); }
      created = true;
      const result = await sdk.createAgentSessionFromServices({ services: policy!.services, sessionManager, model, thinkingLevel: selection.thinkingLevel, scopedModels: [{ model, thinkingLevel: selection.thinkingLevel }], tools: [...config.tools], excludeTools: [...config.disallowedTools] });
      if (result.modelFallbackMessage) throw new Error('Worker model fallback refused');
      return { ...result, services: policy!.services, diagnostics: policy!.services.diagnostics };
    }, { cwd: config.cwd, agentDir: config.agentDir, sessionManager: sdk.SessionManager.create(config.cwd, config.sessionDir) });
    session = runtime.session;
    ledger = new TmuxWorkerLedger({ workerId: config.workerId, generation: config.generation, ownerNonce: config.ownerNonce, sessionId: session.sessionId, epoch: 0 });
    startupPhase = 'policy-pin';
    policy.pin(session, () => armed && !stopping && !!ledger?.snapshot().job);
    session.subscribe(event => {
      if (stopping || !ledger) return;
      if (ledger.snapshot().job && !evidenceFailed && (event.type === 'tool_execution_start' || event.type === 'tool_execution_end')) {
        try { writeEvidence.event(event); } catch { evidenceFailed = true; }
      }
      if ((event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant' && ledger.snapshot().job) {
        // A new assistant message is not a new job: tool cancellation can append an empty error.
        if (event.type === 'message_start') { finalText = { text: '', clipped: false }; lastStop = undefined; }
        ledger.observe(ledger.snapshot().job!, event.message.content);
        const captured = captureTmuxText(event.message.content);
        // An abort may finalize with empty content: retain only this message's bounded streamed partial.
        if (!(event.type !== 'message_start' && event.message.stopReason === 'aborted' && !captured.text && !captured.clipped)) finalText = captured;
        if (captured.text || captured.clipped) partialText = captured;
        if (event.type === 'message_end') lastStop = event.message.stopReason;
      } else if (event.type === 'agent_settled') {
        const job = ledger.snapshot().job;
        if (!job) { shutdown(); return; }
        try {
          policy!.assertCurrent();
          const outcome = event.aborted || lastStop === 'aborted' ? 'aborted' : lastStop === 'stop' ? 'completed' : 'failed';
          // Only unsuccessful jobs may fall back to their own bounded observed partial.
          // resetCapture clears it at every coordinator/human job admission, never on steering.
          const text = outcome !== 'completed' && !finalText.text && !finalText.clipped ? partialText : finalText;
          ledger.settle(job, outcome, text.text, text.clipped, { telemetry: captureTelemetry(), toolEvidence: captureEvidence() });
        }
        catch { shutdown(); }
      }
    });
    startupPhase = 'theme-init';
    if (typeof sdk.initTheme !== 'function') throw new Error('Unsupported worker theme API');
    sdk.initTheme(policy.services.settingsManager.getTheme(), false);
    startupPhase = 'tui-init';
    const mode = new sdk.InteractiveMode(runtime, { tuiMode: 'regular' });
    await mode.init();
    const readyContext = context as ExtensionContext | undefined; // Assigned by the public session_start callback during init().
    if (!readyContext || stopping || readyContext.mode !== 'tui' || !readyContext.hasUI || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Worker interactive context missing');
    policy.assertCurrent();
    const dispatch = (request: TmuxRequest) => {
      if (!session || !ledger || stopping) return;
      if (request.action === 'prompt' || request.action === 'steer') {
        if (request.action === 'prompt') resetCapture();
        // Custom messages retain their explicit source in the visible transcript and model context.
        const content = JSON.stringify({ source: 'coordinator', authority: 'delegated-not-human-authorization', text: request.text });
        void session.sendCustomMessage({ customType: 'clankers-coordinator', content, display: true, details: { source: 'coordinator' } }, { triggerTurn: true, deliverAs: 'steer' }).catch(shutdown);
      } else if (request.action === 'cancel') void session.abort().catch(shutdown);
      else if (request.action === 'close') setImmediate(shutdown);
    };
    startupPhase = 'socket-ready';
    server = createServer(socket => {
      if (!armed || stopping || sockets.size >= 8) { socket.destroy(); return; }
      sockets.add(socket);
      const decoder = new TmuxFrameDecoder();
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
      socket.on('end', () => { try { decoder.finish(); } catch { socket.destroy(); } });
      socket.on('data', chunk => {
        try {
          for (const value of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
            policy!.assertCurrent();
            const request = parseTmuxRequest(value);
            // A stalled reader cannot consume a mutation before capacity is available.
            if (socket.writableLength + TMUX_FRAME_BYTES > 2 * TMUX_FRAME_BYTES) { socket.destroy(); return; }
            if (request.action === 'prompt' && ledger!.snapshot().phase === 'idle' && !requireIdle()) { shutdown(); return; }
            const receipt = ledger!.accept(request);
            try { socket.write(encodeTmuxFrame(receipt)); } catch { shutdown(); return; }
            if (receipt.status !== 'refused') { lease = performance.now(); dispatch(request); }
          }
        } catch { socket.destroy(); }
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(config.socketPath, () => { server!.removeListener('error', reject); resolve(); }); });
    server.on('error', shutdown);
    await chmod(config.socketPath, 0o600);
    const socketStat = await lstat(config.socketPath);
    owned.push({ path: config.socketPath, ino: socketStat.ino, dev: socketStat.dev });
    // Arm supervision before publishing readiness; idle supervision never invokes the model.
    armed = true;
    lease = performance.now();
    const temporary = `${config.readyPath}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    const temporaryStat = await file.stat();
    owned.push({ path: temporary, ino: temporaryStat.ino, dev: temporaryStat.dev });
    try {
      await file.writeFile(JSON.stringify({ version: 1, mode: 'tui', hasUI: true, stdinTTY: true, stdoutTTY: true, identity: ledger.snapshot().identity, pid: process.pid, model: `${selection.provider}/${selection.modelId}`, thinkingLevel: session.thinkingLevel, ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}), maxTurns: config.maxTurns ?? null, tools: session.getActiveToolNames(), socketPath: config.socketPath }));
      await file.sync();
    } finally { await file.close(); }
    // Atomic no-replace publication: never overwrite an unexpected ready file.
    await link(temporary, config.readyPath);
    owned.push({ path: config.readyPath, ino: temporaryStat.ino, dev: temporaryStat.dev });
    await unlink(temporary);
    // run() is the public input loop, on the same runtime initialized above.
    startupPhase = 'interactive';
    await mode.run();
  } catch {
    // Fixed phase only: never persist exception text, credentials, or manifest contents.
    try {
      const diagnostic = await open(`${config.runDir}/startup-failure.json`, 'wx', 0o600);
      try { await diagnostic.writeFile(JSON.stringify({ version: 1, phase: startupPhase })); }
      finally { await diagnostic.close(); }
    } catch { /* Diagnostic failure cannot block owned cleanup. */ }
    shutdown();
    await mcp.dispose();
    if (runtime) await runtime.dispose().catch(() => { process.exitCode = 1; });
    cleanupSync();
    if (emergency) clearTimeout(emergency);
    throw new Error('Worker bootstrap failed');
  }
}
