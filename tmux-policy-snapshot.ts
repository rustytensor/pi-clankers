import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import ts from 'typescript';

/** Parent-only inventory, not public JSON. The owner must enumerate ALL discovery
 * roots (including currently absent ones), package/dependency roots and context
 * inputs used by its loader. This helper does not infer completeness from old files.
 * Do not include auth stores. Unsupported loader configurations must be refused. */
export interface TmuxPolicySnapshotInput {
  coverage: 'explicit-trusted-inventory';
  unsupported: readonly string[];
  cwd: string;
  definition: unknown;
  model: string;
  fallbackModels: readonly string[];
  maxTurns: number | null;
  tools: readonly string[];
  denies: readonly string[];
  may_write: unknown;
  result_schema: unknown;
  trustFiles: readonly string[];
  settingsFiles: readonly string[];
  modelFiles: readonly string[];
  resourceRoots: readonly string[];
  discoveryRoots: readonly string[];
}
const MAX_ENTRIES = 4096;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_DATA = 65536;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const CODE = /\.(?:[cm]?ts|[cm]?js)$/;

/** Loading subset, NOT a JavaScript sandbox: trusted unbundled Node Pi/Jiti 2.7
 * with default resolution (no hooks, PnP, environment aliases or tsconfig paths).
 * Exact existing file paths only. Jiti resolves these before extension fallback;
 * missing/extensionless paths, packages, URLs, native addons and ALL runtime
 * builtin/host-SDK imports are refused, not treated as opaque trusted trees.
 * No compiler module resolver or execution-based discovery is used. Type-only
 * edges are conservatively tracked too. Arbitrary reflective JS is not attested.
 * The owner must refuse loaders/configurations outside this contract in unsupported.
 * Source: installed Pi core/extensions/loader.js loadExtensionModule and Jiti 2.7
 * jitiResolve/jitiRequire/evalModule (exact file, native fallback, package type).
 */
function dependencies(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length) throw new Error('Unsupported policy module syntax');
  const result: string[] = [];
  const pending: ts.Node[] = [file];
  let nodes = 0;
  const add = (node: ts.Node | undefined) => {
    if (!node || !ts.isStringLiteral(node)) throw new Error('Computed policy dependency refused');
    const spec = node.text;
    if ((!spec.startsWith('./') && !spec.startsWith('../') && !isAbsolute(spec)) || /[\\\\?#:%\x00-\x1f]/.test(spec) || !/\.(?:[cm]?ts|[cm]?js|json)$/.test(spec)) throw new Error('Unsupported policy dependency resolution');
    result.push(resolve(dirname(path), spec));
  };
  while (pending.length) {
    if (++nodes > MAX_ENTRIES) throw new Error('Policy module syntax limit');
    const node = pending.pop()!;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier);
      if (node.attributes) throw new Error('Unsupported policy import attributes');
    }
    if (ts.isImportEqualsDeclaration(node)) throw new Error('Unsupported policy import equals');
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (node.arguments.length !== 1) throw new Error('Computed policy dependency refused');
      add(node.arguments[0]);
    }
    if (ts.isIdentifier(node) && node.text === 'require' && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) throw new Error('Aliased policy loader refused');
    if ((ts.isIdentifier(node) && ['eval', 'Function', 'globalThis', 'global', 'process', 'module', 'createRequire', 'constructor', '__proto__', 'jiti', 'jitiImport', 'jitiESMResolve'].includes(node.text)) || ts.isElementAccessExpression(node) || ts.isMetaProperty(node) || ts.isWithStatement(node)) throw new Error('Unsupported reflective policy loader');
    ts.forEachChild(node, child => { pending.push(child); });
    if (pending.length > MAX_ENTRIES) throw new Error('Policy module syntax limit');
  }
  return [...new Set(result)].sort();
}

/** Canonical data only: no getters, custom serialization, cycles or unbounded JSON. */
function canonical(value: unknown): string {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): string {
    if (++nodes > MAX_ENTRIES || depth > 32) throw new Error('Policy data limit');
    if (typeof item === 'string' && Buffer.byteLength(item) > MAX_DATA) throw new Error('Policy data limit');
    let result: string;
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) result = JSON.stringify(item);
    else {
      if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('Unsupported policy data');
      const array = Array.isArray(item);
      if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Unsupported policy object');
      const keys = Reflect.ownKeys(item);
      if (keys.length > MAX_ENTRIES || keys.some(key => typeof key !== 'string')) throw new Error('Policy data limit');
      seen.add(item);
      const parts: string[] = [];
      for (const key of (keys as string[]).sort()) {
        if (Buffer.byteLength(key) > MAX_DATA) throw new Error('Policy data limit');
        if (array && key === 'length') continue;
        const d = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in d) || !d.enumerable) throw new Error('Unsupported policy property');
        if (d.value === undefined && !array) continue;
        parts.push(JSON.stringify(key) + ':' + visit(d.value, depth + 1));
      }
      // Preserve array order and length even for indices beyond 9; sparse arrays refused.
      if (array && (parts.length !== (item as unknown[]).length || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(String(key))))) throw new Error('Unsupported policy array');
      result = (array ? '["array",' + (item as unknown[]).length + ',{' : '{') + parts.join(',') + (array ? '}]' : '}');
      seen.delete(item);
    }
    bytes += Buffer.byteLength(result);
    if (bytes > MAX_DATA) throw new Error('Policy data limit');
    return result;
  }
  return visit(value, 0);
}

