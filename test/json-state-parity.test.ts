import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import { freezeWorkflowData, workflowHash, workflowJson, WORKFLOW_LIMITS } from '../workflow-model.js';
import { createClankersState, createClankersStateContainer, snapshotClankersState } from '../state.js';
import type { ClankersExtensionFields } from '../types.js';

// Readonly historical oracle, not a production backdoor. Verbatim helper slices
// from workflow-model.ts SHA256 6e1f55918609266ab4e7aa78437f354877a8c58fdba9eeca4ff51f938c5d1406
// and state.ts SHA256 2d50ef7c87a474e8aec4c405b584b61275eca396bc752a0f6d1c33e7e76b1f98.
// Retain the original descriptor/entries algorithms independently of production.
const baselineWorkflowSource = String.raw`export const WORKFLOW_LIMITS = Object.freeze({ steps: 16, fanout: 32, concurrency: 32, admissions: 256, attempts: 3,
  definitionBytes: 65536, inputBytes: 32768, resultBytes: 16384, promptBytes: 262144, aggregateBytes: 262144,
  ledgerBytes: 2097152, definitions: 16, runs: 16, depth: 24, nodes: 20000, keys: 256, stringLength: 262144 });
export const WORKFLOW_EXTENSION_KEY = 'workflows';

export function workflowAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
/** Reject non-data before serialization: no accessors, prototypes, cycles, holes or nonfinite numbers. */
export function workflowJson(value: unknown, maxBytes: number = WORKFLOW_LIMITS.aggregateBytes): WorkflowJson {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): WorkflowJson => {
    workflowAssert(++nodes <= WORKFLOW_LIMITS.nodes && depth <= WORKFLOW_LIMITS.depth, 'Workflow JSON complexity exceeded');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { workflowAssert(Number.isFinite(v), 'Nonfinite JSON number'); return v; }
    if (typeof v === 'string') { workflowAssert(v.length <= WORKFLOW_LIMITS.stringLength, 'JSON string exceeded'); return v; }
    workflowAssert(typeof v === 'object' && v !== null, 'Expected plain JSON data');
    workflowAssert(!seen.has(v), 'Cyclic JSON data'); seen.add(v);
    workflowAssert(Object.getOwnPropertySymbols(v).length === 0, 'Symbol keys forbidden');
    const proto = Object.getPrototypeOf(v);
    workflowAssert(Array.isArray(v) ? proto === Array.prototype : proto === Object.prototype || proto === null, 'Nonplain JSON object');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    let out: WorkflowJson;
    if (Array.isArray(v)) {
      workflowAssert(v.length <= WORKFLOW_LIMITS.nodes && Object.keys(v).length === v.length, 'Sparse/extended array forbidden');
      out = Array.from({ length: v.length }, (_, i) => {
        const d = descriptors[String(i)]; workflowAssert(d && 'value' in d && d.enumerable, 'JSON accessor forbidden');
        return visit(d.value, depth + 1);
      });
    } else {
      const keys = Object.keys(descriptors).sort(); workflowAssert(keys.length <= WORKFLOW_LIMITS.keys, 'JSON key limit exceeded');
      const record: Record<string, WorkflowJson> = {};
      for (const key of keys) {
        workflowAssert(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe JSON key');
        const d = descriptors[key]; workflowAssert(d && 'value' in d && d.enumerable, 'JSON accessor/nonenumerable forbidden');
        record[key] = visit(d.value, depth + 1);
      }
      out = record;
    }
    seen.delete(v); return out;
  };
  const result = visit(value, 0);
  workflowAssert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes, 'Workflow byte budget exceeded');
  return result;
}
export function workflowHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(workflowJson(value, WORKFLOW_LIMITS.ledgerBytes))).digest('hex');
}
export function freezeWorkflowData<T>(value: T, maxBytes: number = WORKFLOW_LIMITS.aggregateBytes): T {
  const cloned = workflowJson(value, maxBytes);
  const freeze = (v: WorkflowJson): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(cloned); return cloned as T;
}
`;
const baselineStateSource = String.raw`const MAX_EXTENSION_CLONE_DEPTH = 64;
const MAX_EXTENSION_CLONE_WORK = 100_000;

interface CloneExtensionContext {
  active: WeakSet<object>;
  work: number;
}

function cloneExtensionFields(fields: ClankersExtensionFields = {}): ClankersExtensionFields {
  const context = createExtensionCloneContext();
  context.active.add(fields);
  try {
    return cloneExtensionRecordEntries(fields, context, 0);
  } finally {
    context.active.delete(fields);
  }
}

function createExtensionCloneContext(): CloneExtensionContext {
  return { active: new WeakSet<object>(), work: 0 };
}

function cloneExtensionValue(value: unknown, context: CloneExtensionContext = createExtensionCloneContext(), depth = 0): unknown {
  countExtensionCloneWork(context);

  if (value === null || typeof value !== 'object') {
    return value;
  }

  assertExtensionCloneDepth(depth);

  if (context.active.has(value)) {
    throw new TypeError('Invalid extension metadata: cycle detected');
  }

  if (Array.isArray(value)) {
    context.active.add(value);
    try {
      // Sparse slots also cost work and expand when persisted as JSON. Check
      // length before allocation, then count holes as well as present values.
      if (value.length > MAX_EXTENSION_CLONE_WORK - context.work) {
        throw new TypeError('Invalid extension metadata: too large');
      }
      const output = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (index in value) {
          output[index] = cloneExtensionValue(value[index], context, depth + 1);
        } else {
          countExtensionCloneWork(context);
        }
      }
      return output;
    } finally {
      context.active.delete(value);
    }
  }

  if (isPlainRecord(value)) {
    context.active.add(value);
    try {
      return cloneExtensionRecordEntries(value, context, depth);
    } finally {
      context.active.delete(value);
    }
  }

  return value;
}

function cloneExtensionRecordEntries(record: Record<string, unknown>, context: CloneExtensionContext, depth: number): ClankersExtensionFields {
  const output: ClankersExtensionFields = {};
  for (const [key, nested] of Object.entries(record)) {
    Object.defineProperty(output, key, {
      value: cloneExtensionValue(nested, context, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function countExtensionCloneWork(context: CloneExtensionContext): void {
  context.work += 1;
  if (context.work > MAX_EXTENSION_CLONE_WORK) {
    throw new TypeError('Invalid extension metadata: too large');
  }
}

function assertExtensionCloneDepth(depth: number): void {
  if (depth > MAX_EXTENSION_CLONE_DEPTH) {
    throw new TypeError('Invalid extension metadata: too deep');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

`;

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
assert.equal(digest(baselineWorkflowSource), '46ea20ee0872a7ebadcec5c5b06b796421af2c1961fb7b4481f073d24ebf9a5e');
assert.equal(digest(baselineStateSource), '6c6512c1d4bb36cfe365c993a842929c9d9bc3c6cb8909d5f2c5f11da34ac4e8');
function loadOracle(source: string, suffix = ''): Record<string, unknown> {
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('createHash', 'exports', code + suffix)(createHash, exports);
  return exports;
}
const baseline = {
  ...loadOracle(baselineWorkflowSource),
  ...loadOracle(baselineStateSource, '\nexports.cloneExtensionFields = cloneExtensionFields;'),
} as { workflowJson: typeof workflowJson; workflowHash: typeof workflowHash; freezeWorkflowData: typeof freezeWorkflowData; cloneExtensionFields: (v?: ClankersExtensionFields) => ClankersExtensionFields };
const clone = (extensions?: ClankersExtensionFields) => createClankersState({ extensions }).extensions;

