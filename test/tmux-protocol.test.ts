import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TMUX_FRAME_BYTES, TMUX_TEXT_BYTES, TmuxFrameDecoder, TmuxWorkerLedger,
  captureTmuxText, encodeTmuxFrame, parseTmuxRequest, parseTmuxResponse,
  type TmuxIdentity, type TmuxJobIdentity, type TmuxRequest,
} from '../tmux-protocol.js';

// Protocol-only preparation, NOT proof of Pi settlement, process cleanup or a live backend.
const identity: TmuxIdentity = Object.freeze({ workerId: 'worker-one', sessionId: 'pi-one', generation: 'generation-one', ownerNonce: 'a'.repeat(64), epoch: 0 });
const job = (n: number, owner = identity): TmuxJobIdentity => ({ ...owner, jobId: `job-${n}`, runId: `run-${n}`, taskId: `task-${n}`, source: 'coordinator' });
function request(requestId: string, action: TmuxRequest['action'], options: Partial<TmuxRequest> = {}): TmuxRequest {
  return parseTmuxRequest({ version: 1, requestId, identity, action, expectedJobId: null, job: null, text: null, ...options });
}

test('precalculated coordinator/human sequence retains exact immutable coordinator results', () => {
  const ledger = new TmuxWorkerLedger(identity);
  const one = request('request-1', 'prompt', { job: job(1), text: 'COORD_ONE' });
  assert.equal(parseTmuxResponse(ledger.accept(one), one).status, 'accepted');
  const first = ledger.settle(job(1), 'completed', 'COORD_ONE_OK', false);
  const firstBytes = JSON.stringify(first);
  assert.equal(ledger.snapshot().phase, 'idle');
  assert.equal(ledger.snapshot().identity.sessionId, 'pi-one');

  const two = request('request-2', 'prompt', { job: job(2), text: 'WAIT_STEER' });
  assert.equal(ledger.accept(two).status, 'accepted');
  assert.equal(ledger.humanOwnership('human', identity), 'busy');
  const staleSteer = request('stale-steer', 'steer', { expectedJobId: 'job-1', text: 'SHOULD_NOT_RUN' });
  assert.equal(ledger.accept(staleSteer).reason, 'stale_job');
  const steer = request('steer', 'steer', { expectedJobId: 'job-2', text: 'STEER_ONE' });
  assert.equal(ledger.accept(steer).status, 'requested');
  assert.equal(ledger.snapshot('job-2').result, null, 'steer ACK is not settlement');
  const second = ledger.settle(job(2), 'completed', 'STEER_ONE_OK', false);
  const secondBytes = JSON.stringify(second);

  assert.equal(ledger.humanOwnership('human', identity), null);
  const humanOwner = ledger.snapshot().identity;
  assert.equal(humanOwner.epoch, 1);
  const denied = request('human-owned-denial', 'prompt', { identity: humanOwner, job: job(3, humanOwner), text: 'SHOULD_NOT_RUN' });
  const denial = ledger.accept(denied);
  // Planted receipt corruption must fail this exact assertion; never run as a passing test.
  const observedReason = process.env.CLANKERS_TMUX_PROTOCOL_PLANTED_FAULT === '1' ? null : denial.reason;
  assert.equal(observedReason, 'human_owned');
  const humanJob = ledger.beginHuman('human-job', humanOwner);
  assert.equal(ledger.humanOwnership('coordinator', humanOwner), 'busy');
  const human = ledger.settle(humanJob, 'completed', 'HUMAN_ONE_OK', false);
  assert.equal(human.identity.runId, null);
  assert.equal(human.identity.source, 'human');
  assert.equal(ledger.humanOwnership('coordinator', humanOwner), null);
  const returned = ledger.snapshot().identity;
  assert.equal(returned.epoch, 2);

  const three = request('request-3', 'prompt', { identity: returned, job: job(3, returned), text: 'WAIT_CANCEL' });
  assert.equal(ledger.accept(three).status, 'accepted');
  assert.equal(ledger.accept(request('stale-cancel', 'cancel', { identity: returned, expectedJobId: 'job-2' })).reason, 'stale_job');
  assert.equal(ledger.accept(request('stale-epoch', 'cancel', { expectedJobId: 'job-3' })).reason, 'stale_identity');
  assert.equal(ledger.snapshot().job?.jobId, 'job-3');
  const cancel = request('cancel', 'cancel', { identity: returned, expectedJobId: 'job-3' });
  assert.equal(parseTmuxResponse(ledger.accept(cancel), cancel).status, 'requested');
  assert.equal(ledger.snapshot('job-3').result, null, 'cancel ACK is not settlement');
  const third = ledger.settle(job(3, returned), 'aborted', 'PARTIAL_CANCEL', false);
  assert.equal(third.cancelRequested, true);
  assert.equal(third.settled, true);
  assert.deepEqual([first.text, second.text, human.text, third.text], ['COORD_ONE_OK', 'STEER_ONE_OK', 'HUMAN_ONE_OK', 'PARTIAL_CANCEL']);
  assert.equal(JSON.stringify(first), firstBytes);
  assert.equal(JSON.stringify(second), secondBytes);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.identity), true);
  const inspect = request('inspect-first', 'show', { identity: returned, expectedJobId: 'job-1' });
  assert.equal(parseTmuxResponse(ledger.accept(inspect), inspect).snapshot.result?.text, 'COORD_ONE_OK');
  assert.throws(() => ledger.settle(job(1), 'completed', 'OVERWRITE', false), /Stale/);
  assert.equal(ledger.accept(request('reuse-run', 'prompt', { identity: returned, job: { ...job(1, returned), jobId: 'different-job' }, text: 'SHOULD_NOT_RUN' })).reason, 'invalid_request');
  const close = request('close', 'close', { identity: returned });
  assert.equal(ledger.accept(close).status, 'requested');
  assert.equal(ledger.accept(request('after-close', 'prompt', { identity: returned, job: job(4, returned), text: 'SHOULD_NOT_RUN' })).reason, 'closed');
  ledger.invalidate();
  assert.equal(ledger.snapshot('job-1').result?.text, 'COORD_ONE_OK');
  assert.equal(ledger.snapshot().phase, 'closed');
});

