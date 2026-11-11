import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createNativeContinuationService, continuationDigest, nativeSourceIdentity, validateContinuationPrepare, importNativeContinuation, appendNativeContinuationMarker, captureNativeContinuationPolicySync, CONTINUATION_AUTHORITY_INSTRUCTION, type NativeContinuationAdmission, type NativeContinuationPolicy, type NativeContinuationPrepare } from '../native-continuation.js';
import { parseNativeContinuationCommand, createClankersControl } from '../index.js';
import { createClankersSubagentRunSnapshot, getSubagentRunSnapshot, getSubagentRunSnapshots, normalizeNativeContinuationLineage } from '../state.js';
import { recoverClankersStateAfterRestart } from '../persistence.js';
import { createClankersState, upsertTask, applyRuntimeTransition } from '../state.js';
import { readNativeHistory, type NativeHistory } from '../native-history.js';
import type { ClankersNativeSessionReference } from '../types.js';

function harness() {
  const id = randomUUID();
  const ref: ClankersNativeSessionReference = { schemaVersion: 1, parentRunId: `parent-${id}`, memberRunId: `member-${id}`,
    agentDefinitionId: 'worker', piSessionId: id, sessionFile: `/tmp/${id}.jsonl`, cwd: '/tmp', createdAt: '2026-10-03T12:00:00.000Z', attachment: 'disposed' };
  const policy: NativeContinuationPolicy = { schemaVersion: 1, definition: { id: 'worker', label: 'Worker', prompt: 'CURRENT policy', source: 'runtime', model: 'local/model', tools: ['read'], disallowedTools: ['bash'], permissionMode: 'automatic' },
    model: 'local/model', cwd: '/tmp', thinkingLevel: 'off', authorityInstruction: CONTINUATION_AUTHORITY_INSTRUCTION,
    toolPolicy: { tools: ['read'], excludeTools: ['bash'], activeTools: ['read'], customTools: [] }, resourcePolicy: 'normal-default-resource-loader', inputs: [], context: [] };
  const history: NativeHistory = { header: { type: 'session', version: 3, id, cwd: '/tmp', timestamp: ref.createdAt },
    entries: [{ type: 'custom', id: 'marker', parentId: null, timestamp: ref.createdAt, customType: 'pi-clankers/native-session/v1', data: nativeSourceIdentity(ref) },
      { type: 'message', id: 'selected', parentId: 'marker', timestamp: ref.createdAt, message: { role: 'user', content: 'historical context', timestamp: 1 } }],
    fingerprint: { sha256: 'a'.repeat(64), dev: 1, ino: 1, size: 100, mtimeMs: 1, ctimeMs: 1 } };
  const input: NativeContinuationPrepare = { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId, entryId: 'selected', body: '  /skill:literal\nnew task\t  ' };
  let blocked = false, time = 1_000, reads = 0, policies = 0;
  let onPolicy: (() => void) | undefined;
  const admissions: NativeContinuationAdmission[] = [];
  const service = createNativeContinuationService({ references: () => [ref], blocked: () => blocked,
    policy: async () => { policies++; onPolicy?.(); return structuredClone(policy); },
    readHistory: async () => { reads++; return structuredClone(history); }, now: () => new Date(time),
    launch: (admission) => { admissions.push(admission); return { runId: `new-${id}`, taskId: `task-${id}` }; } });
  return { ref, policy, history, input, service, admissions, reads: () => reads, policies: () => policies,
    block: () => { blocked = true; }, advance: () => { time += 300_001; }, onPolicy: (fn: () => void) => { onPolicy = fn; },
    cleanup: () => { for (const admission of admissions) admission.release(); service.dispose(); } };
}