function outcome(operation: () => unknown): unknown {
  try { return { value: operation() }; }
  catch (error) { assert(error instanceof Error); return { error: error.name, message: error.message }; }
}
function compareJson(make: () => unknown, maxBytes: number = WORKFLOW_LIMITS.ledgerBytes): void {
  assert.deepEqual(outcome(() => workflowJson(make(), maxBytes)), outcome(() => baseline.workflowJson(make(), maxBytes)));
  assert.deepEqual(outcome(() => workflowHash(make())), outcome(() => baseline.workflowHash(make())));
  assert.deepEqual(outcome(() => freezeWorkflowData(make(), maxBytes)), outcome(() => baseline.freezeWorkflowData(make(), maxBytes)));
}
function compareClone(make: () => ClankersExtensionFields): void {
  assert.deepEqual(outcome(() => clone(make())), outcome(() => baseline.cloneExtensionFields(make())));
}
function chain(depth: number, leaf: unknown = null): unknown {
  let value = leaf; for (let i = 0; i < depth; i++) value = { child: value }; return value;
}

test('workflow oracle: canonical keys, UTF8, escaping, surrogates, negative zero and aliases', () => {
  const shared = { z: [-0, null, true], a: '\u0000\n"\\é😀\ud800\udfff' };
  const value = { z: shared, '10': 10, '2': 2, '01': 1, '4294967295': 5, '4294967294': 4, a: shared };
  compareJson(() => value);
  assert.equal(JSON.stringify(workflowJson(value)), JSON.stringify(baseline.workflowJson(value)));
  const copy = workflowJson(value) as typeof value;
  assert(Object.is(copy.z.z[0], -0)); assert.notEqual(copy.a, copy.z); assert.notEqual(copy.z, shared);
  for (const v of [null, true, false, -0, 0, Number.MAX_VALUE, Number.MIN_VALUE, '', 'é', shared]) compareJson(() => v);
});