test('bounded wire frames reject wrong receipt tuples and preserve escaped text within total byte cap', () => {
  const ledger = new TmuxWorkerLedger(identity);
  const prompt = request('prompt', 'prompt', { job: job(1), text: 'COORD_ONE' });
  const receipt = ledger.accept(prompt);
  const frame = encodeTmuxFrame(receipt);
  const decoder = new TmuxFrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 7)), []);
  assert.equal(parseTmuxResponse(decoder.push(frame.subarray(7))[0], prompt).status, 'accepted');
  decoder.finish();
  assert.throws(() => parseTmuxResponse({ ...receipt, expectedJobId: 'job-2' }, prompt), /Mismatched/);
  assert.throws(() => parseTmuxResponse({ ...receipt, status: 'observed' }, prompt), /receipt state/);
  assert.throws(() => parseTmuxRequest({ ...prompt, extra: true }), /fields/);
  assert.throws(() => parseTmuxRequest({ ...prompt, action: 'takeover' }), /action/);
  assert.equal(ledger.accept(prompt).reason, 'duplicate_request');
  assert.throws(() => ledger.accept(request('wrong-owner', 'show', { identity: { ...identity, ownerNonce: 'b'.repeat(64) } })), /worker binding/);
  assert.throws(() => ledger.accept(request('wrong-generation', 'show', { identity: { ...identity, generation: 'generation-two' } })), /worker binding/);
  assert.throws(() => new TmuxFrameDecoder().push(Buffer.alloc(TMUX_FRAME_BYTES + 1)), /limit/);
  ledger.settle(job(1), 'failed', '\u0000'.repeat(TMUX_TEXT_BYTES), false);
  const show = request('show', 'show', { expectedJobId: 'job-1' });
  const resultFrame = encodeTmuxFrame(ledger.accept(show));
  assert.ok(resultFrame.length <= TMUX_FRAME_BYTES);
  const result = parseTmuxResponse(new TmuxFrameDecoder().push(resultFrame)[0], show).snapshot.result;
  assert.equal(result?.text.length, TMUX_TEXT_BYTES);
  assert.equal(result?.outcome, 'failed');
  assert.equal(result?.telemetry, null);
});

test('idle inspection and leases do not consume the worker mutation budget; newline identifiers refuse', () => {
  const ledger = new TmuxWorkerLedger(identity);
  for (let n = 0; n < 2048; n++) {
    assert.equal(ledger.accept(request(`lease-${n}`, 'lease')).status, 'observed');
    assert.equal(ledger.accept(request(`show-${n}`, 'show')).status, 'observed');
  }
  assert.equal(ledger.accept(request('next-task', 'prompt', { job: job(1), text: 'COORD_ONE' })).status, 'accepted');
  assert.equal(ledger.accept(request('busy-lease', 'lease')).status, 'observed');
  assert.equal(ledger.snapshot().job?.jobId, 'job-1');
  assert.throws(() => request('trailing-newline\n', 'show'), /identifier/);
  assert.throws(() => request('bad-nonce', 'show', { identity: { ...identity, ownerNonce: identity.ownerNonce + '\n' } }), /owner/);
});

test('text-only capture is a bounded UTF-8 prefix rather than unbounded concatenation', () => {
  assert.deepEqual(captureTmuxText([{ type: 'text', text: 'COORD_ONE_OK' }, { type: 'image', data: 'ignored' }]), { text: 'COORD_ONE_OK', clipped: false });
  const captured = captureTmuxText([{ type: 'text', text: '😀'.repeat(TMUX_TEXT_BYTES / 4 + 1) }, { type: 'text', text: 'NOT_A_PREFIX' }]);
  assert.equal(captured.text, '😀'.repeat(TMUX_TEXT_BYTES / 4));
  assert.equal(captured.clipped, true);
});
