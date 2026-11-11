import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Only fake markers are seeded. These children import NO SDK, model or provider.
const helper = new URL('./fixtures/fixture-safety.mjs', import.meta.url).href;
function child(body: string, options = '{}') {
  const dir = mkdtempSync(join(tmpdir(), 'clankers-guard-test-'));
  mkdirSync(join(dir, 'home'));
  writeFileSync(join(dir, 'home', 'auth.json'), '{"key":"FAKE_SEEDED_CREDENTIAL_MARKER"}');
  const script = `import assert from 'node:assert/strict';
import http from 'node:http'; import net from 'node:net'; import tls from 'node:tls';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'; import { join } from 'node:path';
import { installFixtureSafety } from ${JSON.stringify(helper)};
const guard = installFixtureSafety(${options});
const listen = async handler => { const server = http.createServer(handler);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 return { server, url: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions' }; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
${body}
`;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: join(dir, 'home'),
        OPENAI_API_KEY: 'FAKE_SEEDED_CREDENTIAL_MARKER', HTTPS_PROXY: 'http://fake.invalid',
        PI_CODING_AGENT_DIR: join(dir, 'home') },
      timeout: 8000, maxBuffer: 16384, encoding: 'utf8', killSignal: 'SIGKILL',
    });
    assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
    assert(!result.stdout.includes('FAKE_SEEDED_CREDENTIAL_MARKER'));
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const rejected = (body: string, options?: string) => {
  const result = child(body, options); assert.equal(result.status, 86, result.stderr + result.stdout);
};

test('fixture guard removes fake ambient credentials/resources before any SDK import', () => {
  const result = child(`assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.HTTPS_PROXY, undefined);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert(process.env.HOME.startsWith(guard.root));
assert(process.env.PI_CODING_AGENT_DIR.startsWith(guard.root));
assert.deepEqual(guard.childEnv(), { ...process.env });
assert.throws(() => readFileSync(join(process.env.HOME, 'auth.json'))); guard.check();`);
  assert.equal(result.status, 0, result.stderr);
});
test('fixture guard admits only owned POST loopback and closes cleanly (no model)', () => {
  const result = child(`const {server,url} = await listen((req,res) => res.end('pure guard response'));
const response = await fetch(url,{method:'POST',body:'{}'});
assert.equal(await response.text(),'pure guard response'); assert.equal(guard.requests,1);
await close(server); guard.check();`);
  assert.equal(result.status, 0, result.stderr);
});
test('caught unapproved-port and raw socket denials still fail the child', () => {
  rejected(`try { await fetch('http://127.0.0.1:9/v1/chat/completions',{method:'POST',body:'{}'}); } catch {}`);
  rejected(`const {server,url} = await listen((_req,res)=>res.end('never'));
try { net.connect(server.address().port,'127.0.0.1'); } catch {} await close(server);`);
});
test('TLS never opens a socket, even when caller catches the error', () => {
  rejected(`try { tls.connect({host:'127.0.0.1',port:443}); } catch {}`);
});
test('redirect to external or different owned endpoint never follows', () => {
  for (const destination of ['http://fake.invalid/secret', '/unapproved']) {
    rejected(`const {server,url}=await listen((_req,res)=>{res.writeHead(302,{location:${JSON.stringify(destination)}});res.end();});
try {await fetch(url,{method:'POST',body:'{}'});} catch {} await close(server);`);
  }
});
test('method/path/query/hash/userinfo fail closed before HTTP', () => {
  for (const suffix of ['?x=1', '#x', '/bad']) {
    rejected(`const {server,url}=await listen((_req,res)=>res.end('never'));
try {await fetch(url+${JSON.stringify(suffix)},{method:'POST',body:'{}'});} catch {} await close(server);`);
  }
  rejected(`const {server,url}=await listen((_req,res)=>res.end('never'));
try {await fetch(url);} catch {} await close(server);`);
  rejected(`const {server,url}=await listen((_req,res)=>res.end('never'));
try {await fetch(url.replace('http://','http://fake:fake@'),{method:'POST',body:'{}'});} catch {} await close(server);`);
});
test('UTF8 byte ceiling includes strings and streaming Request bodies', () => {
  rejected(`const {server,url}=await listen((_req,res)=>res.end('never'));
try {await fetch(url,{method:'POST',body:'😀'.repeat(9)});} catch {} await close(server);`, '{maxRequestBytes:32}');
  rejected(`const {server,url}=await listen((_req,res)=>res.end('never'));
const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(33));c.close();}});
try {await fetch(new Request(url,{method:'POST',body,duplex:'half'}));} catch {} await close(server);`, '{maxRequestBytes:32}');
});
test('request/retry ceiling is sticky despite caught errors', () => {
  rejected(`const {server,url}=await listen((_req,res)=>res.end('ok'));
await (await fetch(url,{method:'POST',body:'{}'})).text();
try {await fetch(url,{method:'POST',body:'{}'});} catch {} await close(server);`, '{maxRequests:1}');
});
test('late cleanup cannot regain ambient env or closed listener access', () => {
  rejected(`const {server,url}=await listen((_req,res)=>res.end('ok')); await close(server);
await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(process.env.OPENAI_API_KEY,undefined);
try {await fetch(url,{method:'POST',body:'{}'});} catch {}`);
});
test('ancestor resources and cwd escape reject without reading user content', () => {
  rejected(`const parent=join(guard.root,'contaminated'); mkdirSync(parent); mkdirSync(join(parent,'child'));
writeFileSync(join(parent,'AGENTS.md'),'FAKE_RESOURCE_MARKER');
try {process.chdir(join(parent,'child'));} catch {}`);
  rejected(`try {process.chdir('/');} catch {}`);
});
test('cleanup fault remains failure and output ceiling counts UTF8 bytes', () => {
  rejected(`guard.markFailure(Error('synthetic cleanup fault'));`);
  rejected(`process.stdout.write('😀'.repeat(9));`, '{maxOutputBytes:32}');
});
test('hard deadline fails unresolved fixture without restoring secrets', () => {
  rejected(`await new Promise(resolve=>setTimeout(resolve,1000));`, '{timeoutMs:40}');
});

