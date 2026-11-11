import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DurableCheckProcessIdentity } from '../workflow-checks.js';

// Seventh workflow crash boundary: selected child durably committed, fresh
// implementation approval pending, BEFORE admission. Closed local fake native
// port only; this is NOT SDK/Pi-host/provider proof (separate acceptance fixture).
const urls = Object.fromEntries(['workflow-runtime', 'state', 'persistence', 'workflow-model'].map(name => [name, new URL(`../${name}.ts`, import.meta.url).href]));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function json(path: string): any {
  assert.ok(lstatSync(path).size <= 1024 * 1024, 'bounded fixture JSON');
  return JSON.parse(readFileSync(path, 'utf8'));
}
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

// Outer owned subreaper adopts each driver's orphaned tsx compiler, if any.
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

// Drivers run with only TMPDIR. All fixtures/receipts/tsx compiler caches live in
// this owned root; no inherited HOME/PATH/provider tokens, network or Git.
const common = `
import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createWorkflowService,recoverWorkflowState} from ${JSON.stringify(urls['workflow-runtime'])};
import {createClankersStateContainer,createClankersState,updateClankersState} from ${JSON.stringify(urls.state)};
import {createClankersPersistenceManager} from ${JSON.stringify(urls.persistence)};
import {workflowHash} from ${JSON.stringify(urls['workflow-model'])};
const root=process.argv[1],projectRoot=join(root,'project'),stagingParent=join(root,'stage'),snapshotFile=join(root,'state.json');
const boundedRead=p=>{assert(fs.lstatSync(p).size<=1024*1024,'bounded fixture JSON');return JSON.parse(fs.readFileSync(p,'utf8'));};
const read=p=>boundedRead(join(root,p));
const record=(p,v)=>{const bytes=JSON.stringify(v);assert(Buffer.byteLength(bytes)<=1024*1024);const path=join(root,p);fs.writeFileSync(path+'.pending',bytes,{mode:0o600});fs.renameSync(path+'.pending',path);};
const ident=()=>({bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:process.pid,startTime:fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(') ').pop().trim().split(/\\s+/)[19]});
function previous(owner){
 try{if(fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==owner.bootId)return 'dead';const fields=fs.readFileSync('/proc/'+owner.pid+'/stat','utf8').split(') ').pop().trim().split(/\\s+/);return fields[19]!==owner.startTimeTicks||['Z','X'].includes(fields[0])?'dead':'live';}
 catch(e){return e.code==='ENOENT'?'dead':'unknown';}
}
const profile={id:'node',executable:process.execPath,argv:['-e','process.exit(0)'],cwd:'src',env:{},timeoutMs:2000,outputBytes:65536,generatedOutputs:[]};
const coding={enabled:true,projectRoot,stagingParent,writablePaths:['src/a.txt'],checkProfiles:{node:profile}};
const snapshot=()=>boundedRead(snapshotFile).state.extensions.workflows;
const base=createClankersStateContainer(),store=createClankersPersistenceManager({snapshotFile});store.hydrate(base);
`;

