import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { normalizeWorkflowAgent, workflowHash } from '../workflow-model.js';
import {
  captureAssistantResultText, createWriteEvidence, lookupAgentResult, lookupAgentResults,
  normalizeResultSchema, retainAgentResult, restoreAgentResults, validateAgentResult,
  type AgentResult, type AgentResultLedger,
} from '../agent-results.js';

// Oracle fixed before execution: ASCII counts include leading/trailing whitespace.
const A = ' \n' + 'A'.repeat(3996) + '\n ';
const B = '\tB' + 'b'.repeat(3996) + '\r\n';
function record(text: string, run = 'run-1'): AgentResult {
  return {
    agent_id: 'a', task_id: 'task-1', run_id: run, member_run_id: run, pi_session_id: 'pi-1',
    state: 'done', stop_reason: 'stop', model: 'fixture/a', final_message: text,
    final_message_chars: text.length, full_available: true, omitted_chars: 0,
    files_changed: [], files_outside_allowed: null, evidence_complete: false, evidence_reasons: [],
    tokens: { input: null, output: null, cache_read: null, cache_write: null },
    context_percent: null, elapsed_seconds: null, validation: { status: 'not_requested', errors: [] },
    result: null, result_available: false, result_omitted: false, historical: false, notice: 'requested',
  };
}
function found(ledger: AgentResultLedger, runId: string, full = false): AgentResult {
  const lookup = lookupAgentResult(ledger, { id: 'a', runId, full });
  assert.equal(lookup.status, 'found');
  if (lookup.status !== 'found') throw new Error('Expected exact retained execution');
  return lookup.result;
}

test('exact text, bounded head/tail preview and historical exact selection', async () => {
  assert.equal(Buffer.byteLength(A), 4000); assert.equal(Buffer.byteLength(B), 4000);
  assert.deepEqual(captureAssistantResultText({ role: 'assistant', content: [
    { type: 'thinking', thinking: 'THINKING_SENTINEL' }, { type: 'text', text: A.slice(0, 2000) },
    { type: 'toolCall', name: 'read', id: 'TOOL_SENTINEL' }, { type: 'text', text: A.slice(2000) },
  ] }), { final_message: A, final_message_chars: 4000, full_available: true, omitted_chars: 0 });
  assert.equal(captureAssistantResultText({ role: 'toolResult', content: [{ type: 'text', text: 'TOOL_OUTPUT_SENTINEL' }] }).final_message, null);
  // 24,008 chars: reserve=28; head=tail=9,986; omitted=4,036.
  const long = 'HEAD' + 'x'.repeat(24_000) + 'TAIL';
  let ledger = retainAgentResult(undefined, record(long));
  const preview = found(ledger, 'run-1');
  assert.equal(preview.final_message, long.slice(0, 9986) + '\n[4036 characters omitted]\n' + long.slice(-9986));
  assert.equal(preview.omitted_chars, 4036); assert.equal(preview.full_available, true);
  assert.equal(found(ledger, 'run-1', true).final_message, long);
  ledger = retainAgentResult(ledger, record(B, 'run-2'));
  assert.deepEqual(lookupAgentResult(ledger, { id: 'a' }), { status: 'ambiguous', selectors: [
    { id: 'a', runId: 'run-1', memberRunId: 'run-1' }, { id: 'a', runId: 'run-2', memberRunId: 'run-2' },
  ] });
  assert.equal(found(ledger, 'run-2', true).final_message, B);
  assert.equal(lookupAgentResult(ledger, { id: 'a', runId: 'run-3' }).status, 'unavailable');
  assert.equal(lookupAgentResult(ledger, { id: 'a', runId: 'run-1', memberRunId: 'run-2' }).status, 'unavailable');
  assert.equal(lookupAgentResults(ledger, ['a', 'missing'], { runId: 'run-2' })[1].status, 'unavailable');
  const restored = restoreAgentResults({ schema_version: 1, records: [{ ...record(A), sessionFile: '/PRIVATE_LOCATOR', cwd: '/PRIVATE_CWD', privateKey: 'PRIVATE_SENTINEL' }] });
  const historical = found(restored, 'run-1', true);
  assert.equal(historical.final_message, A); assert.equal(historical.historical, true);
  assert.equal(historical.notice, 'unavailable'); assert.equal(historical.evidence_complete, false);
  assert.doesNotMatch(JSON.stringify(restored), /PRIVATE_/);
  historical.final_message = 'caller mutation';
  assert.equal(found(restored, 'run-1', true).final_message, A);
  const { createZergControl } = await import('../index.js');
  const control = createZergControl({ extensions: { agentResults: restored } }, {
    subagentAdapter: { kind: 'fake', launch() { assert.fail('Historical results must not replay native work'); } },
  });
  try {
    const response = await control.execute({ action: 'agents.result', id: 'a', runId: 'run-1', full: true });
    assert.deepEqual(response.data, { status: 'found', result: found(restored, 'run-1', true) });
  } finally { control.dispose(); }
});