test('workflow oracle: invalid data, prototypes, descriptors, symbols, holes, cycles and accessors', () => {
  const factories: Array<() => unknown> = [
    () => undefined, () => 1n, () => () => 1, () => Symbol('x'), () => Infinity, () => -Infinity, () => NaN,
    () => new Date(0), () => new Map(), () => new Uint8Array(1), () => Object.create({ inherited: 1 }),
    () => [undefined], () => new Array(2), () => Object.assign([1], { other: 2 }),
    () => Object.defineProperty([1], 'extra', { value: 2 }),
    () => Object.defineProperty([1], '0', { value: 1, enumerable: false }),
    () => Object.setPrototypeOf([1], null), () => Object.assign({}, { [Symbol('x')]: 1 }),
    () => Object.defineProperty({}, 'hidden', { value: 1 }),
    () => Object.defineProperty({}, 'getter', { enumerable: true, get() { throw Error('must not invoke'); } }),
    () => Object.defineProperty([1], '0', { enumerable: true, get() { throw Error('must not invoke'); } }),
    () => { const x: unknown[] = []; x.push(x); return x; },
    () => { const x: Record<string, unknown> = {}; x.self = x; return x; },
    ...['__proto__', 'constructor', 'prototype'].map(key => () => Object.fromEntries([[key, 1]])),
  ];
  for (const make of factories) compareJson(make);
  compareJson(() => Object.assign(Object.create(null), { safe: [-0] }));
  // Baseline accepts a nonenumerable array extra but not an enumerable extra.
  assert.deepEqual(workflowJson(Object.defineProperty([1], 'extra', { value: 2 })), [1]);
});

test('workflow oracle: exact depth, node, key, string and byte boundaries and error precedence', () => {
  for (const depth of [23, 24, 25]) compareJson(() => chain(depth));
  for (const size of [19999, 20000, 20001]) compareJson(() => Array(size).fill(null));
  for (const size of [255, 256, 257]) compareJson(() => Object.fromEntries(Array.from({ length: size }, (_, i) => [`k${i}`, i])));
  for (const size of [262143, 262144, 262145]) compareJson(() => 'x'.repeat(size));
  for (const text of ['é😀', '\ud800', '\u0000', '\\"']) {
    const bytes = Buffer.byteLength(JSON.stringify(text));
    for (const limit of [bytes - 1, bytes, bytes + 1]) compareJson(() => text, limit);
  }
  compareJson(() => [undefined], 0);
  compareJson(() => ({ z: undefined, a: NaN }));
  compareJson(() => Object.fromEntries([['__proto__', NaN], ['a', undefined]]));
  for (const limit of [-1, 0, NaN, Infinity]) compareJson(() => null, limit);
});

test('workflow oracle: fresh calls reject changed data, including mutable descendants of frozen roots', () => {
  for (const model of [baseline, { workflowJson, workflowHash, freezeWorkflowData }]) {
    const nested: Record<string, unknown> = { ok: [1] }, source = Object.freeze({ nested });
    const hash = model.workflowHash(source), a = model.workflowJson(source), b = model.workflowJson(source);
    assert.notEqual(a, b); assert.notEqual((a as any).nested, (b as any).nested);
    (a as any).nested.ok.push(2); assert.deepEqual((b as any).nested.ok, [1]);
    const frozen = model.freezeWorkflowData(source);
    assert(Object.isFrozen(frozen)); assert(Object.isFrozen(frozen.nested)); assert(Object.isFrozen(frozen.nested.ok));
    nested.ok = [2]; assert.notEqual(model.workflowHash(source), hash);
    nested.bad = undefined; assert.throws(() => model.workflowHash(source), /Expected plain JSON/);
    delete nested.bad; nested.loop = nested; assert.throws(() => model.workflowJson(source), /Cyclic JSON/);
  }
});

