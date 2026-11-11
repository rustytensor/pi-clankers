import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DurableCheckProcessIdentity, DurableCheckReceipt } from '../workflow-checks.js';

// Workflow/service acceptance with fake sealed native transport and real local
// commands. No provider, SDK, Pi host, recovered execution, or source mutation.
const urls = Object.fromEntries(['workflow-runtime', 'state', 'persistence', 'workflow-model'].map(name => [name, new URL(`../${name}.ts`, import.meta.url).href]));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
async function until(predicate: () => boolean, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await delay(15);
  assert.ok(predicate(), label);
}
function identityState(identity: DurableCheckProcessIdentity): 'live' | 'dead' | 'unknown' {
  try {
    if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== identity.bootId) return 'dead';
    const raw = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) return 'unknown';
    return fields[19] !== identity.startTime || ['Z', 'X'].includes(fields[0]) ? 'dead' : 'live';
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown'; }
}
function signalVerified(identity: DurableCheckProcessIdentity, signal: NodeJS.Signals): void {
  assert.equal(identityState(identity), 'live', `refuse signal to unverified identity ${JSON.stringify(identity)}`);
  // Bind the signal to a descriptor, not a PID which could be reused after the
  // preceding observation. Revalidate the tuple after opening the pidfd.
  const result = spawnSync('/usr/bin/python3', ['-c', String.raw`
import json,os,signal,sys
expected=json.loads(sys.argv[1]); fd=os.pidfd_open(expected['pid'])
try:
    assert open('/proc/sys/kernel/random/boot_id').read().strip()==expected['bootId']
    fields=open('/proc/'+str(expected['pid'])+'/stat').read().rsplit(')',1)[1].split()
    assert fields[19]==expected['startTime'] and fields[0] not in ['Z','X']
    signal.pidfd_send_signal(fd,getattr(signal,sys.argv[2]),None,0)
finally:
    os.close(fd)
`, JSON.stringify(identity), signal], { env: {}, encoding: 'utf8', timeout: 2000, maxBuffer: 8192 });
  assert.equal(result.status, 0, `owned pidfd signal failed: ${result.stderr || result.error?.message}`);
}

