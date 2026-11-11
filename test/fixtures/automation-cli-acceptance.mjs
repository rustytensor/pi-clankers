/** Owned loopback process acceptance, never a provider-quality/spend/exactly-once test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const hash=b=>createHash('sha256').update(b).digest('hex');
// Fixture-only public-boundary probe, also exercised against deterministic fake SDKs.
// An ID means OBSERVED, never constructed. Disposal must not create its own proof.
export function installSessionLifecycleProbe(prototype,log,{onPrompt=()=>{},beforeDispose=()=>{}}={}) {
 const identities=new WeakMap();let nextId=0;
 const observe=(session,boundary)=>{let sessionId=identities.get(session);if(!sessionId){sessionId='session-'+(++nextId);identities.set(session,sessionId);log({sessionObserved:true,sessionId,boundary});}return sessionId;};
 for(const boundary of ['abort','waitForIdle','subscribe','bindExtensions','prompt']){
  const original=prototype[boundary];assert.equal(typeof original,'function',`missing public SDK ${boundary}`);
  prototype[boundary]=function(...args){const sessionId=observe(this,boundary);if(boundary==='prompt')onPrompt(this,sessionId);return original.apply(this,args);};
 }
 const dispose=prototype.dispose;assert.equal(typeof dispose,'function');
 prototype.dispose=function(...args){const sessionId=identities.get(this)??null;log({disposeAttempt:true,sessionId});beforeDispose(this);const result=dispose.apply(this,args);log({disposeSucceeded:true,sessionId});return result;};
}

// Same validator is used by real acceptance and deterministic identity streams.
export function assertSettledSessionEvidence(own) {
 const observed=new Map(),pending=new Map(),succeeded=new Set();let lastSuccess=-1;
 for(const [i,event] of own.entries()){
  if(event.sessionObserved){assert.ok(typeof event.sessionId==='string'&&event.sessionId.length>0);assert.ok(['abort','waitForIdle','subscribe','bindExtensions','prompt'].includes(event.boundary));assert.ok(!observed.has(event.sessionId),'identity observed more than once');observed.set(event.sessionId,i);}
  if(event.sessionPrompted)assert.ok(observed.has(event.sessionId),'prompt must have prior independent observation');
  if(event.disposeAttempt){assert.ok(observed.has(event.sessionId),'dispose attempt needs prior observed identity');assert.ok(!pending.has(event.sessionId),'uncompleted dispose attempt');pending.set(event.sessionId,i);}
  if(event.disposeSucceeded){assert.ok(observed.has(event.sessionId),'unrelated or stale disposal');assert.ok(pending.has(event.sessionId),'success needs matching prior attempt');assert.ok(pending.get(event.sessionId)>observed.get(event.sessionId));pending.delete(event.sessionId);succeeded.add(event.sessionId);lastSuccess=i;}
 }
 assert.ok(observed.size>0,'settled native lifecycle requires independent observation');
 assert.equal(pending.size,0,'throwing/incomplete disposal is not success');
 assert.deepEqual([...succeeded].sort(),[...observed.keys()].sort(),'every observed object must be successfully disposed');
 const snapshots=own.map((e,i)=>({e,i})).filter(({e})=>e.snapshotCommitted);
 const final=snapshots.at(-1);assert.ok(lastSuccess>=0&&final?.e.cleanupSettled&&final.i>lastSuccess,'LAST successful disposal must precede final settled snapshot');
 const created=own.filter(e=>e.ownerCreated),released=own.map((e,i)=>({e,i})).filter(({e})=>e.ownerRemoved);
 assert.equal(created.length,1);assert.equal(released.length,1);assert.ok(released[0].i>final.i,'owner release must follow final settled snapshot');
 const generation=created[0].owner?.generation;assert.ok(generation);
 for(const e of own.filter(e=>e.ownerCreated||e.snapshotCommitted||e.ownerRemoved))assert.equal(e.owner?.generation,generation,'owner generation must match throughout');
}
// SDK reads are parallel: quota outcomes belong to the full issued ID set,
// not to assistant ordinal or completion order. Also used by pure offline tests.
export function assertQuotaReadEvidence(events,{issuedToolCallIds,readText,successCount,maxReadBytes}) {
 assert.equal(issuedToolCallIds.length,successCount+1);
 assert.deepEqual(issuedToolCallIds,[...issuedToolCallIds.keys()].map(i=>'read'+i));
 assert.equal(events.length,issuedToolCallIds.length);
 const ids=events.map(e=>e.toolCallId);assert.equal(new Set(ids).size,ids.length,'duplicate read ID');
 assert.deepEqual([...ids].sort(),[...issuedToolCallIds].sort(),'every issued read ID must appear exactly once');
 const delivered=events.filter(e=>e.isError===false),errors=events.filter(e=>e.isError===true);
 assert.equal(delivered.length,successCount);assert.equal(errors.length,1);
 const textHash=hash(readText),textBytes=Buffer.byteLength(readText);
 for(const e of delivered){assert.equal(e.textHash,textHash);assert.equal(e.textBytes,textBytes);}
 const total=delivered.reduce((n,e)=>n+e.textBytes,0);
 assert.equal(total,successCount*textBytes);assert.ok(total<=maxReadBytes);if(successCount===2)assert.equal(total,maxReadBytes);
 assert.ok(total+textBytes>maxReadBytes,'one further read must exceed the cumulative quota');
 const denied=errors[0];assert.notEqual(denied.textHash,textHash);assert.ok(denied.textBytes>0);
 const refusal=['read-byte-limit','Operation aborted'].find(text=>hash(text)===denied.textHash);
 assert.ok(refusal,'public SDK refusal text must match quota error or its abort');assert.equal(denied.textBytes,Buffer.byteLength(refusal));
}
export async function acceptance(layout,evidence,focus) {
 assert.equal(process.env.CLANKERS_WORKFLOW_AUTOMATION_ACCEPTANCE,'parent-approved');
 assert.ok(focus===undefined||focus==='quota-outcome'||focus==='lifecycle-proof','unsupported acceptance focus');
 const lifecycleScenarios=new Set(['happy-duplicate-conflict-inspection','quota-42-read3x21','monotonic-deadline']);
 const quotaScenarios=new Set(['exact-read-byte-boundary','exact-cumulative-read-boundary','cumulative-read-cap','provider-preparation-cap','quota-42-read3x21']);
 layout=path.resolve(layout);fs.mkdirSync(evidence,{recursive:true,mode:0o700});
 const require=createRequire(layout+'/package.json');const {createJiti}=require('jiti');const jiti=createJiti(import.meta.url,{fsCache:false});
 const {computeAutomationProfileHash}=await jiti.import(layout+'/automation-profile.ts');
 const {workflowHash,validateWorkflowDefinition,workflowRecoverySourceContract,workflowRecoveryDependencyHash}=await jiti.import(layout+'/workflow-model.ts');
 const {classifyRecoveryOperation}=await jiti.import(layout+'/workflow-recovery.ts');
 const sourceContract=workflowRecoverySourceContract();assert.deepEqual(sourceContract,{knownHash:null,explicitUnknown:true});
 const sdkVersion=JSON.parse(fs.readFileSync(layout+'/node_modules/@earendil-works/pi-coding-agent/package.json')).version;
 const results=[],owned=[];
 async function scenario(name,options={},execute) {
  if(focus==='quota-outcome'&&!quotaScenarios.has(name))return;
  if(focus==='lifecycle-proof'&&!lifecycleScenarios.has(name))return;
  const root=fs.mkdtempSync('/tmp/s8e-final-b2-'+name+'-');owned.push(root);
  for(const d of ['profiles','project','state','agents','sessions','home','home/.pi','home/.pi/agent','project/.pi'])fs.mkdirSync(root+'/'+d,{mode:0o700});
  const readText=options.readText??'SCOPED_ACCEPTANCE_TEXT';
  const paths=options.readPathsRequested??['public.txt'];
  fs.writeFileSync(root+'/project/public.txt',readText,{mode:0o600});fs.writeFileSync(root+'/outside.txt','OUTSIDE_SENTINEL',{mode:0o600});fs.symlinkSync(root+'/outside.txt',root+'/project/link.txt');
  const sentinel='RESOURCE_TRAP_DO_NOT_LOAD';for(const f of ['project/AGENTS.md','project/.pi/settings.json','home/.pi/agent/auth.json','home/.pi/agent/models.json','home/.pi/agent/settings.json'])fs.writeFileSync(root+'/'+f,sentinel,{mode:0o600});
  const requests=[],durable=[],processes=[],children=[];let observedResolve;const observed=new Promise(r=>observedResolve=r);
  const server=createServer(async(req,res)=>{
   try {let text='';for await(const c of req){text+=c;if(text.length>1000000)throw new Error('request-bound');}const body=JSON.parse(text);requests.push(body);
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer DUMMY-NOT-CREDENTIAL');assert.deepEqual(body.tools?.map(t=>t.function.name),['read']);assert.ok(!text.includes(sentinel));
    const container=JSON.parse(fs.readFileSync(root+'/state/snapshot.json','utf8'));const binding=container.state.extensions.automation.events[0];const run=container.state.extensions.workflows.runs.find(r=>r.workflowRunId===binding.workflowRunId);
    assert.ok(run);assert.equal(run.familyId,binding.familyId);assert.equal(run.attemptNo,binding.attemptNo);assert.equal(run.definitionHash,binding.definitionHash);assert.equal(workflowHash(run.inputs),binding.fixedInputsHash);assert.equal(binding.eventId,event.eventId);assert.equal(run.attemptNo,1);assert.equal(container.state.extensions.workflows.runs.length,1);assert.ok(run.recovery);assert.equal(run.recovery.workflowRunId,run.workflowRunId);assert.equal(run.recovery.familyId,run.familyId);assert.equal(run.recovery.attemptNo,run.attemptNo);assert.ok(run.recovery.operations.some(op=>op.kind==='native'));const owner=JSON.parse(fs.readFileSync(root+'/state/snapshot.json.recovery-writer.lock/owner.json','utf8')).owner;assert.equal(owner.generation,binding.ownerGeneration);assert.equal(binding.profileGenerationHash,profile.approvedProfileHash);durable.push({snapshotHash:hash(JSON.stringify(container)),binding,runId:run.workflowRunId,checkpoint:run.recovery,owner,sourceContract});observedResolve();
    if(options.hold)return;
    if(options.providerFailure){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'PROVIDER_SECRET_TEXT',type:'invalid_request_error'}}));return;}
    const hasTools=body.messages.some(m=>m.role==='tool');
    const delta=!hasTools?{role:'assistant',tool_calls:paths.map((p,i)=>({index:i,id:'read'+i,type:'function',function:{name:'read',arguments:JSON.stringify({path:p})}}))}:{role:'assistant',content:options.longOutput?'PROVIDER_SECRET_TEXT'.repeat(3000):JSON.stringify('ok')};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const chunk of [{id:'fixture',object:'chat.completion.chunk',created:1,model:'dummy',choices:[{index:0,delta,finish_reason:null}]},{id:'fixture',object:'chat.completion.chunk',created:1,model:'dummy',choices:[{index:0,delta:{},finish_reason:hasTools?'stop':'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}])res.write('data: '+JSON.stringify(chunk)+'\n\n');res.end('data: [DONE]\n\n');
   }catch(e){results.push({name:name+'-server',failure:e.stack});observedResolve();res.writeHead(500);res.end();}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const config={providers:{local:{baseUrl:`http://127.0.0.1:${port}/v1`,api:'openai-completions',models:[{id:'dummy',name:'dummy',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:256}]}}};
  if(options.unsafeConfig)config.providers.local.apiKey='!unsafe-command';
  const metadata=JSON.stringify(config);fs.writeFileSync(root+'/models.json',metadata,{mode:0o600});
  const definition=validateWorkflowDefinition({version:1,id:'inspection',label:'inspection',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},steps:[{id:'inspect',kind:'native',dependsOn:[],agentId:'reader',prompt:'Read public.txt and return JSON string "ok".',inputs:{},outputSchema:{type:'string',maxLength:128}}]});
  const profile={version:1,id:'daily',enabled:true,approvedProfileHash:'',projectRoot:root+'/project',snapshotFile:root+'/state/snapshot.json',agentDir:root+'/agents',sessionDir:root+'/sessions',definition,definitionId:definition.id,definitionHash:workflowHash(definition),fixedInputs:{},readPaths:['public.txt'],agents:[{id:'reader',label:'reader',prompt:'Read only',source:'runtime',model:'local/dummy:off',tools:['read'],permissionMode:'inherit'}],modelPolicy:{provider:'local',id:'dummy',thinkingLevel:'off'},credentialSourceRef:{kind:'env',name:'S8E_DUMMY_KEY'},modelConfigFile:{path:root+'/models.json',sha256:hash(metadata)},limits:{maxEventAgeMs:300000,maxFutureSkewMs:30000,minIntervalMs:1,maxRetainedEvents:16,maxRunMs:options.maxRunMs??15000,maxCleanupMs:10000,maxOutputBytes:1024,maxReadBytes:options.maxReadBytes??1024,maxAdmissions:options.maxAdmissions??4,maxProviderRequests:options.maxProviderRequests??4,concurrency:1}};
  if(options.twoSteps)profile.definition=validateWorkflowDefinition({...definition,steps:[definition.steps[0],{...definition.steps[0],id:'inspect2',dependsOn:['inspect']}]});
  profile.definitionHash=workflowHash(profile.definition);
  if(options.missingModel){profile.modelPolicy.id='missing';profile.agents[0].model='local/missing:off';profile.modelConfigFile=null;}
  const save=(approve=true)=>{if(approve)profile.approvedProfileHash=computeAutomationProfileHash(profile);fs.writeFileSync(root+'/profiles/daily.json',JSON.stringify(profile),{mode:0o600});};save();
  if(options.hiddenCoding){profile.definition={...profile.definition,version:3,steps:[...profile.definition.steps,{id:'forbidden',kind:'coding',dependsOn:[],when:{op:'truthy',value:{value:false}},inputs:{},outputSchema:{type:'string'},coding:{operation:'apply',policy:{}}}]};save(false);}if(options.badHash){profile.approvedProfileHash='0'.repeat(64);save(false);}if(options.missingConfig)fs.unlinkSync(root+'/models.json');if(options.scopedSymlink){fs.unlinkSync(root+'/project/public.txt');fs.symlinkSync(root+'/outside.txt',root+'/project/public.txt');}if(options.disabled){profile.enabled=false;save(false);}if(options.unsafeRoot)fs.chmodSync(root+'/project',0o777);
  const time=new Date().toISOString();const event={version:1,profileId:'daily',eventId:time,occurrenceTime:time};
  function start(operation='run',input=event){
   const log=root+'/probe-'+processes.length+'.jsonl';
   const env={HOME:root+'/home',PI_AGENT_DIR:root+'/home',PATH:path.dirname(process.execPath),CLANKERS_WORKFLOW_AUTOMATION_ACCEPTANCE:'parent-approved',S8E_LAYOUT:layout,S8E_OWNED_ROOT:root,S8E_PORT:String(port)};
   if(!options.missingAuth)env.S8E_DUMMY_KEY='DUMMY-NOT-CREDENTIAL';
   // Each child owns its lifecycle probe stream; fixture never inherits user env/credentials.
   const native=fileURLToPath(new URL('./automation-native-acceptance.mjs',import.meta.url));
   const child=spawn(process.execPath,['--import',native,layout+'/automation-cli.mjs',operation,'--profiles-dir',root+'/profiles'],{cwd:root+'/project',env,stdio:['pipe','pipe','pipe']});
   const capture={pid:child.pid,operation,stdout:'',stderr:''};processes.push(capture);
   child.stdout.on('data',c=>{capture.stdout+=c;if(capture.stdout.length>65536)child.kill('SIGKILL');});child.stderr.on('data',c=>{capture.stderr+=c;if(capture.stderr.length>65536)child.kill('SIGKILL');});
   child.stdin.end(typeof input==='string'?input:JSON.stringify(input));
   const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
   const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>{clearTimeout(timer);capture.code=code;capture.signal=signal;if(capture.stdout)capture.result=JSON.parse(capture.stdout);resolve(capture);});});
   children.push({child,done});return {child,done};
  }
  const beforeState=()=>{const rows=[];function walk(dir){for(const f of fs.readdirSync(dir).sort()){const p=dir+'/'+f;if(fs.lstatSync(p).isDirectory())walk(p);else rows.push([path.relative(root+'/state',p),hash(fs.readFileSync(p))]);}}walk(root+'/state');return rows;};
  const waitObserved=async()=>{let timer;try{await Promise.race([observed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('provider-not-observed')),20000);})]);}finally{clearTimeout(timer);}};const context={root,profile,save,event,requests,durable,start,observed,waitObserved,beforeState,readText,issuedToolCallIds:paths.map((_,i)=>'read'+i)};
  let pass=false,error;
  try{await execute(context);for(const p of processes){if(!p.signal)assert.ok(p.result,JSON.stringify(p));assert.ok(!p.stdout.includes('DUMMY-NOT-CREDENTIAL'));assert.ok(!p.stdout.includes('PROVIDER_SECRET_TEXT'));assert.ok(!p.stdout.includes('SCOPED_ACCEPTANCE_TEXT'));assert.ok(!p.stdout.includes(readText));assert.ok(!p.stdout.includes(sentinel));assert.ok(p.stdout.length<=1024);}
   const probes=fs.existsSync(root+'/probe.jsonl')?fs.readFileSync(root+'/probe.jsonl','utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
   assert.equal(probes.filter(p=>p.blocked).length,0,JSON.stringify(probes.filter(p=>p.blocked)));for(const p of processes){const own=probes.filter(x=>x.pid===p.pid);if(p.result?.delivery==='duplicate'||p.operation!=='run'){assert.equal(own.filter(x=>x.modelPreparation||x.sessionObserved||x.sessionPrompted||x.disposeAttempt||x.disposeSucceeded||x.providerPreparation||x.ownerCreated||x.ownerRemoved||x.snapshotCommitted).length,0);}if(p.signal==='SIGKILL'||p.result?.cleanup==='uncertain')assert.equal(own.filter(x=>x.ownerRemoved).length,0,'unknown cleanup must retain its owner');if(p.signal==='SIGKILL')assert.ok(!p.result,'SIGKILL is not closed/settled');if(p.result?.cleanup==='settled'&&(p.result?.delivery==='accepted'||own.some(x=>x.sessionObserved||x.disposeAttempt||x.disposeSucceeded)))assertSettledSessionEvidence(own);
    if(own.some(x=>x.sessionObserved)){assert.equal(own.filter(x=>x.ownerCreated).length,1);assert.equal(own.filter(x=>x.ownerRemoved).length,p.signal==='SIGKILL'||p.result?.cleanup==='uncertain'?0:1);if(p.signal==='SIGKILL'){assert.equal(own.filter(x=>x.disposeSucceeded).length,0);}const owners=own.filter(x=>x.ownerCreated||x.snapshotCommitted).map(x=>x.owner?.generation).filter(Boolean);assert.equal(new Set(owners).size,1);for(const x of own.filter(x=>x.snapshotCommitted&&x.checkpoint)){assert.equal(x.checkpoint.attemptNo,1);assert.equal(x.runCount,1);}for(const x of own.filter(x=>x.sessionPrompted)){assert.deepEqual(x.tools,['read']);assert.equal(x.thinking,'off');assert.deepEqual(x.model,{provider:'local',id:'dummy'});}}}pass=true;
  }catch(e){error=e.stack;}
  finally{for(const owned of children){if(owned.child.exitCode===null && owned.child.signalCode===null)owned.child.kill('SIGKILL');await owned.done;}server.closeAllConnections();await new Promise(r=>server.close(r));fs.writeFileSync(evidence+'/'+name+'.json',JSON.stringify({name,sdkVersion,root,layout,pass,error,processes,requests:requests.map(r=>({model:r.model,tools:r.tools?.map(t=>t.function.name),messages:r.messages.map(m=>m.role==='tool'?m:{role:m.role,contentHash:hash(JSON.stringify(m)),toolCalls:m.tool_calls?.map(t=>({name:t.function.name,argumentsHash:hash(t.function.arguments)}))})})),durable,probe:fs.existsSync(root+'/probe.jsonl')?fs.readFileSync(root+'/probe.jsonl','utf8'):''},null,2));results.push({name,pass,error,transportRequests:requests.length});}
 }
 // HTTP messages are transport evidence only. Quota abort may prevent their
 // follow-up request: public tool_execution_end proves exact SDK text delivery.
 const quotaFailure=async(c,reason,successCount)=>{
  const p=await c.start().done;assert.notEqual(p.code,0);assert.equal(p.result.reasonCode,reason);
  const events=fs.readFileSync(c.root+'/probe.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(e=>e.pid===p.pid&&e.toolExecutionEnd);
  assertQuotaReadEvidence(events,{issuedToolCallIds:c.issuedToolCallIds,readText:c.readText,successCount,maxReadBytes:c.profile.limits.maxReadBytes});
  const count=c.requests.length;const before=c.beforeState();const duplicates=[];
  for(const op of ['run','status','report'])duplicates.push(await c.start(op).done);
  assert.equal(c.requests.length,count);assert.deepEqual(c.beforeState(),before);
  for(const dup of duplicates){assert.equal(dup.result.delivery,'duplicate');assert.equal(dup.result.workflowRunId,p.result.workflowRunId);assert.equal(dup.result.workflowStatus,p.result.workflowStatus);assert.notEqual(dup.code,0,'quota failure must remain nonzero on same-event duplicate');}
  assert.ok(['cancelled','failed','needs-attention'].includes(p.result.workflowStatus));assert.equal(p.result.cleanup,'settled');assert.equal(c.requests.length,1,'quota abort permits no follow-up transport');
  return p;
 };
 const checkpointProof=c=>{const snapshot=JSON.parse(fs.readFileSync(c.root+'/state/snapshot.json','utf8'));const run=snapshot.state.extensions.workflows.runs[0];assert.ok(run.recovery);assert.equal(run.recovery.policyHash,workflowHash({definition:run.definition,agents:run.agents,trustedRecoveryConfig:{enabled:true,durablePort:'ensureWriter/inspectOwner:v1',sourceContract}}));const spec=run.definition.steps[0],unit=run.steps[0].units[0];for(const op of run.recovery.operations.filter(o=>o.kind==='native')){assert.equal(op.dependencyHash,workflowRecoveryDependencyHash(run,spec,unit,sourceContract));const classification=classifyRecoveryOperation(op,{inputHash:op.inputHash,dependencyHash:op.dependencyHash,policyHash:op.policyHash,externalInputsKnown:false,dependencyContractVersion:'unknown',nativeAlreadyCompleted:false});assert.notEqual(classification.classification,'completed-valid');}return run.recovery;};
 const successful=async c=>{const first=await c.start().done;assert.equal(first.code,0,JSON.stringify(first));assert.equal(first.result.delivery,'accepted');assert.equal(first.result.workflowStatus,'completed');assert.equal(first.result.cleanup,'settled');assert.equal(c.requests.length,2);assert.equal(c.requests[1].messages.at(-1).content,'SCOPED_ACCEPTANCE_TEXT');assert.equal(c.durable.length,2);checkpointProof(c);
  const count=c.requests.length;const before=c.beforeState();for(const op of ['run','status','report']){const dup=await c.start(op).done;assert.equal(dup.code,0);assert.equal(dup.result.delivery,'duplicate');assert.equal(dup.result.workflowRunId,first.result.workflowRunId);}assert.deepEqual(c.beforeState(),before);assert.equal(c.requests.length,count);
  c.profile.limits.maxAdmissions--;c.save();const conflict=await c.start().done;assert.notEqual(conflict.code,0);assert.equal(conflict.result.reasonCode,'event-conflict');assert.equal(c.requests.length,count);
 };
 await scenario('happy-duplicate-conflict-inspection',{},successful);
 await scenario('exact-read-byte-boundary',{maxReadBytes:Buffer.byteLength('SCOPED_ACCEPTANCE_TEXT')},async c=>{const p=await c.start().done;assert.equal(p.code,0,JSON.stringify(p));assert.equal(p.result.workflowStatus,'completed');assert.equal(p.result.cleanup,'settled');assert.equal(c.requests.length,2);const delivered=c.requests[1].messages.filter(m=>m.role==='tool');assert.equal(delivered.length,1);assert.equal(delivered[0].content,'SCOPED_ACCEPTANCE_TEXT');assert.equal(Buffer.byteLength(delivered[0].content),c.profile.limits.maxReadBytes);checkpointProof(c);});
 await scenario('exact-cumulative-read-boundary',{maxReadBytes:2*Buffer.byteLength('SCOPED_ACCEPTANCE_TEXT'),readPathsRequested:['public.txt','public.txt','public.txt']},async c=>{await quotaFailure(c,'read-byte-limit',2);});
 await scenario('quota-42-read3x21',{maxReadBytes:42,readText:'SCOPED_ACCEPTANCE_TEX',readPathsRequested:['public.txt','public.txt','public.txt']},async c=>{assert.equal(Buffer.byteLength(c.readText),21);await quotaFailure(c,'read-byte-limit',2);});
 for(const name of ['missingAuth','missingModel','unsafeConfig','unsafeRoot','disabled','hiddenCoding','badHash','missingConfig','scopedSymlink'])await scenario(name,{[name]:true},async c=>{const p=await c.start().done;assert.notEqual(p.code,0);assert.equal(c.requests.length,0);assert.equal(p.result.delivery,'rejected');});
 await scenario('strict-stdin',{},async c=>{for(const input of ['{"version":1,"version":1}',' '.repeat(4097),JSON.stringify({...c.event,inputs:{payload:'UNTRUSTED'}})]){const p=await c.start('run',input).done;assert.equal(p.code,2);assert.equal(p.result.delivery,'rejected');}assert.equal(c.requests.length,0);});
 await scenario('failed-duplicate', {providerFailure:true},async c=>{const p=await c.start().done;assert.notEqual(p.code,0);const n=c.requests.length;assert.equal(n,1);const q=await c.start().done;assert.notEqual(q.code,0);assert.equal(q.result.delivery,'duplicate');assert.equal(c.requests.length,n);});
 await scenario('outside-and-symlink',{readPathsRequested:['../outside.txt','link.txt','public.txt']},async c=>{const p=await c.start().done;assert.equal(p.code,0,JSON.stringify(p));const tools=c.requests[1].messages.filter(m=>m.role==='tool');assert.equal(tools.length,3);assert.ok(!JSON.stringify(tools).includes('OUTSIDE_SENTINEL'));assert.equal(tools[2].content,'SCOPED_ACCEPTANCE_TEXT');});
 await scenario('cumulative-read-cap',{maxReadBytes:25,readPathsRequested:['public.txt','public.txt']},async c=>{await quotaFailure(c,'read-byte-limit',1);});
 await scenario('provider-preparation-cap',{maxProviderRequests:1},async c=>{const p=await c.start().done;assert.notEqual(p.code,0);assert.equal(p.result.reasonCode,'provider-request-limit');assert.equal(c.requests.length,1);assert.ok(['cancelled','failed','needs-attention'].includes(p.result.workflowStatus));const before=c.beforeState();for(const op of ['run','status','report']){const dup=await c.start(op).done;assert.notEqual(dup.code,0);assert.equal(dup.result.delivery,'duplicate');assert.equal(dup.result.workflowRunId,p.result.workflowRunId);assert.equal(dup.result.workflowStatus,p.result.workflowStatus);}assert.deepEqual(c.beforeState(),before);assert.equal(c.requests.length,1);});
 await scenario('admission-cap',{maxAdmissions:1,twoSteps:true},async c=>{const p=await c.start().done;assert.notEqual(p.code,0);assert.equal(c.requests.length,2);});
 await scenario('provider-output-not-stdout',{longOutput:true},async c=>{const p=await c.start().done;assert.notEqual(p.code,0);assert.equal(c.requests.length,2);assert.ok(p.stdout.length<=1024);});
 await scenario('sigterm-concurrent',{hold:true},async c=>{const first=c.start();await c.waitObserved();
  const same=await c.start().done;assert.equal(same.result.delivery,'duplicate');assert.notEqual(same.code,0);const t=new Date(Date.now()+1).toISOString();const busy=await c.start('run',{...c.event,eventId:t,occurrenceTime:t}).done;assert.equal(busy.result.delivery,'busy');assert.notEqual(busy.code,0);assert.equal(c.requests.length,1);first.child.kill('SIGTERM');const ended=await first.done;assert.notEqual(ended.code,0);assert.equal(ended.result.workflowStatus,'cancelled');assert.equal(ended.result.cleanup,'settled');
  const before=c.beforeState();const dup=await c.start().done;assert.equal(dup.result.delivery,'duplicate');assert.notEqual(dup.code,0);assert.equal(c.requests.length,1);assert.deepEqual(c.beforeState(),before);
 });
 await scenario('sigkill-inert-owner-retained',{hold:true},async c=>{const first=c.start();await c.waitObserved();first.child.kill('SIGKILL');const ended=await first.done;assert.equal(ended.signal,'SIGKILL');const before=c.beforeState();assert.ok(before.some(([f])=>f.includes('owner')));
  for(const op of ['status','report','run']){const p=await c.start(op).done;assert.notEqual(p.code,0);assert.equal(p.result.delivery,'duplicate');assert.equal(p.result.cleanup,'uncertain');}assert.equal(c.requests.length,1);assert.deepEqual(c.beforeState(),before);
 });
 await scenario('monotonic-deadline',{hold:true,maxRunMs:1000},async c=>{const p=await c.start().done;assert.notEqual(p.code,0);assert.equal(p.result.reasonCode,'runner-deadline');assert.ok(c.requests.length<=1);});
 fs.writeFileSync(evidence+'/summary.json',JSON.stringify({sdkVersion,layout,results,owned,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>r.pass===false||r.failure).length},null,2));
 return {sdkVersion,results,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>r.pass===false||r.failure).length};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const result=await acceptance(process.env.S8E_LAYOUT,process.env.S8E_EVIDENCE,process.env.S8E_ACCEPTANCE_FOCUS);console.log(JSON.stringify(result));process.exitCode=result.failed?1:0;}
