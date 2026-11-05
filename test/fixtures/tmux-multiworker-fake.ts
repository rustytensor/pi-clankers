// Controlled transport for controller-only acceptance; no processes or SDK work.
import { TmuxWorkerLedger, type TmuxJobResult, type TmuxRequest } from '../../tmux-protocol.js';
import type { TmuxLaunchOptions, TmuxWorkerHandle } from '../../tmux-runner.js';

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export class TmuxLaunchError extends Error {
  cleanup: { closed: boolean; errors: string[] };
  constructor(closed: boolean, errors: boolean) { super('synthetic setup failure'); this.cleanup = { closed, errors: errors ? ['unconfirmed'] : [] }; }
}
export const launches: { options: TmuxLaunchOptions; gate: ReturnType<typeof deferred<TmuxWorkerHandle>> }[] = [];
export async function preflightTmuxWorkerPolicy() { /* Controlled by the launch gate below. */ }
export function createTmuxWorker(options: TmuxLaunchOptions) {
  const gate = deferred<TmuxWorkerHandle>(); launches.push({ options, gate }); return gate.promise;
}
export function fakeWorker(workerId: string) {
  const identity = { workerId, sessionId: `session-${workerId}`, generation: 'test-generation', ownerNonce: 'a'.repeat(64), epoch: 0 };
  const ledger = new TmuxWorkerLedger(identity);
  let sequence = 0, pending: ReturnType<typeof deferred<TmuxJobResult>> | undefined;
  const closeGate = deferred<{ closed: boolean; errors: string[] }>();
  const calls = { prompts: 0, cancels: [] as string[], steers: [] as string[], closes: 0 };
  let inspectionFails = false;
  const request = (action: TmuxRequest['action'], expectedJobId: string | null = null): TmuxRequest => ({ version: 1, requestId: `request-${++sequence}`, identity, action, expectedJobId, job: null, text: null });
  const settle = (text: string, outcome: TmuxJobResult['outcome'] = 'completed') => {
    const job = ledger.snapshot().job;
    if (!job || !pending) throw new Error('No pending job');
    const result = ledger.settle(job, outcome, text, false);
    pending.resolve(result); pending = undefined;
    return result;
  };
  const handle: TmuxWorkerHandle = {
    identity, workerId, sessionId: identity.sessionId, attachCommand: 'synthetic-only',
    get isClosed() { return ledger.snapshot().phase === 'closed'; },
    async inspect(jobId) { if (inspectionFails) throw new Error('synthetic inspection failure'); return ledger.snapshot(jobId); },
    prompt(input) {
      calls.prompts++;
      const reply = ledger.accept({ ...request('prompt'), job: { ...identity, jobId: input.jobId, runId: input.runId, taskId: input.taskId, source: 'coordinator' }, text: input.text });
      if (reply.status !== 'accepted') throw new Error('Prompt refused');
      pending = deferred<TmuxJobResult>(); return pending.promise;
    },
    async cancel(jobId) {
      calls.cancels.push(jobId);
      const reply = ledger.accept(request('cancel', jobId));
      if (reply.status === 'requested') settle('A_PARTIAL', 'aborted');
      return reply;
    },
    async steer(jobId, text) { calls.steers.push(jobId); return ledger.accept({ ...request('steer', jobId), text }); },
    close() { calls.closes++; return closeGate.promise; },
  };
  return { handle, calls, ledger, settle,
    failInspection() { inspectionFails = true; },
    finishClose(clean = true) {
      if (pending) settle('CLOSED_PARTIAL', 'aborted');
      if (clean) ledger.invalidate();
      closeGate.resolve({ closed: clean, errors: clean ? [] : ['unconfirmed'] });
    },
  };
}
