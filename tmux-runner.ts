import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rmdir, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { parseTmuxWorkerConfig, preflightTmuxWorkerConfig, parseTmuxModelSpec, type TmuxWorkerConfig } from './tmux-worker-config.js';
import {
  encodeTmuxFrame, parseTmuxIdentity, parseTmuxJobIdentity, parseTmuxRequest,
  parseTmuxResponse, sameTmuxIdentity, TmuxFrameDecoder, TMUX_MAX_JOBS,
  type TmuxIdentity, type TmuxJobIdentity, type TmuxJobResult,
  type TmuxRequest, type TmuxResponse, type TmuxSnapshot,
} from './tmux-protocol.js';

/** Trusted programmatic launch input, never accept SDK/fixture paths from model JSON. */
export type TmuxLaunchOptions = Omit<TmuxWorkerConfig,
  'version' | 'workerId' | 'generation' | 'ownerNonce' | 'runDir' | 'socketPath' |
  'readyPath' | 'sessionDir' | 'parentPid'> & {
    /** Trusted parent capability only. Never serialized into the worker manifest. */
    assertAdmission?: () => void;
    fallbackModels?: readonly string[];
    workerId?: string;
    rootDir?: string;
    /** Trusted fixture preload only; never a manifest field or model-controlled input. */
    fixtureNodeImportPath?: string;
  };
export interface TmuxWorkerHandle {
  /** PRIVATE transport credential. Never serialize this getter into public state. */
  readonly identity: TmuxIdentity;
  readonly workerId: string;
  readonly sessionId: string;
  readonly attachCommand: string;
  readonly isClosed: boolean;
  /** PRIVATE transport snapshot (including nonce); project/redact before publication. */
  inspect(expectedJobId?: string): Promise<TmuxSnapshot>;
  /** PRIVATE result includes transport identity: redact nonce before publication.
   * Caller supplies three fresh canonical IDs per task, not worker-lifetime IDs. */
  prompt(input: { jobId: string; runId: string; taskId: string; text: string }): Promise<TmuxJobResult>;
  /** PRIVATE receipt, requested is not delivered or settled. */
  steer(jobId: string, text: string): Promise<TmuxResponse>;
  /** PRIVATE receipt, requested is not proof of cancellation. */
  cancel(jobId: string): Promise<TmuxResponse>;
  close(): Promise<{ closed: boolean; errors: string[] }>;
}

// Fixed finite limits: no caller can disable supervision by supplying Infinity/zero.
const BOOT_MS = 30_000;
const REQUEST_MS = 2_000;
const COMMAND_MS = 3_000;
const HEARTBEAT_MS = 2_000;
const SETTLEMENT_MS = 60 * 60 * 1000;
const GRACE_MS = 2_000;
const MAX_QUEUE = 8;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const uid = () => process.getuid!();
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

