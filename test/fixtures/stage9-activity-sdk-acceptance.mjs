// AUTHOR-ONLY. Do not execute a provider/SDK/PTY journey without a new parent grant.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, fstatSync, openSync, renameSync, unlinkSync, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';
import { spawn } from 'node:child_process';

const sha = value => createHash('sha256').update(value).digest('hex');
export function regularPath(path, base, directory = false) {
  assert(isAbsolute(path) && isAbsolute(base));
  assert.equal(resolve(path), path); assert.equal(realpathSync(base), base);
  assert(path === base || path.startsWith(base + '/'), 'Path outside explicit capability');
  let current = path;
  for (;;) {
    const st = lstatSync(current);
    assert(!st.isSymbolicLink(), 'No source/parent symlinks');
    if (current === path) {
      assert(directory ? st.isDirectory() : st.isFile());
      if (!directory) assert.equal(st.nlink, 1, 'No hard-linked sources');
    } else assert(st.isDirectory());
    if (current === dirname(current)) break;
    current = dirname(current);
  }
  return path;
}
// Read-only preflight: data inspection only, no module execution or discovery fallback.
// Parent schema: {version:1,root:<absolute>,files:[{path,sha256}]}.
export function inspectManifest(candidate, manifestPath) {
  regularPath(candidate, candidate, true); regularPath(manifestPath, dirname(manifestPath));
  assert(lstatSync(manifestPath).size <= 262144);
  assert.equal(sha(readFileSync(manifestPath)), '2e9ea3e178365b12af84ba2ae2ee191d5b28609546af7746641f06a8ab8e354a', 'Exact immutable parent-reviewed manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.version, 1); assert.equal(manifest.root, candidate);
  assert(Array.isArray(manifest.files) && manifest.files.length <= 512);
  const files = new Map(); let total = 0;
  for (const entry of manifest.files) {
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'sha256']);
    assert(typeof entry.path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(entry.path));
    assert(!isAbsolute(entry.path) && !entry.path.split('/').some(p => !p || p === '.' || p === '..'));
    assert(!files.has(entry.path)); assert(/^[a-f0-9]{64}$/.test(entry.sha256));
    const file = regularPath(join(candidate, entry.path), candidate);
    const st = lstatSync(file); assert(st.size <= 2 * 1024 * 1024);
    total += st.size; assert(total <= 16 * 1024 * 1024);
    assert.equal(sha(readFileSync(file)), entry.sha256, 'Reviewed source hash: ' + entry.path);
    files.set(entry.path, entry.sha256);
  }
  for (const file of ['package.json', 'index.ts', 'types.ts', 'activity.ts', 'internal-patch.ts',
    'state.ts', 'persistence.ts', 'workflow-runtime.ts', 'workflow-model.ts',
    'ui/background-activity.ts', 'ui/management-shortcut.ts', 'ui/preferences.ts',
    'ui/management-overlay.ts', 'ui/settings-pane.ts']) assert(files.has(file), 'Incomplete parent source manifest: ' + file);
  // Parse, never execute, every declared local module (including test roots).
  // Pin the already installed parser; no install, Node resolution fallback for local sources.
  const require = createRequire(join(candidate, 'package.json'));
  const tsPath = realpathSync(require.resolve('typescript'));
  const ts = require(tsPath); assert.equal(ts.version, '5.9.3');
  const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.typescript, '5.9.3'); assert.equal(pkg.dependencies.jiti, '2.7.0');
  const externals = new Set(), edges = [], dynamicOwned = new Set();
  const local = (owner, spec) => {
    assert(spec.startsWith('.'), 'Absolute/outside local module refused: ' + spec);
    const full = resolve(candidate, dirname(owner), spec);
    assert(full.startsWith(candidate + '/'), 'Outside local dependency');
    const rel = full.slice(candidate.length + 1);
    const choices = /\.js$/.test(rel) ? [rel, rel.slice(0, -3) + '.ts'] : /\.[a-z]+$/.test(rel) ? [rel] : [rel, rel + '.ts', rel + '.js', rel + '/index.ts'];
    const found = choices.filter(x => existsSync(join(candidate, x)));
    for (const path of found) assert(files.has(path), 'Unmanifested competing local resolution: ' + path);
    assert.equal(found.length, 1, 'Missing/ambiguous manifest local dependency: ' + owner + ' -> ' + spec);
    regularPath(join(candidate, found[0]), candidate); edges.push([owner, spec, found[0]]);
  };
  const dep = (owner, spec) => {
    if (spec.startsWith('.') || isAbsolute(spec)) return local(owner, spec);
    if (spec.startsWith('node:') || builtinModules.includes(spec)) return;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    assert(Object.hasOwn(pkg.dependencies ?? {}, name) || Object.hasOwn(pkg.peerDependencies ?? {}, name)
      || Object.hasOwn(pkg.devDependencies ?? {}, name), 'Undeclared external module: ' + spec);
    externals.add(spec);
  };
  for (const owner of files.keys()) {
    if (!/\.(?:ts|mjs|js)$/.test(owner)) continue;
    const ast = ts.createSourceFile(owner, readFileSync(join(candidate, owner), 'utf8'), ts.ScriptTarget.Latest, true,
      owner.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    assert.equal(ast.parseDiagnostics.length, 0, 'Source syntax: ' + owner);
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) dep(owner, node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) dep(owner, node.argument.literal.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(ast) === 'jiti.import'))) {
        assert.equal(node.arguments.length, 1);
        if (ts.isStringLiteral(node.arguments[0])) dep(owner, node.arguments[0].text);
        else {
          // Two immutable reviewed test expressions: local dynamic inventory is
          // exactly the parser/transpiler-derived static index imports; bundled
          // SDK URL stays inside the pinned physical SDK package. Reject others.
          const expression = node.arguments[0].getText(ast);
          if (owner === 'test/activity.test.ts' && expression === "new URL(id.replace(/\\.js$/, '.ts'), indexUrl).href") {
            const text = ast.text;
            assert(text.includes("const indexUrl = new URL('../index.ts', import.meta.url)"));
            assert(text.includes('indexCode.matchAll(/require\\("(\\.\\/[^"]+)"\\)/g)'));
            const index = ts.createSourceFile('index.ts', readFileSync(join(candidate, 'index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
            for (const statement of index.statements) if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith('.')) local('index.ts', statement.moduleSpecifier.text);
            dynamicOwned.add(owner);
          } else if ((owner === 'test/management-shortcut-catalog.test.ts' && expression === "new URL('bundle/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href")
            || (owner === 'test/ui/management-shortcut.test.ts' && expression === "new URL('core/keybindings.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href")) {
            dep(owner, '@earendil-works/pi-coding-agent'); dynamicOwned.add(owner);
          } else assert.fail('Unresolved computed module import: ' + owner + ': ' + expression);
        }
      }
      // Owned subprocess code/assets are dependencies, not just import edges.
      if (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL' && node.arguments?.[1]?.getText(ast) === 'import.meta.url') {
        assert(ts.isStringLiteral(node.arguments[0]), 'Computed owned URL refused');
        if (node.arguments[0].text !== '.') { local(owner, node.arguments[0].text); dynamicOwned.add(owner); }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  // workflow-checks uses resolve(dirname(fileURLToPath(import.meta.url)), literal).
  const check = readFileSync(join(candidate, 'workflow-checks.ts'), 'utf8');
  assert(check.includes("resolve(dirname(fileURLToPath(import.meta.url)), 'workflow-check-supervisor.py')"));
  local('workflow-checks.ts', './workflow-check-supervisor.py');
  for (const owner of ['workflow-script-process.ts', 'workflow-checks.ts']) assert(files.has(owner));
  return { manifestHash: sha(readFileSync(manifestPath)), files: Object.fromEntries(files), total,
    closure: { modules: [...files.keys()].filter(x => /\.(ts|mjs|js)$/.test(x)).length,
      edges, externalSpecifiers: [...externals].sort(), parser: { path: tsPath, version: ts.version },
      dynamicOwners: [...dynamicOwned].sort(), ownedAssets: ['workflow-script-compiler.mjs', 'workflow-check-supervisor.py'] } };
}
// Physical dependency closure is DATA ONLY: read package metadata/content,
// follow declared runtime package dependencies inside the explicit installation,
// never evaluate a provider/SDK module or consult another installation.
export function inspectPhysicalDependencies(sdkRoot, hostRoot, candidate) {
  const packages = new Map(); let bytes = 0, fileCount = 0;
  const installation = root => {
    const marker = '/node_modules/'; const at = root.indexOf(marker);
    assert(at >= 0); return root.slice(0, at) + '/node_modules';
  };
  const visit = (root, base) => {
    regularPath(root, base, true);
    if (packages.has(root)) return;
    const pkgPath = regularPath(join(root, 'package.json'), base);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const entry = { path: root, name: pkg.name, version: pkg.version, packageHash: sha(readFileSync(pkgPath)),
      filesHash: '', fileCount: 0, dependencies: {}, absentOptional: [] };
    assert(typeof entry.version === 'string'); packages.set(root, entry); assert(packages.size <= 512);
    const content = [];
    const walk = dir => {
      for (const name of readdirSync(dir).sort()) {
        if (name === 'node_modules') continue;
        const path = join(dir, name), st = lstatSync(path);
        assert(!st.isSymbolicLink(), 'Physical dependency content link refused');
        if (st.isDirectory()) walk(path);
        else {
          regularPath(path, base); assert(st.size <= 64 * 1024 * 1024);
          bytes += st.size; assert(bytes <= 512 * 1024 * 1024);
          assert(++fileCount <= 32768); content.push([path.slice(root.length + 1), sha(readFileSync(path))]);
        }
      }
    };
    walk(root); entry.filesHash = sha(JSON.stringify(content)); entry.fileCount = content.length;
    const resolvePackage = name => {
      assert(/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name));
      let current = root;
      for (;;) {
        const next = join(current, 'node_modules', name);
        if (existsSync(join(next, 'package.json'))) {
          assert(next.startsWith(base + '/'), 'Outside installed dependency fallback');
          regularPath(next, base, true); return next;
        }
        if (current === dirname(base)) return undefined;
        current = dirname(current);
      }
    };
    const optional = pkg.optionalDependencies ?? {};
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...optional })) {
      const path = resolvePackage(name);
      if (!path) { assert(Object.hasOwn(optional, name), 'Missing declared runtime dependency: ' + pkg.name + ' -> ' + name);
        entry.absentOptional.push({ name, range }); continue; }
      entry.dependencies[name] = { range, path }; visit(path, base);
    }
  };
  for (const [root, version] of [[sdkRoot, '1.0.0'], [hostRoot, '1.0.4']]) {
    const base = installation(root); regularPath(base, base, true); visit(root, base);
    assert.equal(packages.get(root).name, '@earendil-works/pi-coding-agent'); assert.equal(packages.get(root).version, version);
    const require = createRequire(join(root, 'package.json'));
    for (const [name, pin] of [['jiti', '2.7.0'], ['@earendil-works/pi-tui', version]]) {
      const path = realpathSync(require.resolve(name)); assert(path.startsWith(base + '/'), 'Host API resolved outside pinned installation');
      const match = [...packages.values()].find(p => p.name === name && path.startsWith(p.path + '/'));
      assert(match, 'Alias dependency missing from physical closure'); assert.equal(match.version, pin);
    }
  }
  // Candidate compiler/parser is explicitly pinned, even though this acceptance
  // uses canonical example definitions and never activates source compilation.
  const require = createRequire(join(candidate, 'package.json'));
  const parser = realpathSync(require.resolve('typescript'));
  let parserRoot = dirname(parser);
  while (!existsSync(join(parserRoot, 'package.json'))) parserRoot = dirname(parserRoot);
  visit(parserRoot, installation(parserRoot)); assert.equal(packages.get(parserRoot).version, '5.9.3');
  return { packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path)), bytes, fileCount,
    digest: sha(JSON.stringify([...packages.values()].sort((a, b) => a.path.localeCompare(b.path)))) };
}
export function exactEndpoint(origin) {
  const url = new URL(origin);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && url.href === origin + '/' && !url.username && !url.password);
  return origin + '/v1/chat/completions';
}
// BEGIN STAGE9 EVIDENCE PUBLICATION (finite fixture messages only).
// One synchronous writer per target; one actor-owned pending slot, never progress/ack.
const EVIDENCE_NAMES = ["http-count.json", "server-failure.json", "config.json", "transport.json", "driver-failure.json", "socket-cleanup.json"];
const EVIDENCE_PENDING = '.stage9-driver-evidence.pending';
function evidenceStat(path) {
  let st;
  try { st = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid());
  return st;
}
function evidencePath(root, name) {
  assert(EVIDENCE_NAMES.includes(name) || name === EVIDENCE_PENDING, 'Unowned evidence path');
  assert(root.startsWith('/tmp/clankers-stage9-') && resolve(root) === root);
  const owner = lstatSync(root); assert(owner.isDirectory() && owner.uid === process.getuid() && (owner.mode & 0o077) === 0);
  const path = join(root, 'evidence', name); assert(path.startsWith(root + '/evidence/') && resolve(path) === path);
  regularPath(dirname(path), root, true); // Reuse the existing normal-parent guard.
  evidenceStat(path); return path;
}
function evidencePut(root, name, value) {
  assert(EVIDENCE_NAMES.includes(name), 'Unowned evidence publisher');
  const text = JSON.stringify(value, null, 2); assert.equal(typeof text, 'string');
  const target = evidencePath(root, name), prior = evidenceStat(target), pending = evidencePath(root, EVIDENCE_PENDING);
  const fd = openSync(pending, 'wx', 0o600), owned = fstatSync(fd); let published = false;
  try {
    try { assert(owned.isFile() && owned.nlink === 1 && owned.uid === process.getuid()); writeFileSync(fd, text); } finally { closeSync(fd); }
    const st = evidenceStat(evidencePath(root, EVIDENCE_PENDING)); assert(st && st.dev === owned.dev && st.ino === owned.ino);
    const current = evidenceStat(evidencePath(root, name));
    assert(prior ? current && current.dev === prior.dev && current.ino === prior.ino : !current, 'Competing evidence writer');
    renameSync(pending, target); published = true;
  } finally {
    if (!published) {
      const st = evidenceStat(evidencePath(root, EVIDENCE_PENDING)); assert(st && st.dev === owned.dev && st.ino === owned.ino);
      unlinkSync(pending); // Exactly one owned cleanup attempt; never a stale/foreign slot.
    }
  }
}
// END STAGE9 EVIDENCE PUBLICATION

