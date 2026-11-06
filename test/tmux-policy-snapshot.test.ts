import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import ts from 'typescript';
import { captureTmuxPolicySnapshot, createTmuxPolicySnapshot, type TmuxPolicySnapshotInput } from '../tmux-policy-snapshot.js';
import { createTmuxContinuationService, type TmuxContinuationSource } from '../tmux-continuation.js';
import { createTmuxWorker, TmuxLaunchError, type TmuxLaunchOptions } from '../tmux-runner.js';

test('real filesystem snapshot: additions, trust, definition, overflow and zero-effect prepare', async () => {
  const root = mkdtempSync('/srv/devops/scratch/tmux-policy-');
  const originalSpawn = childProcess.spawn;
  let children = 0, launches = 0, preflights = 0;
  childProcess.spawn = (() => { children++; throw new Error('Unexpected child'); }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    const resources = join(root, 'resources'); mkdirSync(resources);
    const trust = join(root, 'trust.json'), settings = join(root, 'settings.json'), models = join(root, 'models.json');
    for (const file of [trust, settings, models]) writeFileSync(file, '{}');
    const resource = join(resources, 'skill.md'); writeFileSync(resource, 'ANSWER=42');
    let input: TmuxPolicySnapshotInput = {
      coverage: 'explicit-trusted-inventory', unsupported: [], cwd: root,
      definition: { id: 'worker', prompt: 'Read only' }, model: 'fixture/current', fallbackModels: ['fixture/backup'],
      maxTurns: 2, tools: ['read'], denies: ['bash'], may_write: false, result_schema: null,
      trustFiles: [trust], settingsFiles: [settings], modelFiles: [models], resourceRoots: [resources],
      discoveryRoots: [resources, join(root, 'future')],
    };
    const initial = captureTmuxPolicySnapshot(input);
    // JSON property order is not authority; array order still is.
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as TmuxPolicySnapshotInput;
    assert.equal(captureTmuxPolicySnapshot(reordered).digest, initial.digest);
    assert.deepEqual(Object.keys(initial), ['version', 'digest']);
    const source: TmuxContinuationSource = {
      key: { backend: 'tmux', workerId: 'old-worker', sessionId: 'old-session', generation: 'old-generation', epoch: 0, jobId: 'old-job', runId: 'old-run', taskId: 'old-task', resultDigest: createHash('sha256').update('"ANSWER=42"').digest('hex') },
      agentId: 'worker', originalTask: 'Calculate', resultText: 'ANSWER=42', settled: true, complete: true,
    };
    const service = createTmuxContinuationService({
      source: () => source, policy: () => captureTmuxPolicySnapshot(input), assertAuthority() {},
      async preflight() { preflights++; }, launch() { launches++; },
    });
    const before = [trust, settings, models, resource].map(path => [path, readFileSync(path, 'utf8'), statSync(path).mtimeMs]);
    const review = service.prepare({ source: Object.fromEntries(Object.entries(source.key).reverse()) as unknown as typeof source.key, task: 'Explainonly' });
    assert.equal(children, 0); assert.equal(launches, 0); assert.equal(preflights, 0);
    assert.deepEqual([trust, settings, models, resource].map(path => [path, readFileSync(path, 'utf8'), statSync(path).mtimeMs]), before);
    assert.deepEqual(readdirSync(root).sort(), ['models.json', 'resources', 'settings.json', 'trust.json']);
    writeFileSync(join(resources, 'added.md'), 'new instructions');
    await assert.rejects(service.start({ reviewId: review.reviewId, confirm: true }), /policy changed/);
    assert.equal(launches, 0); assert.equal(preflights, 0);
    const check = (change: () => void) => {
      const snapshot = createTmuxPolicySnapshot(() => input); snapshot.assertCurrent(); change();
      assert.throws(snapshot.assertCurrent, /policy changed/);
    };
    check(() => writeFileSync(resource, 'ANSWER=43'));
    check(() => writeFileSync(trust, '{"trusted":false}'));
    check(() => { input = { ...input, definition: { id: 'worker', prompt: 'Changed' } }; });
    check(() => mkdirSync(join(root, 'future')));
    check(() => writeFileSync(settings, '{"extensions":["new.ts"]}'));
    check(() => writeFileSync(models, '{"providers":{}}'));
    assert.throws(() => captureTmuxPolicySnapshot({ ...input, unsupported: ['uncovered dynamic loader'] }), /Incomplete/);
    writeFileSync(join(resources, 'large'), Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => captureTmuxPolicySnapshot(input), /limit/);
    rmSync(join(resources, 'large'));
    writeFileSync(join(resources, 'auth.json'), 'synthetic-secret');
    assert.throws(() => captureTmuxPolicySnapshot(input), /Credential/);
    rmSync(join(resources, 'auth.json'));

    // Planted final-fence omission must fail the independent changed-trust oracle.
    const code = readFileSync(new URL('../tmux-policy-snapshot.ts', import.meta.url), 'utf8');
    const needle = 'if (captureTmuxPolicySnapshot(readCurrent()).digest !== expected.digest)';
    assert.equal(code.split(needle).length, 2);
    const js = ts.transpileModule(code.replace(needle, 'if (false)').replace("'typescript'", JSON.stringify(import.meta.resolve('typescript'))), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const mutant = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64')) as { createTmuxPolicySnapshot: typeof createTmuxPolicySnapshot };
    const faulty = mutant.createTmuxPolicySnapshot(() => input);
    writeFileSync(trust, '{"trusted":true}');
    assert.throws(() => assert.throws(faulty.assertCurrent, /policy changed/), /Missing expected exception/);

    // Actual runner, real synthetic filesystem, no SDK or tmux process invoked.
    const launch = { rootDir: join(root, 'never-created'), agentDir: root, cwd: root } as TmuxLaunchOptions;
    await assert.rejects(createTmuxWorker({ ...launch, assertAdmission() { throw new Error('revoked'); } }), TmuxLaunchError);
    assert.equal(readdirSync(root).includes('never-created'), false);
    let calls = 0;
    await assert.rejects(createTmuxWorker({ ...launch, assertAdmission() { if (++calls === 3) throw new Error('revoked after mkdir await'); } }), TmuxLaunchError);
    assert.equal(calls, 3); assert.equal(children, 0);
    assert.deepEqual(readdirSync(launch.rootDir!), []);
    service.dispose();
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
  }
});

// Gate: node --import tsx --test --test-concurrency=1 --test-name-pattern='dependency closure' test/tmux-policy-snapshot.test.ts
// Predetermined oracle: outside.ts return 1 -> 2 MUST change the digest and reject
// the saved fence. A mutant dropping dependency traversal MUST fail that oracle.
test('dependency closure: escaping reexport, nested literals, metadata and refusal', async () => {
  const root = mkdtempSync('/srv/devops/scratch/tmux-dependencies-');
  try {
    const resources = join(root, 'resource'); mkdirSync(resources);
    const entry = join(resources, 'extension.ts'), outside = join(root, 'outside.ts');
    const metadata = join(root, 'policy.json'); writeFileSync(metadata, '{}');
    writeFileSync(entry, "export { default } from '../outside.ts';");
    writeFileSync(outside, 'export default function () { return 1; }');
    const input: TmuxPolicySnapshotInput = {
      coverage: 'explicit-trusted-inventory', unsupported: [], cwd: root,
      definition: { id: 'worker' }, model: 'fixture/current', fallbackModels: [], maxTurns: null,
      tools: [], denies: [], may_write: false, result_schema: null,
      trustFiles: [metadata], settingsFiles: [metadata], modelFiles: [metadata],
      resourceRoots: [resources], discoveryRoots: [resources],
    };
    const first = createTmuxPolicySnapshot(() => input);
    writeFileSync(outside, 'export default function () { return 2; }');
    assert.notEqual(captureTmuxPolicySnapshot(input).digest, first.digest);
    assert.throws(first.assertCurrent, /policy changed/);

    // Literal dynamic import and require are collected even inside uncalled code.
    const nested = join(root, 'nested.ts'), leaf = join(root, 'leaf.cjs');
    writeFileSync(outside, "export default async function () { return import('./nested.ts'); }");
    writeFileSync(nested, "export const value = () => require('./leaf.cjs');");
    writeFileSync(leaf, 'exports.value = 1;');
    const nestedSnapshot = createTmuxPolicySnapshot(() => input);
    writeFileSync(leaf, 'exports.value = 2;');
    assert.throws(nestedSnapshot.assertCurrent, /policy changed/);
    const absentPackage = createTmuxPolicySnapshot(() => input);
    writeFileSync(join(root, 'package.json'), '{"type":"module","exports":"./outside.ts"}');
    assert.throws(absentPackage.assertCurrent, /policy changed/);
    const packageSnapshot = createTmuxPolicySnapshot(() => input);
    writeFileSync(join(root, 'package.json'), '{"type":"module","exports":"./nested.ts"}');
    assert.throws(packageSnapshot.assertCurrent, /policy changed/);

    // Native/Jiti extension fallback is deliberately not approximated: no review
    // can be prepared for a missing .js even when a .ts fallback already exists.
    writeFileSync(outside, "export { value } from './shadow.js';");
    writeFileSync(join(root, 'shadow.ts'), 'export const value = 1;');
    assert.throws(() => captureTmuxPolicySnapshot(input), /Unresolved/);
    writeFileSync(join(root, 'shadow.js'), 'export const value = 2;');
    const exact = createTmuxPolicySnapshot(() => input);
    writeFileSync(join(root, 'shadow.js'), 'export const value = 3;');
    assert.throws(exact.assertCurrent, /policy changed/);

    writeFileSync(outside, "export default (name: string) => import(name);");
    assert.throws(() => captureTmuxPolicySnapshot(input), /Computed/);
    writeFileSync(outside, "const loader = require; export default () => loader('./leaf.cjs');");
    assert.throws(() => captureTmuxPolicySnapshot(input), /Aliased/);
    writeFileSync(outside, "export { x } from 'fixture-package';");
    assert.throws(() => captureTmuxPolicySnapshot(input), /Unsupported policy dependency resolution/);
    writeFileSync(outside, "import fs from 'node:fs'; export default () => fs;");
    assert.throws(() => captureTmuxPolicySnapshot(input), /Unsupported policy dependency resolution/);
    writeFileSync(outside, 'export default function () { return 1; }');

    const code = readFileSync(new URL('../tmux-policy-snapshot.ts', import.meta.url), 'utf8');
    const needle = 'for (const dependency of dependencies(path, source)) walk(dependency, depth + 1, true);';
    assert.equal(code.split(needle).length, 2);
    const js = ts.transpileModule(code.replace(needle, '/* planted omission: do not follow escaping imports */').replace("'typescript'", JSON.stringify(import.meta.resolve('typescript'))), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const mutant = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64')) as { createTmuxPolicySnapshot: typeof createTmuxPolicySnapshot; captureTmuxPolicySnapshot: typeof captureTmuxPolicySnapshot };
    const faulty = mutant.createTmuxPolicySnapshot(() => input);
    writeFileSync(outside, 'export default function () { return 2; }');
    assert.throws(() => assert.notEqual(mutant.captureTmuxPolicySnapshot(input).digest, faulty.digest), assert.AssertionError);
    assert.throws(() => assert.throws(faulty.assertCurrent, /policy changed/), /Missing expected exception/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
