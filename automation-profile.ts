import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, readlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { ClankersAgentDefinition } from './types.js';
import { freezeWorkflowData, normalizeWorkflowAgent, validateWorkflowDefinition, validateWorkflowValue, workflowHash, workflowJson } from './workflow-model.js';
import type { WorkflowDefinition, WorkflowJson, WorkflowRunStatus, WorkflowStep } from './workflow-model.js';

/** Local OS access authenticates callers. Hashes detect configuration changes, not actors.
 * This is a reviewed scoped TEXT reader, not builtin-read provenance, DLP or an OS sandbox.
 * Same-user arbitrary code remains outside this boundary. No helper repairs permissions. */
export interface AutomationRequestV1 { version: 1; profileId: string; eventId: string; occurrenceTime: string }
export interface AutomationLimits {
  maxEventAgeMs: number; maxFutureSkewMs: number; minIntervalMs: number; maxRetainedEvents: number;
  maxRunMs: number; maxCleanupMs: number; maxOutputBytes: number; maxReadBytes: number;
  maxAdmissions: number; maxProviderRequests: number; concurrency: number;
}
export interface AutomationProfileV1 {
  version: 1; id: string; enabled: boolean; approvedProfileHash: string;
  projectRoot: string; snapshotFile: string; agentDir: string; sessionDir: string;
  definition: WorkflowDefinition; definitionId: string; definitionHash: string; fixedInputs: WorkflowJson;
  readPaths: string[]; agents: ClankersAgentDefinition[];
  modelPolicy: { provider: string; id: string; thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' };
  credentialSourceRef: { kind: 'env'; name: string }; modelConfigFile: null | { path: string; sha256: string };
  limits: AutomationLimits;
}
export interface AutomationResultV1 {
  version: 1; profileId: string; eventId: string; workflowRunId?: string;
  delivery: 'accepted' | 'duplicate' | 'rejected' | 'busy' | 'uncertain'; workflowStatus?: WorkflowRunStatus;
  cleanup: 'settled' | 'uncertain' | 'not-started'; counts?: Record<string, number>;
  reasonCode?: string; inspection?: string; exitCode: number;
}
export interface AutomationProfileIdentityGuard {
  assertCurrent(): void; readPath(candidatePath: string): string; readModelConfig(): WorkflowJson | null; dispose(): void;
}
export const AUTOMATION_PROFILE_BOUNDS = Object.freeze({ requestBytes: 4096, profileBytes: 1048576,
  modelConfigBytes: 262144, fixedInputBytes: 32768, readPaths: 16, pathBytes: 512 });
const LIMIT_BOUNDS: Record<keyof AutomationLimits, readonly [number, number]> = {
  maxEventAgeMs: [1, 86400000], maxFutureSkewMs: [0, 300000], minIntervalMs: [1, 86400000],
  maxRetainedEvents: [1, 16], maxRunMs: [1, 3600000], maxCleanupMs: [1, 30000],
  maxOutputBytes: [1024, 65536], maxReadBytes: [1, 1048576], maxAdmissions: [1, 256],
  maxProviderRequests: [1, 256], concurrency: [1, 8],
};
function insist(value: unknown, code: string): asserts value { if (!value) throw new Error(`Automation ${code}`); }
function record(value: unknown): Record<string, unknown> {
  insist(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected-object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  insist(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'unsupported-fields');
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value); }
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
// Named physical OpenRouter models are not Pi virtual routers/resource gateways.
// The runner still verifies exact registered physical identity before SDK/provider admission.
function physicalModelPolicy(policy: Record<string, unknown>): void {
  exact(policy, ['provider', 'id', 'thinkingLevel']);
  insist(identifier(policy.provider) && !/^(vercel|vercel-ai-gateway|router|virtual)$/i.test(policy.provider) &&
    typeof policy.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/.test(policy.id) &&
    !policy.id.toLowerCase().split('/').some(s => ['auto', 'router', 'virtual'].includes(s)) &&
    !(policy.provider.toLowerCase() === 'openrouter' && /^(openrouter\/)?free$/i.test(policy.id)) &&
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(policy.thinkingLevel)), 'invalid-physical-model-policy');
}
function absolute(value: unknown): asserts value is string {
  insist(typeof value === 'string' && Buffer.byteLength(value) <= 4096 && value.startsWith('/') && value !== '/' &&
    !/[\x00-\x1f\x7f\\]/.test(value) && path.posix.normalize(value) === value && !value.endsWith('/'), 'noncanonical-absolute-path');
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function safeCandidate(value: unknown): asserts value is string {
  insist(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= AUTOMATION_PROFILE_BOUNDS.pathBytes &&
    !value.startsWith('/') && !/[\x00-\x1f\x7f\\*?\[\]{}]/.test(value) && path.posix.normalize(value) === value && !value.endsWith('/'), 'invalid-read-path');
  const segments = value.split('/');
  insist(segments.every(s => s !== '.' && s !== '..' && !s.startsWith('.') &&
    !/^(auth|credentials?|secrets?|settings|models)(\.|$)/i.test(s) &&
    !/\.(pem|key|p12|pfx|keystore)$/i.test(s) && !/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i.test(s)), 'private-read-path');
}
export function validateAutomationRequest(value: unknown): AutomationRequestV1 {
  const v = record(workflowJson(value, AUTOMATION_PROFILE_BOUNDS.requestBytes));
  exact(v, ['version', 'profileId', 'eventId', 'occurrenceTime']);
  insist(v.version === 1 && identifier(v.profileId), 'invalid-request-identity');
  insist(typeof v.occurrenceTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.occurrenceTime) &&
    Number.isFinite(Date.parse(v.occurrenceTime)) && new Date(v.occurrenceTime).toISOString() === v.occurrenceTime && v.eventId === v.occurrenceTime, 'invalid-occurrence');
  return freezeWorkflowData(v) as unknown as AutomationRequestV1;
}
function structuralProfile(value: unknown): AutomationProfileV1 {
  const v = record(workflowJson(value, AUTOMATION_PROFILE_BOUNDS.profileBytes));
  exact(v, ['version', 'id', 'enabled', 'approvedProfileHash', 'projectRoot', 'snapshotFile', 'agentDir', 'sessionDir',
    'definition', 'definitionId', 'definitionHash', 'fixedInputs', 'readPaths', 'agents', 'modelPolicy', 'credentialSourceRef', 'modelConfigFile', 'limits']);
  insist(v.version === 1 && identifier(v.id) && typeof v.enabled === 'boolean' && typeof v.approvedProfileHash === 'string' &&
    (v.approvedProfileHash === '' || sha(v.approvedProfileHash)), 'invalid-profile-identity');
  for (const key of ['projectRoot', 'snapshotFile', 'agentDir', 'sessionDir']) absolute(v[key]);
  const project = v.projectRoot as string;
  insist(!project.split('/').some(s => ['.pi', '.git', '.ssh', '.config'].includes(s)), 'private-project-root');
  const statePaths = [v.snapshotFile, v.agentDir, v.sessionDir] as string[];
  insist(statePaths.every(p => !overlaps(p, project)) && statePaths.every((p, i) => statePaths.every((q, j) => i === j || !overlaps(p, q))), 'overlapping-state-paths');
  insist(statePaths.every(p => !p.split('/').some(s => ['.pi', '.git', '.ssh', '.config'].includes(s))), 'interactive-state-path');
  insist(Array.isArray(v.readPaths) && v.readPaths.length >= 1 && v.readPaths.length <= AUTOMATION_PROFILE_BOUNDS.readPaths, 'read-path-bound');
  v.readPaths.forEach(safeCandidate); insist(new Set(v.readPaths).size === v.readPaths.length, 'duplicate-read-path');
  v.readPaths.sort();
  const policy = record(v.modelPolicy); exact(policy, ['provider', 'id', 'thinkingLevel']);
  physicalModelPolicy(policy);
  const credential = record(v.credentialSourceRef); exact(credential, ['kind', 'name']);
  insist(credential.kind === 'env' && typeof credential.name === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(credential.name), 'invalid-credential-reference');
  if (v.modelConfigFile !== null) {
    const config = record(v.modelConfigFile); exact(config, ['path', 'sha256']); absolute(config.path);
    insist(sha(config.sha256) && !overlaps(config.path, project) && statePaths.every(p => !overlaps(p, config.path as string)), 'model-config-scope');
  }
  const limits = record(v.limits); exact(limits, Object.keys(LIMIT_BOUNDS));
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS)) insist(Number.isSafeInteger(limits[key]) && (limits[key] as number) >= min && (limits[key] as number) <= max, `limit-${key}`);
  // Walk raw bounded DATA before the core validator: ALL coding is forbidden, even unreachable.
  const rawDef = record(v.definition);
  const visit = (steps: unknown): void => {
    insist(Array.isArray(steps), 'invalid-steps');
    for (const item of steps) { const step = record(item); insist(step.kind !== 'coding' && !Object.hasOwn(step, 'coding'), 'coding-forbidden'); if (step.body !== undefined) visit(step.body); }
  };
  visit(rawDef.steps);
  const definition = validateWorkflowDefinition(v.definition as WorkflowDefinition);
  insist(v.definitionId === definition.id && sha(v.definitionHash) && v.definitionHash === workflowHash(definition), 'definition-mismatch');
  const inputs = workflowJson(v.fixedInputs, AUTOMATION_PROFILE_BOUNDS.fixedInputBytes); validateWorkflowValue(inputs, definition.inputSchema);
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs) && Object.hasOwn(inputs, 'candidatePaths')) {
    insist(Array.isArray(inputs.candidatePaths) && inputs.candidatePaths.every(p => typeof p === 'string' && (v.readPaths as string[]).includes(p)) &&
      new Set(inputs.candidatePaths).size === inputs.candidatePaths.length, 'candidate-outside-read-scope');
  }
  insist(Array.isArray(v.agents) && v.agents.length >= 1 && v.agents.length <= 16, 'agent-bound');
  const agents = v.agents.map(a => {
    const agent = normalizeWorkflowAgent(a as ClankersAgentDefinition);
    insist(identifier(agent.id) && agent.label.length > 0 && agent.prompt.length > 0 && ['builtin', 'user', 'project', 'runtime'].includes(agent.source), 'invalid-agent');
    insist(agent.model === `${policy.provider}/${policy.id}:${policy.thinkingLevel}` && agent.permissionMode === 'inherit' &&
      Array.isArray(agent.tools) && agent.tools.length === 1 && agent.tools[0] === 'read' &&
      agent.fallbackModels === undefined && agent.maxTurns === undefined && agent.extensions === undefined && agent.metadata === undefined &&
      (agent.disallowedTools === undefined || agent.disallowedTools.length === 0), 'agent-policy');
    return agent;
  });
  insist(new Set(agents.map(a => a.id)).size === agents.length, 'duplicate-agent');
  const walk = (steps: WorkflowStep[]): void => { for (const s of steps) {
    if (s.kind === 'native') insist(agents.some(a => a.id === s.agentId), 'missing-agent');
    if (s.body) walk(s.body);
  } }; walk(definition.steps);
  agents.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return freezeWorkflowData({ ...v, definition, fixedInputs: inputs, agents }, AUTOMATION_PROFILE_BOUNDS.profileBytes) as unknown as AutomationProfileV1;
}
/** Pure structural hash utility. It neither enables nor approves a profile. */
export function computeAutomationProfileHash(value: unknown): string {
  const profile = structuralProfile(value);
  const { enabled: _enabled, approvedProfileHash: _approved, ...bearing } = profile;
  return workflowHash(bearing);
}
/** Pure admission validation, with enabled and exact approved generation mandatory. */
export function validateAutomationProfile(value: unknown): AutomationProfileV1 {
  const profile = structuralProfile(value);
  insist(profile.enabled, 'profile-disabled');
  insist(profile.approvedProfileHash === computeAutomationProfileHash(profile), 'profile-unapproved-or-changed');
  return profile;
}

