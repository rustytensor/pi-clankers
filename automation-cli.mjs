#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const INPUT_BYTES = 4096;
const INPUT_DEADLINE_MS = 10000;

/** No event-controlled configuration or positional task text. */
export function parseAutomationArguments(argv) {
  const operation = argv[0];
  if (!['run', 'status', 'report', 'profile-hash'].includes(operation)) throw new Error('invalid-cli-arguments');
  const args = new Map();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--profiles-dir', '--profile-id'].includes(key) || args.has(key) || !value || value.startsWith('--')) {
      throw new Error('invalid-cli-arguments');
    }
    args.set(key, value);
  }
  const profilesDir = args.get('--profiles-dir');
  if (!profilesDir || !isAbsolute(profilesDir) || profilesDir.includes('\0')) throw new Error('invalid-cli-arguments');
  const profileId = args.get('--profile-id');
  if (operation === 'profile-hash' ? !profileId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(profileId) : profileId !== undefined) {
    throw new Error('invalid-cli-arguments');
  }
  return Object.freeze({ operation, profilesDir, ...(profileId ? { profileId } : {}) });
}

// The envelope has scalar fields only. Parse its framing explicitly to reject
// duplicate keys (JSON.parse alone silently accepts them) and nested payloads.
function parseRequestJson(text) {
  let offset = 0;
  const skip = () => { while (/[ \t\r\n]/.test(text[offset] ?? '') && offset < text.length) offset++; };
  const take = (pattern) => {
    skip(); pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) throw new Error('invalid-request-json');
    offset = pattern.lastIndex;
    return JSON.parse(match[0]);
  };
  const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/y;
  const scalar = /(?:"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
  skip();
  if (text[offset++] !== '{') throw new Error('invalid-request-json');
  const keys = new Set();
  skip();
  if (text[offset] !== '}') for (;;) {
    const key = take(string);
    if (keys.has(key) || keys.size >= 4) throw new Error('invalid-request-json');
    keys.add(key);
    skip();
    if (text[offset++] !== ':') throw new Error('invalid-request-json');
    take(scalar);
    skip();
    if (text[offset] !== ',') break;
    offset++;
  }
  if (text[offset++] !== '}') throw new Error('invalid-request-json');
  skip();
  if (offset !== text.length) throw new Error('invalid-request-json');
  return JSON.parse(text);
}

/** Byte bound, strict UTF-8, one JSON value and finite EOF wait; no shell interpolation. */
export async function readAutomationStdin(stream, signal, timeoutMs = INPUT_DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      stream.pause();
      chunks = [];
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > INPUT_BYTES) return finish(new Error('invalid-request-size'));
      chunks.push(bytes);
    };
    const onEnd = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        finish(undefined, parseRequestJson(text));
      } catch { finish(new Error('invalid-request-json')); }
    };
    const onError = () => finish(new Error('stdin-unavailable'));
    const onClose = () => finish(new Error('stdin-unavailable'));
    const onAbort = () => finish(new Error('caller-cancelled'));
    const timer = setTimeout(() => finish(new Error('stdin-deadline')), timeoutMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (stream.readableEnded) onEnd();
    else stream.resume();
  });
}

export async function automationMain(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    const args = parseAutomationArguments(argv);
    // Public bootstrap only. Packaging pins the direct dependency to jiti 2.7.0.
    const { createJiti } = await import('jiti');
    const resolver = createJiti(import.meta.url, { fsCache: false });
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { '@earendil-works/pi-coding-agent': resolver.esmResolve('pi-clankers-worker-sdk') } });
    let result;
    if (args.operation === 'profile-hash') {
      const profileModule = await jiti.import('./automation-profile.ts');
      const profile = await profileModule.loadAutomationProfileForHash(args.profilesDir, args.profileId);
      result = { version: 1, profileId: profile.id, profileHash: profileModule.computeAutomationProfileHash(profile) };
      process.exitCode = 0; // A hash is not enablement, approval, delivery or execution.
    } else {
      const request = await readAutomationStdin(process.stdin, controller.signal);
      const runner = await jiti.import('./automation-runner.ts');
      result = args.operation === 'run'
        ? await runner.runAutomationEvent(args.profilesDir, request, controller.signal)
        : await runner.inspectAutomationEvent(args.profilesDir, request);
      process.exitCode = result.exitCode;
    }
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized, 'utf8') > 65536) throw new Error('result-bound-exceeded');
    process.stdout.write(`${serialized}\n`);
  } catch (error) {
    // Never serialize SDK errors, raw task data, paths, credential names/values or provider output.
    const safeReasons = new Set(['invalid-cli-arguments', 'invalid-request-size', 'invalid-request-json',
      'stdin-unavailable', 'caller-cancelled', 'stdin-deadline', 'result-bound-exceeded']);
    const reasonCode = error instanceof Error && safeReasons.has(error.message) ? error.message : 'automation-unavailable';
    process.stdout.write(`${JSON.stringify({ version: 1, profileId: '', eventId: '', delivery: 'rejected', cleanup: 'not-started', reasonCode, exitCode: 2 })}\n`);
    process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await automationMain();
