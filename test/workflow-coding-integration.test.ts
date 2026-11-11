import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Parent-only Stage8B acceptance. These tests intentionally do not run in the
// ordinary suite: they launch real SDK sessions / Pi TUI hosts and require an
// integrating-parent fixture review before opt-in.
const approved = process.env.CLANKERS_WORKFLOW_ACCEPTANCE === 'parent-approved';
const safetyUrl = new URL('./fixtures/host-fixture-safety.mjs', import.meta.url).href;
const loader = createRequire(import.meta.url).resolve('tsx');

type Fixture = readonly [string, number, RegExp];
const fixtures: Fixture[] = [
  ['workflow-coding-sdk-acceptance.mjs', 240_000, /PASS workflow coding SDK acceptance/],
  ['workflow-coding-host-acceptance.mjs', 360_000, /PASS workflow coding host acceptance/],
];

for (const [fixture, deadline, marker] of fixtures) {
  test(`isolated workflow coding acceptance: ${fixture}`, {
    skip: approved ? false : 'Parent SDK/PTY coding acceptance grant required',
    timeout: deadline + 25_000,
  }, async () => {
    const safety = await import(safetyUrl);
    const root = mkdtempSync(join(tmpdir(), 'clankers-workflow-coding-acceptance-'));
    safety.assertAncestorIsolation(root);
    mkdirSync(join(root, 'work'));
    const controllerPath = join(root, 'controller.py');
    const compiler = realpathSync(createRequire(createRequire(loader).resolve('esbuild/package.json')).resolve(`@esbuild/linux-${process.arch}/bin/esbuild`));
    writeFileSync(controllerPath, String.raw`import ctypes,json,os,signal,subprocess,sys,time
assert sys.platform == 'linux'
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'subreaper unavailable'
compiler=${JSON.stringify(compiler)}
report_path=${JSON.stringify(join(root, 'controller-result.json'))}
report={'ok':False,'fixtureExit':None,'remaining':[],'reaped':[],'errors':[],'signals':[]}
seen={}; proc=None
signal.signal(signal.SIGTERM, lambda s,f: report['signals'].append(s))
signal.signal(signal.SIGINT, lambda s,f: report['signals'].append(s))
def stat(pid):
  try:
    raw=open('/proc/'+str(pid)+'/stat').read(); fields=raw.rsplit(')',1)[1].split()
    return {'pid':pid,'birth':fields[19],'ppid':int(fields[1]),'group':int(fields[2]),'state':fields[0],'comm':raw.split('(',1)[1].rsplit(')',1)[0][:64]}
  except (FileNotFoundError,ProcessLookupError): return None
def owned():
  table={}
  for name in os.listdir('/proc'):
    if name.isdigit():
      e=stat(int(name))
      if e: table[e['pid']]=e
  parents={os.getpid()}; result={}
  for _ in range(65):
    found={pid:e for pid,e in table.items() if e['ppid'] in parents and pid not in parents}
    if not found: break
    result.update(found); parents.update(found)
  for pid,e in result.items():
    try:
      e['exe']=os.readlink('/proc/'+str(pid)+'/exe')
      args=open('/proc/'+str(pid)+'/cmdline','rb').read(4096).split(b'\0')
      e['compiler']=e['comm']=='esbuild' and e['exe']==compiler and any(a.startswith(b'--service=') for a in args)
    except (FileNotFoundError,ProcessLookupError): e['exe']=None; e['compiler']=False
    seen.setdefault((pid,e['birth']),{**e,'compilerVerified':e['compiler']})
    if e['exe'] is not None: seen[(pid,e['birth'])]['compilerVerified']=e['compiler']
    seen[(pid,e['birth'])].update({'ppid':e['ppid'],'state':e['state'],'comm':e['comm']})
  return result
def drain():
  end=time.monotonic()+1
  while True:
    members=owned()
    for pid,e in list(members.items()):
      saved=seen[(pid,e['birth'])]
      if not saved.get('compilerVerified') or e['comm']!='esbuild':
        msg='unexpected descendant '+str(pid)
        if msg not in report['errors']: report['errors'].append(msg)
      if e['ppid']==os.getpid():
        try: reaped,status=os.waitpid(pid,os.WNOHANG)
        except ChildProcessError: reaped=0
        if reaped: report['reaped'].append({'pid':pid,'birth':e['birth'],'comm':e['comm'],'exit':os.waitstatus_to_exitcode(status),'compilerVerified':saved.get('compilerVerified')})
    members=owned()
    if not members or time.monotonic()>=end or report['signals']: break
    time.sleep(.01)
  report['remaining']=list(members.values())
try:
  proc=subprocess.Popen([${JSON.stringify(process.execPath)},'--import',${JSON.stringify(loader)},${JSON.stringify(fileURLToPath(new URL('./fixtures/' + fixture, import.meta.url)))}],stdin=subprocess.DEVNULL)
  while proc.poll() is None and not report['signals']:
    owned(); time.sleep(.01)
  report['fixtureExit']=proc.poll(); drain()
  report['ok']=report['fixtureExit']==0 and not report['remaining'] and not report['errors'] and not report['signals']
finally:
  report['seen']=list(seen.values())
  open(report_path,'w').write(json.dumps(report))
  print('Workflow coding controller settlement: '+json.dumps({k:report.get(k) for k in ['ok','fixtureExit','reaped','signals','errors']})+'; evidence '+report_path, flush=True)
sys.exit(0 if report['ok'] else 1)
`);
    let controller: any; const output: Buffer[] = []; let bytes = 0; let exceeded = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller?.kill('SIGTERM'); }, deadline + 10_000);
    try {
      controller = safety.spawnOwnedController('/usr/bin/python3', [controllerPath], root, deadline);
      const capture = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65_536) { exceeded = true; controller.kill('SIGTERM'); } else output.push(chunk); };
      controller.stdout.on('data', capture); controller.stderr.on('data', capture);
      await controller.fixtureClosed; await safety.settleOwnedController(controller);
      const text = Buffer.concat(output).toString('utf8'); writeFileSync(join(root, 'result.log'), text);
      const report = JSON.parse(readFileSync(join(root, 'supervisor-result.json'), 'utf8'));
      const settlement = JSON.parse(readFileSync(join(root, 'controller-result.json'), 'utf8'));
      assert.equal(settlement.ok, true, `Natural compiler-only drain required; evidence ${root}\n${text}`);
      assert.equal(report.ok, true, `Natural owned process settlement required; evidence ${root}\n${text}`);
      assert(!timedOut && !exceeded && bytes <= 65_536, `bounded output/deadline; evidence ${root}`);
      assert.equal(controller.exitCode, 0, `Acceptance failed; evidence ${root}\n${text}`);
      assert.match(text, marker);
    } finally { clearTimeout(timer); if (output.length) writeFileSync(join(root, 'result.log'), Buffer.concat(output)); await safety.settleOwnedController(controller); }
  });
}
