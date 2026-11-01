import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAncestorIsolation, cleanHostEnvironment, guardSource, readFixtureBody, spawnOwnedController, settleOwnedController } from './host-fixture-safety.mjs';

// Parent-only: approved source snapshot + installed Pi/Python, never an install.
// Real Pi public registration/custom renderer + PTY input, no fake host or model.
// Scripted localhost verdicts are not model quality; ANSI is not manual visuals.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
assert(existsSync(cli), 'Installed Pi CLI required');
const evidence = mkdtempSync(join(tmpdir(), 'zerg-workflow-pty-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

function extensionSource(root, phaseDir, restarting) {
  return `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { registerZergSwarmExtension } from ${JSON.stringify(join(repo, 'index.ts'))};
import { createReadOnlyReviewDefinition } from ${JSON.stringify(join(repo, 'workflow-model.ts'))};
import { createZergPersistenceManager } from ${JSON.stringify(join(repo, 'persistence.ts'))};
import { ZergWorkflowComponent } from ${JSON.stringify(join(repo, 'ui/workflow-overlay.ts'))};
const root=${JSON.stringify(root)}, phaseDir=${JSON.stringify(phaseDir)}, restarting=${JSON.stringify(restarting)};
const put=(name,value)=>writeFileSync(join(phaseDir,name),JSON.stringify(value));
const phase=(name,extra={})=>put('phase.json',{name,...extra});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const units=run=>run.steps.flatMap(step=>step.units);
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){if(await check())return;await sleep(20);}throw Error('Timeout: '+label);}
export default function(pi){
  let handler, registrations=0, started=false, cleaned=false;
  const proxy=new Proxy(pi,{get(target,key){if(key==='registerCommand')return(name,options)=>{if(name==='zerg'){handler=options.handler;registrations++;}return target.registerCommand(name,options);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const registration=registerZergSwarmExtension(proxy,{persistence:{enabled:true,snapshotFile:join(root,'snapshot.json')}});
  const control=registration.control;
  const get=id=>control.getState().extensions.workflows.runs.find(run=>run.workflowRunId===id);
  const components=[];
  function cleanup(){if(cleaned)return;cleaned=true;registration.dispose();registration.dispose();}
  pi.on('session_shutdown',cleanup);
  pi.on('session_start',(_event,ctx)=>{if(started)return;started=true;setTimeout(()=>void smoke(ctx).catch(error=>{put('result.json',{ok:false,error:String(error.stack??error).slice(-16000)});try{cleanup();}finally{ctx.shutdown();}}),0);});
  async function execute(input){const result=await control.execute(input);assert(result.ok,JSON.stringify(result));return result;}
  const terminal=run=>run.cleanupSettled&&['completed','failed','cancelled'].includes(run.status);
  function safe(line,width){const plain=line.split(CURSOR_MARKER).join('').replace(/\\u001b\\[[0-9;]*m/g,'');assert(!/[\\u001b\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]/.test(plain),'Unsafe terminal control');assert(!line.includes('\\n')&&!line.includes('\\r'));assert(visibleWidth(line)<=width);}
  function observedContext(ctx){const ui=new Proxy(ctx.ui,{get(target,key){if(key==='custom')return(factory,options)=>target.custom((tui,theme,kb,done)=>{
      const component=factory(tui,theme,kb,done);assert(component&&typeof component.render==='function','Real public component');
      const item={workflow:component instanceof ZergWorkflowComponent,frames:0,styled:false,disposed:false,component};components.push(item);
      const render=component.render.bind(component),dispose=component.dispose?.bind(component);
      component.render=(width,height)=>{const lines=render(width,height);for(const line of lines)safe(line,Math.min(width,tui.terminal?.columns??width));if(height!==undefined)assert(lines.length<=height);if(tui.terminal?.rows!==undefined)assert(lines.length<=tui.terminal.rows);item.frames++;item.styled ||=lines.some(line=>/\\u001b\\[[0-9;]*m/.test(line));return lines;};
      component.dispose=()=>{dispose?.();item.disposed=true;};return component;
    },options);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});return new Proxy(ctx,{get(target,key){return key==='ui'?ui:Reflect.get(target,key);}});}
  function selected(run){const unit=run.steps.find(step=>step.id==='review').units[0];assert(unit.native);return unit;}
  async function native(unit){const run=(await execute({action:'runs.show',runId:unit.native.runId})).data.run;assert.equal(run.taskId,unit.native.taskId);assert.equal(run.nativeSessions.length,1);return run.nativeSessions[0];}
  const key=ref=>({parentRunId:ref.parentRunId,memberRunId:ref.memberRunId,piSessionId:ref.piSessionId});
  async function smoke(ctx){
    assert.equal(ctx.mode,'tui');assert.equal(registrations,1);assert.equal(typeof handler,'function');
    const facade=observedContext(ctx);
    if(restarting){
      const saved=JSON.parse(readFileSync(join(root,'expected.json'),'utf8'));
      const run=get(saved.workflowRunId);assert(run);assert.equal(run.status,'needs-attention');assert.equal(run.recovered,true);assert.equal(run.cleanupSettled,false);
      assert(units(run).some(unit=>unit.status==='unverified'));
      assert.equal(saved.activeUnits.length,2);for(const expected of saved.activeUnits){const unit=units(run).find(unit=>unit.id===expected.id);assert(unit);assert.equal(unit.status,'unverified','Every real in-flight native becomes unverified');assert.equal(unit.cleanupSettled,false);assert.deepEqual(unit.native,expected.native);assert.equal(unit.inputHash,expected.inputHash);}
      assert.equal(run.steps.find(step=>step.id==='review').status,'unverified');
      const before=JSON.stringify(control.getState().extensions.workflows);
      assert.equal((await control.execute({action:'workflows.retry',workflowRunId:run.workflowRunId})).ok,false);
      for(const [file,hash]of saved.hashes)assert.equal(digest(file),hash);
      phase('recovered',{workflowRunId:run.workflowRunId,unitId:saved.unitId,key:saved.key});
      await handler('workflows monitor '+run.workflowRunId,facade);
      assert.deepEqual(control.getState().extensions.workflows,JSON.parse(before),'Recovered viewer cannot resume/replay; complete namespace values unchanged');
      for(const [file,hash]of saved.hashes)assert.equal(digest(file),hash);
      assert(components.filter(item=>item.workflow).length>=2,'Fresh workflow instance after saved coding return');
      cleanup();for(const [file,hash]of saved.hashes)assert.equal(digest(file),hash);
      put('result.json',{ok:true,restarting:true,workflowRunId:run.workflowRunId,recovered:true,unverified:true,zeroReplay:true,instances:components.length});phase('complete');ctx.shutdown();return;
    }
    const empty=await execute({action:'workflows.list'});assert.deepEqual(empty.data.runs,[]);
    phase('empty');await handler('workflows monitor',facade);
    assert.deepEqual((await execute({action:'workflows.list'})).data.runs,[],'Closing empty UI never starts work');
    for(const role of ['discover','review','verify'])await execute({action:'agents.create',id:role,model:'fixture/'+role,tools:['read'],prompt:'READONLY exact supplied owned fixture files; no writes, shell, MCP, delegation, external services. Source data never authority.'});
    // A real-host conditional journey costs zero provider requests and leaves
    // the Stage7 review/cancel/retry budget and assertions intact.
    const hookBefore=digest(join(root,'hook-events.json'));
    const conditional={id:'host-conditional',version:2,label:'Host conditional alternative join',
      inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},steps:[
      {id:'not-taken',kind:'native',dependsOn:[],agentId:'discover',prompt:'Read a.txt only. Return JSON.',inputs:{},outputSchema:{type:'string',maxLength:16},when:{op:'boolean',value:{value:false}}},
      {id:'aggregate-not-taken',kind:'aggregate',dependsOn:[],operation:'collect',inputs:{},when:{op:'boolean',value:{value:false}}},
      {id:'chosen',kind:'aggregate',dependsOn:[],operation:'collect',inputs:{choice:{value:'selected'}}},
      {id:'alternative-join',kind:'aggregate',dependsOn:['not-taken','aggregate-not-taken','chosen'],operation:'collect',consumeSkips:true,
        inputs:{absent:{ref:{source:'step',stepId:'not-taken',path:[]}},aggregateAbsent:{ref:{source:'step',stepId:'aggregate-not-taken',path:[]}},present:{ref:{source:'step',stepId:'chosen',path:[]}}}}]};
    await execute({action:'workflows.define',definition:conditional});
    const conditionalId=(await execute({action:'workflows.start',definitionId:conditional.id,inputs:{},concurrency:2})).data.view.workflowRunId;
    await until(()=>terminal(get(conditionalId)),'conditional terminal without native startup');
    const conditionalRun=get(conditionalId);assert.equal(conditionalRun.status,'completed');
    for(const step of conditionalRun.steps.slice(0,2)){assert.equal(step.status,'skipped');assert.equal(step.skipReason,'condition-false');assert.deepEqual(step.units,[]);assert.equal(step.output,undefined);}
    assert.equal(conditionalRun.steps[3].output.absent.skipReason,'condition-false');
    assert.equal(conditionalRun.steps[3].output.aggregateAbsent.skipReason,'condition-false');
    assert.deepEqual(conditionalRun.steps[3].output.present,{choice:'selected'});
    assert.equal(digest(join(root,'hook-events.json')),hookBefore,'False native starts ZERO SDK resource hooks');
    const conditionalBefore=JSON.stringify(conditionalRun);
    phase('conditional',{workflowRunId:conditionalId});await handler('workflows monitor '+conditionalId,facade);
    assert.equal(JSON.stringify(get(conditionalId)),conditionalBefore,'Conditional viewer close cannot cancel or mutate work');
    const definition=createReadOnlyReviewDefinition({discover:'discover',reviewer:'review',verifier:'verify'});
    await execute({action:'workflows.define',definition});
    const launch=(await execute({action:'workflows.start',definitionId:definition.id,inputs:{candidatePaths:['a.txt','b.txt','failed.txt'],scope:'HOST_LIVE_READONLY'},concurrency:2})).data.view;
    await until(()=>get(launch.workflowRunId).steps.find(step=>step.id==='review').units.filter(unit=>unit.status==='running').length===2,'two real admitted reviews');
    await until(()=>existsSync(join(root,'streaming-a.txt'))&&existsSync(join(root,'streaming-b.txt')),'two loopback stream markers');
    // Retain a detached REAL in-flight checkpoint before PTY actions release
    // either review. Never project a completed DAG back into a running one.
    const saved=JSON.parse(JSON.stringify(control.getState())),checkpoint=JSON.stringify(saved);
    const recover=saved.extensions.workflows.runs.find(run=>run.workflowRunId===launch.workflowRunId);
    assert.equal(recover.status,'running');assert.equal(recover.cleanupSettled,false);
    const activeUnits=units(recover).filter(unit=>unit.status==='running').map(unit=>({id:unit.id,native:unit.native,inputHash:unit.inputHash}));
    assert.equal(activeUnits.length,2);assert(activeUnits.every(unit=>unit.native&&unit.id.startsWith('review:')));
    const savedUnit=selected(recover),savedRef=await native(savedUnit);assert.equal(savedRef.attachment,'attached');
    phase('live',{workflowRunId:recover.workflowRunId,unitId:savedUnit.id,key:key(savedRef)});
    const observation=(async()=>{
      await until(()=>get(launch.workflowRunId).status==='paused','PTY p exact pause');put('paused.json',{workflowRunId:launch.workflowRunId,status:'paused'});
      await until(()=>get(launch.workflowRunId).steps.find(step=>step.id==='review').units.slice(0,2).every(unit=>unit.status==='completed'),'active finish despite pause');
      const paused=get(launch.workflowRunId);assert.equal(paused.status,'paused');assert(!paused.steps.find(step=>step.id==='review').units[2].native,'Pause prevents next admission');put('paused-finish.json',{ok:true});
      await until(()=>terminal(get(launch.workflowRunId)),'PTY p exact resume then partial finish');
      const report=(await execute({action:'workflows.report',workflowRunId:launch.workflowRunId})).data.report;assert.equal(report.partial,true);assert.equal(report.coverage.failedReviews,1);assert.equal(report.workerFailures.length,1);put('finished.json',{ok:true,status:get(launch.workflowRunId).status,partial:true});
    })().catch(error=>{put('observer-error.json',{error:String(error.stack??error).slice(-16000)});throw error;});
    // Observe immediately, so errors while the modal is open are not unhandled.
    const watched=observation.then(()=>({}),error=>({error}));
    await handler('workflows monitor '+launch.workflowRunId,facade);
    const observed=await watched;if(observed.error)throw observed.error;
    assert(terminal(get(launch.workflowRunId)));assert(components.filter(item=>item.workflow).length>=3,'Empty/live/fresh return actual workflow components');
    const cancellation=(await execute({action:'workflows.start',definitionId:definition.id,inputs:{candidatePaths:['a.txt','b.txt','failed.txt'],scope:'HOST_CANCEL_READONLY'},concurrency:2})).data.view;
    await until(()=>get(cancellation.workflowRunId).steps[0].units[0]?.native&&existsSync(join(root,'cancel-streaming')),'cancel attempt owns exact streaming native');
    phase('cancel',{workflowRunId:cancellation.workflowRunId});
    const cancellationWatch=(async()=>{
      await until(()=>terminal(get(cancellation.workflowRunId)),'PTY x natural cancellation');assert.equal(get(cancellation.workflowRunId).status,'cancelled');put('cancelled.json',{ok:true});
      await until(()=>control.getState().extensions.workflows.runs.some(run=>run.retryOf===cancellation.workflowRunId),'PTY r+rendered Enter creates retry');
      const retry=control.getState().extensions.workflows.runs.find(run=>run.retryOf===cancellation.workflowRunId);assert.equal(retry.familyId,cancellation.familyId);assert.equal(retry.attemptNo,2);assert.notEqual(retry.workflowRunId,cancellation.workflowRunId);
      await until(()=>terminal(get(retry.workflowRunId)),'retry natural settlement');
      const done=get(retry.workflowRunId);assert(units(done).filter(unit=>unit.native).every(unit=>!units(get(cancellation.workflowRunId)).some(prior=>prior.native?.runId===unit.native.runId)),'Fresh native retry identities');put('retry-done.json',{ok:true,workflowRunId:done.workflowRunId,attemptNo:2});return done.workflowRunId;
    })().then(id=>({id}),error=>{put('observer-error.json',{error:String(error.stack??error).slice(-16000)});return {error};});
    await handler('workflows monitor '+cancellation.workflowRunId,facade);
    const retried=await cancellationWatch;if(retried.error)throw retried.error;
    assert(control.getState().extensions.workflows.runs.every(terminal),'All live attempts naturally settled before checkpoint restoration');
    const files=[];for(const row of units(recover).filter(unit=>unit.native)){const n=await native(row);assert.equal(n.attachment,'disposed');if(row.id===savedUnit.id)assert.deepEqual(key(n),key(savedRef));files.push(n.sessionFile);}
    cleanup();
    // Restore the unchanged earlier checkpoint only AFTER natural live SDK
    // cleanup. Finalized native histories are not rolled back or modified.
    // This is checkpoint recovery, NOT an actual process-crash test.
    assert.equal(JSON.stringify(saved),checkpoint,'Detached checkpoint unchanged through live actions and cleanup');
    const hashes=files.map(file=>[file,digest(file)]);
    const hookFile=join(root,'hook-events.json'),hookEvents=JSON.parse(readFileSync(hookFile,'utf8'));assert(hookEvents.startup>0&&hookEvents.read>0,'Normal controlled resources/hooks retained in real native SDK');
    hashes.push([hookFile,digest(hookFile)]); // Fresh host must replay ZERO native startup/read hooks too.
    createZergPersistenceManager({enabled:true,snapshotFile:join(root,'snapshot.json')}).save(saved);
    assert.equal(JSON.stringify(saved),checkpoint,'Saving cannot mutate the retained checkpoint');
    writeFileSync(join(root,'expected.json'),JSON.stringify({workflowRunId:recover.workflowRunId,unitId:savedUnit.id,key:key(savedRef),activeUnits,hashes}));
    assert(components.every(item=>item.frames>0&&item.disposed));assert(components.filter(item=>item.workflow).some(item=>item.styled),'Real Pi theme retained');
    put('result.json',{ok:true,restarting:false,partial:true,pausedAdmission:true,cancelled:true,retryAttemptNo:2,workflowRunId:recover.workflowRunId,instances:components.length,hookEvents});phase('complete');ctx.shutdown();
  }
}
`;
}

const pythonSource = String.raw`import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
root, phase_dir, node, cli, mode, restarting = sys.argv[1:]
master, slave = pty.openpty()
def resize(cols,rows): fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
resize(150,55)
env=dict(os.environ); env['TERM']='xterm-256color'
args=[node,'--import',root+'/guard.mjs',cli,'--offline','--no-session','--no-approve','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-tools','--model','fixture/discover','--thinking','off','--tui-mode',mode,'-e',phase_dir+'/smoke.ts']
proc=subprocess.Popen(args,cwd=root+'/work',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
raw=bytearray(); start=time.monotonic()
ansi=re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]')
def pump(wait=.04):
    if select.select([master],[],[],wait)[0]:
        try: data=os.read(master,65536)
        except OSError as error:
            if error.errno==errno.EIO: return
            raise
        raw.extend(data)
        if len(raw)>4*1024*1024:
            del raw[4*1024*1024:]; raise Exception('Terminal evidence ceiling')
        if b'\x1b[6n' in data: os.write(master,b'\x1b[1;1R')
        if b'\x1b[c' in data: os.write(master,b'\x1b[?1;2c')
        if b'\x1b[>c' in data: os.write(master,b'\x1b[>0;0;0c')
def text(since=0): return ansi.sub('',bytes(raw[since:]).decode('utf-8','replace'))
def emitted(value,since=0): return re.sub(r'\s+','',value) in re.sub(r'\s+','',text(since))
def read(name):
    try:
        with open(phase_dir+'/'+name) as f: return json.load(f)
    except (FileNotFoundError,json.JSONDecodeError): return {}
def phase(name): return read('phase.json').get('name')==name
def until(check,label):
    while time.monotonic()-start<(35 if restarting=='1' else 75):
        pump()
        if check(): return
        if read('result.json').get('ok') is False: raise Exception('Host failure: '+str(read('result.json')))
        if read('observer-error.json'): raise Exception('Observer failure: '+str(read('observer-error.json')))
        if proc.poll() is not None:
            if check(): return
            raise Exception('Host exited early: '+label+'\n'+text()[-5000:])
    raise Exception('PTY deadline: '+label+'\n'+text()[-5000:])
def pause(seconds=.25):
    end=time.monotonic()+seconds
    while time.monotonic()<end: pump()
report={'mode':mode,'restarting':restarting=='1','hostPid':proc.pid,'ok':False,'sizes':[150],'keys':[],'segments':{}}
def mark(name): report['segments'][name]=len(raw);return len(raw)
def key(value,label): os.write(master,value);report['keys'].append(label);pause()
def touch(name):
    with open(root+'/'+name,'w')as f:f.write('controller handshake\n')
def resized():
    for cols,rows in [(20,8),(55,25),(150,55)]:
        before=len(raw);resize(cols,rows);os.kill(proc.pid,signal.SIGWINCH);pause(.35);report['sizes'].append(cols);assert len(raw)>before,'No actual resize redraw'
def review_units(data):
    begin=mark('review-units');resized()
    # Initial exact workflow monitor opens phases: discover then review.
    until(lambda:emitted('clankers workflows · steps',begin),'phases rendered')
    key(b'\x1b[B','Down exact review phase');key(b'\r','Enter phase units')
    until(lambda:emitted('clankers workflows · units',begin)and emitted(data['unitId'],begin),'exact selected unit rendered')
def coding(data,saved=False):
    begin=mark('saved-coding'if saved else'live-coding')
    key(b'c','c exact selected native coding');key(b'\x1b[H','Home full exact coding identity')
    for value in data['key'].values():until(lambda v=value:emitted(v,begin),'exact native tuple '+value)
    for _ in range(12):
        if emitted('HOST_WORKFLOW_READ_EVIDENCE',begin):break
        key(b'\x1b[6~','PgDn genuine read tool card')
    until(lambda:emitted('HOST_WORKFLOW_READ_EVIDENCE',begin),'genuine SDK read card emitted')
    if not saved:
        key(b'\x1b[F','End live coding tail');until(lambda:emitted('HOST_LIVE_A_ONLY',begin),'selected live A not sibling');assert 'HOST_LIVE_B_ONLY'not in text(begin),'Wrong sibling coding'
    resized();returned=mark('coding-return');key(b'q','q coding only then fresh workflow return')
    until(lambda:emitted('clankers workflows · units',returned)and emitted(data['unitId'],returned),'same exact workflow unit fresh return')
def terminate(_sig,_frame):raise Exception('Controller terminated')
signal.signal(signal.SIGTERM,terminate)
try:
    if restarting=='0':
        begin=mark('empty');until(lambda:phase('empty'),'empty monitor hook');pause()
        until(lambda:emitted('No retained selection.',begin),'actual empty state');key(b'q','q empty close only')
        until(lambda:phase('conditional'),'conditional alternative join hook');data=read('phase.json');begin=mark('conditional');pause();resized()
        until(lambda:emitted(data['workflowRunId'],begin)and emitted('condition-false',begin)and emitted('completed',begin),'real conditional termination and skipped branch frame')
        key(b'\x03','Ctrl+C conditional monitor close only')
        until(lambda:phase('live'),'live workflow hook');data=read('phase.json');begin=mark('live-phases');pause()
        # Mark after phase handshake but force a real redraw; never stale global text.
        resized();review_units(data);coding(data)
        begin=mark('pause-control');key(b'p','p exact workflow pause admission')
        until(lambda:read('paused.json').get('status')=='paused','public exact paused backing state')
        until(lambda:emitted('paused',begin),'paused frame');touch('release-a.txt');touch('release-b.txt')
        until(lambda:read('paused-finish.json').get('ok')is True,'active finish; third native still unadmitted')
        begin=mark('resume-control');key(b'p','p resume exact paused workflow')
        until(lambda:read('finished.json').get('partial')is True,'partial report backing data preserves failed review')
        until(lambda:emitted('failed',begin),'failed progress emitted');resized();key(b'\x03','Ctrl+C closes only monitor')
        until(lambda:phase('cancel'),'cancel attempt hook');data=read('phase.json');begin=mark('cancel-control');pause();resized()
        until(lambda:emitted(data['workflowRunId'],begin),'exact cancellation attempt rendered');key(b'x','x exact whole workflow cancel')
        until(lambda:read('cancelled.json').get('ok')is True,'cancel native cleanup naturally settled')
        until(lambda:emitted('cancelled',begin),'cancelled frame')
        begin=mark('retry-confirm');key(b'r','r review NEW attempt confirmation')
        until(lambda:emitted('Retry NEW attempt for '+data['workflowRunId'],begin),'exact rendered retry confirmation')
        assert not read('retry-done.json'),'Retry started before explicit Enter'
        key(b'\r','Enter explicit rendered retry consent')
        until(lambda:read('retry-done.json').get('attemptNo')==2,'new workflow/native attempt settles')
        retry=read('retry-done.json');until(lambda:emitted(retry['workflowRunId'],begin),'new attempt receipt frame')
        key(b'\x03','Ctrl+C closes only retry monitor')
    else:
        until(lambda:phase('recovered'),'fresh-process recovery hook');data=read('phase.json');begin=mark('recovered');pause();resized()
        until(lambda:emitted('needs-attention',begin)and emitted('recovered/unverified history',begin),'truthful recovered state')
        key(b'r','r unresolved cleanup cannot retry');pause();assert not emitted('Retry NEW attempt',begin),'Unverified cleanup offered retry'
        review_units(data);coding(data,True);key(b'\x03','Ctrl+C closes recovered monitor only')
    until(lambda:read('result.json').get('ok')is True,'host result');until(lambda:proc.poll()is not None,'natural Pi shutdown');assert proc.returncode==0
    report['ok']=True
except BaseException as error:report['error']=str(error)[-16000:]
finally:
    if proc.poll()is None:
        report['ok']=False;report['forcedCleanup']=True
        os.killpg(proc.pid,signal.SIGTERM)
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
    try:pump(0)
    except BaseException as error:report['ok']=False;report['cleanupError']=str(error)[-1000:]
    os.close(master);report['hostExit']=proc.returncode;report['bytes']=len(raw)
    with open(phase_dir+'/terminal.ansi','wb')as f:f.write(raw)
    with open(phase_dir+'/pty-result.json','w')as f:json.dump(report,f,indent=2)
if not report['ok']:sys.exit(1)
`;

async function runMode(mode) {
  const root = join(evidence, mode), budget = { hits: 0, max: 20 };
  let controller, serverFailure, restarting = false, cancelledGateUsed = false, responseBytes = 0, aborted = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const input = JSON.parse(await readFixtureBody(req, budget, 524288));
      assert(!restarting, 'Fresh host makes zero provider requests');
      assert.equal(req.headers.authorization, 'Bearer dummy-host-workflow-only'); assert.equal(input.stream, true);
      assert.deepEqual((input.tools ?? []).map(tool => tool.function.name), ['read']);
      assert(['discover', 'review', 'verify'].includes(input.model));
      const text = row => typeof row.content === 'string' ? row.content : (row.content ?? []).map(block => block.text ?? '').join('');
      const prompt = input.messages.filter(row => row.role === 'user').map(text).join('\n');
      const begin = '\n\nWORKFLOW_DATA_JSON\n', end = '\nEND_WORKFLOW_DATA_JSON';
      assert.equal(prompt.split(begin).length, 2); const raw = prompt.split(begin)[1]; assert(raw.endsWith(end));
      const data = JSON.parse(raw.slice(0, -end.length)).inputs;
      const read = input.messages.filter(row => row.role === 'tool');
      const target = data.target ?? 'a.txt', role = input.model, cancel = data.scope === 'HOST_CANCEL_READONLY';
      requests.push({ role, target, cancel, read: read.length }); assert(requests.length <= 20);
      if (read.length) assert(read.some(row => text(row).includes('HOST_WORKFLOW_READ_EVIDENCE')), 'Genuine built-in read result');
      if (role === 'review' && read.length && target === 'failed.txt') { res.writeHead(401); res.end('{"error":{"message":"synthetic review failure"}}'); return; }
      assert.notEqual(role, 'verify', 'Empty findings must not invent verifier work');
      res.on('close', () => { if (!res.writableFinished) aborted++; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => {
        const packet = 'data: ' + JSON.stringify({ id: 'host-wf-' + requests.length, object: 'chat.completion.chunk', created: 1, model: role, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
        responseBytes += Buffer.byteLength(packet); assert(responseBytes <= 8388608); res.write(packet);
      };
      emit({ role: 'assistant' });
      if (!read.length) {
        emit({ tool_calls: [{ index: 0, id: 'read-wf-' + requests.length, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: target }) } }] }); emit({}, 'tool_calls');
      } else {
        if (role === 'review' && !cancel && ['a.txt', 'b.txt'].includes(target)) {
          emit({ content: ' ' }); writeFileSync(join(root, 'streaming-' + target), 'stream active\n');
          // Real selected read card carries HOST_LIVE_A_ONLY/B_ONLY; the
          // assistant stream itself is a split schema-valid JSON result.
          // No diagnostic non-JSON text is allowed in the structured answer.
          emit({ content: '{"findings":[]' });
          const gateEnd = Date.now() + 90000;
          while (!existsSync(join(root, 'release-' + target)) && !res.destroyed && Date.now() < gateEnd) await sleep(20);
          assert(existsSync(join(root, 'release-' + target)) && !res.destroyed, 'Admitted worker must finish normally');
          emit({ content: '}' }); emit({}, 'stop');
        } else if (role === 'discover' && cancel && !cancelledGateUsed) {
          cancelledGateUsed = true; writeFileSync(join(root, 'cancel-streaming'), 'owned stream');
          await new Promise(resolve => res.once('close', resolve)); return;
        } else { emit({ content: JSON.stringify(role === 'discover' ? { targets: ['a.txt', 'b.txt', 'failed.txt'] } : { findings: [] }) }); emit({}, 'stop'); }
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { serverFailure ??= String(error.stack ?? error).slice(-16000); writeFileSync(join(root, 'server-error.txt'), serverFailure); res.destroy(error); }
  });
  async function host(restart) {
    const phaseDir = join(root, restart ? 'restart' : 'live');
    writeFileSync(join(phaseDir, 'smoke.ts'), extensionSource(root, phaseDir, restart));
    writeFileSync(join(phaseDir, 'controller.py'), pythonSource);
    controller = spawnOwnedController('/usr/bin/python3', [join(phaseDir, 'controller.py'), root, phaseDir, process.execPath, cli, mode, restart ? '1' : '0'], root, restart ? 40000 : 80000);
    const output = []; let bytes = 0;
    for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) output.push(chunk); else controller.kill('SIGTERM'); });
    await controller.fixtureClosed; writeFileSync(join(phaseDir, 'diagnostics.txt'), Buffer.concat(output));
    await settleOwnedController(controller);
    const load = name => existsSync(join(phaseDir, name)) ? JSON.parse(readFileSync(join(phaseDir, name), 'utf8')) : {};
    const pty = load('pty-result.json'), result = load('result.json');
    assert.equal(controller.exitCode, 0, JSON.stringify({ pty, result, serverFailure }));
    const supervision = JSON.parse(readFileSync(join(root, 'supervisor-result.json'), 'utf8'));
    writeFileSync(join(phaseDir, 'supervisor-result.json'), JSON.stringify(supervision));
    assert.equal(supervision.ok, true, 'Forced cleanup is NEVER acceptance'); assert.deepEqual(supervision.remaining, []);
    assert(pty.ok && result.ok); assert.equal(pty.hostExit, 0); assert(bytes <= 65536);
    assert(!existsSync(join(root, 'network-refused.txt'))); assert(!serverFailure, serverFailure);
    return { ...result, hostPid: pty.hostPid, terminalBytes: pty.bytes, sizes: pty.sizes };
  }
  try {
    assertAncestorIsolation(root); cleanHostEnvironment(root);
    for (const leaf of ['work/.pi', 'agent/extensions', 'live', 'restart']) mkdirSync(join(root, leaf), { recursive: true });
    for (const path of ['a.txt', 'b.txt', 'failed.txt']) writeFileSync(join(root, 'work', path), 'HOST_WORKFLOW_READ_EVIDENCE: ' + path + '\n' + (path === 'a.txt' ? 'HOST_LIVE_A_ONLY' : path === 'b.txt' ? 'HOST_LIVE_B_ONLY' : 'FAILED_COVERAGE') + '\n');
    writeFileSync(join(root, 'agent/auth.json'), '{}');
    const settings = { packages: [], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], skills: [], prompts: [], themes: [], noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
    writeFileSync(join(root, 'agent/settings.json'), JSON.stringify(settings)); writeFileSync(join(root, 'work/.pi/settings.json'), JSON.stringify(settings));
    writeFileSync(join(root, 'hook-events.json'), JSON.stringify({ startup: 0, read: 0 }));
    writeFileSync(join(root, 'agent/extensions/normal.ts'), `import {readFileSync,writeFileSync}from'node:fs';const file=${JSON.stringify(join(root, 'hook-events.json'))};export default function(pi){function add(key){const data=JSON.parse(readFileSync(file,'utf8'));data[key]++;writeFileSync(file,JSON.stringify(data));}pi.on('session_start',()=>add('startup'));pi.on('tool_result',event=>{if(event.toolName==='read'&&!event.isError)add('read');});}\n`);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'dummy-host-workflow-only', models: ['discover', 'review', 'verify'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 512 })) } } }));
    writeFileSync(join(root, 'guard.mjs'), guardSource(root, origin));
    const live = await host(false);
    const before = requests.length; restarting = true; const restart = await host(true);
    assert.equal(requests.length, before, 'Fresh host makes ZERO SDK/provider replay requests');
    assert.notEqual(live.hostPid, restart.hostPid); assert.equal(aborted, 1, 'Only explicitly cancelled owned stream aborts');
    const result = { mode, localhostRequests: requests.length, aborted, live, restart }; results.push(result);
    writeFileSync(join(root, 'checks.json'), JSON.stringify(result, null, 2));
  } finally {
    await settleOwnedController(controller); // If not reaped, retain all isolated resources.
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    const keep = new Set(['live', 'restart', 'checks.json', 'server-error.txt', 'network-refused.txt', 'supervisor-result.json']);
    for (const leaf of existsSync(root) ? readdirSync(root) : []) if (!keep.has(leaf)) rmSync(join(root, leaf), { recursive: true, force: true });
    const hostKeep = new Set(['terminal.ansi', 'pty-result.json', 'result.json', 'diagnostics.txt', 'observer-error.json', 'supervisor-result.json']);
    for (const phase of ['live', 'restart']) for (const leaf of existsSync(join(root, phase)) ? readdirSync(join(root, phase)) : []) if (!hostKeep.has(leaf)) rmSync(join(root, phase, leaf), { recursive: true, force: true });
  }
}
try {
  await runMode('regular'); await runMode('fullscreen');
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ok: true, results, boundary: 'Actual public Pi registration/renderer/input/resize and owned loopback SDK work; no OS sandbox, manual visual or external model-quality certification. Recovery restores an unchanged real two-review in-flight checkpoint after natural live cleanup; NOT an actual process-crash test.' }, null, 2));
  console.log('PASS workflow host acceptance; bounded synthetic evidence: ' + evidence);
} catch (error) { console.error('FAIL workflow host acceptance; bounded synthetic evidence: ' + evidence); throw error; }