/** Synchronous bounded reads only. Re-enumerates directories on EVERY call so
 * additions, removals, symlink retargeting and formerly missing roots invalidate.
 * Returns only an opaque digest; file contents and credential values never escape. */
export function captureTmuxPolicySnapshot(input: TmuxPolicySnapshotInput): Readonly<{ version: 1; digest: string }> {
  const policy = canonical(input);
  if (input.coverage !== 'explicit-trusted-inventory' || input.unsupported.length) throw new Error('Incomplete tmux policy inventory');
  if (!isAbsolute(input.cwd) || realpathSync(input.cwd) !== input.cwd) throw new Error('Policy cwd must be canonical');
  const roots = [...input.trustFiles, ...input.settingsFiles, ...input.modelFiles, ...input.resourceRoots, ...input.discoveryRoots];
  if (!input.trustFiles.length || !input.settingsFiles.length || !input.modelFiles.length || !input.discoveryRoots.length || roots.length > 512) throw new Error('Incomplete or oversized policy roots');
  let entries = 0, bytes = 0;
  const records: string[] = [];
  const active = new Set<string>();
  const visited = new Set<string>();
  function walk(path: string, depth: number, required = false): void {
    if (++entries > MAX_ENTRIES || depth > 32 || Buffer.byteLength(path) > 4096) throw new Error('Policy filesystem limit');
    if (!isAbsolute(path) || normalize(path) !== path) throw new Error('Policy path must be absolute and normalized');
    // Never open credential stores, even when accidentally included in a package tree.
    if (/(^|\/)(?:auth\.json|credentials(?:\.json)?|\.env(?:\..*)?|[^/]*\.(?:pem|key)|\.ssh|\.aws|\.gnupg|sessions|logs)(?:\/|$)/i.test(path)) throw new Error('Credential file cannot be a policy resource');
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Policy filesystem unavailable');
      if (required) throw new Error('Unresolved policy dependency');
      if (!visited.has(path)) records.push(JSON.stringify([path, 'absent']));
      visited.add(path); return;
    }
    const target = realpathSync(path);
    if (CODE.test(path) && target !== path) throw new Error('Unsupported policy module symlink');
    if (/(^|\/)(?:auth\.json|credentials(?:\.json)?|\.env(?:\..*)?|[^/]*\.(?:pem|key)|\.ssh|\.aws|\.gnupg|sessions|logs)(?:\/|$)/i.test(target)) throw new Error('Credential file cannot be a policy resource');
    if (required && (target !== path || !stat.isFile())) throw new Error('Unsupported policy dependency path');
    if (visited.has(path)) return;
    if (stat.isFile()) visited.add(path);
    records.push(JSON.stringify([path, target, stat.mode, stat.dev, stat.ino]));
    if (stat.isSymbolicLink()) { walk(target, depth + 1); return; }
    if (stat.isDirectory()) {
      if (active.has(target)) throw new Error('Policy resource cycle');
      active.add(target);
      const names: string[] = [];
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (names.length + entries >= MAX_ENTRIES) throw new Error('Policy filesystem limit');
          names.push(entry.name);
        }
      } finally { dir.closeSync(); }
      for (const name of names.sort()) walk(join(path, name), depth + 1);
      active.delete(target); return;
    }
    if (!stat.isFile() || stat.size > MAX_FILE || bytes + stat.size > MAX_BYTES) throw new Error('Policy file limit or unsupported resource');
    if (extname(path) === '.node' || /\.(?:wasm|tsx|jsx)$/.test(path)) throw new Error('Unsupported policy module format');
    let source = '';
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw new Error('Policy file changed');
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = readSync(fd, buffer, length, buffer.length - length, null);
        if (!n) break;
        length += n;
      }
      const after = fstatSync(fd);
      if (length !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Policy file changed');
      bytes += length;
      records.push(JSON.stringify([path, hash(buffer.subarray(0, length))]));
      if (CODE.test(path)) source = buffer.subarray(0, length).toString('utf8');
    } finally { closeSync(fd); }
    if (CODE.test(path)) {
      // Include absent package scopes as well: creating a nearer package.json can
      // change Node/Jiti native loading. No directory or node_modules scan here.
      let dir = dirname(path);
      for (let level = 0; ; level++) {
        if (level > 32) throw new Error('Policy package scope limit');
        walk(join(dir, 'package.json'), depth + 1);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      for (const dependency of dependencies(path, source)) walk(dependency, depth + 1, true);
    }
  }
  for (const root of [...new Set(roots)].sort()) walk(root, 0);
  return Object.freeze({ version: 1, digest: hash(policy + '\n' + records.join('\n')) });
}

/** The getter must return current parent definition AND current trusted inventory.
 * Two captures detect unstable preparation; assertCurrent is suitable for startup fences. */
export function createTmuxPolicySnapshot(readCurrent: () => TmuxPolicySnapshotInput) {
  const expected = captureTmuxPolicySnapshot(readCurrent());
  const assertCurrent = () => {
    if (captureTmuxPolicySnapshot(readCurrent()).digest !== expected.digest) throw new Error('Tmux policy changed; prepare again');
  };
  assertCurrent();
  return Object.freeze({ ...expected, assertCurrent });
}