test('nonexecuting prepare preserves literal body, defensively copies review, and starts exactly once', async () => {
  const h = harness();
  try {
    const review = await h.service.prepare(h.input);
    assert.equal(review.body, h.input.body);
    assert.equal(h.admissions.length, 0);
    assert.ok(h.reads() >= 2);
    assert.equal(review.policyDigest, continuationDigest(h.policy));
    review.policy.definition.prompt = 'MUTATED caller copy';
    const started = await h.service.start({ reviewId: review.reviewId, confirm: true });
    assert.notEqual(started.runId, h.ref.parentRunId);
    assert.equal(h.admissions[0]!.review.policy.definition.prompt, 'CURRENT policy');
    assert.equal(h.admissions[0]!.review.body, h.input.body);
    await assert.rejects(h.service.start({ reviewId: review.reviewId, confirm: true }), /consumed|missing/i);
    assert.equal(h.admissions.length, 1);
  } finally { h.cleanup(); }
});

for (const kind of ['definition', 'source-bytes', 'source-inode', 'reference'] as const) {
  test(`continuation rejects ${kind} drift and consumes failed token without replay`, async () => {
    const h = harness();
    try {
      const review = await h.service.prepare(h.input);
      if (kind === 'definition') h.policy.definition.prompt = 'changed';
      if (kind === 'source-bytes') h.history.fingerprint.sha256 = 'b'.repeat(64);
      if (kind === 'source-inode') h.history.fingerprint.ino++;
      if (kind === 'reference') h.ref.createdAt = '2026-10-03T12:01:00.000Z';
      await assert.rejects(h.service.start({ reviewId: review.reviewId, confirm: true }), /changed/i);
      await assert.rejects(h.service.start({ reviewId: review.reviewId, confirm: true }), /missing|consumed/i);
      assert.equal(h.admissions.length, 0);
    } finally { h.cleanup(); }
  });
}

for (const kind of ['readonly', 'expired', 'discarded', 'disposed', 'other-owner', 'cancelled'] as const) {
  test(`continuation admission blocks ${kind} without execution`, async () => {
    const h = harness(), other = harness();
    try {
      const review = await h.service.prepare(h.input);
      if (kind === 'readonly') h.block();
      if (kind === 'expired') h.advance();
      if (kind === 'discarded') h.service.discard({ reviewId: review.reviewId });
      if (kind === 'disposed') h.service.dispose();
      const signal = kind === 'cancelled' ? AbortSignal.abort() : undefined;
      await assert.rejects((kind === 'other-owner' ? other.service : h.service).start({ reviewId: review.reviewId, confirm: true }, signal));
      assert.equal(h.admissions.length, 0);
    } finally { h.cleanup(); other.cleanup(); }
  });
}

test('prepare remains inspection in readonly; start gates after an asynchronous policy await', async () => {
  const h = harness();
  try {
    const review = await h.service.prepare(h.input);
    h.onPolicy(() => h.block());
    await assert.rejects(h.service.start({ reviewId: review.reviewId, confirm: true }), /read-only/);
    assert.equal(h.admissions.length, 0);
  } finally { h.cleanup(); }
  const readonly = harness();
  try { readonly.block(); assert.ok((await readonly.service.prepare(readonly.input)).reviewId); }
  finally { readonly.cleanup(); }
});

test('attached source rejects; unconfirmed detached source requires explicit copy acknowledgment', async () => {
  const h = harness();
  try {
    h.ref.attachment = 'attached';
    await assert.rejects(h.service.prepare(h.input), /Attached/);
    h.ref.attachment = 'unavailable';
    await assert.rejects(h.service.prepare(h.input), /acknowledgment/);
    const review = await h.service.prepare({ ...h.input, acknowledgeUnconfirmedSource: true });
    assert.ok(review.warnings.some((text) => /unconfirmed detached/i.test(text)));
  } finally { h.cleanup(); }
});

