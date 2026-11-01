import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Standalone child-process instrumentation, NOT an OS sandbox. Call before any
// SDK/resource import. Never restore ambient credentials or unguarded transports.
// The caller must still use an outer process-group/time/output supervisor.
export function installFixtureSafety({ name = 'sdk', maxRequests = 64,
  maxRequestBytes = 1024 * 1024, maxOutputBytes = 8 * 1024 * 1024,
  timeoutMs = 195000 } = {}) {
  if (globalThis[Symbol.for('zerg/fixture-safety')]) throw Error('Fixture guard already installed');
  const root = mkdtempSync(join(tmpdir(), 'zerg-fixture-' + name.replace(/[^a-z0-9-]/gi, '-') + '-'));
  const environment = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'home'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'),
    PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  for (const path of ['home', 'tmp', 'cache', 'data', 'agent', 'work']) mkdirSync(join(root, path));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  let failure, requests = 0, outputBytes = 0;
  const servers = new Map(), sockets = new Set(), liveSessions = new Set(), watched = new WeakSet();
  const fetchScope = new AsyncLocalStorage();
  const fail = (reason) => {
    failure ??= Error('Fixture safety: ' + reason);
    process.exitCode = 86;
    throw failure;
  };
  const check = () => { if (failure) throw failure; };
  const resourceNames = ['.pi', 'AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD',
    'CLAUDE.md', 'CLAUDE.MD', 'SYSTEM.md', 'APPEND_SYSTEM.md'];
  function checkAncestors(path) {
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      for (const leaf of resourceNames) if (existsSync(join(parent, leaf))) fail('ancestor resource ' + leaf);
      if (parent === dirname(parent)) break;
    }
  }
  const originalChdir = process.chdir.bind(process);
  process.chdir = (path) => {
    const target = resolve(path);
    if (target !== root && !target.startsWith(root + '/')) fail('cwd outside owned root');
    checkAncestors(target);
    originalChdir(target);
  };
  process.chdir(join(root, 'work'));
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const first = args[0];
    const options = typeof first === 'object' ? first : { port: first, host: args[1] };
    if (!(this instanceof http.Server) || options?.host !== '127.0.0.1' || options?.path ||
      !Number.isInteger(Number(options?.port))) fail('unapproved listener');
    this.once('listening', () => {
      const address = this.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') fail('listener address');
      servers.set(this, address.port);
    });
    this.once('close', () => servers.delete(this));
    return originalListen.apply(this, args);
  };
  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...args) {
    if (event === 'request') {
      const [req, res] = args;
      try {
        if (!servers.has(this) || req.method !== 'POST' || req.url !== '/v1/chat/completions') fail('method/path');
        if (++requests > maxRequests) fail('request count');
        if (Number(req.headers['content-length'] ?? 0) > maxRequestBytes) fail('request byte limit');
        let bytes = 0;
        for (const method of ['write', 'end']) {
          const original = res[method];
          res[method] = function (chunk, ...args) {
            if (chunk !== undefined && chunk !== null) outputBytes += Buffer.isBuffer(chunk) ? chunk.length :
              Buffer.byteLength(chunk, typeof args[0] === 'string' ? args[0] : 'utf8');
            if (outputBytes > maxOutputBytes) fail('aggregate response/output byte limit');
            return original.call(this, chunk, ...args);
          };
        }
        const originalPush = req.push;
        req.push = function (chunk, encoding) {
          if (chunk !== null) {
            bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
            if (bytes > maxRequestBytes) {
              try { fail('request byte limit'); } catch (error) { this.destroy(error); return false; }
            }
          }
          return originalPush.call(this, chunk, encoding);
        };
      } catch (error) {
        req.on('error', () => {}); req.destroy(); res.destroy(); return false;
      }
    }
    if (event === 'upgrade' || event === 'connect') fail('HTTP upgrade/tunnel');
    return originalEmit.call(this, event, ...args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    check();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const port = Number(url.port);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      ![...servers.values()].includes(port) || url.pathname !== '/v1/chat/completions' ||
      url.search || url.hash || url.username || url.password || method !== 'POST') fail('fetch endpoint/method');
    // Materialize the body to enforce a real byte cap, including Request streams.
    return (async () => {
      const request = new Request(input, { ...init, redirect: 'error' });
      const reader = request.body?.getReader();
      const chunks = []; let bytes = 0;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > maxRequestBytes) { await reader.cancel(); fail('request byte limit'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
      }
      // Only the trusted fetch transport may open an owned socket, not a body producer.
      const response = await fetchScope.run(port, () => originalFetch(url, { method, headers: request.headers,
        body: Buffer.concat(chunks), signal: request.signal, redirect: 'error' }));
      if (response.status >= 300 && response.status < 400) fail('redirect response');
      return response;
    })().catch(error => {
      // A refused redirect can be caught by SDK retry code: still fail the child.
      if (String(error?.cause?.message ?? error).toLowerCase().includes('redirect')) {
        failure ??= Error('Fixture safety: redirect refused'); process.exitCode = 86;
      }
      throw error;
    });
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' ? first : { port: first, host: args[1] };
    if (options?.path || options?.host !== '127.0.0.1' ||
      ![...servers.values()].includes(Number(options?.port)) ||
      fetchScope.getStore() !== Number(options?.port)) fail('raw/unapproved socket');
    sockets.add(this); this.once('close', () => sockets.delete(this));
    return originalConnect.apply(this, args);
  };
  tls.connect = () => fail('TLS transport');
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...args) => {
      outputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof args[0] === 'string' ? args[0] : 'utf8');
      if (outputBytes > maxOutputBytes) { process.exitCode = 86; process.exit(86); }
      return write(chunk, ...args);
    };
  }
  const deadline = setTimeout(() => { failure ??= Error('Fixture safety: hard deadline'); process.exit(86); }, timeoutMs);
  deadline.unref();
  process.on('beforeExit', () => { if (servers.size || liveSessions.size) failure ??= Error('Fixture safety: unsettled listener/SDK cleanup'); });
  process.on('exit', () => {
    if (failure || servers.size || liveSessions.size) process.exitCode = 86;
    try { rmSync(root, { recursive: true, force: true }); } catch { process.exitCode = 86; }
    // No transport/environment restoration, even after successful cleanup.
  });
  const guard = { root, check, fail, get requests() { return requests; },
    childEnv: () => ({ ...environment }),
    watchSDK(sdk) {
      const proto = sdk.AgentSession.prototype;
      if (watched.has(proto)) return; watched.add(proto);
      const bind = proto.bindExtensions, dispose = proto.dispose;
      proto.bindExtensions = function (...args) {
        if (liveSessions.size >= 128) fail('live SDK handle cap');
        liveSessions.add(this); return bind.apply(this, args);
      };
      proto.dispose = function (...args) {
        try { const result = dispose.apply(this, args); liveSessions.delete(this); return result; }
        catch (error) { failure ??= error; process.exitCode = 86; throw error; }
      };
    },
    markFailure: (error) => { failure ??= error instanceof Error ? error : Error(String(error)); process.exitCode = 86; } };
  globalThis[Symbol.for('zerg/fixture-safety')] = guard;
  return guard;
}