test('workflow oracle: proxy trap snapshots and inherited toJSON are not skipped or serialized fewer times', () => {
  const run = (model: typeof baseline) => {
    const calls: string[] = [], target = { z: 1, a: 2 };
    const proxy = new Proxy(target, {
      ownKeys(t) { calls.push('ownKeys'); return Reflect.ownKeys(t); },
      getPrototypeOf(t) { calls.push('prototype'); return Reflect.getPrototypeOf(t); },
      getOwnPropertyDescriptor(t, k) { calls.push(`descriptor:${String(k)}`); return Reflect.getOwnPropertyDescriptor(t, k); },
      get(t, k, r) { calls.push(`get:${String(k)}`); return Reflect.get(t, k, r); },
    });
    return { hash: model.workflowHash(proxy), calls };
  };
  assert.deepEqual(run({ ...baseline, workflowHash }), run(baseline));
  function stringifyEffects(hash: typeof workflowHash) {
    const old = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'); let calls = 0;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { return ++calls; } });
      return { hash: hash({ a: 1 }), calls };
    } finally {
      if (old) Object.defineProperty(Object.prototype, 'toJSON', old); else delete (Object.prototype as any).toJSON;
    }
  }
  assert.deepEqual(stringifyEffects(workflowHash), stringifyEffects(baseline.workflowHash));
  assert.equal(stringifyEffects(workflowHash).calls, 2);
});

test('state oracle: null prototypes, unsafe own keys, symbols, nonenumerables, undefined and opaque references', () => {
  const opaque = [new Date(0), new Map([['x', 1]]), new Set([1]), new Uint8Array([1]), () => 1, Object.create({ opaque: true })];
  const value = Object.assign(Object.create(null), Object.fromEntries([
    ['__proto__', { safe: 1 }], ['constructor', 3], ['prototype', 4], ['undefined', undefined], ['opaque', opaque],
  ]));
  Object.defineProperty(value, 'hidden', { value: 1 }); value[Symbol('symbol')] = 2;
  compareClone(() => value);
  for (const fn of [clone, baseline.cloneExtensionFields]) {
    const copy = fn(value); assert.equal(Object.getPrototypeOf(copy), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(copy, '__proto__')?.writable, true);
    assert.equal(Object.getOwnPropertyDescriptor(copy, '__proto__')?.enumerable, true);
    assert.equal(Object.getOwnPropertyDescriptor(copy, '__proto__')?.configurable, true);
    assert.equal('hidden' in copy, false); assert.deepEqual(Object.getOwnPropertySymbols(copy), []);
    (copy.opaque as unknown[]).forEach((item, i) => assert.equal(item, opaque[i]));
  }
});

test('state oracle: Object.entries snapshots getters before recursion and preserves source callback effects', () => {
  function run(fn: typeof clone) {
    const events: string[] = [], source: ClankersExtensionFields = {};
    const nested = Object.defineProperty({}, 'child', { enumerable: true, get() {
      events.push('nested'); source.second = 'mutated-after-snapshot'; return 1;
    } });
    Object.defineProperty(source, 'first', { enumerable: true, get() { events.push('first'); return nested; } });
    source.second = 'captured';
    Object.defineProperty(source, 'third', { enumerable: true, get() { events.push('third'); source.late = 3; return source.second; } });
    const value = fn(source); return { value, events };
  }
  const actual = run(clone); assert.deepEqual(actual, run(baseline.cloneExtensionFields));
  assert.deepEqual(actual.events, ['first', 'third', 'nested']);
  assert.equal(actual.value.second, 'captured'); assert.equal(actual.value.third, 'captured'); assert.equal('late' in actual.value, false);
  const throws = () => Object.defineProperty({ first: { deep: 1 } }, 'later', { enumerable: true, get() { throw new RangeError('source callback'); } });
  compareClone(throws);
  function deletion() {
    const source = { get first() { delete (source as any).second; return { a: 1 }; }, second: 2 };
    return source;
  }
  compareClone(deletion);
});