function producerSource(): string {
  return common + `
const hash=t=>createHash('sha256').update(t).digest('hex');
const str={type:'string',maxLength:256},arr=items=>({type:'array',maxItems:32,items}),obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const baseProfile={id:profile.id,executable:profile.executable,argv:profile.argv,cwd:profile.cwd,env:profile.env,timeoutMs:profile.timeoutMs,allowGeneratedOutputs:false};
const policy={version:3,capabilities:['stage-write','check','review','apply'],identity:{parentRunId:'fixture',taskId:'fixture-task',attemptNo:1,workerAgentId:'worker',rootAgentId:'reviewer',model:'fake/model'},scope:{task:'Change old to new in owned disposable fixture',writablePaths:['src/a.txt'],baseline:{projectRootId:projectRoot,stateHash:hash('old\\n')},manifest:[{path:'src/a.txt',text:'old\\n',bytes:4,sha256:hash('old\\n')}]},reviewRequired:true,checkProfiles:[{...baseProfile,profileHash:workflowHash(baseProfile)}]};
const definition={id:'selected-interruption',version:3,label:'Selected interruption',inputSchema:obj({}),steps:[
 {id:'stage',kind:'coding',dependsOn:[],inputs:{},outputSchema:obj({candidateHash:str,changedPaths:arr(str)}),coding:{operation:'stage-write',policy}},
 {id:'check',kind:'coding',dependsOn:['stage'],inputs:{},outputSchema:obj({passed:{type:'boolean'},profileId:str,candidateHash:str}),coding:{operation:'check',policy,checkProfileId:'node'}},
 {id:'review',kind:'coding',dependsOn:['check'],inputs:{},outputSchema:obj({passed:{type:'boolean'},candidateHash:str,reviewer:str,findings:arr(obj({}))}),coding:{operation:'review',policy}},
 {id:'apply',kind:'coding',dependsOn:['review'],inputs:{},outputSchema:obj({status:str,candidateHash:str,appliedPaths:arr(str),rejectedPaths:arr(str),diagnostics:arr(str),outcomeHash:str}),coding:{operation:'apply',policy}}
]};
base.update({agentDefinitions:Object.fromEntries(['worker','reviewer'].map(id=>[id,{id,label:id,source:'runtime',prompt:id,model:'fake/model',permissionMode:'inherit'}]))});
const save=next=>{store.save(next);return base.replace(next);};
const container={...base,replace:next=>save(createClankersState(next)),update:(patch,options)=>save(updateClankersState(base.read(),patch,options))};
let runId='',approval;
// CLOSED OWNED PORT: the only effect is synchronous coding.write in THIS process.
// It does not spawn, dispatch, detach or return completed; then awaits forever.
const native={preflight(){},async execute(req){
 assert.equal(req.coding.operation,'stage-write');assert.equal(req.workflowRunId,runId);
 req.onIdentity({runId:'owned-old-writer',taskId:'owned-old-task'});
 req.coding.write('src/a.txt','new\\n');
 const saved=snapshot().runs.find(r=>r.workflowRunId===runId),unit=saved.steps[0].units[0];
 const ops=saved.recovery.operations.filter(op=>op.kind==='native');assert.equal(ops.length,1);const op=ops[0];assert.equal(op.result,undefined);
 assert.equal(op.unitId,req.unitId);assert.equal(op.inputHash,req.inputHash);assert.equal(unit.status,'running');assert.equal(saved.cleanupSettled,false);
 const tuple={workflowRunId:saved.workflowRunId,familyId:saved.familyId,unitId:op.unitId,operationId:op.id,native:unit.native??null,inputHash:op.inputHash,dependencyHash:op.dependencyHash,policyHash:op.policyHash};
 record('old-ready.json',{runId,approvalId:approval.id,requestHash:approval.requestHash,owner:store.inspectRecoveryOwnership().owner,identity:ident(),tuple,stageRoot:req.coding.stageRoot});
 await new Promise(()=>{});
}};
const service=createWorkflowService(container,native,{recovery:{enabled:true,durablePort:{ensureWriter:()=>store.acquireRecoveryOwnership().owner,inspectOwner:()=>store.inspectRecoveryOwnership()}},coding});
setInterval(()=>{},1000);
const d=await service.execute({action:'workflows.define',definition});assert(d.ok,d.error);
const r=await service.execute({action:'workflows.start',definitionId:definition.id,inputs:{},concurrency:1});assert(r.ok,r.error);runId=r.view.workflowRunId;
const end=Date.now()+6000;while(Date.now()<end){approval=service.approvals.inspect().find(a=>a.kind==='implementation'&&a.status==='pending');if(approval)break;await new Promise(r=>setTimeout(r,10));}
assert(approval);service.approvals.grantFingerprint(approval.id,approval.requestHash);
`;
}