/** Deliberately narrow models.json DATA subset. No SDK imports, commands, auth, headers,
 * OAuth, virtual models, routing fallbacks, sampling expressions or extension providers.
 * A custom config contains exactly the selected physical provider/model and pins its route.
 * OpenRouter permits only bounded static upstream/quantization filters with fallbacks off. */
export function validateAutomationModelConfig(value: unknown, modelPolicy: AutomationProfileV1['modelPolicy']): WorkflowJson {
  const policy = record(workflowJson(modelPolicy, 4096)); physicalModelPolicy(policy);
  modelPolicy = policy as unknown as AutomationProfileV1['modelPolicy'];
  const v = record(workflowJson(value, AUTOMATION_PROFILE_BOUNDS.modelConfigBytes)); exact(v, ['providers']);
  const providers = record(v.providers); exact(providers, [modelPolicy.provider]);
  const provider = record(providers[modelPolicy.provider]); exact(provider, ['baseUrl', 'api', 'models'], ['name', 'authHeader']);
  const apis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'];
  insist(typeof provider.api === 'string' && apis.includes(provider.api), 'unsupported-model-api');
  const route = (url: unknown): void => {
    insist(typeof url === 'string' && url.length <= 2048 && !/[\s\x00-\x1f\x7f]/.test(url), 'invalid-model-route');
    let parsed: URL; try { parsed = new URL(url); } catch { throw new Error('Automation invalid-model-route'); }
    insist(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      !/(^|\.)(vercel\.ai|ai-gateway\.vercel\.sh)$/i.test(parsed.hostname) &&
      (modelPolicy.provider === 'openrouter' ? parsed.protocol === 'https:' && parsed.hostname === 'openrouter.ai' :
        !/(^|\.)openrouter\.ai$/i.test(parsed.hostname)), 'invalid-model-route');
  };
  route(provider.baseUrl);
  if (provider.name !== undefined) insist(typeof provider.name === 'string' && provider.name.length <= 160, 'invalid-provider-name');
  if (provider.authHeader !== undefined) insist(typeof provider.authHeader === 'boolean', 'invalid-auth-header');
  insist(Array.isArray(provider.models) && provider.models.length === 1, 'model-count');
  const model = record(provider.models[0]);
  exact(model, ['id', 'name', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens'], ['api', 'baseUrl', 'compat', 'thinkingLevelMap']);
  insist(model.id === modelPolicy.id && typeof model.name === 'string' && model.name.length > 0 && model.name.length <= 160 &&
    typeof model.reasoning === 'boolean' && Array.isArray(model.input) && model.input.length === 1 && model.input[0] === 'text', 'invalid-model-metadata');
  if (model.api !== undefined) insist(model.api === provider.api, 'model-api-mismatch');
  if (model.baseUrl !== undefined) { route(model.baseUrl); insist(model.baseUrl === provider.baseUrl, 'model-route-mismatch'); }
  const cost = record(model.cost); exact(cost, ['input', 'output', 'cacheRead', 'cacheWrite']);
  insist(Object.values(cost).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000000), 'invalid-model-cost');
  for (const key of ['contextWindow', 'maxTokens']) insist(Number.isSafeInteger(model[key]) && (model[key] as number) > 0 && (model[key] as number) <= 10000000, 'invalid-model-tokens');
  insist((model.maxTokens as number) <= (model.contextWindow as number), 'invalid-model-tokens');
  if (model.compat !== undefined) {
    const compat = record(model.compat);
    const bools = ['supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming', 'supportsFinishReason',
      'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages',
      'supportsStrictMode', 'supportsMaxOutputTokens', 'sendSessionAffinityHeaders'];
    exact(compat, [], [...bools, 'maxTokensField', 'thinkingFormat', 'openRouterRouting']);
    for (const [k, val] of Object.entries(compat)) {
      if (k === 'openRouterRouting') {
        insist(modelPolicy.provider === 'openrouter' && provider.api === 'openai-completions', 'invalid-openrouter-routing');
        const routing = record(val); exact(routing, ['only', 'quantizations', 'allow_fallbacks']);
        insist(routing.allow_fallbacks === false, 'openrouter-fallback-forbidden');
        for (const key of ['only', 'quantizations']) {
          const entries = routing[key];
          insist(Array.isArray(entries) && entries.length >= 1 && entries.length <= 16 &&
            entries.every(x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(x)) &&
            new Set(entries).size === entries.length, 'invalid-openrouter-routing-array');
        }
      } else if (bools.includes(k)) insist(typeof val === 'boolean', 'invalid-model-compat');
      else insist(k === 'maxTokensField' ? ['max_tokens', 'max_completion_tokens'].includes(String(val)) : ['openai', 'deepseek', 'zai', 'qwen'].includes(String(val)), 'invalid-model-compat');
    }
  }
  if (model.thinkingLevelMap !== undefined) {
    const map = record(model.thinkingLevelMap); exact(map, [], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    insist(Object.values(map).every(x => x === null || (typeof x === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(x))), 'invalid-thinking-map');
  }
  return freezeWorkflowData(v, AUTOMATION_PROFILE_BOUNDS.modelConfigBytes) as WorkflowJson;
}

type ProofNode = { name: string; dev: number; ino: number; uid: number; mode: number; nlink: number; file: boolean };
type PathProof = { path: string; nodes: ProofNode[]; hash?: string; maxBytes?: number; text?: string };
const sourceProofs = new WeakMap<AutomationProfileV1, PathProof[]>();
function node(name: string, s: Stats): ProofNode { return { name, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink, file: s.isFile() }; }
function same(a: ProofNode, b: ProofNode): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && (!a.file || a.nlink === b.nlink) && a.file === b.file; }
function uid(): number { insist(process.platform === 'linux' && typeof process.geteuid === 'function', 'linux-uid-required'); return process.geteuid(); }
function trust(s: Stats, file: boolean, protectedChild: boolean): boolean {
  const effective = uid();
  insist((s.uid === effective || s.uid === 0) && (file ? s.isFile() && s.nlink === 1 : s.isDirectory()), 'untrusted-owner-or-type');
  if (protectedChild) insist(s.uid === effective && !file && !(s.mode & 0o022), 'sticky-child-unprotected');
  const sticky = !file && s.uid === 0 && !!(s.mode & 0o1000);
  insist(!(s.mode & 0o022) || sticky, 'writable-path');
  return sticky && !!(s.mode & 0o022);
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function descriptorName(handle: number, expected: string): void {
  insist(readlinkSync(`/proc/self/fd/${handle}`) === expected, 'path-substituted');
}
/** Every child is opened relative to an already verified directory descriptor, never by
 * a pathname with unchecked ancestors. Root-owned sticky ancestors require the very next
 * opened directory to be non-other-writable and effective-UID-owned. */
function protectedPath(absolutePath: string, file: boolean, maxBytes?: number, expected?: PathProof, allowMissing = false): PathProof {
  absolute(absolutePath); const handles: number[] = []; const nodes: ProofNode[] = [];
  try {
    let handle = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(handle);
    let stat = fstatSync(handle); let sticky = trust(stat, false, false); nodes.push(node('/', stat));
    const parts = absolutePath.slice(1).split('/'); let current = '';
    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1; const isFile = leaf && file;
      current += `/${parts[i]}`;
      let child: number;
      try { child = openSync(`/proc/self/fd/${handle}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (isFile ? 0 : constants.O_DIRECTORY)); }
      catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          insist(!sticky, 'missing-sticky-child');
          for (let j = 0; j < handles.length; j++) {
            descriptorName(handles[j], nodes[j].name);
            insist(same(node(nodes[j].name, fstatSync(handles[j])), nodes[j]), 'path-changed-during-read');
          }
          return { path: absolutePath, nodes };
        }
        throw new Error('Automation unavailable-protected-path');
      }
      handles.push(child); handle = child; stat = fstatSync(handle);
      sticky = trust(stat, isFile, sticky); nodes.push(node(current, stat));
      descriptorName(handle, current);
      if (expected && i + 1 < expected.nodes.length) insist(same(nodes[i + 1], expected.nodes[i + 1]), 'path-identity-changed');
    }
    insist(!sticky, 'sticky-root-unprotected');
    if (expected) insist(nodes.length === expected.nodes.length && nodes.every((n, i) => same(n, expected.nodes[i])), 'path-identity-changed');
    let text: string | undefined, hash: string | undefined;
    if (file && maxBytes !== undefined) {
      insist(stat.size <= maxBytes, 'file-byte-bound');
      const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
      while (length < buffer.length) { const bytesRead = readSync(handle, buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
      insist(length <= maxBytes, 'file-byte-bound');
      const after = fstatSync(handle);
      insist(stat.dev === after.dev && stat.ino === after.ino && stat.size === length && after.size === length && stat.mtimeMs === after.mtimeMs && stat.ctimeMs === after.ctimeMs && stat.mode === after.mode && stat.uid === after.uid && after.nlink === 1, 'file-changed-during-read');
      const bytes = buffer.subarray(0, length); hash = digest(bytes);
      insist(!bytes.includes(0), 'binary-text-forbidden');
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Automation invalid-utf8'); }
      if (expected?.hash) insist(hash === expected.hash, 'file-hash-changed');
    }
    for (let i = 0; i < handles.length; i++) {
      descriptorName(handles[i], nodes[i].name);
      insist(same(node(nodes[i].name, fstatSync(handles[i])), nodes[i]), 'path-changed-during-read');
    }
    return { path: absolutePath, nodes, ...(file ? { hash, maxBytes, text } : {}) };
  } finally { for (const h of handles.reverse()) closeSync(h); }
}
function verifyProof(proof: PathProof): void {
  protectedPath(proof.path, proof.hash !== undefined, proof.maxBytes, proof);
}
async function load(profilesDir: string, id: string, admission: boolean): Promise<AutomationProfileV1> {
  absolute(profilesDir); insist(identifier(id), 'invalid-profile-id');
  const directory = protectedPath(profilesDir, false);
  const source = protectedPath(`${profilesDir}/${id}.json`, true, AUTOMATION_PROFILE_BOUNDS.profileBytes);
  let data: unknown; try { data = JSON.parse(source.text!); } catch { throw new Error('Automation invalid-profile-json'); }
  const profile = admission ? validateAutomationProfile(data) : structuralProfile(data);
  insist(profile.id === id && !overlaps(profilesDir, profile.projectRoot) &&
    [profile.snapshotFile, profile.agentDir, profile.sessionDir].every(p => !overlaps(p, profilesDir)), 'profile-locator-scope');
  const proofs = [directory, source];
  proofs.push(protectedPath(profile.projectRoot, false));
  // State leaves may not exist; existing physical ancestry must already be protected.
  for (const p of [profile.snapshotFile, profile.agentDir, profile.sessionDir]) {
    const proof = protectedPath(p, p === profile.snapshotFile, undefined, undefined, true);
    const dirs = proof.nodes.filter(n => !n.file);
    proofs.push({ path: dirs[dirs.length - 1].name, nodes: dirs });
  }
  if (profile.modelConfigFile) {
    const config = protectedPath(profile.modelConfigFile.path, true, AUTOMATION_PROFILE_BOUNDS.modelConfigBytes);
    insist(config.hash === profile.modelConfigFile.sha256, 'model-config-hash-mismatch');
    let metadata: unknown; try { metadata = JSON.parse(config.text!); } catch { throw new Error('Automation invalid-model-config-json'); }
    validateAutomationModelConfig(metadata, profile.modelPolicy); proofs.push(config);
  }
  for (const proof of proofs) verifyProof(proof);
  sourceProofs.set(profile, proofs); return profile;
}
export async function loadAutomationProfile(profilesDir: string, id: string): Promise<AutomationProfileV1> { return load(profilesDir, id, true); }
/** Trusted bounded read only; explicitly DOES NOT enable/approve/admit. */
export async function loadAutomationProfileForHash(profilesDir: string, id: string): Promise<AutomationProfileV1> { return load(profilesDir, id, false); }
export async function createAutomationProfileIdentityGuard(profile: AutomationProfileV1): Promise<AutomationProfileIdentityGuard> {
  validateAutomationProfile(profile);
  const sources = sourceProofs.get(profile); insist(sources, 'trusted-loader-required');
  const project = protectedPath(profile.projectRoot, false);
  const reads = new Map<string, PathProof>();
  for (const candidate of profile.readPaths) reads.set(candidate, protectedPath(`${profile.projectRoot}/${candidate}`, true, profile.limits.maxReadBytes));
  let disposed = false;
  const assertCurrent = (): void => {
    insist(!disposed, 'guard-disposed');
    for (const proof of sources) verifyProof(proof);
    verifyProof(project);
    // Snapshot contents are mutable execution truth: recheck nofollow/type/UID/permissions,
    // not their content hash. Absent isolated leaves are legal until the owner creates them.
    for (const p of [profile.snapshotFile, profile.agentDir, profile.sessionDir])
      protectedPath(p, p === profile.snapshotFile, undefined, undefined, true);
    insist(!disposed, 'guard-disposed');
  };
  assertCurrent();
  const guard: AutomationProfileIdentityGuard = Object.freeze({ assertCurrent,
    readPath(candidatePath: string): string {
      safeCandidate(candidatePath); const proof = reads.get(candidatePath); insist(proof, 'read-outside-scope');
      assertCurrent();
      const read = protectedPath(proof.path, true, profile.limits.maxReadBytes, proof);
      assertCurrent(); insist(!disposed, 'guard-disposed'); return read.text!;
    },
    readModelConfig(): WorkflowJson | null {
      assertCurrent();
      if (!profile.modelConfigFile) return null;
      const proof = sources.find(p => p.path === profile.modelConfigFile!.path && p.hash !== undefined);
      insist(proof, 'model-config-proof-missing');
      const read = protectedPath(proof.path, true, AUTOMATION_PROFILE_BOUNDS.modelConfigBytes, proof);
      let metadata: unknown; try { metadata = JSON.parse(read.text!); } catch { throw new Error('Automation invalid-model-config-json'); }
      const config = validateAutomationModelConfig(metadata, profile.modelPolicy);
      assertCurrent(); return config;
    },
    dispose(): void { disposed = true; reads.clear(); },
  });
  boundGuards.set(guard, profile); return guard;
}
/** Only a guard created for this exact trusted loaded profile may service reads. */
const boundGuards = new WeakMap<AutomationProfileIdentityGuard, AutomationProfileV1>();
export function scopedReadAutomationPath(profile: AutomationProfileV1, candidatePath: string, guard: AutomationProfileIdentityGuard): string {
  // Bound by the factory, never inferred from caller-supplied labels.
  insist(boundGuards.get(guard) === profile, 'guard-profile-mismatch'); return guard.readPath(candidatePath);
}