test('state oracle: own data property creation bypasses prototype setters', () => {
  const key = 'paritySetter', previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  let writes = 0;
  try {
    Object.defineProperty(Object.prototype, key, { configurable: true, set() { writes++; throw Error('setter invoked'); } });
    const source = Object.defineProperty({}, key, { enumerable: true, value: { value: 1 } });
    compareClone(() => source); assert.equal(writes, 0);
  } finally { if (previous) Object.defineProperty(Object.prototype, key, previous); else delete (Object.prototype as any)[key]; }
});

test('state oracle: sparse arrays, inherited slots, ignored extras and changing length getters', () => {
  function sparse() {
    const array = new Array(4), proto = Object.create(Array.prototype);
    Object.defineProperty(proto, '1', { get() { return { inherited: true }; } });
    Object.setPrototypeOf(array, proto); array[3] = { own: true }; (array as any).extra = 'ignored';
    return { array };
  }
  compareClone(sparse);
  const copy = clone(sparse()).array as unknown[];
  assert.equal(0 in copy, false); assert.equal(Object.hasOwn(copy, '1'), true); assert.equal(2 in copy, false);
  assert.equal('extra' in copy, false); assert.equal(Object.getPrototypeOf(copy), Array.prototype);
  for (const grow of [false, true]) compareClone(() => {
    const a = [1, 2]; Object.defineProperty(a, '0', { get() { if (grow) a.push(3); else a.length = 1; return { read: true }; } });
    return { a };
  });
});

test('state oracle: exact depth and work counts include holes, repeated aliases and opaque values', () => {
  for (const depth of [63, 64, 65]) compareClone(() => ({ value: chain(depth - 1, {}) }));
  // A primitive at depth 65 is accepted; an object there is not.
  compareClone(() => chain(65, 1) as ClankersExtensionFields);
  compareClone(() => chain(65, {}) as ClankersExtensionFields);
  for (const length of [99998, 99999, 100000]) {
    compareClone(() => ({ array: new Array(length) }));
    compareClone(() => ({ array: Array(length).fill(0) }));
  }
  for (const length of [100000, 100001]) compareClone(() => Object.fromEntries(Array.from({ length }, (_, i) => [`k${i}`, 0])));
  compareClone(() => ({ array: Array(50000).fill({ child: 1 }) }));
  compareClone(() => ({ deep: chain(65, new Date(0)) }));
  compareClone(() => { const x: ClankersExtensionFields = {}; x.self = x; return x; });
  compareClone(() => { const x: unknown[] = []; x.push(x); return { x }; });
});

test('state oracle: proxy entry/get/prototype traps retain order, including recursive source mutations', () => {
  function run(fn: typeof clone) {
    const events: string[] = [];
    const child = new Proxy({ item: 1 }, {
      getPrototypeOf(t) { events.push('child:prototype'); return Reflect.getPrototypeOf(t); },
      ownKeys(t) { events.push('child:keys'); return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) { events.push(`child:descriptor:${String(k)}`); return Reflect.getOwnPropertyDescriptor(t, k); },
      get(t, k, r) { events.push(`child:get:${String(k)}`); return Reflect.get(t, k, r); },
    });
    const source = new Proxy({ child, next: 2 }, {
      ownKeys(t) { events.push('root:keys'); return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) { events.push(`root:descriptor:${String(k)}`); return Reflect.getOwnPropertyDescriptor(t, k); },
      get(t, k, r) { events.push(`root:get:${String(k)}`); return Reflect.get(t, k, r); },
    });
    return { value: fn(source), events };
  }
  assert.deepEqual(run(clone), run(baseline.cloneExtensionFields));
});

test('state snapshots: aliases are fresh, mutable input is re-read, frozen root does not freeze descendants', () => {
  for (const fn of [clone, baseline.cloneExtensionFields]) {
    const shared = { values: [1] }, source = Object.freeze({ a: shared, b: shared });
    const one = fn(source) as typeof source, two = fn(source) as typeof source;
    assert.notEqual(one.a, one.b); assert.notEqual(one.a, two.a); one.a.values.push(9);
    assert.deepEqual(one.b.values, [1]); assert.deepEqual(two.a.values, [1]); assert.deepEqual(shared.values, [1]);
    shared.values.push(2); assert.deepEqual((fn(source) as typeof source).a.values, [1, 2]);
    (shared as any).self = shared; assert.throws(() => fn(source), /cycle detected/);
  }
});

