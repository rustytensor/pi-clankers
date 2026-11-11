import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Public JavaScript fixture intentionally has no declaration file.
import { acceptance, assertQuotaReadEvidence } from './fixtures/automation-cli-acceptance.mjs';

const enabled = process.env.CLANKERS_WORKFLOW_AUTOMATION_ACCEPTANCE === 'parent-approved';

// Pure author checks: no acceptance env, SDK, transport, child process or PTY.
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
const quotaOptions = { issuedToolCallIds: ['read0', 'read1', 'read2'], readText: 'SCOPED_ACCEPTANCE_TEXT', successCount: 2, maxReadBytes: 44 };
const readEnd = (id: number, isError = false, readText = quotaOptions.readText) => {
  const text = isError ? 'Operation aborted' : readText;
  return { toolCallId: 'read' + id, isError, textHash: textHash(text), textBytes: Buffer.byteLength(text) };
};

test('pure quota evidence accepts parallel read permutations and all current callers', () => {
  const recorded = [readEnd(0), readEnd(2), readEnd(1, true)];
  // Recorded completion order 0/2/1 and source-order persistence 0/1/2.
  for (const events of [recorded, [recorded[0], recorded[2], recorded[1]], [readEnd(1), readEnd(0), readEnd(2, true)], [readEnd(0, true), readEnd(2), readEnd(1)]]) {
    assert.doesNotThrow(() => assertQuotaReadEvidence(events, quotaOptions));
  }
  const text21 = 'SCOPED_ACCEPTANCE_TEX';
  assert.doesNotThrow(() => assertQuotaReadEvidence([readEnd(2, false, text21), readEnd(0, true), readEnd(1, false, text21)], { ...quotaOptions, readText: text21, maxReadBytes: 42 }));
  assert.doesNotThrow(() => assertQuotaReadEvidence([readEnd(0, true), readEnd(1)], { ...quotaOptions, issuedToolCallIds: ['read0', 'read1'], successCount: 1, maxReadBytes: 25 }));
  assert.doesNotThrow(() => assertQuotaReadEvidence([readEnd(0), { ...readEnd(1, true), textHash: textHash('read-byte-limit'), textBytes: 15 }], { ...quotaOptions, issuedToolCallIds: ['read0', 'read1'], successCount: 1, maxReadBytes: 25 }));
});

test('pure quota evidence rejects invalid IDs, counts, text, budget and refusal', () => {
  const valid = [readEnd(0), readEnd(2), readEnd(1, true)];
  const cases = [
    { name: 'duplicate ID', events: [valid[0], { ...valid[1], toolCallId: 'read0' }, valid[2]] },
    { name: 'missing event', events: valid.slice(0, 2) },
    { name: 'missing ID', events: [valid[0], { ...valid[1], toolCallId: undefined }, valid[2]] },
    { name: 'foreign ID', events: [valid[0], { ...valid[1], toolCallId: 'read3' }, valid[2]] },
    { name: 'wrong success count', events: valid, options: { ...quotaOptions, successCount: 1 } },
    { name: 'wrong issued count', events: valid, options: { ...quotaOptions, issuedToolCallIds: ['read0', 'read1'] } },
    { name: 'foreign issued ID', events: valid, options: { ...quotaOptions, issuedToolCallIds: ['read0', 'read1', 'read3'] } },
    { name: 'wrong success hash', events: [valid[0], { ...valid[1], textHash: textHash('OTHER') }, valid[2]] },
    { name: 'wrong success bytes', events: [valid[0], { ...valid[1], textBytes: 21 }, valid[2]] },
    { name: 'over quota', events: valid, options: { ...quotaOptions, maxReadBytes: 43 } },
    { name: 'quota still permits read', events: valid, options: { ...quotaOptions, maxReadBytes: 66 } },
    { name: 'extra error', events: [valid[0], readEnd(2, true), valid[2]] },
    { name: 'extra event', events: [...valid, readEnd(3, true)] },
    { name: 'missing refusal', events: [valid[0], valid[1], readEnd(1)] },
    { name: 'invalid error flag', events: [valid[0], { ...valid[1], isError: undefined }, valid[2]] },
    { name: 'refusal contains approved text', events: [valid[0], valid[1], { ...readEnd(1), isError: true }] },
    { name: 'unrecognized refusal', events: [valid[0], valid[1], { ...valid[2], textHash: textHash('OTHER') }] },
    { name: 'empty refusal', events: [valid[0], valid[1], { ...valid[2], textBytes: 0 }] },
    { name: 'wrong refusal bytes', events: [valid[0], valid[1], { ...valid[2], textBytes: 18 }] },
  ];
  for (const { name, events, options = quotaOptions } of cases) {
    assert.throws(() => assertQuotaReadEvidence(events, options), assert.AssertionError, name);
  }
});

test('explicit opt-in owned-loopback actual automation CLI/SDK acceptance', { skip: !enabled, timeout: 180000 }, async t => {
  // This selector belongs to the trusted test operator, never to an automation event.
  // Copy a declared installed dependency closure here to test a packed layout offline.
  const layout = resolve(process.env.CLANKERS_AUTOMATION_PACKAGE_ROOT ?? fileURLToPath(new URL('../', import.meta.url)));
  const evidence = process.env.CLANKERS_AUTOMATION_ACCEPTANCE_EVIDENCE ?? mkdtempSync(resolve(tmpdir(), 's8e-final-b2-evidence-'));
  const focus = process.env.S8E_ACCEPTANCE_FOCUS;
  assert.ok(focus === undefined || focus === 'quota-outcome');
  const result = await acceptance(layout, evidence, focus);
  for (const scenario of result.results) await t.test(scenario.name, () => assert.equal(scenario.pass, true, scenario.error));
  assert.equal(result.failed, 0);
  assert.equal(result.passed, focus === 'quota-outcome' ? 5 : 23);
  assert.ok(['1.0.0', '1.0.4'].includes(result.sdkVersion), `Unreviewed SDK ${result.sdkVersion}; obtain a fresh acceptance grant.`);
});
