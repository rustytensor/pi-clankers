// Actual scripted-loopback driver. Run ONLY under reviewed wrapper/subreaper.
// Heavy host imports occur in isolated children after capability + env checks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanHostEnvironment, guardSource, readFixtureBody } from './host-fixture-safety.mjs';

const [root, mode, installedPi] = process.argv.slice(2);
assert(['sdk', 'regular', 'fullscreen', 'packed'].includes(mode));
const identity = lstatSync(root);
assert(identity.isDirectory() && !identity.isSymbolicLink() && realpathSync(root) === root && identity.uid === process.getuid() && (identity.mode & 0o077) === 0);
assert.deepEqual(JSON.parse(readFileSync(join(root, 'evidence/parent-approval.json'), 'utf8')), { guard: 'parent-approved', root, uid: identity.uid, dev: identity.dev, ino: identity.ino });
assert.equal(JSON.parse(readFileSync(join(installedPi, 'package.json'), 'utf8')).version, '1.0.2', 'Pinned existing host, never install/fallback');
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixture = fileURLToPath(new URL('./workflow-script-host-fixture.ts', import.meta.url));
const python = fileURLToPath(new URL('./workflow-script-host-pty.py', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const put = (name, value) => writeFileSync(join(root, 'evidence', name), JSON.stringify(value, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Freeze every allowlisted package asset (including new examples/guide/parser),
// affected provenance/control sources and the reviewed acceptance/safety harness.
const metadataBefore = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
const trackedSources = ['package.json', 'package-lock.json', 'tsconfig.json', 'test/workflow-script-integration.test.ts', 'test/fixtures/workflow-script-sdk-acceptance.mjs', 'test/fixtures/workflow-script-host-fixture.ts', 'test/fixtures/workflow-script-host-pty.py', 'test/fixtures/host-fixture-safety.mjs'];
function addAssets(path) {
  const st = lstatSync(join(sourceRoot, path)); assert(!st.isSymbolicLink(), 'Public asset must not be a link');
  if (st.isDirectory()) for (const name of readdirSync(join(sourceRoot, path)).sort()) addAssets(path + '/' + name);
  else { assert(st.isFile()); trackedSources.push(path); }
}
for (const path of metadataBefore.files) addAssets(path);
const tracked = [...new Set(trackedSources)].sort();
for (const path of ['workflow-script-format.ts', 'workflow-script.ts', 'workflow-script-controls.ts', 'workflow-script-process.ts', 'workflow-script-compiler.mjs', 'workflow-script-examples.ts', 'workflow-script-language.md', 'workflow-model.ts', 'workflow-runtime.ts', 'index.ts', 'types.ts', 'ui/workflow-overlay.ts']) assert(tracked.includes(path), 'Missing explicitly declared/fingerprinted Stage8D asset: ' + path);
const sourceHashes = () => Object.fromEntries(tracked.map(path => [path, sha(readFileSync(join(sourceRoot, path)))]));
const before = sourceHashes();
const env = cleanHostEnvironment(root);
let moduleRoot = sourceRoot, piPackage = installedPi;
let controller, closed = false, failure;
const diagnostics = [];
const sockets = new Set(), responses = new Set(), requests = [], held = [];
let responseBytes = 0;
const budget = { hits: 0, max: 8 };

function locatePackage(base, name) {
  // Discover metadata, not an entry point: ESM-only exports need no require main.
  assert(/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name) && name !== '.' && name !== '..');
  base = realpathSync(base);
  const meta = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
  assert(Object.hasOwn({ ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies }, name), 'Only declared installed dependencies: ' + name);
  const paths = createRequire(join(base, 'package.json')).resolve.paths(name) ?? [];
  // Restrict Node's paths to at most twenty ordinary physical ancestors. Never
  // consult NODE_PATH, global/user-profile paths, scan directories or import code.
  let dir = base;
  for (let i = 0; i < 20; i++, dir = dirname(dir)) {
    const search = join(dir, 'node_modules');
    if (paths.includes(search)) {
      const candidate = join(search, name);
      if (existsSync(candidate)) {
        const root = realpathSync(candidate), metadata = join(root, 'package.json');
        assert(statSync(root).isDirectory() && lstatSync(metadata).isFile() && realpathSync(metadata) === metadata, 'Physical package root/metadata required');
        assert(statSync(metadata).size <= 1024 * 1024, 'Bounded package metadata');
        assert.equal(JSON.parse(readFileSync(metadata, 'utf8')).name, name, 'Nearest installed package metadata identity');
        return root;
      }
    }
    if (dir === dirname(dir)) break;
  }
  throw Error('Installed declared package missing: ' + name);
}
function preparePackedLayout() {
  // No npm install, lifecycle, network, user caches or checkout/dev fallback.
  // Package data are copied from already-installed declared runtime/peer closure.
  const pack = join(root, 'pack'); mkdirSync(pack);
  const result = spawnSync('/usr/bin/npm', ['pack', '--ignore-scripts', '--offline', '--json', '--cache', join(root, 'tmp/npm-cache'), '--pack-destination', pack], { cwd: sourceRoot, env, timeout: 30_000, maxBuffer: 131072, encoding: 'utf8' });
  assert.equal(result.status, 0, String(result.error ?? result.stderr));
  const info = JSON.parse(result.stdout); assert.equal(info.length, 1);
  assert(/^[A-Za-z0-9_.-]+\.tgz$/.test(info[0].filename));
  const packagePath = join(root, 'layout/node_modules/pi-clankers'); mkdirSync(packagePath, { recursive: true });
  const tar = spawnSync('/usr/bin/tar', ['-xzf', join(pack, info[0].filename), '--strip-components=1', '-C', packagePath], { env, timeout: 10_000, maxBuffer: 4096, encoding: 'utf8' });
  assert.equal(tar.status, 0, String(tar.error ?? tar.stderr));
  const metadata = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
  assert.equal(metadata.dependencies?.typescript, '5.9.3', 'Parser MUST be pinned declared runtime dependency; parent handles metadata');
  for (const file of tracked.filter(path => path !== 'package-lock.json' && path !== 'tsconfig.json' && !path.startsWith('test/'))) {
    assert(existsSync(join(packagePath, file)), 'Missing packed runtime asset: ' + file);
    assert.equal(sha(readFileSync(join(packagePath, file))), before[file], 'Packed asset differs from frozen reviewed source: ' + file);
  }
  const closureRoot = join(root, 'layout/closure'); mkdirSync(closureRoot);
  const copied = new Map(), inventory = [];
  let bytes = 0, files = 0;
  function copyTree(source, dest, packageSource) {
    const st = statSync(source);
    const real = realpathSync(source);
    assert(real === packageSource || real.startsWith(packageSource + sep), 'Declared package escapes its own physical root');
    if (st.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(source)) if (name !== 'node_modules' && name !== '.git') copyTree(join(source, name), join(dest, name), packageSource);
    } else {
      assert(st.isFile() && st.size <= 32 * 1024 * 1024);
      bytes += st.size; assert(bytes <= 512 * 1024 * 1024 && ++files <= 30_000, 'Owned closure resource ceiling');
      copyFileSync(source, dest); chmodSync(dest, st.mode & 0o777);
    }
  }
  function link(from, name, target) {
    const dest = join(from, 'node_modules', name); mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) symlinkSync(relative(dirname(dest), target), dest, 'dir');
    assert(realpathSync(dest).startsWith(join(root, 'layout') + sep), 'All copied dependency links remain owned');
  }
  function copyPackage(source) {
    source = realpathSync(source);
    if (copied.has(source)) return copied.get(source);
    assert(copied.size < 256, 'Declared closure package ceiling');
    const meta = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    const target = join(closureRoot, sha(source).slice(0, 16)); copied.set(source, target);
    copyTree(source, target, source); inventory.push({ name: meta.name, version: meta.version, target: relative(root, target) });
    const deps = { ...meta.dependencies, ...meta.optionalDependencies, ...meta.peerDependencies };
    for (const name of Object.keys(deps)) {
      let dep;
      try { dep = locatePackage(source, name); }
      catch (error) { if (Object.hasOwn(meta.optionalDependencies ?? {}, name) || meta.peerDependenciesMeta?.[name]?.optional) continue; throw error; }
      link(target, name, copyPackage(dep));
    }
    return target;
  }
  for (const name of Object.keys({ ...metadata.dependencies, ...metadata.peerDependencies })) {
    const source = name === '@earendil-works/pi-coding-agent' ? installedPi : name === '@earendil-works/pi-tui' ? locatePackage(installedPi, name) : locatePackage(sourceRoot, name);
    link(packagePath, name, copyPackage(source));
  }
  moduleRoot = packagePath; piPackage = join(packagePath, 'node_modules/@earendil-works/pi-coding-agent');
  assert.equal(JSON.parse(readFileSync(join(packagePath, 'node_modules/typescript/package.json'), 'utf8')).version, '5.9.3');
  put('package-layout.json', { ok: true, archive: info[0].filename, archiveHash: sha(readFileSync(join(pack, info[0].filename))), moduleRoot: relative(root, moduleRoot), inventory, bytes, files, noCheckoutFallback: true, hostLoader: 'declared Pi runtime jiti, not checkout tsx' });
}

const counts = { refine: 0, assess: 0 };
const server = createServer(async (req, res) => {
  responses.add(res); res.once('close', () => responses.delete(res));
  try {
    const input = JSON.parse(await readFixtureBody(req, budget, 262144));
    assert.equal(req.headers.authorization, 'Bearer dummy-script-only'); assert.equal(input.stream, true);
    assert(existsSync(join(root, 'evidence/compiled.json')), 'No HTTP work before explicit compiled save/start');
    const tools = (input.tools ?? []).map(tool => tool.function.name).sort();
    assert.deepEqual(tools, ['read'], 'Existing readonly tool intersection, never shell/write/approval');
    assert(!input.messages.some(message => message.role === 'tool'), 'No tool execution scripted');
    const text = input.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    let answer;
    if (input.model === 'reviewer') { assert(/SCRIPT_ALPHA|SCRIPT_BETA/.test(text)); answer = JSON.stringify(text.includes('SCRIPT_ALPHA') ? 'alpha' : 'beta'); }
    else { assert(['refine', 'assess'].includes(input.model)); answer = JSON.stringify(++counts[input.model]); }
    const id = requests.length + 1; requests.push({ id, model: input.model, tools }); put('http-count.json', { requests: requests.length });
    const respond = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => { const packet = 'data: ' + JSON.stringify({ id: 'script-' + id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'; responseBytes += Buffer.byteLength(packet); assert(responseBytes <= 131072); res.write(packet); };
      emit({ role: 'assistant' }); emit({ content: answer }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
    };
    if (id <= 2) held.push(respond); else respond();
  } catch (error) { failure ??= error; put('server-failure.json', { error: String(error.stack ?? error).slice(-8000) }); res.destroy(); }
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
server.on('clientError', (_error, socket) => socket.destroy());
let releaseTimer;
try {
  if (mode === 'packed') preparePackedLayout();
  writeFileSync(join(root, 'work/sentinel.txt'), 'UNRELATED_SYNTHETIC_BYTES\n');
  const settings = { packages: [], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], skills: [], prompts: [], themes: [], noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
  writeFileSync(join(root, 'agent/settings.json'), JSON.stringify(settings)); writeFileSync(join(root, 'agent/auth.json'), '{}');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'dummy-script-only', models: ['reviewer', 'refine', 'assess'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 2048 })) } } }));
  const sdkPath = realpathSync(join(piPackage, 'dist/index.js'));
  const tuiPath = realpathSync(join(locatePackage(piPackage, '@earendil-works/pi-tui'), 'dist/index.js'));
  const sdk = pathToFileURL(sdkPath).href, tui = pathToFileURL(tuiPath).href;
  const hostModuleAliases = { '@earendil-works/pi-coding-agent': sdkPath, '@earendil-works/pi-tui': tuiPath };
  if (mode === 'packed') for (const path of Object.values(hostModuleAliases)) assert(path.startsWith(join(root, 'layout') + sep), 'Jiti host aliases must stay inside copied declared closure');
  const mapped = { '@earendil-works/pi-coding-agent': sdk, '@earendil-works/pi-tui': tui };
  const packedGuard = mode === 'packed' ? `\nconst checkout=${JSON.stringify(realpathSync(sourceRoot))};\nfunction noCheckout(url){if(url.startsWith('file:')&&decodeURIComponent(new URL(url).pathname).startsWith(checkout+'/'))throw Error('Packed smoke refused checkout fallback');}\n` : '\nfunction noCheckout(_url){}\n';
  writeFileSync(join(root, 'preload.mjs'), guardSource(root, origin) + packedGuard + `\nimport {registerHooks} from 'node:module';\nconst mapped=${JSON.stringify(mapped)};\nregisterHooks({resolve(specifier,context,next){const result=mapped[specifier]?{url:mapped[specifier],shortCircuit:true}:next(specifier,context);noCheckout(result.url);return result;}});\n`);
  // Copy test-only host harness into owned temp root, never into tarball/public files.
  copyFileSync(fixture, join(root, 'fixture.ts'));
  const jitiPath = createRequire(join(piPackage, 'package.json')).resolve('jiti');
  if (mode === 'packed') assert(realpathSync(jitiPath).startsWith(join(root, 'layout') + sep), 'Jiti must come from copied declared host closure');
  const jiti = pathToFileURL(jitiPath).href;
  writeFileSync(join(root, 'sdk-bootstrap.mjs'), `import {createJiti} from ${JSON.stringify(jiti)};const jiti=createJiti(import.meta.url,{moduleCache:true,fsCache:false,alias:${JSON.stringify(hostModuleAliases)}});const fixture=await jiti.import(${JSON.stringify(join(root, 'fixture.ts'))});await fixture.runSDK();`);
  put('config.json', { root, mode: mode === 'packed' ? 'sdk' : mode, sdk, piPackage, moduleRoot, hostModuleAliases, node: process.execPath, cli: join(piPackage, 'dist/bundle/cli.js'), fixture: join(root, 'fixture.ts'), sourceFingerprint: before, origin });
  controller = spawn('/usr/bin/python3', [python, root], { cwd: join(root, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0;
  for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) diagnostics.push(chunk); else { failure ??= Error('Controller output ceiling'); controller.kill('SIGTERM'); } });
  const done = new Promise(resolve => { controller.once('close', () => { closed = true; resolve(); }); controller.once('error', error => { failure ??= error; closed = true; resolve(); }); });
  releaseTimer = setInterval(() => { if (existsSync(join(root, 'evidence/release.json'))) while (held.length) { try { held.shift()(); } catch (error) { failure ??= error; } } }, 20);
  await done; if (failure) throw failure;
  assert.equal(controller.exitCode, 0, 'PTY/SDK controller failed; inspect retained evidence');
  assert.equal(JSON.parse(readFileSync(join(root, 'evidence/result.json'), 'utf8')).ok, true);
  assert.equal(requests.length, 8); assert.deepEqual(counts, { refine: 2, assess: 2 });
  assert(!existsSync(join(root, 'network-refused.txt')), 'No refused outbound attempt');
  assert.deepEqual(sourceHashes(), before, 'Source freeze changed during acceptance');
  assert.equal(readFileSync(join(root, 'work/sentinel.txt'), 'utf8'), 'UNRELATED_SYNTHETIC_BYTES\n');
  put('transport.json', { requests, responseBytes, sourceHashes: before, ok: true });
  console.log('PASS restricted script acceptance ' + mode + '; requests=8; evidence=' + join(root, 'evidence'));
} catch (error) { put('driver-failure.json', { error: String(error.stack ?? error).slice(-16000) }); throw error; }
finally {
  clearInterval(releaseTimer);
  if (controller && !closed) { controller.kill('SIGTERM'); await Promise.race([new Promise(resolve => controller.once('close', () => { closed = true; resolve(); })), sleep(10_000)]); assert(closed, 'Retain sandbox: controller unsettled'); }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  await sleep(20); assert.equal(sockets.size, 0); assert.equal(responses.size, 0);
  put('socket-cleanup.json', { listening: server.listening, sockets: sockets.size, responses: responses.size });
  writeFileSync(join(root, 'evidence/controller.log'), Buffer.concat(diagnostics));
  const proof = existsSync(join(root, 'evidence/pty-result.json')) ? JSON.parse(readFileSync(join(root, 'evidence/pty-result.json'), 'utf8')) : null;
  if (closed && proof && Array.isArray(proof.remaining) && proof.remaining.length === 0) {
    const now = lstatSync(root); assert(now.dev === identity.dev && now.ino === identity.ino && now.uid === identity.uid && !now.isSymbolicLink(), 'Root changed; retain resources');
    for (const name of readdirSync(root)) if (name !== 'evidence' && name !== 'supervisor-result.json') rmSync(join(root, name), { recursive: true, force: true });
  } else put('retained-resources.json', { reason: 'No independently verified controller closure; outer supervisor must settle before deletion' });
}