test('separate tokens never start same-source tasks concurrently; task release permits a later explicit start', async () => {
  const h = harness();
  try {
    const a = await h.service.prepare(h.input), b = await h.service.prepare(h.input);
    const results = await Promise.allSettled([h.service.start({ reviewId: a.reviewId, confirm: true }), h.service.start({ reviewId: b.reviewId, confirm: true })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(h.admissions.length, 1);
    h.admissions[0]!.release();
    const c = await h.service.prepare(h.input);
    await h.service.start({ reviewId: c.reviewId, confirm: true });
    assert.equal(h.admissions.length, 2);
  } finally { h.cleanup(); }
});

test('unsupported nonempty historical system content rejects rather than claiming replace:true restoration', async () => {
  const h = harness();
  try {
    h.history.entries.push({ type: 'message', id: 'legacy', parentId: 'selected', timestamp: h.ref.createdAt, message: { role: 'system', content: 'OLD AUTHORITY', timestamp: 2 } });
    await assert.rejects(h.service.prepare({ ...h.input, entryId: 'legacy' }), /legacy system/);
  } finally { h.cleanup(); }
});

test('new actions reject extra fields/control inputs and require literal explicit confirmation', async () => {
  const h = harness();
  try {
    for (const value of [ { ...h.input, before: true }, { ...h.input, model: 'x/y\u0085' }, { ...h.input, model: `p/${'x'.repeat(513)}` }, { ...h.input, body: 'hi\u009b' }, { ...h.input, acknowledgeUnconfirmedSource: 'yes' } ]) {
      await assert.rejects(h.service.prepare(value as NativeContinuationPrepare));
    }
    assert.doesNotThrow(() => validateContinuationPrepare({ ...h.input, entryId: 'selected.id:valid' }));
    const review = await h.service.prepare(h.input);
    await assert.rejects(h.service.start({ reviewId: review.reviewId, confirm: false } as never));
    await assert.rejects(h.service.start({ reviewId: review.reviewId, confirm: true, mode: 'before' } as never));
    assert.equal(h.admissions.length, 0);
  } finally { h.cleanup(); }
});

test('CLI continuation parity preserves exact literal whitespace and rejects ambiguous modes/duplicate options', () => {
  const body = ' /skill:literal\nline two\t  ';
  const parsed = parseNativeContinuationCommand(`sessions continue prepare p m pi selected --model local/model:high --ack-unconfirmed -- ${body}`);
  assert.ok(parsed && parsed.action === 'session.continuation.prepare');
  assert.equal(parsed.body, body);
  assert.equal(parsed.model, 'local/model:high');
  for (const input of ['sessions continue start token', 'sessions continue start token --confirm --confirm', 'sessions continue prepare p m pi e --before -- body', 'sessions continue prepare p m pi e --model p/m --model p/m -- body']) assert.equal(parseNativeContinuationCommand(input), undefined);
  assert.deepEqual(parseNativeContinuationCommand('sessions continue start token --confirm'), { action: 'session.continuation.start', reviewId: 'token', confirm: true });
  assert.deepEqual(parseNativeContinuationCommand('sessions continue discard token'), { action: 'session.continuation.discard', reviewId: 'token' });
});

test('unsupported custom adapter cannot silently launch a no-history continuation', async () => {
  let launches = 0;
  const control = createClankersControl({}, { subagentAdapter: { kind: 'fake', launch: () => { launches++; return { ok: true, message: 'bad' }; } } });
  try {
    const h = harness();
    const result = await control.execute({ action: 'session.continuation.prepare', ...h.input });
    assert.equal(result.ok, false);
    assert.match(result.error!.message, /unavailable/);
    assert.equal(launches, 0);
    h.cleanup();
  } finally { control.dispose(); }
});

test('exclusive destination import preserves original bytes/tree and records new identity/model/current-authority lineage', async () => {
  const h = harness(), dir = mkdtempSync(join(tmpdir(), 'clankers-cont-copy-'));
  try {
    h.ref.cwd = dir; h.policy.cwd = dir; h.ref.sessionFile = join(dir, 'source.jsonl');
    h.history.header.cwd = dir;
    (h.history.entries[0] as { data: unknown }).data = nativeSourceIdentity(h.ref);
    h.history.entries.push({ type: 'message', id: 'abandoned', parentId: 'marker', timestamp: h.ref.createdAt, message: { role: 'user', content: 'abandoned sibling', timestamp: 2 } });
    const original = [h.history.header, ...h.history.entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    writeFileSync(h.ref.sessionFile, original);
    const review = await h.service.prepare(h.input);
    await h.service.start({ reviewId: review.reviewId, confirm: true });
    const manager = importNativeContinuation(sdk, h.admissions[0]!);
    assert.notEqual(manager.getSessionId(), h.ref.piSessionId);
    assert.notEqual(manager.getSessionFile(), h.ref.sessionFile);
    assert.equal(manager.getHeader()!.parentSession, h.ref.sessionFile);
    assert.equal(manager.getEntries().some((entry) => entry.id === 'abandoned'), true);
    assert.equal(manager.buildSessionContext().model!.provider, 'local');
    assert.equal(manager.buildSessionContext().thinkingLevel, 'off');
    const reference: ClankersNativeSessionReference = { ...h.ref, parentRunId: 'new-parent', memberRunId: 'new-parent', piSessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()! };
    manager.appendCustomEntry('pi-clankers/native-session/v1', nativeSourceIdentity(reference));
    appendNativeContinuationMarker(manager, h.admissions[0]!);
    const own = manager.getEntries().filter((entry) => entry.type === 'custom' && entry.customType === 'pi-clankers/native-continuation/v1');
    assert.equal(own.length, 1);
    assert.equal(readFileSync(h.ref.sessionFile, 'utf8'), original);
  } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('durable lineage is bounded defensive evidence and recovery never restores review authority', () => {
  const h = harness();
  try {
    const lineage = { schemaVersion: 1 as const, source: nativeSourceIdentity(h.ref), entryId: 'selected', sourceFingerprint: h.history.fingerprint.sha256, policyDigest: continuationDigest(h.policy), policy: h.policy };
    const snapshot = createClankersSubagentRunSnapshot({ runId: 'new', agentId: 'worker', taskId: 'task', status: 'running', metadata: { nativeContinuation: lineage } });
    assert.deepEqual(snapshot.nativeContinuation, lineage);
    assert.notEqual(snapshot.nativeContinuation!.policy, h.policy);
    assert.equal(normalizeNativeContinuationLineage({ ...lineage, reviewId: 'replay' }), undefined);
    assert.equal(normalizeNativeContinuationLineage({ ...lineage, policy: { ...h.policy, definition: { ...h.policy.definition, prompt: 'x'.repeat(40_000) } } }), undefined);
    let state = upsertTask(createClankersState(), { id: 'task', title: 'NEW task', ownerAgentId: 'clankers-new', status: 'running', updatedAt: h.ref.createdAt });
    state = applyRuntimeTransition(state, { entity: 'agent', action: 'start', id: 'clankers-new', kind: 'subagent', metadata: { taskId: 'task', nativeContinuation: lineage } });
    const projected = getSubagentRunSnapshot(state, 'clankers-new');
    assert.deepEqual(projected?.nativeContinuation, lineage);
    assert.deepEqual(getSubagentRunSnapshots(state)[0]?.nativeContinuation, lineage);
    projected!.nativeContinuation!.policy.definition.prompt = 'Caller mutation';
    assert.equal(getSubagentRunSnapshot(state, 'clankers-new')?.nativeContinuation?.policy.definition.prompt, 'CURRENT policy');
    const recovered = recoverClankersStateAfterRestart(state).state;
    assert.equal(recovered.agents['clankers-new']!.status, 'needs-attention');
    assert.match(recovered.agents['clankers-new']!.runtime!.substateReason!, /new reviewed task/);
    assert.equal(recovered.tasks.task!.status, 'needs-attention');
    assert.equal(h.admissions.length, 0);
  } finally { h.cleanup(); }
});

test('ordinary >128-file resources use bounded root manifests; credentials/workflow churn is not policy drift', () => {
  const h = harness(), dir = mkdtempSync(join(tmpdir(), 'clankers-cont-policy-'));
  try {
    const agentDir = join(dir, 'agent'), cwd = join(dir, 'project');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true }); mkdirSync(cwd);
    h.ref.cwd = cwd;
    for (let i = 0; i < 150; i++) writeFileSync(join(agentDir, 'extensions', `${i}.ts`), `export const value = ${i};`);
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'low' }));
    writeFileSync(join(agentDir, 'auth.json'), 'SECRET credential');
    mkdirSync(join(agentDir, 'sessions')); writeFileSync(join(agentDir, 'sessions', 'churn'), 'ignored');
    writeFileSync(join(cwd, 'AGENTS.override.md'), 'CURRENT override');
    const stub = { getAgentDir: () => agentDir } as typeof sdk;
    const before = captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy);
    assert.equal(before.thinkingLevel, 'low');
    assert.ok(before.inputs.some((input) => input.path.endsWith('/extensions') && input.entries! >= 151));
    assert.ok(before.inputs.length < 128);
    assert.ok(JSON.stringify(before).length < 32768);
    assert.ok(before.context.some((context) => context.path.endsWith('AGENTS.override.md')));
    assert.equal(JSON.stringify(before).includes('SECRET'), false);
    assert.equal(before.inputs.some((input) => /auth\.json|sessions/.test(input.path)), false);
    writeFileSync(join(agentDir, 'auth.json'), 'REFRESHED credential'); writeFileSync(join(agentDir, 'sessions', 'churn'), 'ignored different');
    assert.equal(continuationDigest(captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy)), continuationDigest(before));
    writeFileSync(join(agentDir, 'extensions', '0.ts'), 'export const changed = true;');
    assert.notEqual(continuationDigest(captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy)), continuationDigest(before));
    symlinkSync(join(agentDir, 'extensions', '0.ts'), join(agentDir, 'extensions', 'linked.ts'));
    assert.doesNotThrow(() => captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy));
    writeFileSync(join(agentDir, 'extensions', 'oversized.ts'), 'x'.repeat(4_194_305));
    assert.throws(() => captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy), /bounded work/);
  } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed setup admission releases source guard; consumed token is never retried implicitly', async () => {
  const h = harness(); let attempts = 0;
  const service = createNativeContinuationService({ references: () => [h.ref], blocked: () => false, policy: async () => h.policy,
    readHistory: async () => h.history, launch: (admission) => { attempts++; if (attempts === 1) throw new Error('setup failed'); admission.release(); return { runId: 'new-run', taskId: 'new-task' }; } });
  try {
    const review = await service.prepare(h.input);
    await assert.rejects(service.start({ reviewId: review.reviewId, confirm: true }), /setup failed/);
    await assert.rejects(service.start({ reviewId: review.reviewId, confirm: true }), /consumed|missing/);
    const next = await service.prepare(h.input);
    await service.start({ reviewId: next.reviewId, confirm: true });
    assert.equal(attempts, 2);
  } finally { service.dispose(); h.cleanup(); }
});
test('actual localhost Pi SDK continuation regression fixture', { timeout: 125_000 }, async () => {
  const fixture = new URL('./fixtures/native-continuation-smoke.mjs', import.meta.url);
  const child = spawn(process.execPath, ['--import', 'tsx', fixture.pathname], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1_048_576); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1_048_576); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, `native continuation SDK fixture failed\n${stdout}\n${stderr}`);
    assert.match(stdout, /PASS native continuation SDK:/);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('normal colon model IDs and recognized thinking suffixes are preserved without quantization confusion', async () => {
  const { splitContinuationModelSpec } = await import('../native-continuation.js');
  const h = harness();
  try {
    assert.deepEqual(splitContinuationModelSpec('ollama/qwen3:8b'), { modelId: 'ollama/qwen3:8b' });
    assert.deepEqual(splitContinuationModelSpec('ollama/qwen3:8b:high'), { modelId: 'ollama/qwen3:8b', thinkingLevel: 'high' });
    for (const model of ['ollama/qwen3:8b', 'ollama/qwen3:8b:high']) assert.doesNotThrow(() => validateContinuationPrepare({ ...h.input, model }));
    assert.throws(() => validateContinuationPrepare({ ...h.input, model: 'ollama/:high' }));
  } finally { h.cleanup(); }
});