test('state snapshots: reads, listeners, updates and failed commits stay detached', () => {
  const seed = { nested: { values: [1] } }, container = createClankersStateContainer({ extensions: seed });
  seed.nested.values.push(2); assert.deepEqual(container.read().extensions, { nested: { values: [1] } });
  const a = container.read(), b = container.snapshot(); (a.extensions.nested as any).values.push(3);
  assert.deepEqual(container.read().extensions, b.extensions); assert.notEqual(a.extensions, b.extensions);
  let observed: unknown;
  container.subscribe!(s => { (s.extensions.nested as any).values.push(4); });
  container.subscribe!(s => { observed = s.extensions; });
  const result = container.update({ lifecycle: 'ready' });
  assert.deepEqual(observed, b.extensions); assert.deepEqual(result.extensions, b.extensions);
  (result.extensions.nested as any).values.push(5); assert.deepEqual(container.read().extensions, b.extensions);
  const snapshot = snapshotClankersState(container.read()); assert.deepEqual(snapshot.extensions, b.extensions);
  const cyclic: any = {}; cyclic.self = cyclic;
  assert.throws(() => container.update({ extensions: cyclic }), /cycle/);
  assert.deepEqual(container.read().extensions, b.extensions);
});

test('deterministic generated JSON trees have exact canonical/hash and extension-clone parity', () => {
  let seed = 0x72b190;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const tree = (depth: number): unknown => {
    const kind = random() % (depth ? 7 : 4);
    if (kind === 0) return null;
    if (kind === 1) return !!(random() & 1);
    if (kind === 2) return random() % 2 ? -0 : random() / 13;
    if (kind === 3) return ['é', '\ud800', '\n', '😀', 'a'][random() % 5];
    if (kind === 4) return Array.from({ length: random() % 5 }, () => tree(depth - 1));
    return Object.fromEntries(Array.from({ length: random() % 5 }, (_, i) => [`${random() % 2 ? '' : 'key'}${i}`, tree(depth - 1)]));
  };
  for (let i = 0; i < 200; i++) {
    const value = tree(4); compareJson(() => value); compareClone(() => ({ value }));
  }
});

test('state oracle: root entry semantics are distinct from nested plain-record/array semantics', () => {
  const date = Object.assign(new Date(0), { own: { value: 1 } });
  const callable = Object.assign(() => 1, { own: { value: 2 } });
  for (const value of [undefined, null, 1, 'text', true, Symbol('x'), date, callable, [1, , 3]]) {
    assert.deepEqual(outcome(() => clone(value as any)), outcome(() => baseline.cloneExtensionFields(value as any)));
  }
  assert.deepEqual(clone([1, , 3] as any), { 0: 1, 2: 3 });
});

test('state oracle: inherited-property guard observes prototype changes made during nested cloning', () => {
  const key = 'parityLateInheritedKey';
  function run(fn: typeof clone, accessor: boolean) {
    const old = Object.getOwnPropertyDescriptor(Object.prototype, key); let hits = 0;
    try {
      const nested = Object.defineProperty({}, 'trigger', { enumerable: true, get() {
        Object.defineProperty(Object.prototype, key, accessor
          ? { configurable: true, get() { hits++; throw Error('inherited get'); }, set() { hits++; throw Error('inherited set'); } }
          : { configurable: true, value: 7, writable: false });
        return 1;
      } });
      const source = Object.defineProperty({}, key, { enumerable: true, value: nested });
      const value = fn(source);
      return { value, hits, descriptor: Object.getOwnPropertyDescriptor(value, key) };
    } finally { if (old) Object.defineProperty(Object.prototype, key, old); else delete (Object.prototype as any)[key]; }
  }
  for (const accessor of [true, false]) {
    const actual = run(clone, accessor); assert.deepEqual(actual, run(baseline.cloneExtensionFields, accessor));
    assert.equal(actual.hits, 0); assert.equal(actual.descriptor?.writable, true);
  }
});