function confirmerSource(): string {
  return common + `
const old=read('old-ready.json');assert.notEqual(process.pid,old.identity.pid);assert.equal(previous(old.owner),'dead');assert.equal(fs.existsSync('/proc/'+old.identity.pid),false);
const initial=fs.readFileSync(snapshotFile),original=snapshot().runs.find(r=>r.workflowRunId===old.runId);
const effects={acquire:0,publish:0,save:0,native:0,check:0,cleanup:0};let fingerprint,selections,service;
const forbidden=k=>()=>{effects[k]++;throw Error('unexpected effect '+k);};
const requests=[];
// Positive lifecycle proof is valid ONLY for this owned closed port's exact tuple
// AND the actual old boot/PID/start death. It cannot prove an SDK session settled.
function settlement(req){requests.push(structuredClone(req));return previous(old.owner)==='dead'&&workflowHash(req)===workflowHash(old.tuple)?'settled':'unknown';}
assert.equal(settlement(old.tuple),'settled');
for(const field of ['workflowRunId','familyId','unitId','operationId','inputHash','dependencyHash','policyHash'])assert.equal(settlement({...old.tuple,[field]:'wrong'}),'unknown');
assert.equal(settlement({...old.tuple,native:{...old.tuple.native,runId:'wrong'}}),'unknown');
function save(next){
 effects.save++;store.save(next);const value=base.replace(next);
 const child=next.extensions.workflows?.runs.find(r=>r.recoveryOf===old.runId);
 const unit=child?.steps[0].units[0];
 if(unit?.coding?.phase==='awaiting-implementation-approval'&&unit.coding.approvalStatus==='pending'){
  const source=next.extensions.workflows.runs.find(r=>r.workflowRunId===old.runId);
  const pending=service.approvals.inspect().find(a=>a.id===unit.coding.approvalId);assert(pending);assert.equal(pending.kind,'implementation');assert.equal(pending.status,'pending');
  assert.notEqual(pending.id,old.approvalId);assert.notEqual(pending.requestHash,old.requestHash);
  assert.deepEqual(child.recovery.origin,source.recovery.selection);assert.equal(child.recovery.selection,undefined);
  assert.equal(child.admissions,source.admissions);assert.equal(child.recovery.budget.usedAdmissions,source.recovery.budget.usedAdmissions);assert.equal(child.recovery.budget.correctionsUsed,source.recovery.budget.correctionsUsed);
  assert.deepEqual(child.recovery.operations,[]);assert.equal(unit.native,undefined);assert.equal(unit.result,undefined);assert.equal(unit.coding.workspace,undefined);
  assert.deepEqual(source.steps,sourceBefore.steps);assert.deepEqual(source.recovery.operations,original.recovery.operations);assert.deepEqual(source.recoveryOriginal,sourceBefore.recoveryOriginal);
  assert.equal(effects.publish,1);assert.equal(effects.acquire,1);assert.equal(effects.native,0);assert.equal(effects.check,0);assert.equal(effects.cleanup,0);
  assert.equal(fs.existsSync(join(root,'authorize-ack.json')),false,'scheduled approval gate interrupts BEFORE authorize acknowledgment');
  record('selected-ready.json',{childId:child.workflowRunId,sourceId:source.workflowRunId,fingerprint,selections,pending:{id:pending.id,requestHash:pending.requestHash},owner:store.inspectRecoveryOwnership().owner,identity:ident(),effects,requests,sourceBefore});
  // Real process remains alive at the durable gate, then the outer owner pidfd
  // SIGKILLs it. No simulated restart flag or same-PID service recreation.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 return value;
}
const container={...base,replace:next=>save(createClankersState(next)),update:(patch,options)=>save(updateClankersState(base.read(),patch,options))};
const durable={ensureWriter:()=>store.acquireRecoveryOwnership().owner,inspectOwner:()=>store.inspectRecoveryOwnership(),inspectPreviousOwner:previous,
 acquireWriter:opts=>{effects.acquire++;assert.deepEqual(opts.verifiedDeadOwner,old.owner);assert.equal(opts.expectedSnapshotHash,store.inspectRecoveryOwnership().actualSnapshotHash);const owner=store.acquireRecoveryOwnership(opts).owner;assert.equal(owner.pid,process.pid);assert.equal(previous(owner),'live');return owner;},
 publishSnapshot:(next,opts)=>{effects.publish++;assert.equal(opts.expectedSnapshotHash,store.inspectRecoveryOwnership().actualSnapshotHash);store.save(next);return base.replace(next);}
};
service=createWorkflowService(container,{preflight(){},execute:async()=>forbidden('native')(),cancel:forbidden('cleanup')},{recovery:{enabled:true,durablePort:durable,inspectNativeSettlement:settlement},coding:{...coding,allocateCheckReceipt:forbidden('check')}});
const sourceBefore=structuredClone(service.get(old.runId));assert.equal(sourceBefore.steps[0].units[0].status,'unverified');
assert.equal(service.approvals.inspect().length,0);assert.throws(()=>service.approvals.grantFingerprint(old.approvalId,old.requestHash));
const displayed=await service.execute({action:'workflows.recovery.inspect',workflowRunId:old.runId});assert(displayed.ok,displayed.error);
selections=structuredClone(displayed.assessment.plan.recommendedSelections);
assert.deepEqual(selections,{reuseUnitIds:[],rerunUnitIds:['stage:0','check:0','review:0','apply:0']});
const p=await service.recovery.prepare(old.runId,selections);assert(p.ok,p.error);assert.equal(p.assessment.plan.status,'prepared',JSON.stringify(p.assessment.blocked));fingerprint=p.assessment.fingerprint;
assert.deepEqual(fs.readFileSync(snapshotFile),initial);assert.deepEqual(effects,{acquire:0,publish:0,save:0,native:0,check:0,cleanup:0});
assert(requests.some(req=>workflowHash(req)===workflowHash(old.tuple)));
const cancelled=new AbortController();cancelled.abort();const rejected=await service.recovery.authorize({workflowRunId:old.runId,assessmentFingerprint:fingerprint,selections},cancelled.signal);assert.equal(rejected.ok,false);assert.match(rejected.error,/cancelled/i);assert.equal(service.list().length,1);assert.deepEqual(fs.readFileSync(snapshotFile),initial);
setInterval(()=>{},1000);
const reply=await service.recovery.authorize({workflowRunId:old.runId,assessmentFingerprint:fingerprint,selections});
// This statement is unreachable before the SIGKILL: test asserts ack is absent.
record('authorize-ack.json',reply);throw Error('missed pending-approval interruption');
`;
}