for (const extension of ['./extra.ts', '+./extra.ts']) {
  test(`project settings ${extension} binds .pi-relative resource and local package code`, () => {
    const h = harness(), dir = mkdtempSync(join(tmpdir(), 'clankers-cont-relative-'));
    try {
      const agentDir = join(dir, 'agent'), cwd = join(dir, 'project'), projectDir = join(cwd, '.pi');
      mkdirSync(agentDir); mkdirSync(join(projectDir, 'local-package'), { recursive: true });
      h.ref.cwd = cwd;
      writeFileSync(join(projectDir, 'settings.json'), JSON.stringify({ extensions: [extension], packages: [{ source: './local-package' }] }));
      writeFileSync(join(projectDir, 'extra.ts'), 'export const reviewed = 1;');
      writeFileSync(join(cwd, 'extra.ts'), 'WRONG cwd-relative resource');
      writeFileSync(join(projectDir, 'local-package', 'index.ts'), 'export const reviewedPackage = 1;');
      const stub = { ...sdk, getAgentDir: () => agentDir };
      const capture = () => captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy);
      const before = capture();
      assert.ok(before.inputs.some((input) => input.path === join(projectDir, 'extra.ts')));
      assert.ok(before.inputs.some((input) => input.path === join(projectDir, 'local-package')));
      assert.equal(before.inputs.some((input) => input.path === join(cwd, 'extra.ts') || input.path.includes('+')), false);
      writeFileSync(join(cwd, 'extra.ts'), 'WRONG cwd file changed');
      assert.equal(continuationDigest(capture()), continuationDigest(before));
      writeFileSync(join(projectDir, 'extra.ts'), 'export const reviewed = 2;');
      const resourceDrift = capture();
      assert.notEqual(continuationDigest(resourceDrift), continuationDigest(before));
      writeFileSync(join(projectDir, 'local-package', 'index.ts'), 'export const reviewedPackage = 2;');
      assert.notEqual(continuationDigest(capture()), continuationDigest(resourceDrift));
    } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const scope of ['user', 'project'] as const) {
  test(`public read-only ${scope} installed git lookup binds code, removal and installation without npm lookup`, async () => {
    const h = harness(), dir = mkdtempSync(join(tmpdir(), 'clankers-cont-git-policy-'));
    let service: ReturnType<typeof createNativeContinuationService> | undefined;
    try {
      const agentDir = join(dir, 'agent'), cwd = join(dir, 'project'), projectDir = join(cwd, '.pi');
      mkdirSync(agentDir); mkdirSync(projectDir, { recursive: true }); h.ref.cwd = cwd;
      const root = scope === 'user' ? agentDir : projectDir;
      const installed = join(root, 'git', 'github.com', 'example', 'reviewed-resource');
      // Test-owned cache only: no clone, Git command, installation, SDK session or loader.
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'index.ts'), 'export const reviewed = 1;');
      const source = scope === 'user' ? 'git:github.com/example/reviewed-resource@v1' : 'https://github.com/example/reviewed-resource';
      writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [{ source }, 'npm:never-run-a-lookup'], npmCommand: ['FORBIDDEN_NPM_COMMAND'] }));
      const lookups: Array<{ source: string; scope: string }> = [];
      class ReadOnlyPackageManager extends sdk.DefaultPackageManager {
        override getInstalledPath(...args: Parameters<sdk.DefaultPackageManager['getInstalledPath']>) {
          assert.equal(args[0].startsWith('npm:'), false, 'npm lookup must never run during review');
          lookups.push({ source: args[0], scope: args[1] });
          return super.getInstalledPath(...args);
        }
        override async resolve(): Promise<never> { throw new Error('Package resolution forbidden during review'); }
      }
      const stub = { ...sdk, getAgentDir: () => agentDir, DefaultPackageManager: ReadOnlyPackageManager };
      const capture = () => captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy);
      const before = capture();
      assert.deepEqual(lookups, [{ source, scope }]);
      assert.ok(before.inputs.some((input) => input.path === installed && input.entries! >= 2));
      assert.ok(before.inputs.some((input) => input.path === join(root, 'npm', 'node_modules', 'never-run-a-lookup')));
      service = createNativeContinuationService({ references: () => [h.ref], blocked: () => false,
        policy: async () => capture(), readHistory: async () => structuredClone(h.history),
        launch: () => { assert.fail('Changed git code must reject before launch'); } });
      const review = await service.prepare(h.input);
      writeFileSync(join(installed, 'index.ts'), 'export const reviewed = 2;');
      const codeDrift = capture();
      assert.notEqual(continuationDigest(codeDrift), continuationDigest(before));
      await assert.rejects(service.start({ reviewId: review.reviewId, confirm: true }), /policy changed/i);
      rmSync(installed, { recursive: true });
      const absent = capture();
      assert.notEqual(continuationDigest(absent), continuationDigest(codeDrift));
      assert.ok(absent.inputs.some((input) => input.path === join(root, 'git')));
      const absentReview = await service.prepare(h.input);
      // Host/owner ancestors still exist: absence binding must notice a nested checkout.
      mkdirSync(installed); writeFileSync(join(installed, 'index.ts'), 'export const installedLater = 3;');
      assert.notEqual(continuationDigest(capture()), continuationDigest(absent));
      await assert.rejects(service.start({ reviewId: absentReview.reviewId, confirm: true }), /policy changed/i);
      assert.equal(lookups.every((lookup) => lookup.source === source && lookup.scope === scope), true);
    } finally { service?.dispose(); h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });
}