test('budget boundary outcomes are independently pinned as well as differential', () => {
  assert.doesNotThrow(() => workflowJson(chain(24)));
  assert.throws(() => workflowJson(chain(25)), /^Error: Workflow JSON complexity exceeded$/);
  assert.doesNotThrow(() => workflowJson(Array(19999).fill(null)));
  assert.throws(() => workflowJson(Array(20000).fill(null)), /^Error: Workflow JSON complexity exceeded$/);
  assert.doesNotThrow(() => workflowJson('é', 4));
  assert.throws(() => workflowJson('é', 3), /^Error: Workflow byte budget exceeded$/);
  assert.doesNotThrow(() => clone(chain(64, {}) as ClankersExtensionFields));
  assert.throws(() => clone(chain(65, {}) as ClankersExtensionFields), /^TypeError: Invalid extension metadata: too deep$/);
  assert.doesNotThrow(() => clone(chain(65, 1) as ClankersExtensionFields));
  assert.doesNotThrow(() => clone({ holes: new Array(99999) }));
  assert.throws(() => clone({ holes: new Array(100000) }), /^TypeError: Invalid extension metadata: too large$/);
});

// Finding 10794: DefineProperty converts inherited get/set fields even when
// the descriptor's own fields describe a data property. Keep native intrinsics
// untouched; only accepted nested source getters install prototype properties.
type DescriptorField = 'get' | 'set';
type DescriptorVariant = 'data-undefined' | 'data-function' | 'data-invalid'
  | 'accessor-undefined' | 'accessor-function' | 'accessor-invalid'
  | 'accessor-throw' | 'accessor-delete' | 'setter-only';
const nativeDefineProperty = Object.defineProperty;
function descriptorMutation(
  fields: ReadonlyArray<readonly [DescriptorField, DescriptorVariant]>,
  operation: (source: ClankersExtensionFields) => unknown,
  sourceThrows = false,
) {
  const previous = fields.map(([key]) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const);
  const events: string[] = [];
  const callbackError = new RangeError('inherited descriptor callback');
  const sourceError = new SyntaxError('nested source callback');
  let result: { value?: unknown; error?: string; message?: string; sameCallbackError?: boolean; sameSourceError?: boolean };
  try {
    const nested = {
      get child() {
        events.push('source:child');
        // Prepare all callbacks before pollution (including transpiler-added
        // function-name descriptors); installation itself uses only safe data.
        const descriptors = fields.map(([key, variant]) => {
          // Null-prototype descriptors are for installing/restoring the test
          // mutation, NOT for changing the production descriptor semantics.
          const descriptor = Object.create(null) as PropertyDescriptor;
          descriptor.configurable = true;
          const fieldValue = () => variant.endsWith('function')
            ? () => { events.push(`must-not-call:${key}`); }
            : variant.endsWith('invalid') ? 7 : undefined;
          if (variant.startsWith('data-')) descriptor.value = fieldValue();
          else if (variant === 'setter-only') descriptor.set = () => { events.push(`must-not-set:${key}`); };
          else descriptor.get = () => {
            events.push(`descriptor:${key}`);
            if (variant === 'accessor-throw') throw callbackError;
            if (variant === 'accessor-delete') delete (Object.prototype as any)[key];
            return fieldValue();
          };
          return [key, descriptor] as const;
        });
        for (const [key, descriptor] of descriptors) nativeDefineProperty(Object.prototype, key, descriptor);
        if (sourceThrows) throw sourceError;
        return 1;
      },
      get later() { events.push('source:later'); return 2; },
    };
    const source = {
      get ordinary() { events.push('root:ordinary'); return nested; },
      get last() { events.push('root:last'); return 3; },
    };
    try { result = { value: operation(source) }; }
    catch (error) {
      const caught = error as Error;
      result = { error: caught.name, message: caught.message, sameCallbackError: error === callbackError, sameSourceError: error === sourceError };
    }
  } finally {
    // Remove every mutation before restoring any ordinary historical descriptor.
    for (const [key] of previous) delete (Object.prototype as any)[key];
    for (const [key, old] of previous) {
      if (old) nativeDefineProperty(Object.prototype, key, Object.assign(Object.create(null), old));
    }
  }
  return { result, events };
}
const descriptorSourceEvents = ['root:ordinary', 'root:last', 'source:child', 'source:later'];
const descriptorVariants: DescriptorVariant[] = [
  'data-undefined', 'data-function', 'data-invalid', 'accessor-undefined',
  'accessor-function', 'accessor-invalid', 'accessor-throw', 'accessor-delete', 'setter-only',
];
for (const key of ['get', 'set'] as const) for (const variant of descriptorVariants) {
  test(`state descriptor parity: inherited ${key}/${variant} preserves errors and callbacks`, () => {
    const fields = [[key, variant]] as const;
    const expected = descriptorMutation(fields, baseline.cloneExtensionFields);
    const actual = descriptorMutation(fields, clone);
    assert.deepEqual(actual, expected);
    assert.equal(actual.result.error, variant === 'accessor-throw' ? 'RangeError' : 'TypeError');
    assert.equal(actual.result.sameCallbackError, variant === 'accessor-throw');
    assert.deepEqual(actual.events, [...descriptorSourceEvents, ...(variant.startsWith('accessor-') ? [`descriptor:${key}`] : [])]);
    if (variant === 'accessor-throw') assert.equal(actual.result.message, 'inherited descriptor callback');
    else if (variant.endsWith('invalid')) assert.match(actual.result.message!, /must be a function/);
    else assert.match(actual.result.message!, /Invalid property descriptor/);
    assert.equal(Object.defineProperty, nativeDefineProperty);
    // The fallback is fresh, not cached after a previous prototype mutation.
    assert.deepEqual(clone({ ordinary: { child: 1 } }), { ordinary: { child: 1 } });
  });
}

