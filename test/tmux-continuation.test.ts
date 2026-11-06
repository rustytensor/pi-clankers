import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createTmuxContinuationService, type TmuxContinuationSource, type TmuxContinuationAdmission } from '../tmux-continuation.js';

// Independent fixture: old evidence ANSWER=42, new literal assignment Explainonly.
const source: TmuxContinuationSource = {
  key: { backend: 'tmux', workerId: 'old-worker', sessionId: 'old-session', generation: 'old-generation', epoch: 3, jobId: 'old-job', runId: 'old-run', taskId: 'old-task', resultDigest: createHash('sha256').update('"ANSWER=42"').digest('hex') },
  agentId: 'worker', originalTask: 'Compute six times seven', resultText: 'ANSWER=42', settled: true, complete: true,
};
const initialPolicy = { definition: { id: 'worker', model: 'fixture/current', tools: ['read'] }, trust: true, resources: 'fixed-fingerprint' };
function fixture(factory = createTmuxContinuationService) {
  let time = 0, blocked = false, launches = 0, preflights = 0;
  let evidence: TmuxContinuationSource | undefined = structuredClone(source);
  let policy = structuredClone(initialPolicy);
  let duringPreflight: (() => void) | undefined;
  let last: TmuxContinuationAdmission | undefined;
  const service = factory({
    now: () => time,
    source: () => evidence,
    policy: () => policy,
    assertAuthority() { if (blocked) throw new Error('read-only/current policy refused'); },
    async preflight(admission) { preflights++; admission.assertCurrent(); duringPreflight?.(); await Promise.resolve(); admission.assertCurrent(); },
    launch(admission) { admission.assertCurrent(); last = admission; launches++; return { workerId: `new-worker-${launches}`, sessionId: `new-session-${launches}`, runId: `new-run-${launches}`, taskId: `new-task-${launches}` }; },
  });
  const prepare = () => service.prepare({ source: structuredClone(source.key), task: 'Explainonly' });
  return { service, prepare, get launches() { return launches; }, get preflights() { return preflights; }, get last() { return last; }, get evidence() { return evidence; },
    expire() { time += 300_000; }, block() { blocked = true; },
    driftPolicy() { policy = { ...policy, resources: 'changed' }; },
    driftSource() { evidence = evidence && { ...evidence, originalTask: 'changed' }; },
    unavailable() { evidence = undefined; },
    clipped() { evidence = { ...source, complete: false } as unknown as TmuxContinuationSource; },
    oversized() { evidence = { ...source, originalTask: 'x'.repeat(32768) }; },
    during(fn: () => void) { duringPreflight = fn; },
  };
}
async function duplicateOracle(factory = createTmuxContinuationService) {
  const f = fixture(factory);
  const review = f.prepare();
  const input = { reviewId: review.reviewId, confirm: true as const };
  const first = f.service.start(input);
  await assert.rejects(f.service.start(input), /consumed/);
  await first;
  assert.equal(f.launches, 1);
}
test('tmux result-context admission: exact copy, one use, current policy and bounded refusal', async () => {
  const f = fixture();
  const oldBytes = JSON.stringify(f.evidence);
  const review = f.prepare();
  assert.equal(f.launches, 0); assert.equal(f.preflights, 0);
  assert.equal(review.resultContext, 'ANSWER=42');
  assert.equal(review.task, 'Explainonly');
  assert.equal(review.originalTask, 'Compute six times seven');
  assert.match(review.prompt, /UNTRUSTED/); assert.match(review.prompt, /NOT full history/);
  assert.deepEqual(JSON.parse(review.prompt.split('\n')[1]), { untrustedResultContext: { originalTask: 'Compute six times seven', result: 'ANSWER=42' }, newLiteralTask: 'Explainonly' });
  assert.equal(JSON.stringify(review).includes('ownerNonce'), false);
  const expectedPrompt = review.prompt;
  review.prompt = 'tampered external review';
  const result = await f.service.start({ reviewId: review.reviewId, confirm: true });
  assert.deepEqual(result, { workerId: 'new-worker-1', sessionId: 'new-session-1', runId: 'new-run-1', taskId: 'new-task-1' });
  assert.equal(f.last?.review.prompt, expectedPrompt);
  assert.equal(f.launches, 1); assert.equal(JSON.stringify(f.evidence), oldBytes);
  await assert.rejects(f.service.start({ reviewId: review.reviewId, confirm: true }), /consumed/);
  await duplicateOracle();
  for (const invalidate of ['expire', 'block', 'driftPolicy', 'driftSource', 'unavailable'] as const) {
    const rejected = fixture(); const pending = rejected.prepare(); rejected[invalidate]();
    await assert.rejects(rejected.service.start({ reviewId: pending.reviewId, confirm: true }));
    await assert.rejects(rejected.service.start({ reviewId: pending.reviewId, confirm: true }), /consumed/);
    assert.equal(rejected.launches, 0);
  }
  for (const invalidate of ['block', 'driftPolicy', 'driftSource', 'expire'] as const) {
    const rejected = fixture(); const pending = rejected.prepare(); rejected.during(() => rejected[invalidate]());
    await assert.rejects(rejected.service.start({ reviewId: pending.reviewId, confirm: true }));
    assert.equal(rejected.launches, 0);
  }
  const disposed = fixture(); const pending = disposed.prepare(); disposed.service.dispose();
  await assert.rejects(disposed.service.start({ reviewId: pending.reviewId, confirm: true })); assert.equal(disposed.launches, 0);
  for (const invalidate of ['unavailable', 'clipped', 'oversized'] as const) {
    const rejected = fixture(); rejected[invalidate](); assert.throws(() => rejected.prepare());
    assert.equal(rejected.launches, 0); assert.equal(rejected.preflights, 0);
  }
  const cap = fixture(); const first = cap.prepare();
  for (let i = 1; i < 16; i++) cap.prepare();
  assert.throws(() => cap.prepare(), /16/);
  cap.service.discard({ reviewId: first.reviewId }); cap.prepare();
  assert.equal(cap.launches, 0);

  // Plant the exact nonconsumption fault in a throwaway in-memory module, never in runtime source.
  const original = await readFile(new URL('../tmux-continuation.ts', import.meta.url), 'utf8');
  const needle = 'tokens.delete(input.reviewId); // Consume before';
  assert.equal(original.split(needle).length, 2);
  const faulty = original.replace(needle, '/* planted nonconsumption */ // Consume before');
  const js = ts.transpileModule(faulty, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64')) as { createTmuxContinuationService: typeof createTmuxContinuationService };
  await assert.rejects(duplicateOracle(mutant.createTmuxContinuationService), /Missing expected rejection/);
});