async function main(args) {
  if (args[0] === '--preflight-only') {
    const [, candidate, manifest, sdkRoot, hostRoot] = args;
    const source = inspectManifest(candidate, manifest);
    console.log(JSON.stringify({ ...source, ...(sdkRoot && hostRoot ? { physicalDependencies: inspectPhysicalDependencies(sdkRoot, hostRoot, candidate) } : {}) })); return;
  }
  const [root, mode, candidate, manifest, sdkRoot, hostRoot, guardsRoot] = args;
  assert(['sdk', 'regular', 'fullscreen'].includes(mode));
  regularPath(root, root, true);
  const identity = lstatSync(root);
  assert.equal(identity.uid, process.getuid()); assert.equal(identity.mode & 0o077, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'evidence/parent-approval.json'), 'utf8')),
    { guard: 'parent-approved', root, uid: identity.uid, dev: identity.dev, ino: identity.ino });
  const before = inspectManifest(candidate, manifest);
  const dependenciesBefore = inspectPhysicalDependencies(sdkRoot, hostRoot, candidate);
  for (const [path, version] of [[sdkRoot, '1.0.0'], [hostRoot, '1.0.4']]) {
    regularPath(path, path, true);
    assert.equal(JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version, version, 'Explicit installed version only');
  }
  for (const file of ['host-fixture-safety.mjs', 'fixture-safety.mjs']) regularPath(join(guardsRoot, file), guardsRoot);
  const safety = await import(pathToFileURL(join(guardsRoot, 'host-fixture-safety.mjs')).href);
  const { installFixtureSafety } = await import(pathToFileURL(join(guardsRoot, 'fixture-safety.mjs')).href);
  // Unchanged standalone guard creates its OWN clean driver home and owns server
  // transport instrumentation. Child HOME is separately rooted in the supervisor.
  const guard = installFixtureSafety({ name: 'stage9-driver', maxRequests: 32,
    maxRequestBytes: 262144, maxOutputBytes: 1048576, timeoutMs: 165000 });
  safety.assertAncestorIsolation(root);
  const { createServer } = await import('node:http');
  const env = safety.cleanHostEnvironment(root);
  const evidence = join(root, 'evidence');
  const put = (name, value) => evidencePut(root, name, value);
  const fixtureModels = ['solo', 'w0', 'w1', 'w2', 'lead', 'workflow', 'fail', 'cancel',
    'coding-reader', 'coding-writer', 'reuse-a', 'reuse-b', 'generalist', 'reviewer', 'reloaded'];
  const requests = [], sockets = new Set(), responses = new Set(), held = new Map();
  const budget = { hits: 0, max: 32 };
  let failure, responseBytes = 0, controller, closed = false, releaseTimer;
  const diagnostics = []; let diagnosticBytes = 0;
  const server = createServer(async (req, res) => {
    responses.add(res); res.once('close', () => responses.delete(res));
    try {
      assert.equal(req.headers.authorization, 'Bearer DUMMY-stage9-owned-only');
      const input = JSON.parse(await safety.readFixtureBody(req, budget, 262144));
      assert.equal(input.stream, true);
      assert(fixtureModels.includes(input.model));
      const coding = input.model.startsWith('coding-');
      const tools = (input.tools ?? []).map(row => row.function.name).sort();
      assert.deepEqual(tools, coding ? (input.model === 'coding-writer'
        ? ['workflow_stage_inspect', 'workflow_stage_read', 'workflow_stage_write']
        : ['workflow_stage_inspect', 'workflow_stage_read']).sort()
        : ['workflow', 'reuse-a', 'reuse-b', 'generalist', 'reviewer'].includes(input.model) ? ['read'] : [],
        'Exact scoped tool set; no shell/delegation/MCP/approval authority');
      if (!coding) assert(!input.messages.some(row => row.role === 'tool'), 'Readonly scenario invokes no tools');
      const id = requests.length + 1;
      requests.push({ id, model: input.model }); put('http-count.json', { requests: requests.length, rows: requests });
      const send = () => {
        if (res.destroyed) return;
        if (input.model === 'fail' || (input.model === 'reuse-b' && requests.filter(r => r.model === 'reuse-b').length === 1)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          const body = JSON.stringify({ error: { message: 'DUMMY scripted failure' } });
          responseBytes += Buffer.byteLength(body); assert(responseBytes <= 131072); res.end(body); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const emit = (delta, finish_reason = null) => {
          const body = 'data: ' + JSON.stringify({ id: 'stage9-' + id, object: 'chat.completion.chunk', created: 1,
            model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
          responseBytes += Buffer.byteLength(body); assert(responseBytes <= 131072); res.write(body);
        };
        emit({ role: 'assistant' });
        const rowText = row => typeof row.content === 'string' ? row.content : (row.content ?? []).map(b => b.text ?? '').join('');
        const prompt = input.messages.filter(r => r.role === 'user').map(rowText).join('\n');
        const results = input.messages.filter(r => r.role === 'tool');
        const calls = new Map(input.messages.filter(r => r.role === 'assistant').flatMap(r => r.tool_calls ?? []).map(c => [c.id, c]));
        for (const result of results) assert(calls.has(result.tool_call_id), 'Actual tool reply must match a real call');
        let answer = 'done', tool;
        if (coding) {
          if (input.model === 'coding-writer') {
            if (results.length === 0) tool = ['workflow_stage_read', { path: 'src/message.txt' }];
            else if (results.length === 1) {
              assert(rowText(results[0]).includes('hello from disposable project'));
              tool = ['workflow_stage_write', { path: 'src/message.txt', text: 'hello from trusted workflow\n' }];
            } else { assert.equal(results.length, 2); assert(rowText(results[1]).includes('staged write accepted')); answer = { status: 'writer-complete' }; }
          } else if (/Review exact staged candidate/i.test(prompt)) {
            if (!results.length) tool = ['workflow_stage_read', { path: 'src/message.txt' }];
            else { assert.equal(results.length, 1); assert(rowText(results[0]).includes('hello from trusted workflow')); answer = { verdict: 'pass', findings: [] }; }
          } else {
            assert(/Readonly workflow coding investigation/.test(prompt));
            if (!results.length) tool = ['workflow_stage_read', { path: 'package.json' }];
            else { assert.equal(results.length, 1); assert(rowText(results[0]).includes('python3')); answer = { summary: 'readonly inspected disposable package', paths: ['package.json'] }; }
          }
        } else if (input.model === 'generalist' || input.model === 'reviewer') {
          answer = /short summary/.test(prompt) ? { summary: 'dummy readonly survey', concerns: [] }
            : /your verdict/.test(prompt) ? { verdict: 'confirm', reason: 'dummy readonly verification' }
            : { findings: [], questions: [], done: true };
        }
        if (tool) {
          assert(tools.includes(tool[0]));
          emit({ tool_calls: [{ index: 0, id: 'stage9-call-' + id, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] });
          emit({}, 'tool_calls');
        } else { emit({ content: JSON.stringify(answer) }); emit({}, 'stop'); }
        const done = 'data: [DONE]\n\n'; responseBytes += Buffer.byteLength(done); assert(responseBytes <= 131072); res.end(done);
      };
      held.set(id, { model: input.model, send }); res.once('close', () => held.delete(id));
      if (coding || input.model === 'reuse-a' || (input.model === 'reuse-b' && requests.filter(r => r.model === 'reuse-b').length === 1)
        || input.model === 'reloaded') { held.delete(id); send(); }
    } catch (error) {
      failure ??= error; put('server-failure.json', { error: String(error.stack ?? error).slice(-8000) }); res.destroy();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port; exactEndpoint(origin);
    const piRoot = mode === 'sdk' ? sdkRoot : hostRoot;
    const require = createRequire(join(piRoot, 'package.json'));
    // Managed CLI and bundle/index.js share the actual same bundled classes.
    // SDK mode uses the installed unbundled public root. No fabricated bridge.
    const sdkPath = realpathSync(join(piRoot, mode === 'sdk' ? 'dist/index.js' : 'dist/bundle/index.js'));
    const tuiPath = realpathSync(require.resolve('@earendil-works/pi-tui'));
    const jitiPath = realpathSync(require.resolve('jiti'));
    const aliases = { '@earendil-works/pi-coding-agent': sdkPath, '@earendil-works/pi-tui': tuiPath };
    writeFileSync(join(root, 'agent/settings.json'), JSON.stringify({ packages: [],
      extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'],
      skills: [], prompts: [], themes: [], defaultProjectTrust: 'never',
      enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off',
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
      quietStartup: true, theme: 'dark', showHardwareCursor: true }));
    writeFileSync(join(root, 'agent/auth.json'), '{}');
    writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: {
      api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'DUMMY-stage9-owned-only',
      models: fixtureModels.map(id => ({
        id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    } } }));
    // Observable extension collision: Alt+k belongs to the companion fixture.
    writeFileSync(join(root, 'agent/keybindings.json'), JSON.stringify({ 'app.session.new': 'alt+n' }));
    writeFileSync(join(root, 'work/sentinel.txt'), 'immutable Stage9 synthetic sentinel\n');
    const fixtureSource = fileURLToPath(new URL('./stage9-activity-host-fixture.ts', import.meta.url));
    regularPath(fixtureSource, dirname(fixtureSource)); copyFileSync(fixtureSource, join(root, 'fixture.ts'));
    const config = { root, mode, candidateRoot: candidate, manifest, source: before, physicalDependencies: dependenciesBefore, origin,
      sdk: pathToFileURL(sdkPath).href, piRoot, aliases, node: process.execPath,
      cli: join(piRoot, 'dist/bundle/cli.js'), fixture: join(root, 'fixture.ts') };
    put('config.json', config);
    // Install unchanged exact host guard BEFORE SDK/resource imports. Public
    // loader hooks and Jiti aliases pin the two Pi APIs to the selected host.
    writeFileSync(join(root, 'preload.mjs'), safety.guardSource(root, origin) + `
import {registerHooks} from 'node:module';
const aliases=${JSON.stringify(Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,pathToFileURL(v).href])))};
const candidate=${JSON.stringify(candidate)}, files=${JSON.stringify(before.files)};
const physicalRoots=${JSON.stringify(dependenciesBefore.packages.map(p=>p.path))};
function closedResult(result){
 if(result.url?.startsWith('file:')){const u=new URL(result.url),p=decodeURIComponent(u.pathname);
  if(!physicalRoots.some(root=>p.startsWith(root+'/')) && !p.startsWith(candidate+'/') && !p.startsWith(${JSON.stringify(root)}+'/'))throw Error('Outside pinned physical dependency closure');
 }return result;
}
registerHooks({resolve(s,c,next){
 if(aliases[s])return {url:aliases[s],shortCircuit:true};
 if(c.parentURL?.startsWith('file://'+candidate+'/') && (s.startsWith('.')||s.startsWith('/')||s.startsWith('file:'))){
  const u=new URL(s,c.parentURL),p=decodeURIComponent(u.pathname);
  if(u.search||u.hash||!p.startsWith(candidate+'/'))throw Error('Outside candidate local import');
  const rel=p.slice(candidate.length+1), choices=rel.endsWith('.js')?[rel,rel.slice(0,-3)+'.ts']:[rel];
  const found=choices.filter(x=>Object.hasOwn(files,x));if(found.length!==1)throw Error('Unmanifested local import');
  return {url:new URL(found[0],'file://'+candidate+'/').href,shortCircuit:true};
 }
 const result=next(s,c);
 if(c.parentURL?.startsWith('file://'+candidate+'/') || physicalRoots.some(root=>c.parentURL?.startsWith('file://'+root+'/')))return closedResult(result);
 return result;
}});
`);
    writeFileSync(join(root, 'sdk-bootstrap.mjs'), `import {createJiti} from ${JSON.stringify(pathToFileURL(jitiPath).href)};
const jiti=createJiti(import.meta.url,{moduleCache:true,fsCache:false,interopDefault:false,alias:${JSON.stringify(aliases)}});
const fixture=await jiti.import(${JSON.stringify(join(root,'fixture.ts'))});await fixture.runSDK();`);
    controller = spawn('/usr/bin/python3', [fileURLToPath(new URL('./stage9-activity-host-pty.py', import.meta.url)), root],
      { cwd: join(root, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise(resolve => {
      controller.once('close', () => { closed = true; resolve(); });
      controller.once('error', error => { failure ??= error; closed = true; resolve(); });
    });
    for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes <= 65536) diagnostics.push(chunk);
      else { failure ??= Error('Controller output cap'); controller.kill('SIGTERM'); }
    });
    releaseTimer = setInterval(() => {
      if (!existsSync(join(evidence, 'release.json'))) return;
      try {
        const ids = JSON.parse(readFileSync(join(evidence, 'release.json'), 'utf8')).models;
        assert(Array.isArray(ids) && ids.length <= 16);
        for (const [requestId, row] of held) if (ids.includes(row.model)) { held.delete(requestId); row.send(); }
      } catch (error) { failure ??= error; put('server-failure.json', { error: String(error).slice(-8000) }); }
    }, 20);
    await done; if (failure) throw failure;
    assert.equal(controller.exitCode, 0, 'Controller failed; retain all evidence');
    assert.equal(JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8')).ok, true);
    assert(!existsSync(join(root, 'network-refused.txt')), 'No refused outbound attempts');
    assert.deepEqual(inspectManifest(candidate, manifest), before);
    assert.deepEqual(inspectPhysicalDependencies(sdkRoot, hostRoot, candidate), dependenciesBefore);
    assert.equal(readFileSync(join(root, 'work/sentinel.txt'), 'utf8'), 'immutable Stage9 synthetic sentinel\n');
    guard.check(); put('transport.json', { ok: true, requests, responseBytes, source: before, physicalDependencies: dependenciesBefore });
  } catch (error) {
    put('driver-failure.json', { error: String(error.stack ?? error).slice(-16000) }); throw error;
  } finally {
    clearInterval(releaseTimer);
    if (controller && !closed) {
      controller.kill('SIGTERM');
      await Promise.race([new Promise(resolve => controller.once('close', () => { closed = true; resolve(); })),
        new Promise((_, reject) => setTimeout(() => reject(Error('Retain root: controller unsettled')), 10000))]);
    }
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
    put('socket-cleanup.json', { listening: server.listening, sockets: sockets.size, responses: responses.size });
    assert.equal(sockets.size, 0); assert.equal(responses.size, 0);
    writeFileSync(join(evidence, 'controller.log'), Buffer.concat(diagnostics));
    // No eager resource deletion: evidence and dummy-only roots remain for parent
    // review; the ORIGINAL outer supervisor independently proves ancestry closure.
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
