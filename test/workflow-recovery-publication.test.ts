import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createClankersControl } from '../index.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { createClankersState, createClankersStateContainer, getAgentDefinition, snapshotClankersState, updateClankersState } from '../state.js';
import type { ClankersState, ClankersStateContainer, ClankersSubagentControlAdapter } from '../types.js';

const workerSeed = () => createClankersState({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', prompt: 'Literal task only.', source: 'runtime' } } });
const ids = { runId: () => 'publication-run', taskId: () => 'publication-task' };
const fakeAdapter = (launch: ClankersSubagentControlAdapter['launch'] = () => ({ ok: true, message: 'accepted' })): ClankersSubagentControlAdapter => ({ kind: 'fake', launch });

function tempRoot() { return mkdtempSync(join(tmpdir(), 'clankers-publication-')); }
function savedState(snapshotFile: string): ClankersState { return (JSON.parse(readFileSync(snapshotFile, 'utf8')) as { state: ClankersState }).state; }
function blockedSnapshotFile(root: string): string {
  const blocker = join(root, 'not-a-directory');
  writeFileSync(blocker, 'blocks mkdir');
  return join(blocker, 'state.json');
}

test('persistence wrapper resolves functional update exactly once before publication', () => {
  const root = tempRoot();
  const snapshotFile = join(root, 'state.json');
  const base = createClankersStateContainer(workerSeed());
  const wrapped = extractControlPersistenceWrapper(base, snapshotFile);
  let calls = 0;
  try {
    const result = wrapped.update((state) => {
      calls += 1;
      return { metadata: { ...state.metadata, updatedAt: '2026-10-05T00:00:00.000Z' } };
    });
    assert.equal(calls, 1);
    assert.equal(result.revision, 1);
    assert.equal(savedState(snapshotFile).revision, 1);
    assert.equal(base.read().revision, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('persistence wrapper replacement preserves replacement revision without duplicate increment', () => {
  const root = tempRoot();
  const snapshotFile = join(root, 'state.json');
  const base = createClankersStateContainer(workerSeed());
  const wrapped = extractControlPersistenceWrapper(base, snapshotFile);
  try {
    const result = wrapped.replace({ ...workerSeed(), revision: 41, selectedNodeId: 'chosen' });
    assert.equal(result.revision, 41);
    assert.equal(base.read().revision, 41);
    assert.equal(savedState(snapshotFile).revision, 41);
    assert.equal(savedState(snapshotFile).selectedNodeId, 'chosen');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('persistent control listeners see publication only after snapshot exists', async () => {
  const root = tempRoot();
  const snapshotFile = join(root, 'state.json');
  const base = createClankersStateContainer(workerSeed());
  const control = createClankersControl(base, { persistence: { snapshotFile }, subagentAdapter: fakeAdapter() });
  const observations: boolean[] = [];
  const unsubscribe = base.subscribe!((state) => {
    if (getAgentDefinition(state, 'extra')) {
      observations.push(existsSync(snapshotFile) && getAgentDefinition(savedState(snapshotFile), 'extra') !== undefined);
    }
  });
  try {
    const result = await control.execute({ action: 'agents.create', id: 'extra', prompt: 'Extra.' });
    assert.equal(result.ok, true);
    assert.deepEqual(observations, [true]);
  } finally { unsubscribe(); control.dispose(); rmSync(root, { recursive: true, force: true }); }
});


test('persistent wrapper refuses synchronous nested writes during commit while allowing observer reads', () => {
  const root = tempRoot();
  const snapshotFile = join(root, 'state.json');
  const base = createClankersStateContainer(workerSeed());
  const wrapped = extractControlPersistenceWrapper(base, snapshotFile);
  let readRevision: number | undefined;
  let nestedMessage = '';
  const unsubscribe = wrapped.subscribe!((state) => {
    readRevision = wrapped.snapshot().revision;
    try { wrapped.replace({ ...state, selectedNodeId: 'nested' }); } catch (error) { nestedMessage = error instanceof Error ? error.message : String(error); }
  });
  try {
    const result = wrapped.replace({ ...workerSeed(), selectedNodeId: 'outer' });
    assert.equal(result.selectedNodeId, 'outer');
    assert.equal(readRevision, result.revision);
    assert.match(nestedMessage, /nested state writes are refused|commit already in progress/i);
    assert.equal(base.read().selectedNodeId, 'outer');
    assert.equal(savedState(snapshotFile).selectedNodeId, 'outer');
  } finally { unsubscribe(); rmSync(root, { recursive: true, force: true }); }
});

test('persistent wrapper refuses functional patch reentrant writes before nested effects', () => {
  const root = tempRoot();
  const snapshotFile = join(root, 'state.json');
  const base = createClankersStateContainer(workerSeed());
  const wrapped = extractControlPersistenceWrapper(base, snapshotFile);
  let nestedMessage = '';
  try {
    const result = wrapped.update((state) => {
      try { wrapped.replace({ ...state, selectedNodeId: 'nested' }); } catch (error) { nestedMessage = error instanceof Error ? error.message : String(error); }
      return { selectedNodeId: 'outer' };
    });
    assert.match(nestedMessage, /nested state writes are refused|commit already in progress/i);
    assert.equal(result.selectedNodeId, 'outer');
    assert.equal(base.read().selectedNodeId, 'outer');
    assert.equal(savedState(snapshotFile).selectedNodeId, 'outer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('persistent wrapper re-saves canonical raw listener mutation and returns it', () => {
  const root = tempRoot();
  const snapshotFile = join(root, 'state.json');
  const base = createClankersStateContainer(workerSeed());
  const wrapped = extractControlPersistenceWrapper(base, snapshotFile);
  let reentered = false;
  const unsubscribe = base.subscribe!(() => {
    if (reentered) return;
    reentered = true;
    const current = base.read();
    base.replace({ ...current, mode: { ...current.mode, readOnly: true } });
  });
  try {
    const result = wrapped.replace({ ...workerSeed(), selectedNodeId: 'outer' });
    assert.equal(result.mode.readOnly, true);
    assert.equal(base.read().mode.readOnly, true);
    assert.equal(savedState(snapshotFile).mode.readOnly, true);
  } finally { unsubscribe(); rmSync(root, { recursive: true, force: true }); }
});

test('persistent wrapper post-publication save failure is honest and leaves canonical publication visible', () => {
  const base = createClankersStateContainer(workerSeed());
  let saves = 0;
  const persistenceManager = {
    hydrate() { return undefined; },
    save() {
      saves += 1;
      if (saves > 1) throw new Error('post publication save failed');
    },
  };
  const wrapped = extractControlPersistenceWrapper(base, 'unused', persistenceManager);
  let reentered = false;
  const unsubscribe = base.subscribe!(() => {
    if (reentered) return;
    reentered = true;
    const current = base.read();
    base.replace({ ...current, mode: { ...current.mode, readOnly: true } });
  });
  try {
    assert.throws(() => wrapped.replace({ ...workerSeed(), selectedNodeId: 'outer' }), /post publication save failed/);
    assert.equal(base.read().mode.readOnly, true);
    assert.equal(base.read().selectedNodeId, 'outer');
    assert.throws(() => wrapped.replace(workerSeed()), /previous failure|commit unavailable/i);
  } finally { unsubscribe(); }
});

test('failed persistent pre-write gives zero native admission and leaves old state visible', async () => {
  const root = tempRoot();
  const snapshotFile = blockedSnapshotFile(root);
  const base = createClankersStateContainer(workerSeed());
  let launches = 0;
  const control = createClankersControl(base, { persistence: { snapshotFile }, idFactory: ids, subagentAdapter: fakeAdapter(() => { launches += 1; return { ok: true, message: 'accepted' }; }) });
  try {
    const before = base.snapshot();
    const result = await control.execute({ action: 'run', agent: 'worker', task: 'must not admit', background: true });
    assert.equal(result.ok, false);
    assert.equal(launches, 0);
    assert.deepEqual(base.snapshot(), before);
  } finally { control.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('persistent commit failure poisons subsequent workflow admission', async () => {
  const root = tempRoot();
  const snapshotFile = blockedSnapshotFile(root);
  const base = createClankersStateContainer(workerSeed());
  let launches = 0;
  const control = createClankersControl(base, { persistence: { snapshotFile }, idFactory: ids, subagentAdapter: fakeAdapter(() => { launches += 1; return { ok: true, message: 'accepted' }; }) });
  try {
    const failed = await control.execute({ action: 'agents.create', id: 'extra', prompt: 'Extra.' });
    assert.equal(failed.ok, false);
    assert.equal(getAgentDefinition(base.read(), 'extra'), undefined);
    const run = await control.execute({ action: 'run', agent: 'worker', task: 'still closed', background: true });
    assert.equal(run.ok, false);
    assert.match(run.error?.message ?? '', /previous failure|commit unavailable/i);
    assert.equal(launches, 0);
    assert.equal(base.read().tasks[ids.taskId()], undefined);
  } finally { control.dispose(); rmSync(root, { recursive: true, force: true }); }
});


test('independent persistent controls for same snapshot keep separate CAS heads and stale writer is blocked', async () => {
  const root = tempRoot();
  const snapshotFile = join(root, 'state.json');
  const firstContainer = createClankersStateContainer(workerSeed());
  const secondContainer = createClankersStateContainer(workerSeed());
  const first = createClankersControl(firstContainer, { persistence: { snapshotFile }, subagentAdapter: fakeAdapter() });
  const second = createClankersControl(secondContainer, { persistence: { snapshotFile }, subagentAdapter: fakeAdapter() });
  try {
    const written = await first.execute({ action: 'agents.create', id: 'first', prompt: 'First.' });
    assert.equal(written.ok, true);
    const stale = await second.execute({ action: 'agents.create', id: 'second', prompt: 'Second.' });
    assert.equal(stale.ok, false);
    assert.match(stale.error?.message ?? '', /stale|snapshot head|previous failure|commit unavailable/i);
    assert.equal(getAgentDefinition(savedState(snapshotFile), 'first')?.prompt, 'First.');
    assert.equal(getAgentDefinition(savedState(snapshotFile), 'second'), undefined);
  } finally { first.dispose(); second.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('non-persistent control keeps existing publication compatibility', async () => {
  const base = createClankersStateContainer(workerSeed());
  const control = createClankersControl(base, { subagentAdapter: fakeAdapter() });
  const seen: ClankersState[] = [];
  const unsubscribe = base.subscribe!((state) => { if (getAgentDefinition(state, 'direct')) seen.push(state); });
  try {
    const result = await control.execute({ action: 'agents.create', id: 'direct', prompt: 'Direct.' });
    assert.equal(result.ok, true);
    assert.equal(getAgentDefinition(base.read(), 'direct')?.prompt, 'Direct.');
    assert.deepEqual(seen.map((state) => getAgentDefinition(state, 'direct')?.prompt), ['Direct.']);
  } finally { unsubscribe(); control.dispose(); }
});

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.ts', indexSource, ts.ScriptTarget.ES2022, true);
function extractControlPersistenceWrapper(baseContainer: ClankersStateContainer, snapshotFile: string, persistenceOverride?: unknown): ClankersStateContainer {
  const owner = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'createClankersControl');
  assert.ok(owner, 'createClankersControl source missing');
  const statements = owner.body?.statements ?? [];
  const start = statements.findIndex((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === 'committingPersistentState'));
  const end = statements.findIndex((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === 'container'));
  assert.ok(start >= 0 && end >= start, 'persistence wrapper source block missing');
  const preparedStart = statements.findIndex((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === 'preparedOwner'));
  const preparedEnd = statements.findIndex((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === 'assertPreparedOwner'));
  assert.ok(preparedStart >= 0 && preparedEnd >= preparedStart, 'prepared owner initialization source missing');
  const source = `${[...statements.slice(preparedStart, preparedEnd + 1), ...statements.slice(start, end + 1)].map((node) => node.getText(parsed)).join('\n')}\nreturn container;`;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const persistenceManager = persistenceOverride ?? createClankersPersistenceManager({ snapshotFile });
  return new Function('startupRecoveryBlock', 'baseContainer', 'persistenceManager', 'options', 'createClankersState', 'updateClankersState', 'snapshotClankersState', 'isDeepStrictEqual', 'associatedPersistenceManager', js)(undefined, baseContainer, persistenceManager, {}, createClankersState, updateClankersState, snapshotClankersState, isDeepStrictEqual, undefined) as ClankersStateContainer;
}
