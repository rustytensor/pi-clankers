/**
 * Stage 8E focused test: automation ledger, event lookup, reservation, projection and pruning.
 *
 * Owns ONLY pure validator/policy behaviour for the automation event ledger.
 * No runner, scheduler, native bridge, real provider, real workflow execution or
 * persistence write is exercised. The reservation hook is validated, never
 * granted replay or recovery authority.
 *
 * Source: s8e-kernel-impl staged automation-admission.ts and the matching
 * s8e-profile-impl staged automation-profile.ts pure validators.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_LEDGER_BYTES, AUTOMATION_EXTENSION_KEY,
  createAutomationLedger, lookupAutomationEvent, projectAutomationEvent, pruneAutomationEvents,
  reserveAutomationEvent, validateAutomationLedger, validateAutomationReservation,
} from '../automation-admission.js';
import type { AutomationLedgerV1, AutomationEventBindingV1, AutomationLookup } from '../automation-admission.js';
import { AUTOMATION_PROFILE_BOUNDS } from '../automation-profile.js';
import type { AutomationProfileV1, AutomationRequestV1 } from '../automation-profile.js';
import {
  createReadOnlyReviewDefinition, freezeWorkflowData, normalizeWorkflowAgent, validateReviewInputs,
  workflowHash,
} from '../workflow-model.js';
import type { WorkflowJson, WorkflowRun, WorkflowState } from '../workflow-model.js';
import type { ClankersAgentDefinition } from '../types.js';

const PROFILE_ID = 'p1';
const FIXED_INPUTS: WorkflowJson = { candidatePaths: ['a.txt'], scope: 'Inspect' };

function buildAgent(): ClankersAgentDefinition { return { id: 'generalist', label: 'G', prompt: 'P', source: 'builtin' }; }
function buildReviewer(): ClankersAgentDefinition { return { id: 'reviewer', label: 'R', prompt: 'P', source: 'builtin' }; }
function buildDefinition() {
  return createReadOnlyReviewDefinition({ discover: 'generalist', reviewer: 'reviewer', verifier: 'reviewer' });
}
function buildProfileAgents(extra: ClankersAgentDefinition[] = []): ClankersAgentDefinition[] {
  return freezeWorkflowData([buildAgent(), buildReviewer(), ...extra].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) as unknown as ClankersAgentDefinition[];
}
function buildProfileHashInputs() {
  return {
    projectRoot: '/tmp/auto', snapshotFile: '/tmp/auto/snap.json',
    agentDir: '/tmp/auto/agent', sessionDir: '/tmp/auto/session',
  };
}
function buildProfile(over: Partial<AutomationProfileV1> = {}): AutomationProfileV1 {
  const def = buildDefinition();
  const base: AutomationProfileV1 = {
    version: 1, id: PROFILE_ID, enabled: true, approvedProfileHash: '0'.repeat(64),
    ...buildProfileHashInputs(),
    definition: def, definitionId: def.id, definitionHash: workflowHash(def),
    fixedInputs: FIXED_INPUTS, readPaths: ['a.txt'], agents: buildProfileAgents(),
    modelPolicy: { provider: 'mock', id: 'gpt-x', thinkingLevel: 'off' },
    credentialSourceRef: { kind: 'env', name: 'KEY' }, modelConfigFile: null,
    limits: {
      maxEventAgeMs: 86_400_000, maxFutureSkewMs: 300_000, minIntervalMs: 1,
      maxRetainedEvents: 4, maxRunMs: 60_000, maxCleanupMs: 5_000,
      maxOutputBytes: 4096, maxReadBytes: 4096, maxAdmissions: 16, maxProviderRequests: 4, concurrency: 1,
    },
  };
  const merged = { ...base, ...over } as AutomationProfileV1;
  merged.definitionHash = workflowHash(merged.definition);
  merged.approvedProfileHash = workflowHash(merged.definition); // simplify for hash test
  return merged;
}
function buildRun(profile: AutomationProfileV1, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const def = profile.definition;
  validateReviewInputs(FIXED_INPUTS);
  const runAgents = Object.fromEntries(profile.agents.map(a => [a.id, normalizeWorkflowAgent(a)])) as unknown as Record<string, ClankersAgentDefinition>;
  return {
    workflowRunId: 'w1', familyId: 'w1', attemptNo: 1, definition: def, definitionHash: profile.definitionHash,
    inputs: FIXED_INPUTS, agents: runAgents, concurrency: 1, status: 'running',
    createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z',
    admissions: 0, cleanupSettled: true, recovered: false,
    steps: def.steps.map(s => ({ id: s.id, status: 'queued', units: [] })),
    ...over,
  };
}
function buildRequest(occurrence: string, profileId: string = PROFILE_ID): AutomationRequestV1 {
  return { version: 1, profileId, eventId: occurrence, occurrenceTime: occurrence };
}
const ISO = (d: Date): string => d.toISOString();
const NOW_MS = Date.parse('2026-10-06T12:00:00.000Z');
const OCCURRENCE = ISO(new Date(NOW_MS));
const DUP_OCC = ISO(new Date(NOW_MS - 1));
function makeBinding(profile: AutomationProfileV1, over: Partial<AutomationEventBindingV1> = {}): AutomationEventBindingV1 {
  return {
    eventId: OCCURRENCE, occurrenceTime: OCCURRENCE, profileGenerationHash: profile.approvedProfileHash,
    definitionHash: profile.definitionHash, fixedInputsHash: workflowHash(profile.fixedInputs),
    workflowRunId: 'w1', familyId: 'w1', attemptNo: 1, ownerGeneration: 'g1', acceptedAt: NOW_MS, ...over,
  };
}
function makeLedger(profile: AutomationProfileV1, events: AutomationEventBindingV1[] = [], over: Partial<AutomationLedgerV1> = {}): AutomationLedgerV1 {
  const namespace = workflowHash({ profileId: profile.id, projectRoot: profile.projectRoot, snapshotFile: profile.snapshotFile });
  return validateAutomationLedger({
    version: 1, namespace, profileId: profile.id,
    projectRoot: profile.projectRoot, snapshotFile: profile.snapshotFile,
    profileGenerationHash: profile.approvedProfileHash, rejectBefore: 0,
    lastOccurrence: events.at(-1) ? Date.parse(events.at(-1)!.occurrenceTime) : 0,
    lastAcceptedAt: events.at(-1)?.acceptedAt ?? 0, clockWatermark: events.at(-1)?.acceptedAt ?? 0,
    events, ...over,
  });
}

test('extension key is fixed automation and ledger byte bound is enforced', () => {
  assert.equal(AUTOMATION_EXTENSION_KEY, 'automation');
  assert.equal(AUTOMATION_LEDGER_BYTES, 32_768);
  // Profile request bound is independent of ledger bound.
  assert.equal(AUTOMATION_PROFILE_BOUNDS.requestBytes, 4096);
  assert.ok(AUTOMATION_LEDGER_BYTES > AUTOMATION_PROFILE_BOUNDS.requestBytes);
});

test('createAutomationLedger returns a valid empty ledger bound to profile generation', () => {
  const profile = buildProfile();
  const ledger = createAutomationLedger(profile);
  assert.equal(ledger.version, 1);
  assert.equal(ledger.profileId, profile.id);
  assert.equal(ledger.projectRoot, profile.projectRoot);
  assert.equal(ledger.snapshotFile, profile.snapshotFile);
  assert.equal(ledger.profileGenerationHash, profile.approvedProfileHash);
  assert.equal(ledger.rejectBefore, 0);
  assert.equal(ledger.lastOccurrence, 0);
  assert.equal(ledger.lastAcceptedAt, 0);
  assert.equal(ledger.clockWatermark, 0);
  assert.deepEqual(ledger.events, []);
  // Namespace hash binds profileId + projectRoot + snapshotFile.
  assert.equal(ledger.namespace, workflowHash({ profileId: profile.id, projectRoot: profile.projectRoot, snapshotFile: profile.snapshotFile }));
});

test('validateAutomationLedger rejects every extra/missing field and wrong version', () => {
  const profile = buildProfile(); const base = createAutomationLedger(profile);
  for (const extra of ['extra', 'tampered', 'unknown', 'forbidden']) {
    assert.throws(() => validateAutomationLedger({ ...base, [extra]: 1 }), /Invalid automation metadata fields/);
  }
  for (const key of ['version', 'namespace', 'profileId', 'projectRoot', 'snapshotFile', 'profileGenerationHash', 'rejectBefore', 'lastOccurrence', 'lastAcceptedAt', 'clockWatermark', 'events']) {
    const copy: Record<string, unknown> = { ...base }; delete copy[key];
    assert.throws(() => validateAutomationLedger(copy), /Invalid automation metadata fields/);
  }
  for (const version of [0, 2, -1, 1.5, null, '1', true]) {
    assert.throws(() => validateAutomationLedger({ ...base, version }), /Invalid automation namespace identity/);
  }
});

test('validateAutomationLedger rejects bad namespace, paths, digests and event shapes', () => {
  const profile = buildProfile(); const base = createAutomationLedger(profile);
  // Non-hash namespace.
  assert.throws(() => validateAutomationLedger({ ...base, namespace: 'short' }), /Invalid automation namespace identity/);
  // Hash mismatch with profile (wrong generation).
  assert.throws(() => validateAutomationLedger({ ...base, namespace: 'b'.repeat(64) }), /Automation namespace hash mismatch/);
  // Non-absolute projectRoot.
  assert.throws(() => validateAutomationLedger({ ...base, projectRoot: 'relative' }), /Invalid automation metadata path/);
  // Path contains NUL.
  assert.throws(() => validateAutomationLedger({ ...base, projectRoot: '/tmp/has\0nul' }), /Invalid automation metadata path/);
  // Path too long.
  assert.throws(() => validateAutomationLedger({ ...base, projectRoot: '/' + 'a'.repeat(4096) }), /Invalid automation metadata path/);
  // Time floor negative or non-safe.
  for (const value of [-1, 1.5, '0', null, true]) {
    assert.throws(() => validateAutomationLedger({ ...base, rejectBefore: value }), /Invalid automation time floor/);
  }
  // NaN/Infinity rejected by JSON layer first.
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => validateAutomationLedger({ ...base, rejectBefore: value }), /Nonfinite|Invalid automation time floor/);
  }
  // clockWatermark before lastAcceptedAt.
  assert.throws(() => validateAutomationLedger({ ...base, lastAcceptedAt: 100, clockWatermark: 50 }), /clock floor inconsistent/);
});

test('validateAutomationLedger rejects retention overflow and each event shape violation', () => {
  const profile = buildProfile();
  const tooMany = Array.from({ length: 17 }, (_, i) => makeBinding(profile, { eventId: ISO(new Date(NOW_MS + i)), occurrenceTime: ISO(new Date(NOW_MS + i)) }));
  assert.throws(() => makeLedger(profile, tooMany), /retention bound exceeded/);
  // Bad digest/eventId/occurrenceTime: any one is fatal before admission.
  for (const bad of [{ eventId: 'short' }, { eventId: OCCURRENCE, occurrenceTime: '2026-13-01T00:00:00.000Z' }]) {
    assert.throws(() => makeLedger(profile, [makeBinding(profile, bad)]));
  }
  // Duplicate eventId (== occurrenceTime): collision/order mismatch.
  const dup = makeBinding(profile); assert.throws(() => makeLedger(profile, [dup, dup]), /collision\/order mismatch/);
  // Out-of-order events: the second one has an earlier occurrence.
  const e1 = makeBinding(profile, { eventId: ISO(new Date(NOW_MS + 10)), occurrenceTime: ISO(new Date(NOW_MS + 10)), acceptedAt: NOW_MS + 10 });
  const e2 = makeBinding(profile, { eventId: ISO(new Date(NOW_MS)), occurrenceTime: ISO(new Date(NOW_MS)), acceptedAt: NOW_MS + 11, workflowRunId: 'w2', familyId: 'w2' });
  assert.throws(() => makeLedger(profile, [e1, e2]), /collision\/order mismatch/);
  // Wrong attemptNo / familyId.
  assert.throws(() => makeLedger(profile, [{ ...makeBinding(profile), attemptNo: 2 } as unknown as AutomationEventBindingV1]), /Invalid automation attempt binding/);
  assert.throws(() => makeLedger(profile, [makeBinding(profile, { familyId: 'other', workflowRunId: 'w1' })]), /Invalid automation attempt binding/);
  // Bad acceptedAt ordering vs lastAcceptedAt: a later occurrence with earlier acceptedAt is invalid.
  const t1 = makeBinding(profile, { eventId: ISO(new Date(NOW_MS)), occurrenceTime: ISO(new Date(NOW_MS)), workflowRunId: 'w1', familyId: 'w1', acceptedAt: NOW_MS + 100 });
  const t2 = makeBinding(profile, { eventId: ISO(new Date(NOW_MS + 1)), occurrenceTime: ISO(new Date(NOW_MS + 1)), workflowRunId: 'w2', familyId: 'w2', acceptedAt: NOW_MS });
  assert.throws(() => makeLedger(profile, [t1, t2]), /Invalid automation acceptance time/);
  // Generation hash mismatch.
  assert.throws(() => makeLedger(profile, [makeBinding(profile, { profileGenerationHash: '3'.repeat(64) })]), /Invalid automation event generation\/hash/);
});

test('lookupAutomationEvent returns missing/duplicate/conflict by exact payload hash', () => {
  const profile = buildProfile(); const ledger = createAutomationLedger(profile);
  const request = buildRequest(OCCURRENCE);
  assert.deepEqual(lookupAutomationEvent(ledger, profile, request), { kind: 'missing' });
  // Build a binding that matches profile exactly, then look up.
  const binding: AutomationEventBindingV1 = {
    eventId: OCCURRENCE, occurrenceTime: OCCURRENCE,
    profileGenerationHash: profile.approvedProfileHash, definitionHash: profile.definitionHash,
    fixedInputsHash: workflowHash(profile.fixedInputs),
    workflowRunId: 'w1', familyId: 'w1', attemptNo: 1, ownerGeneration: 'g1', acceptedAt: NOW_MS,
  };
  const stored = makeLedger(profile, [binding]);
  const result = lookupAutomationEvent(stored, profile, request) as Extract<AutomationLookup, { kind: 'duplicate' | 'conflict' }>;
  assert.equal(result.kind, 'duplicate');
  assert.equal(result.binding.workflowRunId, 'w1');
  // Conflict: different profile generation hash. Build the other profile so it shares id/projectRoot/snapshotFile
  // with the stored ledger but has a distinct approvedProfileHash; the binding's profileGenerationHash then differs.
  const otherProfile: AutomationProfileV1 = { ...buildProfile(), approvedProfileHash: 'a'.repeat(64) };
  const conflict = lookupAutomationEvent(stored, otherProfile, request);
  assert.equal(conflict.kind, 'conflict');
  // Conflict: same generation but different inputs (re-use stored, change profile.fixedInputs).
  const altered = lookupAutomationEvent(stored, { ...profile, fixedInputs: { candidatePaths: ['b.txt'], scope: 'Inspect' } }, request);
  assert.equal(altered.kind, 'conflict');
});

test('lookupAutomationEvent rejects namespace, identity and profileId mismatch with no lookup', () => {
  const profile = buildProfile(); const ledger = createAutomationLedger(profile);
  // Different profileId: request identity is rejected, never a lookup.
  assert.throws(() => lookupAutomationEvent(ledger, profile, { ...buildRequest(OCCURRENCE), profileId: 'other' }), /Invalid automation request identity|invalid-request-identity/);
  // eventId !== occurrenceTime.
  assert.throws(() => lookupAutomationEvent(ledger, profile, { version: 1, profileId: PROFILE_ID, eventId: OCCURRENCE, occurrenceTime: ISO(new Date(NOW_MS + 1)) }), /Invalid automation request identity|Invalid automation occurrence|invalid-request-identity|invalid-occurrence/);
  // Different projectRoot in ledger.
  const wrongRoot = createAutomationLedger({ ...profile, projectRoot: '/tmp/other' });
  assert.throws(() => lookupAutomationEvent(wrongRoot, profile, buildRequest(OCCURRENCE)), /Automation namespace mismatch/);
});

test('reserveAutomationEvent happy path appends binding, advances floors and freezes identity', () => {
  const profile = buildProfile(); const run = buildRun(profile);
  const request = buildRequest(OCCURRENCE);
  const ledger = createAutomationLedger(profile);
  const next = reserveAutomationEvent(ledger, profile, request, run, 'g1', NOW_MS);
  assert.equal(next.events.length, 1);
  const b = next.events[0];
  assert.equal(b.eventId, OCCURRENCE);
  assert.equal(b.occurrenceTime, OCCURRENCE);
  assert.equal(b.workflowRunId, 'w1');
  assert.equal(b.familyId, 'w1');
  assert.equal(b.attemptNo, 1);
  assert.equal(b.ownerGeneration, 'g1');
  assert.equal(b.acceptedAt, NOW_MS);
  assert.equal(b.profileGenerationHash, profile.approvedProfileHash);
  assert.equal(b.definitionHash, profile.definitionHash);
  assert.equal(b.fixedInputsHash, workflowHash(profile.fixedInputs));
  assert.equal(next.lastOccurrence, NOW_MS);
  assert.equal(next.lastAcceptedAt, NOW_MS);
  assert.equal(next.clockWatermark, NOW_MS);
  // Repeating the same event is never a new run and never replaces the binding.
  assert.throws(() => reserveAutomationEvent(next, profile, request, run, 'g1', NOW_MS + 5), /duplicate\/conflict never grants replay/);
  // Same eventId/occurrenceTime with different profile generation: conflict, still not a replay.
  const conflictReq = buildRequest(OCCURRENCE);
  const otherProfile: AutomationProfileV1 = { ...buildProfile(), approvedProfileHash: 'a'.repeat(64) };
  const otherRun = buildRun(otherProfile);
  // namespace check in reserveAutomationEvent calls matchingNamespace(ledger, profile) BEFORE the
  // lookup, so a profile with same id/projectRoot/snapshotFile but a different approvedProfileHash
  // is rejected at the namespace level (defence in depth, no replay granted either way).
  assert.throws(() => reserveAutomationEvent(next, otherProfile, conflictReq, otherRun, 'g1', NOW_MS + 1), /namespace|duplicate/);
});

test('reserveAutomationEvent rejects disabled profile and never grants replay even if other checks pass', () => {
  const profile = buildProfile({ enabled: false });
  const run = buildRun(profile);
  const ledger = createAutomationLedger(profile);
  assert.throws(() => reserveAutomationEvent(ledger, profile, buildRequest(OCCURRENCE), run, 'g1', NOW_MS), /Automation profile disabled/);
});

test('reserveAutomationEvent rejects clock rollback, stale/expired/future events and frequency violation', () => {
  const profile = buildProfile();
  const run = buildRun(profile);
  // Clock rollback.
  const prev = createAutomationLedger(profile);
  const advanced = reserveAutomationEvent(prev, profile, buildRequest(OCCURRENCE), run, 'g1', NOW_MS);
  assert.throws(() => reserveAutomationEvent(advanced, profile, buildRequest(ISO(new Date(NOW_MS + 1))), run, 'g1', NOW_MS - 1), /clock rollback/);
  // Expired: event older than maxEventAgeMs.
  const old = buildRequest(ISO(new Date(NOW_MS - 86_400_001)));
  assert.throws(() => reserveAutomationEvent(prev, profile, old, run, 'g1', NOW_MS), /expired/);
  // Future: event beyond maxFutureSkewMs.
  const future = buildRequest(ISO(new Date(NOW_MS + 300_001)));
  assert.throws(() => reserveAutomationEvent(prev, profile, future, run, 'g1', NOW_MS), /expired, stale or future/);
  // Frequency: minIntervalMs not yet elapsed since the last accepted event.
  const tight = buildProfile({ limits: { ...buildProfile().limits, minIntervalMs: 10_000 } });
  const tightRun = buildRun(tight);
  const t1 = reserveAutomationEvent(createAutomationLedger(tight), tight, buildRequest(ISO(new Date(NOW_MS))), tightRun, 'g1', NOW_MS);
  assert.throws(() => reserveAutomationEvent(t1, tight, buildRequest(ISO(new Date(NOW_MS + 1))), tightRun, 'g1', NOW_MS + 1), /frequency limit/);
});

test('reserveAutomationEvent rejects retention full, ownerGeneration and run state violations', () => {
  const profile = buildProfile({ limits: { ...buildProfile().limits, maxRetainedEvents: 1 } });
  const run1 = buildRun(profile);
  const t1 = reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(ISO(new Date(NOW_MS))), run1, 'g1', NOW_MS);
  // No more capacity.
  const r2 = buildRun(profile, { workflowRunId: 'w2', familyId: 'w2' });
  assert.throws(() => reserveAutomationEvent(t1, profile, buildRequest(ISO(new Date(NOW_MS + 1))), r2, 'g2', NOW_MS + 1), /retention full/);
  // bad ownerGeneration
  const base = createAutomationLedger(buildProfile());
  for (const og of ['', 'has space', 'a'.repeat(161), 'no@bad']) {
    assert.throws(() => reserveAutomationEvent(base, buildProfile(), buildRequest(ISO(new Date(NOW_MS))), buildRun(buildProfile()), og, NOW_MS), /Automation reservation requires exact fresh profile attempt/);
  }
  // Run state violations against the fresh-attempt check.
  for (const [label, over] of [
    ['admissions>0', { admissions: 1 }],
    ['recovered', { recovered: true }],
    ['not-running', { status: 'completed' as const }],
    ['attemptNo!=1', { attemptNo: 2 }],
    ['familyId!=workflowRunId', { familyId: 'w2' }],
    ['retryOf', { retryOf: 'w0' }],
    ['recoveryOf', { recoveryOf: 'w0' }],
    ['supersededBy', { supersededBy: 'w2' }],
    ['cleanup-not-settled', { cleanupSettled: false }],
  ] satisfies Array<[string, Partial<WorkflowRun>]>) {
    const p = buildProfile(); const r = buildRun(p, over);
    assert.throws(() => reserveAutomationEvent(createAutomationLedger(p), p, buildRequest(ISO(new Date(NOW_MS))), r, 'g1', NOW_MS), new RegExp(`fresh profile attempt|already started|event/attempt binding`), `${label} should fail`);
  }
  // definition.id mismatch.
  const wrongDefRun = buildRun(profile, { definition: { ...profile.definition, id: 'other' }, definitionHash: workflowHash({ ...profile.definition, id: 'other' }) });
  assert.throws(() => reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(ISO(new Date(NOW_MS))), wrongDefRun, 'g1', NOW_MS), /fresh profile attempt/);
  // Concurrency > limit.
  const tooMany = buildRun(profile, { concurrency: 2 });
  assert.throws(() => reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(ISO(new Date(NOW_MS))), tooMany, 'g1', NOW_MS), /fresh profile attempt/);
  // Agent hash mismatch.
  const wrongAgents = buildRun(profile, { agents: { generalist: { ...buildAgent(), prompt: 'tampered' } } });
  assert.throws(() => reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(ISO(new Date(NOW_MS))), wrongAgents, 'g1', NOW_MS), /fresh profile attempt/);
});

test('reserveAutomationEvent rejects runs that are already started (non-queued or populated)', () => {
  const profile = buildProfile(); const def = profile.definition;
  const started = buildRun(profile, {
    steps: def.steps.map((s, i) => ({ id: s.id, status: i === 0 ? 'running' as const : 'queued' as const, units: [] })),
  });
  assert.throws(() => reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(ISO(new Date(NOW_MS))), started, 'g1', NOW_MS), /already started/);
  const populated = buildRun(profile, { steps: def.steps.map(s => ({ id: s.id, status: 'queued' as const, units: [{ id: 'u1', stepId: s.id, index: 0, status: 'queued' as const, inputHash: 'h', inputs: null, cleanupSettled: true }] })) });
  assert.throws(() => reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(ISO(new Date(NOW_MS))), populated, 'g1', NOW_MS), /already started/);
});

test('validateAutomationReservation accepts the new binding and rejects every namespace/identity/floor rewrite', () => {
  const profile = buildProfile();
  const priorRun = buildRun(profile, { workflowRunId: 'wPrior', familyId: 'wPrior' });
  const run = buildRun(profile);
  // Build a starting ledger with one prior event and a non-zero rejectBefore floor.
  const priorReserved = reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(ISO(new Date(NOW_MS - 1000))), priorRun, 'g0', NOW_MS - 1000);
  const prior = makeLedger(profile, priorReserved.events, { rejectBefore: NOW_MS - 500 });
  // A second reservation on top of the prior ledger gives us a "previous with one event".
  const reserved = reserveAutomationEvent(prior, profile, buildRequest(OCCURRENCE), run, 'g1', NOW_MS);
  // A single-event reservation on a fresh ledger for the "previous undefined" case.
  const solo = reserveAutomationEvent(createAutomationLedger(profile), profile, buildRequest(OCCURRENCE), run, 'g1', NOW_MS);
  // previous undefined and a new ledger with exactly one event: accepted.
  const ok = validateAutomationReservation(undefined, solo, run);
  assert.equal(ok.events.length, 1);
  // previous provided, same delta: previous has 1, reserved has 2: accepted.
  const ok2 = validateAutomationReservation(prior, reserved, run);
  assert.equal(ok2.events.length, 2);
  // events.length not +1: rejected.
  assert.throws(() => validateAutomationReservation(prior, prior, run), /append exactly one event/);
  // Namespace rewrite: the tampered namespace is rejected by the basic ledger validator first.
  const renamed = { ...reserved, namespace: '0'.repeat(64) };
  assert.throws(() => validateAutomationReservation(prior, renamed, run), /namespace hash mismatch|cannot replace namespace/);
  // rejectBefore lowered: rejected (use a valid lower integer).
  const lowReject = { ...reserved, rejectBefore: prior.rejectBefore - 1 };
  assert.throws(() => validateAutomationReservation(prior, lowReject, run), /cannot lower or rewrite floors/);
  // lastOccurrence not strictly greater: caught at the basic ledger validator because the second
  // event's occurrenceTime would exceed the lowered floor.
  const sameLast = { ...reserved, lastOccurrence: prior.lastOccurrence };
  assert.throws(() => validateAutomationReservation(prior, sameLast, run), /collision|cannot lower or rewrite floors/);
  // clockWatermark lowered: caught at the basic validator (clockWatermark < lastAcceptedAt is illegal).
  const lowClock = { ...reserved, clockWatermark: prior.clockWatermark - 1 };
  assert.throws(() => validateAutomationReservation(prior, lowClock, run), /clock floor inconsistent|cannot lower or rewrite floors/);
  // lastAcceptedAt lowered: caught at the basic validator (event.acceptedAt <= ledger.lastAcceptedAt).
  const lowAccepted = { ...reserved, lastAcceptedAt: prior.lastAcceptedAt - 1 };
  assert.throws(() => validateAutomationReservation(prior, lowAccepted, run), /acceptance time|cannot lower or rewrite floors/);
  // Existing event bindings rewritten: caught at the basic validator (bad generation hash).
  const tampered = { ...reserved, events: [{ ...reserved.events[0], profileGenerationHash: '9'.repeat(64) }] };
  assert.throws(() => validateAutomationReservation(prior, tampered, run), /generation\/hash|cannot rewrite existing event bindings/);
  // Binding floor mismatch: the new binding's acceptedAt is lower than the ledger's lastAcceptedAt.
  // The basic validator allows this (event.acceptedAt <= ledger.lastAcceptedAt) but the dedicated
  // "floors mismatch" check fails because binding.acceptedAt must equal ledger.lastAcceptedAt.
  const lastBinding = reserved.events[reserved.events.length - 1];
  const badFloor = { ...reserved, events: [...reserved.events.slice(0, -1), { ...lastBinding, acceptedAt: lastBinding.acceptedAt - 1 }] };
  assert.throws(() => validateAutomationReservation(prior, badFloor, run), /Reservation floors mismatch/);
  // The two-binding floor check (badFloor above) also covers the "last event binding must match
  // lastAcceptedAt" property. No further not-last binding test is required here.
});

test('projectAutomationEvent returns missing/duplicate with a fresh WorkflowView, refuses ambiguous/missing runs', () => {
  const profile = buildProfile();
  const run = buildRun(profile);
  const request = buildRequest(OCCURRENCE);
  const empty = createAutomationLedger(profile);
  const emptyState: WorkflowState = { version: 1, definitions: [profile.definition], runs: [] };
  // missing: lookup-only, no view.
  const missing = projectAutomationEvent(empty, emptyState, profile, request);
  assert.equal(missing.lookup.kind, 'missing');
  assert.equal(missing.view, undefined);
  // Reserved: returns duplicate + view.
  const reserved = reserveAutomationEvent(empty, profile, request, run, 'g1', NOW_MS);
  const projection = projectAutomationEvent(reserved, { ...emptyState, runs: [run] }, profile, request);
  assert.equal(projection.lookup.kind, 'duplicate');
  assert.ok(projection.view);
  assert.equal(projection.view!.workflowRunId, 'w1');
  // Ambiguous (two runs with the same workflowRunId): rejected.
  const twin = buildRun(profile, { workflowRunId: 'w1', familyId: 'w1' });
  assert.throws(() => projectAutomationEvent(reserved, { ...emptyState, runs: [run, twin] }, profile, request), /missing or ambiguous/);
  // Missing run: rejected.
  const other = buildRun(profile, { workflowRunId: 'w1', familyId: 'w1', definition: { ...profile.definition, id: 'other' }, definitionHash: '0'.repeat(64) });
  assert.throws(() => projectAutomationEvent(reserved, { ...emptyState, runs: [other] }, profile, request), /event\/attempt binding mismatch/);
});

test('pruneAutomationEvents removes only safe+expired events and raises rejectBefore monotonically', () => {
  const profile = buildProfile();
  const now = NOW_MS;
  const old = makeBinding(profile, { eventId: ISO(new Date(now - 86_400_001)), occurrenceTime: ISO(new Date(now - 86_400_001)), workflowRunId: 'wOld', familyId: 'wOld', acceptedAt: now - 86_400_001 });
  const fresh = makeBinding(profile, { eventId: ISO(new Date(now)), occurrenceTime: ISO(new Date(now)), workflowRunId: 'w1', familyId: 'w1', acceptedAt: now });
  const oldRun: WorkflowRun = { ...buildRun(profile, { workflowRunId: 'wOld', familyId: 'wOld' }), status: 'completed', cleanupSettled: true, steps: profile.definition.steps.map(s => ({ id: s.id, status: 'completed' as const, units: [] })) };
  const freshRun = buildRun(profile);
  const state: WorkflowState = { version: 1, definitions: [profile.definition], runs: [oldRun, freshRun] };
  const ledger = makeLedger(profile, [old, fresh], { lastOccurrence: Date.parse(fresh.occurrenceTime), lastAcceptedAt: now, clockWatermark: now });
  const pruned = pruneAutomationEvents(ledger, state, profile, now);
  assert.deepEqual(pruned.removedWorkflowRunIds, ['wOld']);
  assert.equal(pruned.ledger.events.length, 1);
  assert.equal(pruned.ledger.events[0].workflowRunId, 'w1');
  // rejectBefore raised to the removed occurrence.
  assert.equal(pruned.ledger.rejectBefore, Date.parse(old.occurrenceTime));
  // runs also dropped.
  assert.equal(pruned.workflows.runs.length, 1);
  assert.equal(pruned.workflows.runs[0].workflowRunId, 'w1');
  // Runs that pass boundRun but are unsafe must NOT be removed. boundRun itself refuses runs with
  // retryOf/recoveryOf/supersededBy/recovery set, so we exercise only the unsafe states that the
  // safe-check evaluates: status not in {completed,failed,cancelled}, cleanupSettled false, or
  // step/unit status queued/running/unverified.
  const unsafeStates: Array<[string, Partial<WorkflowRun>]> = [
    ['status-running', { status: 'running' as const }],
    ['status-cancelling', { status: 'cancelling' as const }],
    ['status-needs-attention', { status: 'needs-attention' as const }],
    ['status-paused', { status: 'paused' as const }],
    ['cleanup-not-settled', { cleanupSettled: false }],
  ];
  for (const [label, over] of unsafeStates) {
    const p = buildProfile();
    // Build the safe settled run from buildRun so its agents/inputs are freezeWorkflowData-clean,
    // then apply the unsafe marker and a settled step shape.
    const completedSteps = p.definition.steps.map(s => ({ id: s.id, status: 'completed' as const, units: [{ id: 'u1', stepId: s.id, index: 0, status: 'completed' as const, inputHash: 'h', inputs: null, cleanupSettled: true }] }));
    const base = buildRun(p, { workflowRunId: 'wKeep', familyId: 'wKeep' });
    // Strip nullable lineage fields so the workflowJson plain-object check passes.
    delete (base as Partial<WorkflowRun>).retryOf;
    delete (base as Partial<WorkflowRun>).recoveryOf;
    delete (base as Partial<WorkflowRun>).supersededBy;
    delete (base as Partial<WorkflowRun>).recovery;
    const safeRun: WorkflowRun = { ...base, status: 'completed', cleanupSettled: true, steps: completedSteps, ...over };
    const k1 = makeBinding(p, { eventId: ISO(new Date(now - 86_400_001)), occurrenceTime: ISO(new Date(now - 86_400_001)), workflowRunId: 'wKeep', familyId: 'wKeep', acceptedAt: now - 86_400_001 });
    const k2 = makeBinding(p, { eventId: ISO(new Date(now)), occurrenceTime: ISO(new Date(now)), workflowRunId: 'w1', familyId: 'w1', acceptedAt: now });
    const l = makeLedger(p, [k1, k2], { lastOccurrence: now, lastAcceptedAt: now, clockWatermark: now });
    // The w1 run is required so the k2 binding resolves; the unsafe marker on safeRun keeps it.
    const w1Run = buildRun(p, { workflowRunId: 'w1', familyId: 'w1' });
    const result = pruneAutomationEvents(l, { version: 1, definitions: [p.definition], runs: [safeRun, w1Run] }, p, now);
    assert.deepEqual(result.removedWorkflowRunIds, [], `${label} should be preserved`);
  }
  // Clock rollback rejected.
  assert.throws(() => pruneAutomationEvents(ledger, state, profile, now - 1), /clock rollback/);
  // Namespace mismatch rejected.
  const otherProfile: AutomationProfileV1 = { ...buildProfile(), id: 'p2', approvedProfileHash: 'b'.repeat(64) };
  assert.throws(() => pruneAutomationEvents(ledger, state, otherProfile, now), /namespace\/profile generation changed/);
});

test('pruneAutomationEvents refuses to evict when ledger events reference a workflow that no longer exists', () => {
  const profile = buildProfile();
  const now = NOW_MS;
  const old = makeBinding(profile, { eventId: ISO(new Date(now - 86_400_001)), occurrenceTime: ISO(new Date(now - 86_400_001)), workflowRunId: 'wOld', familyId: 'wOld', acceptedAt: now - 86_400_001 });
  const fresh = makeBinding(profile, { eventId: ISO(new Date(now)), occurrenceTime: ISO(new Date(now)), workflowRunId: 'w1', familyId: 'w1', acceptedAt: now });
  const freshRun = buildRun(profile);
  const ledger = makeLedger(profile, [old, fresh], { lastOccurrence: Date.parse(fresh.occurrenceTime), lastAcceptedAt: now, clockWatermark: now });
  // wOld is missing from workflows: prune must fail closed rather than guess.
  const state: WorkflowState = { version: 1, definitions: [profile.definition], runs: [freshRun] };
  assert.throws(() => pruneAutomationEvents(ledger, state, profile, now), /missing or ambiguous/);
});

test('concurrent reservation attempts: same event cannot allocate two executable bindings', () => {
  const profile = buildProfile(); const run = buildRun(profile);
  const request = buildRequest(OCCURRENCE);
  const ledger = createAutomationLedger(profile);
  const first = reserveAutomationEvent(ledger, profile, request, run, 'g1', NOW_MS);
  // Simulate two concurrent attempts delivering the same event.
  for (const attempt of ['g1', 'g2', 'gx']) {
    assert.throws(() => reserveAutomationEvent(first, profile, request, run, attempt, NOW_MS + 1), /duplicate\/conflict never grants replay/);
  }
  // And the ledger has exactly one binding.
  assert.equal(first.events.length, 1);
});