for (const scope of ['global', 'cwd', 'ancestor'] as const) {
  test(`oversized ${scope} preferred context is bounded before any public context helper`, () => {
    const h = harness(), dir = mkdtempSync(join(tmpdir(), 'clankers-cont-context-bound-'));
    try {
      const agentDir = join(dir, 'agent'), cwd = join(dir, 'project');
      mkdirSync(agentDir); mkdirSync(cwd); h.ref.cwd = cwd;
      const root = scope === 'global' ? agentDir : scope === 'cwd' ? cwd : dir;
      const stub = { ...sdk, getAgentDir: () => agentDir,
        loadProjectContextFiles: (): never => { assert.fail('Preparation must not invoke unbounded pathname context reads'); } };
      writeFileSync(join(root, 'AGENTS.md'), 'CURRENT bounded fallback');
      const capture = () => captureNativeContinuationPolicySync(stub, h.ref, h.policy.definition, 'local/model', h.policy.toolPolicy);
      assert.ok(capture().context.some((context) => context.path === join(root, 'AGENTS.md')));
      writeFileSync(join(root, 'AGENTS.override.md'), 'x'.repeat(4_194_305));
      assert.throws(capture, /bounded work/);
    } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a repeated old admission release cannot unlock a newer same-source task', async () => {
  const h = harness();
  try {
    const first = await h.service.prepare(h.input);
    await h.service.start({ reviewId: first.reviewId, confirm: true });
    h.admissions[0]!.release();
    const second = await h.service.prepare(h.input);
    await h.service.start({ reviewId: second.reviewId, confirm: true });
    h.admissions[0]!.release();
    const competing = await h.service.prepare(h.input);
    await assert.rejects(h.service.start({ reviewId: competing.reviewId, confirm: true }), /already starting\/running/);
    assert.equal(h.admissions.length, 2);
  } finally { h.cleanup(); }
});

test('faulty supplied review-service disposal cannot block native owner cleanup', () => {
  let disposals = 0;
  const control = createClankersControl({}, { nativeContinuationService: {
    prepare: async () => { throw new Error('No preparation expected'); },
    start: async () => { throw new Error('No start expected'); },
    discard: () => undefined,
    dispose: () => { disposals++; throw new Error('Injected review cleanup fault'); },
  } });
  assert.doesNotThrow(() => control.dispose());
  assert.doesNotThrow(() => control.dispose());
  assert.equal(disposals, 1);
});