function verifierSource(): string {
  return common + `
const old=read('old-ready.json'),selected=read('selected-ready.json');
assert.notEqual(process.pid,old.identity.pid);assert.notEqual(process.pid,selected.identity.pid);
assert.equal(previous(old.owner),'dead');assert.equal(previous(selected.owner),'dead');
assert.equal(fs.existsSync('/proc/'+old.identity.pid),false);assert.equal(fs.existsSync('/proc/'+selected.identity.pid),false);
const initial=fs.readFileSync(snapshotFile),raw=snapshot(),savedSource=raw.runs.find(r=>r.workflowRunId===old.runId),savedChild=raw.runs.find(r=>r.workflowRunId===selected.childId);
assert.equal(raw.runs.length,2);assert.equal(savedChild.status,'running');assert.equal(savedChild.steps[0].units[0].coding.approvalStatus,'pending');
const effects={acquire:0,publish:0,save:0,native:0,check:0,cleanup:0,allocate:0};
const forbidden=k=>()=>{effects[k]++;throw Error('fresh inspection effect '+k);};
const container={...base,replace:forbidden('save'),update:forbidden('save')};
// Do not invent settlement evidence for the selected child. Only the old owned
// closed port's exact request has proof; the new pending gate launched nothing.
const requests=[];function settlement(req){requests.push(structuredClone(req));return previous(old.owner)==='dead'&&workflowHash(req)===workflowHash(old.tuple)?'settled':'unknown';}
const service=createWorkflowService(container,{preflight:forbidden('native'),execute:async()=>forbidden('native')(),cancel:forbidden('cleanup')},{idFactory:forbidden('allocate'),recovery:{enabled:true,inspectNativeSettlement:settlement,durablePort:{ensureWriter:forbidden('acquire'),acquireWriter:forbidden('acquire'),publishSnapshot:forbidden('publish'),inspectOwner:()=>store.inspectRecoveryOwnership(),inspectPreviousOwner:previous}},coding:{...coding,allocateCheckReceipt:forbidden('check')}});
try{
 assert.equal(service.approvals.inspect().length,0);
 for(const record of [{id:old.approvalId,requestHash:old.requestHash},selected.pending])assert.throws(()=>service.approvals.grantFingerprint(record.id,record.requestHash));
 const source=structuredClone(service.get(old.runId)),child=structuredClone(service.get(selected.childId));
 assert.equal(source.status,'needs-attention');assert.equal(child.status,'needs-attention');assert.equal(child.recovered,true);assert.equal(child.cleanupSettled,false);
 assert.equal(source.steps[0].units[0].status,'unverified');assert.equal(child.steps[0].units[0].status,'unverified');assert.equal(child.steps[0].units[0].cleanupSettled,false);
 assert.equal(child.steps[0].units[0].result,undefined);assert.equal(child.steps[0].units[0].native,undefined);assert.equal(child.steps[0].units[0].coding.workspace,undefined);
 assert.equal(child.recovery.selection,undefined);assert.deepEqual(child.recovery.origin,source.recovery.selection);assert.deepEqual(child.recovery.origin,savedChild.recovery.origin);
 assert.equal(source.supersededBy,child.workflowRunId);assert.equal(child.recoveryOf,source.workflowRunId);assert.equal(child.attemptNo,2);assert.equal(child.familyId,source.familyId);
 assert.deepEqual(child.recovery.budget.attemptIds,[source.workflowRunId,child.workflowRunId]);assert.deepEqual(source.recovery.budget.attemptIds,[source.workflowRunId]);
 assert.equal(child.admissions,source.admissions);assert.equal(child.recovery.budget.usedAdmissions,source.recovery.budget.usedAdmissions);assert.equal(child.recovery.budget.correctionsUsed,source.recovery.budget.correctionsUsed);
 assert.deepEqual(source.recovery,savedSource.recovery);assert.deepEqual(source.recoveryOriginal,savedSource.recoveryOriginal);assert.deepEqual(source.steps,savedSource.steps);
 assert.deepEqual(child.recovery.operations,[]);assert.deepEqual(child.recovery,savedChild.recovery);
 assert.equal(child.recoveryOriginal.status,'running');assert.equal(child.recoveryOriginal.steps[0].units[0].status,'running');assert.equal(child.recoveryOriginal.steps[0].units[0].cleanupSettled,true);
 const counts={admissions:child.admissions,budget:structuredClone(child.recovery.budget),origin:structuredClone(child.recovery.origin),sourceBudget:structuredClone(source.recovery.budget)};
 for(const id of [source.workflowRunId,child.workflowRunId]){
  const inspect=await service.execute({action:'workflows.recovery.inspect',workflowRunId:id});assert(inspect.ok,inspect.error);assert.notEqual(inspect.assessment.plan.status,'prepared');
  const prepared=await service.recovery.prepare(id,selected.selections);assert(prepared.ok,prepared.error);
  if(id===child.workflowRunId){assert.equal(prepared.assessment.plan.status,'blocked','next attempt may lack carry/native proof; no synthetic proof');record('next-attempt-blocked.json',prepared.assessment.blocked);}
 }
 // Reconfirm the ORIGINAL fingerprint/selection, not a newly prepared child plan.
 // This must be idempotent after a real second process death with lost ack.
 for(let i=0;i<2;i++){
  const duplicate=await service.recovery.authorize({workflowRunId:source.workflowRunId,assessmentFingerprint:selected.fingerprint,selections:selected.selections});assert(duplicate.ok,duplicate.error);assert.equal(duplicate.view.workflowRunId,child.workflowRunId);
  assert.equal(service.list().length,2);assert.deepEqual(service.get(child.workflowRunId).recovery.budget,counts.budget);assert.deepEqual(service.get(source.workflowRunId).recovery.budget,counts.sourceBudget);assert.deepEqual(service.get(child.workflowRunId).recovery.origin,counts.origin);assert.equal(service.get(child.workflowRunId).admissions,counts.admissions);
 }
 const competing=await service.recovery.authorize({workflowRunId:source.workflowRunId,assessmentFingerprint:selected.fingerprint,selections:{}});assert.equal(competing.ok,false);assert.match(competing.error,/Competing/);
 const retry=await service.execute({action:'workflows.retry',workflowRunId:child.workflowRunId});assert.equal(retry.ok,false,'history cannot be ordinary retry permission');
 await assert.rejects(service.drain(),/settlement is uncertain/);await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(service.get(source.workflowRunId),source);assert.deepEqual(service.get(child.workflowRunId),child);
 assert.equal(service.approvals.inspect().length,0);assert.deepEqual(fs.readFileSync(snapshotFile),initial);
 assert.deepEqual(effects,{acquire:0,publish:0,save:0,native:0,check:0,cleanup:0,allocate:0});
 // Negative validation of unsaved clones only: never overwrite authoritative CP.
 const tamper=[
  ledger=>{ledger.runs.find(r=>r.workflowRunId===child.workflowRunId).recovery.origin.sourceAttemptId='other';},
  ledger=>{ledger.runs.find(r=>r.workflowRunId===source.workflowRunId).recovery.selection.rerunUnitIds=['other:0'];},
  ledger=>{ledger.runs.find(r=>r.workflowRunId===child.workflowRunId).steps[0].units[0].inputHash='0'.repeat(64);},
  ledger=>{ledger.runs=ledger.runs.filter(r=>r.workflowRunId!==child.workflowRunId);}
 ];
 for(const mutate of tamper){const clone=structuredClone(raw);mutate(clone);assert.throws(()=>recoverWorkflowState(clone));}
 assert.deepEqual(fs.readFileSync(snapshotFile),initial);
 assert.equal(fs.readFileSync(join(projectRoot,'src/a.txt'),'utf8'),'old\\n');assert.equal(fs.readFileSync(join(projectRoot,'unrelated.txt'),'utf8'),'USER_BYTES');assert.equal(fs.readFileSync(join(old.stageRoot,'src/a.txt'),'utf8'),'new\\n');
 record('verifier-result.json',{pid:process.pid,effects,counts,sourceStatus:source.status,childStatus:child.status,childUnitStatus:child.steps[0].units[0].status,proofRequests:requests.length,duplicateChildId:child.workflowRunId,tamperRejected:tamper.length});
}finally{service.dispose();assert.deepEqual(effects,{acquire:0,publish:0,save:0,native:0,check:0,cleanup:0,allocate:0});}
`;
}