test('synthetic public-session tracking makes unsettled/throwing cleanup fail (NO SDK)', () => {
  rejected(`class FakeSession { bindExtensions() {} dispose() {} }
guard.watchSDK({AgentSession:FakeSession}); new FakeSession().bindExtensions();`);
  rejected(`class FakeSession { bindExtensions() {} dispose() { throw Error('synthetic dispose fault'); } }
guard.watchSDK({AgentSession:FakeSession}); const session=new FakeSession(); session.bindExtensions();
try {session.dispose();} catch {}`);
  const result = child(`class FakeSession { bindExtensions() {} dispose() {} }
guard.watchSDK({AgentSession:FakeSession}); const session=new FakeSession(); session.bindExtensions(); session.dispose();`);
  assert.equal(result.status, 0, result.stderr);
});
test('listener and response byte ceilings fail closed without any model', () => {
  rejected(`const server=http.createServer(); try {server.listen(0,'0.0.0.0');} catch {}`);
  rejected(`const {server,url}=await listen((_req,res)=>{try {res.end('😀'.repeat(9));} catch {res.destroy();}});
try {await fetch(url,{method:'POST',body:'{}'});} catch {} await close(server);`, '{maxOutputBytes:32}');
});
test('stream producers cannot borrow fetch socket authority; response cap is aggregate', () => {
  rejected(`const {server,url}=await listen((_req,res)=>res.end('ok'));
const body=new ReadableStream({pull(c){try {net.connect(server.address().port,'127.0.0.1');} catch {} c.enqueue(new Uint8Array([1])); c.close();}});
try {await fetch(new Request(url,{method:'POST',body,duplex:'half'}));} catch {} await close(server);`);
  rejected(`const {server,url}=await listen((_req,res)=>{try {res.end('😀'.repeat(5));} catch {res.destroy();}});
await (await fetch(url,{method:'POST',body:'{}'})).text();
try {await fetch(url,{method:'POST',body:'{}'});} catch {} await close(server);`, '{maxOutputBytes:32}');
});