// Outer owned subreaper adopts the producer's Python supervisor and tsx compiler.
// It only waitpids its own children, never scans /proc or signals unknown PIDs.
const reaper = String.raw`
import ctypes,json,os,signal,subprocess,sys,time
assert ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0
root,label,node,source=sys.argv[1:5]
proc=subprocess.Popen([node,'--import','tsx','--input-type=module','-e',source,root],env={'TMPDIR':root},stdin=subprocess.DEVNULL)
producer_fd=os.pidfd_open(proc.pid)
fields=open('/proc/'+str(proc.pid)+'/stat').read().rsplit(')',1)[1].split()
identity={'pid':proc.pid,'bootId':open('/proc/sys/kernel/random/boot_id').read().strip(),'startTime':fields[19]}
open(os.path.join(root,label+'-pid.json'),'w').write(json.dumps(identity))
reaped=[]; deadline=time.monotonic()+35; empty=False; timed_out=False; deadline_target_gone=False
while time.monotonic()<deadline:
  if not timed_out and time.monotonic()>deadline-8:
    timed_out=True
    try:
      fields=open('/proc/'+str(proc.pid)+'/stat').read().rsplit(')',1)[1].split()
      if fields[19]==identity['startTime'] and fields[0] not in ['Z','X']: signal.pidfd_send_signal(producer_fd,signal.SIGKILL,None,0)
    except (FileNotFoundError,ProcessLookupError): deadline_target_gone=True
  try:
    pid,status=os.waitpid(-1,os.WNOHANG)
    if pid:
      reaped.append({'pid':pid,'exit':os.waitstatus_to_exitcode(status)})
      continue
  except ChildProcessError:
    empty=True; break
  time.sleep(.01)
os.close(producer_fd)
report={'timedOut':timed_out,'empty':empty,'reaped':reaped,'producerPid':proc.pid,'deadlineTargetAlreadyGone':deadline_target_gone}
open(os.path.join(root,label+'-reaped.json'),'w').write(json.dumps(report))
sys.exit(0 if empty and not timed_out else 1)
`;
interface OwnedProcess { child: ChildProcessWithoutNullStreams; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; output: () => string; }
function launch(root: string, label: string, source: string): OwnedProcess {
  const child = spawn('/usr/bin/python3', ['-c', reaper, root, label, process.execPath, source], { env: { TMPDIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  let output = '', bytes = 0;
  const capture = (chunk: Buffer) => {
    bytes += chunk.length;
    output = (output + chunk.toString()).slice(-16384);
    // The fixture emits only bounded summaries. Retain evidence on overflow;
    // do not kill a group or leave the subreaper unable to reap its children.
    if (bytes > 65536) writeFileSync(join(root, label + '-overflow'), String(bytes));
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, output: () => output };
}

function producerSource(boundary: 'running' | 'completed'): string {
  return `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createWorkflowService } from ${JSON.stringify(urls['workflow-runtime'])};
import { createClankersStateContainer, createClankersState, updateClankersState } from ${JSON.stringify(urls.state)};
import { createClankersPersistenceManager } from ${JSON.stringify(urls.persistence)};
import { workflowHash } from ${JSON.stringify(urls['workflow-model'])};
const root=process.argv[1], projectRoot=join(root,'project'), stagingParent=join(root,'stage'), snapshotFile=join(root,'state.json');
const boundary=${JSON.stringify(boundary)};
const ident=()=>({bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:process.pid,startTime:fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(') ').pop().trim().split(/\\s+/)[19]});
const identCode=${JSON.stringify("const fs=require('node:fs');const ident=()=>({bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:process.pid,startTime:fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(') ').pop().trim().split(/\\s+/)[19]});")};
const grandchildCode=identCode+"fs.writeFileSync("+JSON.stringify(join(root,'grandchild.json'))+",JSON.stringify(ident()),{mode:0o600});setTimeout(()=>fs.writeFileSync("+JSON.stringify(join(root,'survival-effect'))+",'survived'),12000);setInterval(()=>{},1000);";
const command=identCode+(boundary==='running'?
  "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"+JSON.stringify(grandchildCode)+"],{env:{TMPDIR:"+JSON.stringify(root)+"},stdio:'ignore'});fs.writeFileSync("+JSON.stringify(join(root,'command.json'))+",JSON.stringify(ident()),{mode:0o600});setInterval(()=>{},1000);":
  "fs.writeFileSync("+JSON.stringify(join(root,'command.json'))+",JSON.stringify(ident()),{mode:0o600});process.exit(0);");
const baseProfile={id:'node',executable:process.execPath,argv:['-e',command],cwd:'src',env:{TMPDIR:root},timeoutMs:20000,allowGeneratedOutputs:false};
const trusted={id:baseProfile.id,executable:baseProfile.executable,argv:baseProfile.argv,cwd:baseProfile.cwd,env:baseProfile.env,timeoutMs:baseProfile.timeoutMs,outputBytes:65536,generatedOutputs:[]};
fs.writeFileSync(join(root,'profile.json'),JSON.stringify(trusted),{mode:0o600});
const str={type:'string',maxLength:256}, arr=items=>({type:'array',maxItems:32,items}), obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const hash=text=>createHash('sha256').update(text).digest('hex');
const policy={version:3,capabilities:['stage-write','check','review','apply'],identity:{parentRunId:'fixture',taskId:'fixture-task',attemptNo:1,workerAgentId:'worker',rootAgentId:'reviewer',model:'fake/model'},scope:{task:'Change old to new in disposable owned fixture',writablePaths:['src/a.txt'],baseline:{projectRootId:projectRoot,stateHash:hash('old\\n')},manifest:[{path:'src/a.txt',text:'old\\n',bytes:4,sha256:hash('old\\n')}]},reviewRequired:true,checkProfiles:[{...baseProfile,profileHash:workflowHash(baseProfile)}]};
const definition={id:'check-interruption',version:3,label:'Check interruption',inputSchema:obj({}),steps:[
{id:'stage',kind:'coding',dependsOn:[],inputs:{},outputSchema:obj({candidateHash:str,changedPaths:arr(str)}),coding:{operation:'stage-write',policy}},
{id:'check',kind:'coding',dependsOn:['stage'],inputs:{},outputSchema:obj({passed:{type:'boolean'},profileId:str,candidateHash:str}),coding:{operation:'check',policy,checkProfileId:'node'}},
{id:'review',kind:'coding',dependsOn:['check'],inputs:{},outputSchema:obj({passed:{type:'boolean'},candidateHash:str,reviewer:str,findings:arr(obj({}))}),coding:{operation:'review',policy}}
]};
const agents=Object.fromEntries(['worker','reviewer'].map(id=>[id,{id,label:id,source:'runtime',prompt:id,model:'fake/model',permissionMode:'inherit'}]));
const base=createClankersStateContainer({agentDefinitions:agents}), store=createClankersPersistenceManager({snapshotFile});store.hydrate(base);
let runId='',approval;
function save(next){
 const run=next.extensions.workflows?.runs?.find(r=>r.workflowRunId===runId);
 const durable=run?.steps.find(s=>s.id==='check')?.units[0]?.coding?.evidence?.durableCheck;
 if(boundary==='completed' && durable?.receipt){
  assert(fs.existsSync(durable.receipt.receiptPath),'Python receipt must precede workflow publication');
  const prior=JSON.parse(fs.readFileSync(snapshotFile,'utf8')).state.extensions.workflows.runs.find(r=>r.workflowRunId===runId);
  assert(!prior.steps.find(s=>s.id==='check').units[0].coding.evidence.durableCheck.receipt);
  assert(!prior.recovery.operations.find(op=>op.kind==='check').result);
  fs.writeFileSync(join(root,'before-receipt-save.json'),JSON.stringify({runId,owner:store.inspectRecoveryOwnership().owner}),{mode:0o600});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 store.save(next);
 if(durable?.ready) fs.writeFileSync(join(root,'ready.json'),JSON.stringify({runId,owner:store.inspectRecoveryOwnership().owner,producerIdentity:ident(),approvalId:approval.id,requestHash:approval.requestHash}),{mode:0o600});
}
const container={...base,replace(next){const value=createClankersState(next);save(value);return base.replace(value);},update(patch,options){const value=updateClankersState(base.read(),patch,options);save(value);return base.replace(value);}};
const native={preflight(){},async execute(req){
 assert.equal(req.coding.operation,'stage-write','check must use real checker, not native callback');
 const identity={runId:'native-writer',taskId:'task-writer'};req.onIdentity(identity);req.coding.write('src/a.txt','new\\n');
 assert.equal(fs.readFileSync(join(req.coding.stageRoot,'src/a.txt'),'utf8'),'new\\n');
 return {status:'completed',text:'{}',cleanupSettled:true,identity};
}};
const service=createWorkflowService(container,native,{recovery:{enabled:true,durablePort:{ensureWriter:()=>store.acquireRecoveryOwnership().owner,inspectOwner:()=>store.inspectRecoveryOwnership()}},coding:{enabled:true,projectRoot,stagingParent,writablePaths:['src/a.txt'],checkProfiles:{node:trusted},allocateCheckReceipt:({candidateId,profileId})=>{
 const receiptDir=fs.mkdtempSync(join(stagingParent,'receipt-')), generation=randomUUID(),nonce=randomUUID(),markerPath=join(receiptDir,'marker.json');
 fs.writeFileSync(markerPath,JSON.stringify({generation,nonce,candidateId,profileId}),{mode:0o600});return {receiptDir,markerPath,generation,nonce,candidateId,profileId};
}}});
const keepAlive=setInterval(()=>{},1000);
const d=await service.execute({action:'workflows.define',definition});assert(d.ok,d.error);
const r=await service.execute({action:'workflows.start',definitionId:definition.id,inputs:{},concurrency:1});assert(r.ok,r.error);runId=r.view.workflowRunId;
const end=Date.now()+5000;while(Date.now()<end){approval=service.approvals.inspect().find(a=>a.kind==='implementation'&&a.status==='pending');if(approval)break;await new Promise(r=>setTimeout(r,10));}
assert(approval,'fresh operator implementation approval required');service.approvals.grantFingerprint(approval.id,approval.requestHash);
`;
}

function verifierSource(label: string, mode: 'live' | 'settled' | 'blocked', profileDrift = false, selectReuse = false): string {
  return `
import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';
import {createWorkflowService} from ${JSON.stringify(urls['workflow-runtime'])};
import {createClankersStateContainer} from ${JSON.stringify(urls.state)};
import {createClankersPersistenceManager} from ${JSON.stringify(urls.persistence)};
const root=process.argv[1], snapshotFile=join(root,'state.json'), ready=JSON.parse(fs.readFileSync(join(root,'ready.json'),'utf8'));
assert.notEqual(process.pid,ready.owner.pid,'must be a fresh verifier PROCESS');
const before=fs.readFileSync(snapshotFile), raw=JSON.parse(before), saved=raw.state.extensions.workflows.runs.find(r=>r.workflowRunId===ready.runId);
const base=createClankersStateContainer(),store=createClankersPersistenceManager({snapshotFile});store.hydrate(base);
const effects={acquire:0,save:0,native:0,check:0,cleanup:0};
const forbidden=k=>()=>{effects[k]++;throw Error('inspection effect '+k);};
const container={...base,replace:forbidden('save'),update:forbidden('save')};
const profile=JSON.parse(fs.readFileSync(join(root,'profile.json'),'utf8'));${profileDrift ? "profile.argv=['-e','process.exit(7)'];" : ''}
function previous(owner){
 if(owner.pid!==ready.owner.pid||owner.bootId!==ready.owner.bootId||owner.startTimeTicks!==ready.owner.startTimeTicks||owner.generation!==ready.owner.generation)return 'unknown';
 try{if(fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==owner.bootId)return 'dead';const fields=fs.readFileSync('/proc/'+owner.pid+'/stat','utf8').split(') ').pop().trim().split(/\\s+/);return fields[19]!==owner.startTimeTicks||['Z','X'].includes(fields[0])?'dead':'live';}
 catch(e){return e.code==='ENOENT'?'dead':'unknown';}
}
assert.equal(previous(ready.owner),${JSON.stringify(mode === 'live' ? 'live' : 'dead')});
const service=createWorkflowService(container,{preflight:forbidden('native'),execute:async()=>forbidden('native')(),cancel:forbidden('cleanup')},{recovery:{enabled:true,durablePort:{ensureWriter:forbidden('acquire'),acquireWriter:forbidden('acquire'),publishSnapshot:forbidden('save'),inspectOwner:()=>store.inspectRecoveryOwnership(),inspectPreviousOwner:previous}},coding:{enabled:true,projectRoot:join(root,'project'),stagingParent:join(root,'stage'),writablePaths:['src/a.txt'],checkProfiles:{node:profile},allocateCheckReceipt:forbidden('check')}});
try{
 assert.equal(service.approvals.inspect().length,0);assert.throws(()=>service.approvals.grantFingerprint(ready.approvalId,ready.requestHash));
 const original=structuredClone(service.get(ready.runId));const check=original.steps.find(s=>s.id==='check').units[0];
 assert.equal(check.status,'unverified');assert.equal(check.cleanupSettled,false);
 assert.equal(check.coding.evidence.durableCheck.receipt,undefined,'external receipt cannot become saved receipt');
 assert.equal(original.cleanupSettled,false,'receipt observations do not settle original workflow flags');
 assert.equal(saved.steps.find(s=>s.id==='check').units[0].status,'running','actual persisted original check was running');
 const op=original.recovery.operations.find(op=>op.kind==='check');assert.equal(op.result,undefined);
 assert.deepEqual(original.recovery.operations,saved.recovery.operations,'actual saved CP must not be rewritten');
 const inspect=await service.execute({action:'workflows.recovery.inspect',workflowRunId:ready.runId});assert(inspect.ok,inspect.error);
 const selections=structuredClone(inspect.assessment.plan.recommendedSelections);
 assert.deepEqual(selections,{reuseUnitIds:[],rerunUnitIds:['stage:0','check:0','review:0']});
 ${selectReuse ? 'selections.reuseUnitIds=[check.id];selections.rerunUnitIds=selections.rerunUnitIds.filter(id=>id!==check.id);' : ''}
 const reply=await service.execute({action:'workflows.recovery.prepare',workflowRunId:ready.runId,selections});assert(reply.ok,reply.error);
 const assessment=reply.assessment;
 assert.equal(assessment.schema.prepareIsPermission,false);
 assert.notEqual(inspect.assessment.plan.status,'prepared','inspect never grants preparation or execution');
 ${mode === 'settled' ? "assert.equal(inspect.assessment.plan.status,'blocked');assert.deepEqual(inspect.assessment.blocked,['unselected-required-execution-address']);" : ''}
 assert.equal(assessment.plan.status,${JSON.stringify(mode === 'settled' ? 'prepared' : 'blocked')},JSON.stringify(assessment.blocked));
 ${mode === 'live' ? "assert.match(JSON.stringify(assessment),/snapshot-writer-live/);" : ''}
 ${mode === 'settled' ? `
 const unit=assessment.units.find(u=>u.unitId===check.id);assert.equal(unit.reuseEligible,false);assert.equal(unit.rerunEligible,true);assert.equal(unit.observedLocalSettlement,true);
 assert(assessment.plan.freshAuthorizationsRequired.includes('implementation'));
 assert.equal(assessment.current.observedReceipts.length,1,'external receipt is current observation, not original CP result');
 assert(assessment.candidateCarry.some(c=>c.state==='reusable-candidate-carry-only'));
 assert(assessment.dependencyInvalidations.downstreamInvalidatedUnitIds.includes(check.id));
 ` : ''}
 assert.deepEqual(service.get(ready.runId),original,'nonexecuting inspection must preserve unverified flags and original missing result');
 assert.deepEqual(fs.readFileSync(snapshotFile),before);assert.equal(fs.readFileSync(join(root,'project/unrelated.txt'),'utf8'),'USER_BYTES');assert.equal(fs.readFileSync(join(root,'project/src/a.txt'),'utf8'),'old\\n');
 assert.deepEqual(effects,{acquire:0,save:0,native:0,check:0,cleanup:0});assert.equal(service.approvals.inspect().length,0);
 fs.writeFileSync(join(root,${JSON.stringify(label + '-result.json')}),JSON.stringify({effects,assessment,verifierPid:process.pid,originalResult:op.result??'missing',checkStatus:check.status}),{mode:0o600});
}finally{service.dispose();}
`;
}

for (const boundary of ['running', 'completed'] as const) {
  test(`workflow ${boundary} check: SIGKILL before receipt publication; fresh-process inert reconciliation`, { skip: process.platform !== 'linux', timeout: 90000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'clankers-workflow-check-interruption-'));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    let succeeded = false, ready: any, supervisor: DurableCheckProcessIdentity | undefined, command: DurableCheckProcessIdentity | undefined, grandchild: DurableCheckProcessIdentity | undefined;
    const processes: OwnedProcess[] = [];
    let stopped = false;
    t.after(async () => {
      try {
        if (stopped && supervisor && identityState(supervisor) === 'live') { signalVerified(supervisor, 'SIGCONT'); stopped = false; }
        const producerIdentity = ready?.producerIdentity ?? (existsSync(join(root, 'producer-pid.json')) ? json(join(root, 'producer-pid.json')) : undefined);
        if (producerIdentity && identityState(producerIdentity) === 'live') signalVerified(producerIdentity, 'SIGKILL');
        command ??= existsSync(join(root, 'command.json')) ? json(join(root, 'command.json')) : undefined;
        grandchild ??= existsSync(join(root, 'grandchild.json')) ? json(join(root, 'grandchild.json')) : undefined;
        // Normal fixtures naturally settle via supervisor EOF cleanup. On failure
        // only these marker/handshake-verified fixture identities may be stopped.
        for (const id of [command, grandchild]) if (id && identityState(id) === 'live') signalVerified(id, 'SIGKILL');
        for (const proc of processes) {
          await until(() => proc.child.exitCode !== null || proc.child.signalCode !== null, 'owned subreaper must exit', 45000);
          await proc.closed;
        }
        if (supervisor) assert.equal(existsSync(`/proc/${supervisor.pid}`), false, 'supervisor reaped, not merely zombie');
        if (command) assert.equal(existsSync(`/proc/${command.pid}`), false);
        if (grandchild) assert.equal(existsSync(`/proc/${grandchild.pid}`), false);
        if (succeeded) { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
        else console.error('Retained workflow interruption failure evidence:', root, processes.map(p => p.output()).join('\n'));
      } finally { if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir; assert.equal(process.env.TMPDIR, previousTmpdir); }
    });
    mkdirSync(join(root, 'project'), { mode: 0o700 }); mkdirSync(join(root, 'project/src')); mkdirSync(join(root, 'stage'), { mode: 0o700 });
    writeFileSync(join(root, 'project/src/a.txt'), 'old\n'); writeFileSync(join(root, 'project/unrelated.txt'), 'USER_BYTES');
    const producer = launch(root, 'producer', producerSource(boundary)); processes.push(producer);
    await until(() => existsSync(join(root, 'ready.json')), 'workflow supervisor handshake saved'); ready = json(join(root, 'ready.json'));
    assert.equal(ready.owner.pid, json(join(root, 'producer-pid.json')).pid);
    assert.equal(ready.owner.startTimeTicks, ready.producerIdentity.startTime);
    assert.equal(identityState(ready.producerIdentity), 'live');
    const snapshotFile = join(root, 'state.json');
    const saved = json(snapshotFile).state.extensions.workflows.runs.find((r: any) => r.workflowRunId === ready.runId);
    const check = saved.steps.find((s: any) => s.id === 'check').units[0];
    const stageUnit = saved.steps.find((s: any) => s.id === 'stage').units[0];
    assert.equal(stageUnit.status, 'completed'); assert.equal(stageUnit.cleanupSettled, true);
    assert.equal(check.status, 'running'); assert.equal(check.cleanupSettled, false);
    assert.equal(saved.recovery.operations.find((op: any) => op.kind === 'check').result, undefined);
    assert.equal(readFileSync(join(stageUnit.coding.workspace.recoveryManifest.stageRoot, 'src/a.txt'), 'utf8'), 'new\n');
    const durable = check.coding.evidence.durableCheck;
    supervisor = durable.ready.supervisorIdentity;
    assert.equal(identityState(supervisor!), 'live');
    const receiptFile = join(durable.config.receiptDir, durable.config.generation + '.receipt.json');
    await until(() => existsSync(join(root, 'command.json')), 'actual approved local command start marker'); command = json(join(root, 'command.json'));
    if (boundary === 'running') {
      await until(() => existsSync(join(root, 'grandchild.json')), 'actual owned command descendant marker'); grandchild = json(join(root, 'grandchild.json'));
      assert.equal(identityState(command!), 'live'); assert.equal(identityState(grandchild!), 'live'); assert.equal(existsSync(receiptFile), false);
    } else {
      await until(() => existsSync(join(root, 'before-receipt-save.json')), 'producer paused immediately before workflow receipt save');
      assert.equal(existsSync(receiptFile), true);
      const receipt = json(receiptFile) as DurableCheckReceipt;
      assert.equal(receipt.commandCompleted, true); assert.equal(receipt.commandOutcome?.exitCode, 0); assert.equal(receipt.cleanup.outcome, 'ok');
    }
    const before = readFileSync(snapshotFile);
    const verify = async (label: string, mode: 'live' | 'settled' | 'blocked', drift = false, reuse = false) => {
      const proc = launch(root, label, verifierSource(label, mode, drift, reuse)); processes.push(proc);
      await until(() => proc.child.exitCode !== null || proc.child.signalCode !== null, 'bounded fresh verifier: ' + label, 12000);
      const close = await proc.closed; assert.equal(close.code, 0, label + ': ' + proc.output());
      assert.equal(existsSync(join(root, label + '-overflow')), false);
      const reaped = json(join(root, label + '-reaped.json')); assert.equal(reaped.empty, true); assert.equal(reaped.reaped.find((r: any) => r.pid === reaped.producerPid).exit, 0, proc.output());
      const result = json(join(root, label + '-result.json')); assert.notEqual(result.verifierPid, ready.owner.pid);
      assert.deepEqual(readFileSync(snapshotFile), before); return result;
    };
    await verify('live', 'live');
    if (boundary === 'running') { signalVerified(supervisor!, 'SIGSTOP'); stopped = true; }
    signalVerified(ready.producerIdentity, 'SIGKILL');
    await until(() => !existsSync(`/proc/${ready.owner.pid}`), 'actual old producer reaped');
    assert.equal(identityState(ready.producerIdentity), 'dead');
    if (boundary === 'running') {
      const unknown = await verify('surviving-supervisor', 'blocked');
      assert.match(JSON.stringify(unknown.assessment.blocked), /durable-check-receipt-missing/);
      assert.equal(identityState(supervisor!), 'live', 'surviving supervisor settlement remains unknown; verifier must not stop it');
      assert.equal(identityState(command!), 'live'); assert.equal(identityState(grandchild!), 'live');
      signalVerified(supervisor!, 'SIGCONT'); stopped = false;
    }
    await until(() => existsSync(receiptFile), 'durable bounded EOF settlement receipt');
    const receipt = json(receiptFile) as DurableCheckReceipt;
    assert.equal(receipt.commandStarted, true); assert.equal(receipt.cleanup.outcome, 'ok');
    assert.deepEqual(receipt.supervisorIdentity, supervisor); assert.equal(receipt.nodeIdentity.pid, ready.owner.pid);
    if (boundary === 'running') {
      assert.equal(receipt.cleanup.attempted, true);
      assert.equal(receipt.commandOutcome?.timedOut, false, 'EOF cleanup must settle before approved command timeout');
      assert.equal(receipt.originalObservation?.parentEofObserved, true); assert.equal(receipt.originalObservation?.ownershipLost, true); assert.equal(receipt.originalObservation?.uncertain, true);
      assert.notEqual(receipt.commandOutcome?.exitCode, 0, 'stopped old command cannot become old success');
    } else {
      assert.equal(receipt.commandCompleted, true); assert.equal(receipt.commandOutcome?.exitCode, 0);
      assert.equal(receipt.originalObservation?.ownershipLost, false, 'already-written completed receipt remains a distinct prior observation');
      assert.equal(receipt.originalObservation?.uncertain, false);
    }
    await until(() => producer.child.exitCode !== null || producer.child.signalCode !== null, 'bounded supervisor/reaper settlement', 6000);
    const closed = await producer.closed; assert.equal(closed.code, 0, producer.output());
    const reaped = json(join(root, 'producer-reaped.json')); assert.equal(reaped.empty, true); assert.ok(reaped.reaped.some((r: any) => r.pid === ready.owner.pid && r.exit === -9)); if (boundary === 'running') assert.ok(reaped.reaped.some((r: any) => r.pid === supervisor!.pid), 'orphan supervisor reaped by owned subreaper'); // Completed supervisor may already be reaped by its producer.
    for (const id of [ready.producerIdentity, supervisor, command, grandchild]) if (id) assert.equal(existsSync(`/proc/${id.pid}`), false, 'all exact owned processes reaped');
    assert.equal(existsSync(join(root, 'survival-effect')), false);
    const settled = await verify('settled', 'settled');
    const observed = settled.assessment.units.find((u: any) => u.unitId === check.id).classifications.find((c: any) => c.operationId === 'durable:' + check.id);
    assert.equal(observed.classification, boundary === 'completed' ? 'completed-invalid' : 'known-failed-cancelled');
    assert.equal(settled.originalResult, 'missing'); assert.equal(settled.checkStatus, 'unverified');
    const reuse = await verify('old-check-reuse', 'blocked', false, true); assert.match(JSON.stringify(reuse.assessment), /selected-reuse-evidence-is-ineligible/);
    // Negative tampering of real retained artifacts only. Never manufacture or
    // rewrite a saved checkpoint, operation history, or positive receipt.
    const bytes = readFileSync(receiptFile);
    renameSync(receiptFile, receiptFile + '.held');
    try { const missing = await verify('missing-receipt', 'blocked'); assert.match(JSON.stringify(missing.assessment.blocked), /durable-check-receipt-missing/); }
    finally { renameSync(receiptFile + '.held', receiptFile); }
    for (const [label, mutate] of [
      ['corrupt-receipt', () => '{'],
      ['identity-wrong', () => JSON.stringify({ ...receipt, supervisorIdentity: { ...receipt.supervisorIdentity, startTime: '0' } })],
      ['cleanup-unknown', () => JSON.stringify({ ...receipt, cleanup: { attempted: true, outcome: 'uncertain' } })],
    ] as const) {
      writeFileSync(receiptFile, mutate());
      try { await verify(label, 'blocked'); } finally { writeFileSync(receiptFile, bytes); }
    }
    const stage = saved.steps.find((s: any) => s.id === 'stage').units[0].coding.workspace.recoveryManifest.stageRoot;
    const candidatePath = join(stage, 'src/a.txt'), candidateBytes = readFileSync(candidatePath);
    writeFileSync(candidatePath, 'drift\n');
    try { await verify('candidate-drift', 'blocked'); } finally { writeFileSync(candidatePath, candidateBytes); }
    const profile = await verify('profile-drift', 'blocked', true); assert.match(JSON.stringify(profile.assessment.blocked), /check-profile-policy-drift/);
    await verify('restored-settlement', 'settled');
    assert.deepEqual(readFileSync(snapshotFile), before); assert.equal(readFileSync(join(root, 'project/unrelated.txt'), 'utf8'), 'USER_BYTES');
    succeeded = true;
  });
}