interface ProcessIdentity { pid: number; start: string; group: number; parent: number; }
function processIdentity(pid: number): ProcessIdentity | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
  } catch (error) { if (missing(error)) return null; throw error; }
}
function alive(owned: ProcessIdentity | null): boolean {
  return owned !== null && processIdentity(owned.pid)?.start === owned.start;
}
function signalOwned(owned: ProcessIdentity | null, signal: NodeJS.Signals): void {
  if (!owned || !alive(owned)) return;
  // Only a saved, still-live group leader can authorize a process-group signal.
  const target = owned.group === owned.pid ? -owned.pid : owned.pid;
  try { process.kill(target, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
async function waitDead(owned: ProcessIdentity | null, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  while (alive(owned) && performance.now() < until) await pause(40);
  return !alive(owned);
}
async function privateArtifact(path: string, kind: 'file' | 'socket' | 'directory'): Promise<void> {
  const stat = await lstat(path);
  const mode = kind === 'directory' ? 0o700 : 0o600;
  if (stat.uid !== uid() || (stat.mode & 0o777) !== mode || stat.isSymbolicLink() ||
      !(kind === 'directory' ? stat.isDirectory() : kind === 'socket' ? stat.isSocket() : stat.isFile())) {
    throw new Error('Unsafe owned tmux artifact');
  }
}
async function readReady(path: string): Promise<Record<string, unknown>> {
  await privateArtifact(path, 'file');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (stat.size > 16_384 || stat.uid !== uid() || (stat.mode & 0o777) !== 0o600) throw new Error('Invalid tmux ready artifact');
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error('Oversized tmux ready artifact');
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new Error('Malformed tmux ready artifact'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tmux ready');
    return value as Record<string, unknown>;
  } finally { await fd.close(); }
}

/** Safe launch failure proof; never retains the original exception or child output. */
export class TmuxLaunchError extends Error {
  readonly cleanup: Readonly<{ closed: boolean; errors: readonly string[] }>;
  constructor(closed: boolean, hasErrors: boolean) {
    super('Tmux worker launch failed.');
    this.name = 'TmuxLaunchError';
    this.cleanup = Object.freeze({ closed, errors: Object.freeze(hasErrors ? ['Owned worker cleanup unconfirmed.'] : []) });
  }
}

/** Linux-only first standalone worker. No reconnect, resume, fallback SDK or shell transport. */
export async function createTmuxWorker(options: TmuxLaunchOptions): Promise<TmuxWorkerHandle> {
  try { return await launchTmuxWorker(options); }
  catch (error) {
    if (error instanceof TmuxLaunchError) throw error;
    throw new TmuxLaunchError(false, true);
  }
}

async function launchTmuxWorker(options: TmuxLaunchOptions): Promise<TmuxWorkerHandle> {
  const parentAdmission = options.assertAdmission;
  let firstPromptAccepted = false;
  const assertAdmission = () => {
    try { if (!firstPromptAccepted) parentAdmission?.(); }
    catch { throw new Error('Tmux parent admission revoked'); }
  };
  assertAdmission();
  // Startup only: never wrap cleanup, reaping, close requests or cleanup commands.
  const admitted = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertAdmission();
    const result = await operation();
    assertAdmission();
    return result;
  };
  if (process.platform !== 'linux' || !process.getuid) throw new Error('Tmux worker requires Linux /proc supervision');
  if (options.fallbackModels !== undefined && !options.modelSelection) throw new Error('Fallback selection must be frozen before launch');
  const base = options.rootDir ?? join(options.agentDir, 'zerg-swarm', 'tmux');
  if (!isAbsolute(base) || /[\0\r\n]/.test(base)) throw new Error('Invalid tmux root');
  await admitted(() => mkdir(base, { recursive: true, mode: 0o700 }));
  if (await admitted(() => realpath(base)) !== base) throw new Error('Tmux root must be canonical');
  await admitted(() => privateArtifact(base, 'directory'));
  // Capture the newly owned directory before any post-await admission fence.
  assertAdmission();
  const runDir = await mkdtemp(join(base, 'worker-'));
  let earlyDirectory: { dev: number; ino: number } | undefined;
  try {
    const stat = await lstat(runDir);
    earlyDirectory = { dev: stat.dev, ino: stat.ino };
    assertAdmission();
    await admitted(() => chmod(runDir, 0o700));
  } catch {
    // No child or session artifact exists yet. Cleanup must not require admission.
    let removed = false;
    try {
      const current = await lstat(runDir);
      if (earlyDirectory && current.dev === earlyDirectory.dev && current.ino === earlyDirectory.ino &&
          current.uid === uid() && current.isDirectory() && !current.isSymbolicLink()) {
        await rmdir(runDir); removed = true;
      }
    } catch (error) { removed = missing(error); }
    throw new TmuxLaunchError(true, !removed);
  }
  const socketPath = join(runDir, 'control.sock');
  const serverSocket = join(runDir, 'tmux.sock');
  const readyPath = join(runDir, 'ready.json');
  const manifestPath = join(runDir, 'config.json');
  const sessionDir = join(runDir, 'sessions');
  const entry = fileURLToPath(new URL('./tmux-worker-entry.mjs', import.meta.url));
  let server: ChildProcess | undefined;
  let serverIdentity: ProcessIdentity | null = null;
  let serverPid: number | undefined;
  let paneIdentity: ProcessIdentity | null = null;
  let identity: TmuxIdentity | undefined;
  let pane = '';
  let serverFailed = false;
  let serverSocketOwned = false;
  let closed = false;
  let closing: Promise<{ closed: boolean; errors: string[] }> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let heartbeatPending = false;
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let activeJob: TmuxJobIdentity | null = null;
  const jobs = new Map<string, TmuxJobIdentity>();
  const runs = new Set<string>();
  const tasks = new Set<string>();
  const env: NodeJS.ProcessEnv = { ...process.env, SHELL: '/bin/sh' };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const clients = new Set<ChildProcess>();
  const ownedArtifacts = new Map<string, { dev: number; ino: number }>();
  async function rememberArtifact(path: string): Promise<void> {
    const s = await lstat(path); ownedArtifacts.set(path, { dev: s.dev, ino: s.ino });
  }
  async function command(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('tmux', ['-S', serverSocket, '-f', '/dev/null', ...args], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      clients.add(child);
      let output = ''; let settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) child.kill('SIGKILL');
        clients.delete(child);
        error ? reject(error) : resolve(output.trim());
      };
      const timer = setTimeout(() => finish(new Error('Tmux command timeout')), COMMAND_MS);
      child.stdout!.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(output) + chunk.length > 4096) finish(new Error('Tmux command output limit'));
        else output += chunk.toString('utf8');
      });
      child.once('error', () => finish(new Error('Unable to execute tmux')));
      child.once('close', code => finish(code === 0 ? undefined : new Error('Tmux command failed')));
    });
  }
  function healthy(): void {
    if (closed || serverFailed || !alive(serverIdentity) || !alive(paneIdentity)) throw new Error('Owned tmux worker is unavailable');
  }
  async function exchange(request: TmuxRequest): Promise<TmuxResponse> {
    await privateArtifact(socketPath, 'socket');
    const owned = ownedArtifacts.get(socketPath);
    const current = await lstat(socketPath);
    if (!owned || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new Error('Owned tmux control socket replaced; not reconnecting');
    }
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const decoder = new TmuxFrameDecoder();
      let done = false;
      const finish = (error?: Error, response?: TmuxResponse) => {
        if (done) return; done = true; clearTimeout(timer); socket.destroy();
        error ? reject(error) : resolve(response!);
      };
      const timer = setTimeout(() => finish(new Error('Tmux response timeout; mutation outcome uncertain, not replayed')), REQUEST_MS);
      socket.once('connect', () => {
        try {
          if (request.action === 'prompt') assertAdmission();
          socket.write(encodeTmuxFrame(request));
        } catch { finish(new Error('Tmux prompt admission revoked')); }
      });
      socket.on('data', (chunk: Buffer) => {
        try {
          const frames = decoder.push(chunk);
          if (!frames.length) return;
          if (frames.length !== 1) throw new Error('Unexpected tmux response count');
          decoder.finish();
          finish(undefined, parseTmuxResponse(frames[0], request));
        } catch { finish(new Error('Invalid tmux response; mutation not replayed')); }
      });
      socket.once('error', () => finish(new Error('Tmux channel failed; mutation not replayed')));
      socket.once('close', () => { if (!done) finish(new Error('Tmux channel closed before response')); });
    });
  }
  function send(action: TmuxRequest['action'], expectedJobId: string | null = null,
    text: string | null = null, job: TmuxJobIdentity | null = null, forClose = false): Promise<TmuxResponse> {
    if (queued >= MAX_QUEUE) return Promise.reject(new Error('Tmux request queue full'));
    if (closing && !forClose) return Promise.reject(new Error('Tmux worker closing'));
    // Pin at submission: queueing must not silently adopt a newer ownership epoch.
    const request = parseTmuxRequest({ version: 1, requestId: randomUUID(), identity,
      action, expectedJobId, text, job });
    queued++;
    const result = tail.then(async () => {
      healthy();
      const response = await exchange(request);
      for (const reported of [response.snapshot.job, response.snapshot.result?.identity]) {
        if (!reported || reported.source !== 'coordinator') continue;
        const submitted = jobs.get(reported.jobId);
        if (!submitted || !sameTmuxIdentity(reported, submitted) || reported.runId !== submitted.runId ||
            reported.taskId !== submitted.taskId || reported.source !== submitted.source) {
          throw new Error('Unknown or mismatched coordinator job tuple');
        }
      }
      if (response.status === 'requested' && (action === 'steer' || action === 'cancel') &&
          (response.snapshot.job?.jobId !== expectedJobId || response.snapshot.job?.source !== 'coordinator')) {
        throw new Error('Mismatched requested tmux job');
      }
      const next = response.snapshot.identity;
      if (response.status === 'refused' && response.reason === 'stale_identity') {
        if (next.epoch < identity!.epoch || !sameTmuxIdentity({ ...next, epoch: identity!.epoch }, identity!)) {
          throw new Error('Invalid ownership epoch update');
        }
        identity = next; // Authenticated same session only. Caller must explicitly resubmit intent.
      }
      return response;
    });
    tail = result.then(() => undefined, () => undefined).finally(() => { queued--; });
    // Channel failure is terminal, not an excuse to retarget/replay uncertain mutations.
    void result.catch(() => { if (!closing) void close(); });
    return result;
  }
  async function inspect(expectedJobId?: string): Promise<TmuxSnapshot> {
    const response = await send('show', expectedJobId ?? null);
    // send authenticated the exact worker and any newer epoch; show has no mutation to replay.
    if (response.status === 'refused' && response.reason !== 'stale_identity') {
      throw new Error(`Tmux inspection refused: ${response.reason}`);
    }
    return response.snapshot;
  }
  function exitCleanup(): void {
    // Synchronous parent exit fallback. Child also checks parentPid and a lease.
    try { signalOwned(paneIdentity, 'SIGKILL'); } catch { /* process is exiting */ }
    try { signalOwned(serverIdentity, 'SIGKILL'); } catch { /* broker observes parent disconnect */ }
    // Leave the broker alive to observe IPC disconnect and reap its exact child.
  }
  function close(): Promise<{ closed: boolean; errors: string[] }> {
    if (closing) return closing;
    closing = (async () => {
      const errors: string[] = [];
      if (heartbeat) clearInterval(heartbeat);
      // Drain at most the bounded queue; each request has a finite deadline.
      await tail;
      if (identity && !serverFailed && alive(paneIdentity) && alive(serverIdentity)) {
        try {
          const observed = await send('show', null, null, null, true);
          // A validated stale-epoch show is still a safe snapshot for this explicit close.
          // Send close once with the learned epoch; never retry a refused/uncertain mutation.
          if (observed.status !== 'refused' || observed.reason === 'stale_identity') {
            const receipt = await send('close', observed.snapshot.job?.jobId ?? null, null, null, true);
            if (receipt.status === 'refused') errors.push(`Close refused: ${receipt.reason}`);
          } else errors.push(`Close inspection refused: ${observed.reason}`);
        } catch { errors.push('Graceful close channel unavailable'); }
      }
      await waitDead(paneIdentity, GRACE_MS);
      try { signalOwned(paneIdentity, 'SIGTERM'); } catch { errors.push('Unable to terminate owned pane'); }
      if (!await waitDead(paneIdentity, GRACE_MS)) {
        try { signalOwned(paneIdentity, 'SIGKILL'); } catch { errors.push('Unable to kill owned pane'); }
        await waitDead(paneIdentity, GRACE_MS);
      }
      // Never kill-server: retain and signal only the foreground server we spawned.
      try { signalOwned(serverIdentity, 'SIGTERM'); } catch { errors.push('Unable to terminate owned server'); }
      if (!await waitDead(serverIdentity, GRACE_MS)) {
        try { signalOwned(serverIdentity, 'SIGKILL'); } catch { errors.push('Unable to kill owned server'); }
        await waitDead(serverIdentity, GRACE_MS);
      }
      // Disconnect also covers startup failures before the broker reported a server PID.
      if (server?.connected) server.disconnect();
      if (server && server.exitCode === null && server.signalCode === null) {
        await Promise.race([new Promise<void>(resolve => server!.once('exit', () => resolve())), pause(GRACE_MS + 500)]);
      }
      for (const client of clients) client.kill('SIGKILL');
      closed = !alive(paneIdentity) && !alive(serverIdentity) &&
        (!server || server.exitCode !== null || server.signalCode !== null || server.pid === undefined);
      if (!closed) errors.push('Owned processes did not exit within cleanup deadline');
      if (closed) {
        process.removeListener('exit', exitCleanup);
        // Only exact registered scratch artifacts; session JSONL and directories survive.
        for (const [path, owned] of ownedArtifacts) {
          try {
            const now = await lstat(path);
            if (now.dev !== owned.dev || now.ino !== owned.ino || now.uid !== uid() || now.isSymbolicLink()) {
              errors.push('Replaced artifact preserved'); continue;
            }
            await unlink(path);
          } catch (error) { if (!missing(error)) errors.push('Owned artifact cleanup failed'); }
        }
      }
      return { closed, errors };
    })();
    return closing;
  }

  try {
    if (Buffer.byteLength(serverSocket) > 100 || Buffer.byteLength(socketPath) > 100) throw new Error('Tmux UNIX socket path too long');
    await admitted(() => mkdir(sessionDir, { mode: 0o700 }));
    const config = parseTmuxWorkerConfig({
      version: 1, workerId: options.workerId ?? `worker-${randomUUID()}`, generation: randomUUID(),
      ownerNonce: randomBytes(32).toString('hex'), cwd: options.cwd, agentDir: options.agentDir,
      runDir, sessionDir, socketPath, readyPath, sdkModulePath: options.sdkModulePath,
      parentPid: process.pid, modelSpec: options.modelSpec, ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }), definitionPrompt: options.definitionPrompt,
      tools: options.tools, disallowedTools: options.disallowedTools,
      ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
      ...(options.fixtureExtensionPaths ? { fixtureExtensionPaths: options.fixtureExtensionPaths } : {}),
      ...(options.fixtureMcpCommand ? { fixtureMcpCommand: options.fixtureMcpCommand } : {}),
    });
    await admitted(() => preflightTmuxWorkerConfig(config));
    const fixtureImport = options.fixtureNodeImportPath;
    if (fixtureImport !== undefined) {
      if (typeof fixtureImport !== 'string' || !isAbsolute(fixtureImport) || /[\0\r\n]/.test(fixtureImport) ||
          await admitted(() => realpath(fixtureImport)) !== fixtureImport || !(await admitted(() => lstat(fixtureImport))).isFile()) {
        throw new Error('Fixture Node import must be an absolute canonical regular file');
      }
    }
    const childArgv = [process.execPath, ...(fixtureImport === undefined ? [] : ['--import', fixtureImport]), entry, manifestPath];
    const expectedPolicy = parseTmuxModelSpec(config.modelSpec);
    if (!isAbsolute(config.sdkModulePath) || !(await admitted(() => lstat(config.sdkModulePath))).isFile() ||
        !(await admitted(() => lstat(entry))).isFile()) throw new Error('Unsupported SDK/entry layout');
    await admitted(() => readFile('/proc/self/stat', 'utf8')); // Reject platforms without process identity support.
    await admitted(async () => {
      const fd = await open(manifestPath, 'wx', 0o600);
      try {
        // Register ownership before a revocation can throw; closing fd is unconditional.
        await rememberArtifact(manifestPath);
        assertAdmission();
        await fd.writeFile(JSON.stringify(config));
      } finally { await fd.close(); }
    });
    // Small owned broker keeps a parent-death guard armed even before a pane exists.
    // IPC disconnect (including SIGKILL of the parent) terminates its exact child;
    // no process-name matching, inherited tmux server, shell, or global kill-server.
    const broker = `
      const {spawn}=require('node:child_process');
      const fs=require('node:fs');
      const child=spawn('tmux',['-D','-S',process.argv[1],'-f','/dev/null'],{detached:true,stdio:'ignore'});
      let timer, ownedSocket, ownedManifest;
      const stop=()=>{ if(timer)return; child.kill('SIGTERM'); timer=setTimeout(()=>child.kill('SIGKILL'),2000); };
      process.on('message',message=>{
        try {
          if(ownedSocket || !message || message.type!=='socket-owned' || !Number.isSafeInteger(message.dev) || !Number.isSafeInteger(message.ino)) return stop();
          const s=fs.lstatSync(process.argv[1]);
          if(!s.isSocket() || s.isSymbolicLink() || s.uid!==process.getuid() || s.dev!==message.dev || s.ino!==message.ino) return stop();
          const m=fs.lstatSync(process.argv[2]);
          if(!Number.isSafeInteger(message.manifestDev) || !Number.isSafeInteger(message.manifestIno) || !m.isFile() || m.isSymbolicLink() || m.uid!==process.getuid() || m.dev!==message.manifestDev || m.ino!==message.manifestIno) return stop();
          ownedSocket={dev:s.dev,ino:s.ino};
          ownedManifest={dev:m.dev,ino:m.ino};
          if(process.connected)process.send({socketOwned:true});else stop();
        } catch { stop(); }
      });
      process.on('disconnect',stop); process.on('error',stop); process.on('SIGTERM',stop); process.on('SIGINT',stop);
      child.on('error',()=>process.exit(1));
      child.on('exit',code=>{
        clearTimeout(timer);
        if(ownedSocket) {
          try {
            const s=fs.lstatSync(process.argv[1]);
            if(s.isSocket() && !s.isSymbolicLink() && s.uid===process.getuid() && s.dev===ownedSocket.dev && s.ino===ownedSocket.ino) fs.unlinkSync(process.argv[1]);
          } catch(error) { if(error.code!=='ENOENT') code=1; }
        }
        if(ownedManifest) {
          try {
            const m=fs.lstatSync(process.argv[2]);
            if(m.isFile() && !m.isSymbolicLink() && m.uid===process.getuid() && m.dev===ownedManifest.dev && m.ino===ownedManifest.ino) fs.unlinkSync(process.argv[2]);
          } catch(error) { if(error.code!=='ENOENT') code=1; }
        }
        process.exit(code===0?0:1);
      });
      if(process.connected)process.send({pid:child.pid});else stop();
    `;
    assertAdmission();
    server = spawn(process.execPath, ['-e', broker, serverSocket, manifestPath], {
      detached: true, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    server.on('message', message => {
      if ((message as { socketOwned?: unknown })?.socketOwned === true) {
        if (!ownedArtifacts.has(serverSocket) || serverSocketOwned) serverFailed = true;
        else serverSocketOwned = true;
        return;
      }
      const pid = (message as { pid?: unknown })?.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || serverPid !== undefined) { serverFailed = true; return; }
      serverPid = pid as number;
      try {
        const observed = processIdentity(serverPid);
        if (!observed || observed.parent !== server!.pid || observed.group !== serverPid) { serverFailed = true; return; }
        serverIdentity = observed;
      } catch { serverFailed = true; }
    });
    server.once('error', () => { serverFailed = true; });
    server.once('exit', () => { serverFailed = true; if (identity && !closing) void close(); });
    process.once('exit', exitCleanup);
    const until = performance.now() + BOOT_MS;
    while (true) {
      if (serverFailed) throw new Error('Tmux foreground server failed (requires -D support)');
      if (!serverIdentity) {
        if (performance.now() >= until) throw new Error('Tmux broker boot timeout');
        await admitted(() => pause(40)); continue;
      }
      try {
        const stat = await admitted(() => lstat(serverSocket));
        if (!stat.isSocket() || stat.uid !== uid() || stat.isSymbolicLink()) throw new Error('Unsafe tmux server socket');
        await admitted(async () => {
          await chmod(serverSocket, 0o600);
          await rememberArtifact(serverSocket);
        }); break;
      } catch (error) { if (!missing(error)) throw error; }
      if (performance.now() >= until) throw new Error('Tmux server boot timeout');
      await admitted(() => pause(40));
    }
    // Transfer exact socket cleanup ownership before creating a pane. The broker
    // survives parent SIGKILL and removes only this inode after its server exits.
    const ownedServerSocket = ownedArtifacts.get(serverSocket)!;
    const ownedManifest = ownedArtifacts.get(manifestPath)!;
    server.send({ type: 'socket-owned', ...ownedServerSocket, manifestDev: ownedManifest.dev, manifestIno: ownedManifest.ino }, error => { if (error) serverFailed = true; });
    while (!serverSocketOwned) {
      if (serverFailed || !alive(serverIdentity)) throw new Error('Tmux socket ownership handshake failed');
      if (performance.now() >= until) throw new Error('Tmux socket ownership handshake timeout');
      await admitted(() => pause(20));
    }
    // tmux >= 3 direct multi-argument execution: no shell command string, no send-keys prompt.
    assertAdmission();
    const info = await command(['new-session', '-d', '-s', 'worker', '-x', '120', '-y', '40',
      '-P', '-F', '#{pane_id}:#{pane_pid}:#{pid}', '-c', config.cwd,
      ...childArgv]);
    const match = /^(%\d+):(\d+):(\d+)$/.exec(info);
    if (!match || Number(match[3]) !== serverPid) throw new Error('Unexpected tmux pane/server identity');
    pane = match[1]; paneIdentity = processIdentity(Number(match[2]));
    if (!paneIdentity || paneIdentity.parent !== serverPid || paneIdentity.group !== paneIdentity.pid) throw new Error('Unsupported tmux pane process layout');
    // Capture pane identity before the post-await fence so revocation can reap it.
    assertAdmission();
    await admitted(() => command(['set-option', '-s', 'exit-empty', 'on']));
    while (true) {
      healthy();
      try {
        const ready = await admitted(() => readReady(readyPath));
        const keys = ['version', 'identity', 'pid', 'model', 'thinkingLevel', 'tools', 'socketPath',
          'mode', 'hasUI', 'stdinTTY', 'stdoutTTY', 'maxTurns', ...(config.modelSelection !== undefined ? ['modelSelection'] : [])];
        if (Object.keys(ready).length !== keys.length || Object.keys(ready).some(key => !keys.includes(key))) throw new Error('Invalid ready fields');
        const pin = parseTmuxIdentity(ready.identity);
        const expectedModel = `${expectedPolicy.provider}/${expectedPolicy.modelId}`;
        if (ready.version !== 1 || ready.mode !== 'tui' || ready.hasUI !== true ||
            ready.stdinTTY !== true || ready.stdoutTTY !== true ||
            ready.pid !== paneIdentity.pid || ready.socketPath !== socketPath ||
            pin.workerId !== config.workerId || pin.generation !== config.generation ||
            pin.ownerNonce !== config.ownerNonce || pin.epoch !== 0 || ready.model !== expectedModel ||
            (config.modelSelection !== undefined && !isDeepStrictEqual(ready.modelSelection, config.modelSelection)) ||
            ready.thinkingLevel !== expectedPolicy.thinkingLevel || ready.maxTurns !== (config.maxTurns ?? null) || !Array.isArray(ready.tools) ||
            ready.tools.length !== config.tools.length || new Set(ready.tools).size !== ready.tools.length ||
            ready.tools.some(tool => typeof tool !== 'string' || !config.tools.includes(tool) || config.disallowedTools.includes(tool))) {
          throw new Error('Tmux readiness identity/policy mismatch');
        }
        const actual = await admitted(() => command(['display-message', '-p', '-t', pane, '#{pane_pid}:#{pid}']));
        if (actual !== `${paneIdentity.pid}:${serverPid}` || !alive(paneIdentity)) throw new Error('Tmux ready pane replaced');
        const argv = (await admitted(() => readFile(`/proc/${paneIdentity!.pid}/cmdline`))).toString().split('\0');
        if (argv.pop() !== '') throw new Error('Malformed tmux child command line');
        if (argv.length !== childArgv.length || argv.some((arg, index) => arg !== childArgv[index])) throw new Error('Tmux child entry identity mismatch');
        await admitted(() => privateArtifact(socketPath, 'socket'));
        await admitted(() => rememberArtifact(socketPath)); await admitted(() => rememberArtifact(readyPath));
        identity = pin; break;
      } catch (error) { if (!missing(error)) throw error; }
      if (performance.now() >= until) throw new Error('Tmux worker readiness timeout');
      await admitted(() => pause(50));
    }
    const initial = await admitted(() => inspect());
    if (initial.phase !== 'idle' || initial.ownership !== 'coordinator' || initial.job || initial.result) throw new Error('Worker was not idle at startup');
    heartbeat = setInterval(() => {
      if (heartbeatPending || closing || queued) return;
      heartbeatPending = true;
      void send('lease').then(response => {
        if (response.status === 'refused' && response.reason !== 'stale_identity') void close();
      }, () => undefined).finally(() => { heartbeatPending = false; });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const handle: TmuxWorkerHandle = {
      get identity() { return identity!; },
      workerId: identity.workerId, sessionId: identity.sessionId,
      attachCommand: `tmux -S ${quote(serverSocket)} attach-session -t worker`,
      get isClosed() { return closed || serverFailed; },
      inspect,
      async prompt(input) {
        assertAdmission();
        healthy();
        if (closing || activeJob) throw new Error('Worker already has a pending coordinator task');
        const job = parseTmuxJobIdentity({ ...identity, jobId: input.jobId, runId: input.runId, taskId: input.taskId, source: 'coordinator' });
        // Validate before reserving IDs. Never reuse any submitted tuple, even after uncertain acceptance.
        parseTmuxRequest({ version: 1, requestId: randomUUID(), identity, action: 'prompt', expectedJobId: null, job, text: input.text });
        if (jobs.size >= TMUX_MAX_JOBS || jobs.has(job.jobId) || runs.has(input.runId) || tasks.has(input.taskId)) throw new Error('Fresh canonical job/run/task IDs required');
        jobs.set(job.jobId, job); runs.add(input.runId); tasks.add(input.taskId); activeJob = job;
        let acceptedJob = false;
        try {
          const accepted = await send('prompt', null, input.text, job);
          if (accepted.status !== 'accepted') throw new Error(`Tmux prompt refused: ${accepted.reason}`);
          acceptedJob = true;
          firstPromptAccepted = true; // Review/source TTL fences end at the first accepted prompt.
          const until = performance.now() + SETTLEMENT_MS;
          while (performance.now() < until) {
            const snapshot = await inspect(job.jobId);
            if (snapshot.result) {
              const result = snapshot.result;
              if (!sameTmuxIdentity(result.identity, job) || result.identity.source !== 'coordinator' ||
                  result.identity.jobId !== job.jobId || result.identity.runId !== job.runId || result.identity.taskId !== job.taskId) {
                await close(); throw new Error('Mismatched coordinator result');
              }
              return result; // Keep the same interactive session alive after actual settlement.
            }
            if (snapshot.phase === 'closed' || !snapshot.job || snapshot.job.jobId !== job.jobId ||
                snapshot.job.runId !== job.runId || snapshot.job.taskId !== job.taskId ||
                snapshot.job.source !== 'coordinator' || !sameTmuxIdentity(snapshot.job, job)) {
              await close(); throw new Error('Coordinator job disappeared without settlement');
            }
            await pause(150);
          }
          await close(); throw new Error('Tmux settlement deadline exceeded; no completed result');
        } catch (error) {
          if (acceptedJob) await close();
          throw error;
        } finally { activeJob = null; }
      },
      steer: (jobId, text) => send('steer', jobId, text),
      cancel: jobId => send('cancel', jobId),
      close,
    };
    // A registry can enumerate safe fields without accidentally serializing the transport nonce.
    Object.defineProperty(handle, 'identity', { enumerable: false });
    return Object.freeze(handle);
  } catch {
    const cleanup = await close().catch(() => ({ closed: false, errors: ['Cleanup unconfirmed.'] }));
    throw new TmuxLaunchError(cleanup.closed, cleanup.errors.length > 0);
  }
}