// Bounded immutable byte inventory for project + stage. Inspection/selection must
// not copy candidates, allocate a stage/check destination, or alter user bytes.
function inventory(root: string): string {
  const entries: Array<[string, string]> = [];
  let bytes = 0;
  const visit = (relative: string) => {
    assert.ok(entries.length < 256, 'bounded fixture tree');
    const path = join(root, relative);
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      entries.push([relative, 'directory']);
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else {
      assert.ok(stat.isFile()); bytes += stat.size; assert.ok(bytes < 1024 * 1024);
      entries.push([relative, createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  };
  visit('project'); visit('stage');
  const leases = 'pi-clankers-coding-leases-' + process.getuid!();
  if (existsSync(join(root, leases))) visit(leases);
  return JSON.stringify(entries);
}

test('seventh workflow SIGKILL boundary: selected child pending new grant BEFORE admission; third fresh process returns SAME child after lost acknowledgment', { skip: process.platform !== 'linux', timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'clankers-workflow-selected-interruption-'));
  const previousTmpdir = process.env.TMPDIR; process.env.TMPDIR = root;
  const processes: Array<{ label: string; proc: OwnedProcess }> = [];
  let succeeded = false;
  const start = (label: string, source: string) => {
    const proc = launch(root, label, source); processes.push({ label, proc }); return proc;
  };
  const awaitMarker = async (label: string, proc: OwnedProcess, marker: string) => {
    await until(() => {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) throw Error(label + ' exited before marker: ' + proc.output());
      return existsSync(join(root, marker));
    }, label + ' durable marker', 10000);
    return json(join(root, marker));
  };
  const settle = async (label: string, proc: OwnedProcess, expectedExit: number) => {
    await until(() => proc.child.exitCode !== null || proc.child.signalCode !== null, label + ' owned subreaper exited', 12000);
    const closed = await proc.closed; assert.equal(closed.code, 0, proc.output());
    assert.equal(existsSync(join(root, label + '-overflow')), false);
    const report = json(join(root, label + '-reaped.json'));
    assert.equal(report.empty, true, 'all descendants, including orphan tsx compiler, reaped');
    assert.equal(report.timedOut, false);
    assert.equal(report.reaped.find((r: any) => r.pid === report.producerPid)?.exit, expectedExit, proc.output());
    for (const reaped of report.reaped) assert.equal(existsSync(`/proc/${reaped.pid}`), false, 'reaped, not merely zombie');
    return report;
  };
  t.after(async () => {
    try {
      // Failure teardown targets ONLY the direct process identity written by our
      // own subreaper. No PID scan, process-group signal, or broad kill fallback.
      for (const { label } of processes) {
        const path = join(root, label + '-pid.json');
        if (existsSync(path)) { const id = json(path); if (identityState(id) === 'live') signalVerified(id, 'SIGKILL'); }
      }
      for (const { proc } of processes) {
        await until(() => proc.child.exitCode !== null || proc.child.signalCode !== null, 'teardown owned subreaper', 45000);
        await proc.closed;
      }
      if (succeeded) { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
      else console.error('Retained selected interruption failure evidence:', root, processes.map(({ label, proc }) => label + ': ' + proc.output()).join('\n'));
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
      assert.equal(process.env.TMPDIR, previousTmpdir);
    }
  });
  mkdirSync(join(root, 'project'), { mode: 0o700 }); mkdirSync(join(root, 'project/src')); mkdirSync(join(root, 'stage'), { mode: 0o700 });
  writeFileSync(join(root, 'project/src/a.txt'), 'old\n'); writeFileSync(join(root, 'project/unrelated.txt'), 'USER_BYTES');
  const producer = start('producer', producerSource());
  const old = await awaitMarker('producer', producer, 'old-ready.json');
  const oldPid = json(join(root, 'producer-pid.json'));
  assert.deepEqual(old.identity, oldPid); assert.equal(old.owner.pid, oldPid.pid); assert.equal(old.owner.bootId, oldPid.bootId); assert.equal(old.owner.startTimeTicks, oldPid.startTime);
  assert.equal(identityState(old.identity), 'live');
  const oldSnapshot = readFileSync(join(root, 'state.json'));
  const oldRun = json(join(root, 'state.json')).state.extensions.workflows.runs[0];
  assert.equal(oldRun.status, 'running'); assert.equal(oldRun.steps[0].units[0].status, 'running'); assert.equal(oldRun.cleanupSettled, false);
  assert.equal(oldRun.recovery.operations.find((op: any) => op.kind === 'native').result, undefined);
  assert.equal(readFileSync(join(old.stageRoot, 'src/a.txt'), 'utf8'), 'new\n');
  const beforeInventory = inventory(root);
  signalVerified(old.identity, 'SIGKILL'); const firstReport = await settle('producer', producer, -9);
  assert.equal(identityState(old.identity), 'dead'); assert.deepEqual(readFileSync(join(root, 'state.json')), oldSnapshot);
  const confirmer = start('confirmer', confirmerSource());
  const selected = await awaitMarker('confirmer', confirmer, 'selected-ready.json');
  const confirmerPid = json(join(root, 'confirmer-pid.json'));
  assert.deepEqual(selected.identity, confirmerPid); assert.notEqual(confirmerPid.pid, oldPid.pid);
  assert.equal(selected.owner.pid, confirmerPid.pid); assert.equal(selected.owner.bootId, confirmerPid.bootId); assert.equal(selected.owner.startTimeTicks, confirmerPid.startTime);
  assert.equal(identityState(selected.identity), 'live'); assert.equal(existsSync(join(root, 'authorize-ack.json')), false);
  const selectedSnapshot = readFileSync(join(root, 'state.json'));
  const savedRuns = json(join(root, 'state.json')).state.extensions.workflows.runs;
  assert.equal(savedRuns.length, 2);
  const source = savedRuns.find((r: any) => r.workflowRunId === old.runId), child = savedRuns.find((r: any) => r.workflowRunId === selected.childId);
  assert.deepEqual(source.recovery.selection, child.recovery.origin); assert.equal(child.recovery.selection, undefined);
  assert.equal(child.steps[0].units[0].coding.approvalStatus, 'pending'); assert.equal(child.status, 'running');
  assert.equal(child.admissions, oldRun.admissions); assert.equal(source.admissions, oldRun.admissions);
  assert.equal(child.recovery.budget.usedAdmissions, oldRun.recovery.budget.usedAdmissions); assert.equal(child.recovery.budget.correctionsUsed, oldRun.recovery.budget.correctionsUsed);
  assert.equal(child.recovery.origin.usedAdmissions, oldRun.admissions); assert.equal(source.recovery.selection.usedAdmissions, oldRun.admissions);
  assert.deepEqual(child.recovery.operations, []); assert.deepEqual(source.recovery.operations, oldRun.recovery.operations);
  assert.equal(inventory(root), beforeInventory, 'durable selection is not a stage/check/application effect');
  signalVerified(selected.identity, 'SIGKILL'); const secondReport = await settle('confirmer', confirmer, -9);
  assert.equal(identityState(selected.identity), 'dead'); assert.deepEqual(readFileSync(join(root, 'state.json')), selectedSnapshot);
  const verifier = start('verifier', verifierSource()); const thirdReport = await settle('verifier', verifier, 0);
  assert.notEqual(thirdReport.producerPid, firstReport.producerPid); assert.notEqual(thirdReport.producerPid, secondReport.producerPid);
  assert.equal(processes.length, 3, 'three distinct fresh service processes, not same-PID recreation');
  const result = json(join(root, 'verifier-result.json'));
  assert.equal(result.pid, thirdReport.producerPid); assert.equal(result.duplicateChildId, selected.childId); assert.equal(result.childUnitStatus, 'unverified'); assert.equal(result.tamperRejected, 4);
  assert.deepEqual(result.effects, { acquire: 0, publish: 0, save: 0, native: 0, check: 0, cleanup: 0, allocate: 0 });
  assert.deepEqual(readFileSync(join(root, 'state.json')), selectedSnapshot); assert.equal(inventory(root), beforeInventory);
  assert.equal(existsSync(join(root, 'authorize-ack.json')), false);
  succeeded = true;
});