test('state descriptor parity: get-before-set conversion and first-error precedence', () => {
  const cases: Array<{ fields: ReadonlyArray<readonly [DescriptorField, DescriptorVariant]>; callbacks: string[]; error: string }> = [
    { fields: [['get', 'accessor-undefined'], ['set', 'accessor-undefined']], callbacks: ['get', 'set'], error: 'TypeError' },
    { fields: [['set', 'accessor-undefined'], ['get', 'accessor-delete']], callbacks: ['get', 'set'], error: 'TypeError' },
    { fields: [['get', 'accessor-invalid'], ['set', 'accessor-throw']], callbacks: ['get'], error: 'TypeError' },
    { fields: [['get', 'accessor-throw'], ['set', 'accessor-undefined']], callbacks: ['get'], error: 'RangeError' },
    { fields: [['get', 'accessor-undefined'], ['set', 'accessor-throw']], callbacks: ['get', 'set'], error: 'RangeError' },
  ];
  for (const { fields, callbacks, error } of cases) {
    const actual = descriptorMutation(fields, clone);
    assert.deepEqual(actual, descriptorMutation(fields, baseline.cloneExtensionFields));
    assert.equal(actual.result.error, error);
    assert.deepEqual(actual.events, [...descriptorSourceEvents, ...callbacks.map(key => `descriptor:${key}`)]);
  }
});

test('state descriptor parity: nested source errors precede descriptor callbacks', () => {
  for (const key of ['get', 'set'] as const) {
    const fields = [[key, 'accessor-throw']] as const;
    const actual = descriptorMutation(fields, clone, true);
    assert.deepEqual(actual, descriptorMutation(fields, baseline.cloneExtensionFields, true));
    assert.deepEqual(actual.result, { error: 'SyntaxError', message: 'nested source callback', sameSourceError: true, sameCallbackError: false });
    assert.deepEqual(actual.events, ['root:ordinary', 'root:last', 'source:child']);
  }
});

for (const method of ['update', 'replace'] as const) for (const key of ['get', 'set'] as const) {
  for (const variant of ['accessor-undefined', 'data-undefined', 'accessor-throw'] as const) {
    test(`state descriptor failure before commit: ${method}/${key}/${variant} retains revision and publishes nothing`, () => {
      const container = createClankersStateContainer({ extensions: { stable: { values: [0] } } });
      const before = container.read();
      let publications = 0;
      container.subscribe!(() => { publications++; });
      const fields = [[key, variant]] as const;
      const actual = descriptorMutation(fields, extensions => container[method]({ extensions }));
      assert.deepEqual(actual, descriptorMutation(fields, baseline.cloneExtensionFields));
      assert.equal(actual.result.error, variant === 'accessor-throw' ? 'RangeError' : 'TypeError');
      assert.equal(publications, 0);
      assert.equal(container.read().revision, 0);
      assert.deepEqual(container.read(), before);
      // A later ordinary update still succeeds; no poisoned clone context/state.
      const updated = container.update({ extensions: { stable: { values: [1] } } });
      assert.equal(updated.revision, 1);
      assert.equal(publications, 1);
      assert.deepEqual(updated.extensions, { stable: { values: [1] } });
    });
  }
}