test('ordinary required boolean schema checks parsed result without coercing raw output', () => {
  // Approved Ajv 8.20.0: bounded offline draft-07 profile; no refs, regex,
  // formats, loading, coercion/defaults/removal. Not arbitrary-schema isolation.
  const schema = normalizeResultSchema({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false });
  assert.deepEqual(validateAgentResult('{"ok":true}', schema), { status: 'valid', errors: [], result: { ok: true } });
  const invalid = '{"ok":"yes"}';
  const checked = validateAgentResult(invalid, schema);
  assert.equal(checked.status, 'schema_mismatch'); assert.equal(checked.result, undefined);
  assert.equal(invalid, '{"ok":"yes"}');
  assert.throws(() => normalizeResultSchema({ type: 'not-a-type' }));
  assert.throws(() => normalizeResultSchema({ $ref: 'https://unused.invalid/schema' }), /Unsupported/);
  const oldAgent = { id: 'reader', label: 'Reader', prompt: 'Read only.', source: 'runtime' as const };
  const legacyBytes = '{"id":"reader","label":"Reader","prompt":"Read only.","source":"runtime"}';
  const legacyHash = createHash('sha256').update(legacyBytes).digest('hex');
  assert.equal(workflowHash(normalizeWorkflowAgent(oldAgent)), legacyHash);
  assert.equal(workflowHash(normalizeWorkflowAgent({ ...oldAgent, result_schema: undefined, may_write: undefined })), legacyHash);
  assert.throws(() => normalizeWorkflowAgent({ ...oldAgent, result_schema: schema }), /Standalone/);
  assert.throws(() => normalizeWorkflowAgent({ ...oldAgent, may_write: [] }), /Standalone/);
});

test('write observations report policy violations without claiming sandbox completeness', () => {
  const evidence = createWriteEvidence('/owned', ['docs/**']);
  for (const [toolCallId, path, isError] of [['outside', 'coord/x.md', false], ['inside', 'docs/ok.md', false], ['duplicate', './coord/x.md', false], ['partial', 'coord/partial.md', true]] as const) {
    evidence.event({ type: 'tool_execution_start', toolName: 'write', toolCallId, args: { path } });
    evidence.event({ type: 'tool_execution_end', toolName: 'write', toolCallId, isError });
  }
  evidence.event({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'shell' });
  evidence.event({ type: 'tool_execution_start', toolName: 'mcp', toolCallId: 'mcp' });
  const observed = evidence.snapshot();
  assert.deepEqual(observed.files_changed, ['coord/x.md', 'docs/ok.md']);
  assert.deepEqual(observed.files_outside_allowed, ['coord/x.md']);
  assert.equal(observed.evidence_complete, false);
  assert(observed.evidence_reasons.some(reason => reason.includes('Bash/MCP')));
  assert(observed.evidence_reasons.some(reason => reason.includes('partial')));
});

test('native public control and actual parent notice transport preserve exact execution results', { timeout: 35_000 }, () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', new URL('./fixtures/agent-results-smoke.mjs', import.meta.url).pathname, '--regression'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env }, timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8',
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /PASS exact native results/);
});
