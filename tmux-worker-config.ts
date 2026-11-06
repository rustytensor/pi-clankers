import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize, dirname, basename, join } from 'node:path';

import { parseTmuxMcpCommand, resolveTmuxToolPolicy, type TmuxMcpCommand } from './tmux-mcp.js';

export interface TmuxWorkerConfig {
  readonly version: 1;
  readonly workerId: string;
  readonly generation: string;
  readonly ownerNonce: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly runDir: string;
  readonly sessionDir: string;
  readonly socketPath: string;
  readonly readyPath: string;
  readonly sdkModulePath: string;
  readonly parentPid: number;
  readonly modelSpec: string;
  readonly modelSelection?: TmuxModelSelection;
  readonly maxTurns?: number;
  readonly definitionPrompt: string;
  readonly tools: readonly string[];
  readonly disallowedTools: readonly string[];
  /** Trusted programmatic fixture injection; never accept from model control JSON. */
  readonly fixtureExtensionPaths?: readonly string[];
  readonly fixtureMcpCommand?: TmuxMcpCommand;
}
export interface TmuxModelSelection {
  readonly candidates: readonly string[];
  readonly index: number;
  readonly modelSpec: string;
  readonly modelDigest: string;
  readonly planDigest: string;
}
/** Preserve caller order, including duplicates. Only catalog absence permits skipping. */
export function tmuxModelCandidates(primary: string, fallbacks: unknown = []): readonly string[] {
  if (!Array.isArray(fallbacks) || fallbacks.length > 7) throw new Error('Tmux permits at most 7 fallback models');
  const candidates: string[] = [];
  for (let i = 0; i <= fallbacks.length; i++) {
    const spec = i === 0 ? primary : fallbacks[i - 1];
    if (typeof spec !== 'string') throw new Error('Invalid tmux model candidate');
    parseTmuxModelSpec(spec);
    candidates.push(spec);
  }
  return Object.freeze(candidates);
}
export function tmuxModelDigest(value: unknown): string {
  let nodes = 0;
  const canonical = (v: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new Error('Invalid model descriptor');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(item => canonical(item, depth + 1));
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v).filter(key => (v as Record<string, unknown>)[key] !== undefined).sort().map(key => [key, canonical((v as Record<string, unknown>)[key], depth + 1)]));
    }
    throw new Error('Invalid model descriptor');
  };
  const text = JSON.stringify(canonical(value, 0));
  if (Buffer.byteLength(text) > 32768) throw new Error('Model descriptor too large');
  return createHash('sha256').update(text).digest('hex');
}
export function parseTmuxModelSelection(value: unknown): TmuxModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model selection');
  const v = value as TmuxModelSelection;
  if (Object.keys(v).sort().join(',') !== 'candidates,index,modelDigest,modelSpec,planDigest' || !Array.isArray(v.candidates) || !v.candidates.length) throw new Error('Invalid model selection fields');
  const candidates = tmuxModelCandidates(v.candidates[0], v.candidates.slice(1));
  if (!Number.isSafeInteger(v.index) || v.index < 0 || v.index >= candidates.length || candidates[v.index] !== v.modelSpec || typeof v.modelDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.modelDigest)) throw new Error('Invalid chosen model');
  const plan = { candidates, index: v.index, modelSpec: v.modelSpec, modelDigest: v.modelDigest };
  if (v.planDigest !== tmuxModelDigest(plan)) throw new Error('Model plan digest mismatch');
  return Object.freeze({ ...plan, planDigest: v.planDigest });
}
export const TMUX_MANIFEST_BYTES = 64 * 1024;
export const TMUX_LEASE_MS = 30_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$(?![\s\S])/;
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function parseTmuxModelSpec(spec: string): { provider: string; modelId: string; thinkingLevel: typeof LEVELS[number] } {
  if (spec.length > 512 || /[\s\x00-\x1f]/.test(spec)) throw new Error('Invalid worker model');
  const slash = spec.indexOf('/');
  if (slash < 1 || slash === spec.length - 1) throw new Error('Canonical provider/model required');
  const provider = spec.slice(0, slash);
  let modelId = spec.slice(slash + 1);
  let thinkingLevel: typeof LEVELS[number] = 'off';
  const colon = modelId.lastIndexOf(':');
  if (colon >= 0) {
    const suffix = modelId.slice(colon + 1);
    if ((LEVELS as readonly string[]).includes(suffix)) {
      thinkingLevel = suffix as typeof thinkingLevel;
      modelId = modelId.slice(0, colon);
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(provider) || !modelId || !/^[A-Za-z0-9._/:+-]+$/.test(modelId)) throw new Error('Invalid canonical model');
  return { provider, modelId, thinkingLevel };
}
/** Bounded per-job provider-request ceiling; nested same-session calls count too. */
export function parseTmuxMaxTurns(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1024) throw new Error('Tmux maxTurns must be an integer from 1 to 1024');
  return value as number;
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid worker path');
  return value;
}
function names(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid worker tools');
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || !TOOL.test(value[i]) || result.includes(value[i])) throw new Error('Exact unique tool names required');
    result.push(value[i]);
  }
  return Object.freeze(result);
}
/** Strict data parser: no discovery, processes, SDK loading or provider work. */
export function parseTmuxWorkerConfig(value: unknown): TmuxWorkerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid worker manifest');
  const v = value as Record<string, unknown>;
  const required = ['version', 'workerId', 'generation', 'ownerNonce', 'cwd', 'agentDir', 'runDir', 'sessionDir', 'socketPath', 'readyPath', 'sdkModulePath', 'parentPid', 'modelSpec', 'definitionPrompt', 'tools', 'disallowedTools'];
  if (required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && k !== 'fixtureExtensionPaths' && k !== 'fixtureMcpCommand' && k !== 'maxTurns' && k !== 'modelSelection')) throw new Error('Invalid worker manifest fields');
  if (v.version !== 1 || typeof v.workerId !== 'string' || !ID.test(v.workerId) || /\s/.test(v.workerId) || typeof v.generation !== 'string' || !ID.test(v.generation) || /\s/.test(v.generation)) throw new Error('Invalid worker identity');
  if (typeof v.ownerNonce !== 'string' || !/^[a-f0-9]{64}$/.test(v.ownerNonce) || v.ownerNonce.length !== 64) throw new Error('Invalid worker credential');
  if (!Number.isSafeInteger(v.parentPid) || (v.parentPid as number) <= 1) throw new Error('Invalid worker parent');
  if (typeof v.modelSpec !== 'string') throw new Error('Missing worker model');
  parseTmuxModelSpec(v.modelSpec);
  const maxTurns = parseTmuxMaxTurns(v.maxTurns);
  const modelSelection = v.modelSelection === undefined ? undefined : parseTmuxModelSelection(v.modelSelection);
  if (modelSelection && modelSelection.modelSpec !== v.modelSpec) throw new Error('Selected model mismatch');
  if (typeof v.definitionPrompt !== 'string' || Buffer.byteLength(v.definitionPrompt) > 16 * 1024) throw new Error('Invalid worker definition');
  const cwd = absolute(v.cwd), agentDir = absolute(v.agentDir), runDir = absolute(v.runDir);
  const sessionDir = absolute(v.sessionDir), socketPath = absolute(v.socketPath), readyPath = absolute(v.readyPath), sdkModulePath = absolute(v.sdkModulePath);
  if (runDir === '/' || dirname(sessionDir) !== runDir || dirname(socketPath) !== runDir || dirname(readyPath) !== runDir || new Set([sessionDir, socketPath, readyPath]).size !== 3 || Buffer.byteLength(socketPath) > 100) throw new Error('Worker resources must be distinct direct children of private runDir');
  const resolved = resolveTmuxToolPolicy(names(v.tools), names(v.disallowedTools));
  const tools = Object.freeze(resolved.tools), disallowedTools = Object.freeze(resolved.disallowedTools);
  const fixtureMcpCommand = Object.hasOwn(v, 'fixtureMcpCommand') ? parseTmuxMcpCommand(v.fixtureMcpCommand) : undefined;
  let fixtureExtensionPaths: readonly string[] | undefined;
  if (Object.hasOwn(v, 'fixtureExtensionPaths')) {
    if (!Array.isArray(v.fixtureExtensionPaths) || v.fixtureExtensionPaths.length > 16) throw new Error('Invalid fixture paths');
    fixtureExtensionPaths = Object.freeze(v.fixtureExtensionPaths.map(absolute));
  }
  return Object.freeze({ version: 1, workerId: v.workerId, generation: v.generation, ownerNonce: v.ownerNonce, cwd, agentDir, runDir, sessionDir, socketPath, readyPath, sdkModulePath, parentPid: v.parentPid as number, modelSpec: v.modelSpec, ...(modelSelection ? { modelSelection } : {}), ...(maxTurns === undefined ? {} : { maxTurns }), definitionPrompt: v.definitionPrompt, tools, disallowedTools, ...(fixtureExtensionPaths ? { fixtureExtensionPaths } : {}), ...(fixtureMcpCommand ? { fixtureMcpCommand } : {}) });
}
export async function requirePrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) throw new Error('Worker directory is not private/canonical');
}
/** Filesystem/data preflight only; SDK resource/model/tool attestation happens in the child before provider work. */
export async function preflightTmuxWorkerConfig(input: TmuxWorkerConfig): Promise<TmuxWorkerConfig> {
  const config = parseTmuxWorkerConfig(input);
  await requirePrivateDirectory(config.runDir);
  await requirePrivateDirectory(config.sessionDir);
  for (const path of [config.cwd, config.agentDir]) {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Worker input directory must be canonical');
  }
  if (!(await lstat(config.sdkModulePath)).isFile() || await realpath(config.sdkModulePath) !== config.sdkModulePath) throw new Error('Worker SDK must be a canonical file');
  for (const path of [config.socketPath, config.readyPath]) {
    try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error('Worker artifact already exists');
  }
  return config;
}
export async function readTmuxWorkerManifest(path: string): Promise<TmuxWorkerConfig> {
  absolute(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const link = await lstat(path);
    if (!stat.isFile() || link.isSymbolicLink() || stat.ino !== link.ino || stat.dev !== link.dev || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > TMUX_MANIFEST_BYTES || await realpath(path) !== path) throw new Error('Worker manifest must be a private regular file');
    const bytes = Buffer.alloc(TMUX_MANIFEST_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > TMUX_MANIFEST_BYTES) throw new Error('Worker manifest too large');
    const config = parseTmuxWorkerConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))));
    if (dirname(path) !== config.runDir || [basename(config.readyPath), basename(config.socketPath), basename(config.sessionDir)].includes(basename(path))) throw new Error('Worker manifest is not owned');
    if (join(config.runDir, basename(path)) !== path) throw new Error('Invalid manifest path');
    return await preflightTmuxWorkerConfig(config);
  } finally { await file.close(); }
}
