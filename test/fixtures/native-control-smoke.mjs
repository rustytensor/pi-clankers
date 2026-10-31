import { installFixtureSafety } from './fixture-safety.mjs';
// Dedicated subprocess: guard/empty environment installed before SDK resources.
installFixtureSafety({ name: 'control', maxRequests: 64 });
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'zerg-phase1-host-'));
const agentDir=join(dir,'agent');mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_OFFLINE='1';process.chdir(dir);
const requests=[];const gates=new Map();const seen=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label){for(let i=0;i<200;i++){if(await test())return;await sleep(20);}throw Error('Timed out: '+label);}
const server=createServer(async(req,res)=>{
 try{
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body);requests.push(input);
 if(input.model==='error'){
  res.writeHead(401,{'Content-Type':'application/json'});
  res.end(JSON.stringify(input.messages).includes('multiline-error-fixture') ? 'first error line\nsecond error line' : JSON.stringify({error:{message:'offline unauthorized fixture',type:'authentication_error'}}));
  return;
 }
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'phase1',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
 emit({role:'assistant'});
 if(input.model.startsWith('slow')&&!seen.has(input.model)){
  seen.add(input.model);await new Promise(resolve=>{gates.set(input.model,resolve);res.on('close',resolve);});gates.delete(input.model);
 }
 if(!res.destroyed){emit({content:`done ${input.model}`});emit({},input.model==='length'?'length':'stop');res.end('data: [DONE]\n\n');}
 }catch(e){res.destroy(e);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
writeFileSync(join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'dummy-local-only',models:['ok','error','length','a','b','lead','slowA','slowB','slowCancel'].map(id=>({id,reasoning:false,input:['text'],contextWindow:32768,maxTokens:128}))}}}));
writeFileSync(join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'ok',packages:[]}));
const deadline=setTimeout(()=>{console.error('Global smoke timeout');process.exit(1);},60000);
globalThis[Symbol.for('zerg/fixture-safety')].watchSDK(await import('@earendil-works/pi-coding-agent'));
const zerg=await import(new URL('../../index.ts', import.meta.url).href);
const control=zerg.createZergControl();
let registration;let registeredTool;
async function agent(id,model,extra={}){const result=await control.execute({action:'agents.create',id,model:'fixture/'+model,prompt:'Only return a concise status. Never execute tools or change files.',tools:[],...extra});assert(result.ok,JSON.stringify(result));}
async function run(id){const result=await control.execute({action:'run',agent:id,task:'Return concise status. No edits.',background:false});assert(result.runId,JSON.stringify(result));if(['error','length','manual'].includes(id))assert.equal(result.ok,false,JSON.stringify(result));return (await control.execute({action:'runs.show',runId:result.runId})).data.run;}

function assertTeamRequestOrder(actual,workers,leader){assert.equal(actual.at(-1),leader,JSON.stringify(actual));assert.deepEqual(actual.slice(0,-1).sort(),[...workers].sort(),JSON.stringify(actual));}
try{
 await agent('error','error');assert.equal((await run('error')).status,'failed');
 await agent('length','length');assert.equal((await run('length')).status,'failed');
 await agent('ok','ok');assert.equal((await run('ok')).status,'done');
 assert.equal(requests.findLast(r=>r.model==='ok').tools?.length??0,0);
 console.log('PASS actual native public control: provider error/length not success; explicit empty tools');
 await agent('deny','ok',{tools:['files','bash'],disallowedTools:['write','edit','shell']});await run('deny');
 assert.deepEqual((requests.findLast(r=>r.model==='ok').tools??[]).map(t=>t.function.name),['read']);
 console.log('PASS actual native public control: aliases expand before denylist; only read declared');
 await agent('manual','ok',{permissionMode:'manual'});const beforeUnsupported=requests.length;assert.equal((await run('manual')).status,'failed');assert.equal(requests.length,beforeUnsupported);
 console.log('PASS unsupported explicit native permission mode rejected before model execution');
 await agent('lead','lead');await agent('a','a');await agent('b','b');
 for(const [id,member]of [['team-a','a'],['team-b','b']])assert((await control.execute({action:'team.create',id,leader:'lead',members:[member]})).ok);
 let start=requests.length;const selected=await run('team-b');assert.equal(selected.status,'done');assert.deepEqual(requests.slice(start).map(r=>r.model),['b','lead']);
 start=requests.length;await run('lead');assert.deepEqual(requests.slice(start).map(r=>r.model),['lead']);
 const badTeam=await control.execute({action:'team.create',id:'bad-team',leader:'lead',members:['missing']});
 if(badTeam.ok){start=requests.length;assert.equal((await control.execute({action:'run',agent:'bad-team',task:'no',background:true})).ok,false);assert.equal(requests.length,start);}
 console.log('PASS actual native public control: selected team preserved, bare leader independent, missing members rejected');
 await agent('slow-a','slowA');await agent('slow-b','slowB');assert((await control.execute({action:'team.create',id:'slow-team',leader:'lead',members:['slow-a','slow-b']})).ok);
 const bg=await control.execute({action:'run',agent:'slow-team',task:'Return status. No tools or edits.',background:true});assert(bg.ok);
 await until(()=>gates.has('slowA')&&gates.has('slowB'),'both team member streams');
 const marker='message exclusively for worker B';
 const message=await control.execute({action:'message',runId:bg.runId,targetId:'slow-b',body:marker});assert(message.ok,JSON.stringify(message));
 assert.equal(message.data.message.routedTargetId,'slow-b');assert(['queued','handled','accepted'].includes(message.data.message.status),JSON.stringify(message));
 for(const release of gates.values())release();
 await until(async()=>['done','failed','cancelled'].includes((await control.execute({action:'runs.show',runId:bg.runId})).data.run.status),'team completion');
 const mixedTeam=await control.execute({action:'team.create',id:'mixed-team',leader:'lead',members:['error','a']});assert(mixedTeam.ok,JSON.stringify(mixedTeam));
 start=requests.length;const mixedForeground=await control.execute({action:'run',agent:'mixed-team',task:'Worker error must fail aggregate.',background:false});assert.equal(mixedForeground.ok,false,JSON.stringify(mixedForeground));assert.equal(mixedForeground.error.code,'run_failed');
 const mixedRun=(await control.execute({action:'runs.show',runId:mixedForeground.runId})).data.run;assert.equal(mixedRun.status,'failed');const mixedLeaderResult=(await control.execute({action:'agents.result',id:'lead',runId:mixedRun.runId})).data;assert.equal(mixedLeaderResult.status,'found');assert.equal(mixedLeaderResult.result.final_message,'done lead');assert.deepEqual(mixedRun.metadata.failedMemberSummaries.map(member=>member.agentId),['error']);assert(mixedRun.memberProgress.some(member=>member.agentId==='error'&&member.status==='failed'),JSON.stringify(mixedRun.memberProgress));assertTeamRequestOrder(requests.slice(start).map(r=>r.model),['error','a'],'lead');
 start=requests.length;const mixedBackground=await control.execute({action:'run',agent:'mixed-team',task:'Background worker error must fail eventually.',background:true});assert(mixedBackground.ok,JSON.stringify(mixedBackground));
 await until(async()=>(await control.execute({action:'runs.show',runId:mixedBackground.runId})).data.run.status==='failed','mixed background aggregate failure');assertTeamRequestOrder(requests.slice(start).map(r=>r.model),['error','a'],'lead');
 await agent('setup-reject','ok',{permissionMode:'manual'});assert((await control.execute({action:'team.create',id:'setup-reject-team',leader:'lead',members:['setup-reject']})).ok);
 start=requests.length;const setupRejected=await control.execute({action:'run',agent:'setup-reject-team',task:'Setup rejection must fail aggregate.',background:false});assert.equal(setupRejected.ok,false,JSON.stringify(setupRejected));
 const setupRejectedRun=(await control.execute({action:'runs.show',runId:setupRejected.runId})).data.run;assert.equal(setupRejectedRun.status,'failed');assert(setupRejectedRun.memberProgress.some(member=>member.agentId==='setup-reject'&&member.status==='failed'),JSON.stringify(setupRejectedRun.memberProgress));assert.deepEqual(requests.slice(start).map(r=>r.model),['lead']);
 assert((await control.execute({action:'team.create',id:'leader-fail-team',leader:'error',members:['a']})).ok);start=requests.length;const leaderFailed=await control.execute({action:'run',agent:'leader-fail-team',task:'Leader failure must fail aggregate.',background:false});assert.equal(leaderFailed.ok,false,JSON.stringify(leaderFailed));assert.equal(leaderFailed.error.code,'run_failed');const leaderFailedRun=(await control.execute({action:'runs.show',runId:leaderFailed.runId})).data.run;assert.equal(leaderFailedRun.status,'failed');assert(leaderFailedRun.metadata.finalSummary.includes('offline unauthorized fixture'),JSON.stringify(leaderFailedRun.metadata));assert.equal(leaderFailedRun.memberProgress.find(member=>member.agentId==='a')?.status,'done',JSON.stringify(leaderFailedRun.memberProgress));assertTeamRequestOrder(requests.slice(start).map(r=>r.model),['a'],'error');
 assert.equal(control.getState().tasks[mixedForeground.taskId].status,'failed');
 assert.equal(control.getState().tasks[mixedBackground.taskId].status,'failed');
 assert.equal(control.getState().tasks[setupRejected.taskId].status,'failed');
 const mixedWorkerResult=(await control.execute({action:'agents.result',id:'a',runId:mixedRun.runId})).data;assert.equal(mixedWorkerResult.status,'found');assert.equal(mixedWorkerResult.result.final_message,'done a');
 const detailedFailure=await control.execute({action:'run',agent:'error',task:'multiline-error-fixture',background:false});
 const detailedFailureRun=(await control.execute({action:'runs.show',runId:detailedFailure.runId})).data.run;
 assert.equal(detailedFailure.ok,false);assert.equal(detailedFailureRun.errorSummary,'401 first error line\nsecond error line');
 await agent('error-peer','error');
 assert((await control.execute({action:'team.create',id:'both-fail-team',leader:'error',members:['error-peer','a']})).ok);
 const bothFailed=await control.execute({action:'run',agent:'both-fail-team',task:'Preserve worker and leader errors.',background:false});
 const bothFailedRun=(await control.execute({action:'runs.show',runId:bothFailed.runId})).data.run;
 assert.equal(bothFailed.ok,false);assert.equal(bothFailedRun.status,'failed');
 assert.match(bothFailedRun.errorSummary,/offline unauthorized fixture/);assert.match(bothFailedRun.errorSummary,/error-peer/);
 assert.deepEqual(bothFailedRun.metadata.failedMemberSummaries.map(member=>member.agentId),['error-peer']);
 const siblingResult=(await control.execute({action:'agents.result',id:'a',runId:bothFailedRun.runId})).data;assert.equal(siblingResult.status,'found');assert.equal(siblingResult.result.final_message,'done a');
 seen.delete('slowA');
 assert((await control.execute({action:'team.create',id:'mixed-cancel-team',leader:'lead',members:['error','slow-a']})).ok);
 start=requests.length;
 const mixedCancel=await control.execute({action:'run',agent:'mixed-cancel-team',task:'Cancel after a worker failed.',background:true});assert(mixedCancel.ok);
 await until(async()=>gates.has('slowA')&&(await control.execute({action:'runs.show',runId:mixedCancel.runId})).data.run.memberProgress.some(member=>member.agentId==='error'&&member.status==='failed'),'failed worker alongside active sibling');
 const failedBeforeCancel=(await control.execute({action:'runs.show',runId:mixedCancel.runId})).data.run.memberProgress.find(member=>member.agentId==='error');
 assert((await control.execute({action:'interrupt',runId:mixedCancel.runId})).ok);
 await until(async()=>(await control.execute({action:'runs.show',runId:mixedCancel.runId})).data.run.status==='cancelled','parent cancellation wins over member failure');
 const cancelledTeam=(await control.execute({action:'runs.show',runId:mixedCancel.runId})).data.run;
 assert.equal(control.getState().tasks[mixedCancel.taskId].status,'cancelled');assert.equal(cancelledTeam.errorSummary,undefined);
 assert(cancelledTeam.memberProgress.every(member=>['failed','cancelled'].includes(member.status)),JSON.stringify(cancelledTeam.memberProgress));
 assert.equal(cancelledTeam.memberProgress.find(member=>member.agentId==='error').completedAt,failedBeforeCancel.completedAt);
 assert.deepEqual(requests.slice(start).map(request=>request.model).sort(),['error','slowA']);
 console.log('PASS team cancellation precedence, complete error diagnostics, task outcomes, and preserved sibling handoffs');
 console.log('PASS actual native team outcome: required worker failures, setup rejections, and leader failures are terminal failures with truthful progress');
 const targeted=requests.filter(r=>JSON.stringify(r.messages).includes(marker));assert(targeted.some(r=>r.model==='slowB'));assert(!targeted.some(r=>r.model==='slowA'));
 console.log('PASS actual native streaming message: queued/handled acknowledgement, correct member only');
 await agent('slow-cancel','slowCancel');const cancel=await control.execute({action:'run',agent:'slow-cancel',task:'Wait.',background:true});
 await until(()=>gates.has('slowCancel'),'cancel stream');assert((await control.execute({action:'interrupt',runId:cancel.runId})).ok);
 await until(async()=>(await control.execute({action:'runs.show',runId:cancel.runId})).data.run.status==='cancelled','native cancel settles');
 console.log('PASS actual native streaming cancellation');
 seen.delete('slowCancel');const disposingNative=await control.execute({action:'run',agent:'slow-cancel',task:'Cancel on disposal.',background:true});assert(disposingNative.ok);
 await until(()=>gates.has('slowCancel'),'active native disposal stream');control.dispose();
 await until(async()=>(await control.execute({action:'runs.show',runId:disposingNative.runId})).data.run.status==='cancelled','active native disposal settles');
 assert.equal((await control.execute({action:'run',agent:'ok',task:'Do not launch after disposal.',background:true})).ok,false);
 console.log('PASS active native disposal aborts execution and rejects subsequent launches');
 const listeners=new Map();const events={on(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);},emit(name,data){for(const fn of listeners.get(name)??[])fn(data);}};
 registration=zerg.registerZergSwarmExtension({events,registerCommand(){},registerTool(tool){registeredTool=tool;}});
 assert((await registration.control.execute({action:'agents.create',id:'bridge',prompt:'No tools.',tools:[],model:'fixture/ok'})).ok);
 assert((await registration.control.execute({action:'agents.create',id:'bridge-error',prompt:'No tools.',tools:[],model:'fixture/error'})).ok);assert((await registration.control.execute({action:'agents.create',id:'bridge-ok',prompt:'No tools.',tools:[],model:'fixture/ok'})).ok);assert((await registration.control.execute({action:'team.create',id:'bridge-team',leader:'bridge',members:['bridge-error','bridge-ok']})).ok);
 start=requests.length;const bridgeAggregate=await registration.control.execute({action:'run',agent:'bridge-team',task:'Bridge native aggregate failure.',background:true});assert(bridgeAggregate.ok,JSON.stringify(bridgeAggregate));
 await until(async()=>(await registration.control.execute({action:'runs.show',runId:bridgeAggregate.runId})).data.run.status==='failed','bridge native aggregate failure');let bridgeAggregateRun=(await registration.control.execute({action:'runs.show',runId:bridgeAggregate.runId})).data.run;const bridgeLeaderResult=(await registration.control.execute({action:'agents.result',id:'bridge',runId:bridgeAggregateRun.runId})).data;assert.equal(bridgeLeaderResult.status,'found');assert.equal(bridgeLeaderResult.result.final_message,'done ok');assert.deepEqual(bridgeAggregateRun.metadata.failedMemberSummaries.map(member=>member.agentId),['bridge-error']);assertTeamRequestOrder(requests.slice(start).map(r=>r.model),['error','ok'],'ok');
 start=requests.length;const bridgeToolAggregate=await registeredTool.execute('aggregate-smoke',{action:'run',agent:'bridge-team',task:'Bridge foreground tool aggregate failure.',background:false});assert.equal(bridgeToolAggregate.details.ok,false,JSON.stringify(bridgeToolAggregate));assert.equal(bridgeToolAggregate.isError,true);assert.equal(bridgeToolAggregate.details.error.code,'run_failed');
 bridgeAggregateRun=(await registration.control.execute({action:'runs.show',runId:bridgeToolAggregate.details.runId})).data.run;assert.equal(bridgeAggregateRun.status,'failed');assertTeamRequestOrder(requests.slice(start).map(r=>r.model),['error','ok'],'ok');
 console.log('PASS bridge-native aggregate outcome failures propagate through background control and foreground tool calls');
 start=requests.length;const pending=await registration.control.execute({action:'run',agent:'bridge',task:'Do not start after cancellation.',background:true});assert(pending.ok);
 assert((await registration.control.execute({action:'interrupt',runId:pending.runId})).ok);await sleep(500);assert.equal(requests.length,start);
 assert.equal((await registration.control.execute({action:'runs.show',runId:pending.runId})).data.run.status,'cancelled');
 const abortController=new AbortController();
 const foreground=registeredTool.execute('abort-smoke',{action:'run',agent:'bridge',task:'Cancel foreground before fallback.',background:false},abortController.signal);
 abortController.abort();const abortedToolResult=await foreground;assert.equal(abortedToolResult.details.ok,false,JSON.stringify(abortedToolResult));assert.equal(abortedToolResult.isError,true);await sleep(350);assert.equal(requests.length,start);
 console.log('PASS foreground zerg_control abort signal cancels queued child and resolves failed tool result');
 seen.delete('slowA');assert((await registration.control.execute({action:'agents.update',id:'bridge',model:'fixture/slowA'})).ok);
 const bridgeNative=await registration.control.execute({action:'run',agent:'bridge',task:'Wait for operator steering.',background:true});assert(bridgeNative.ok);
 await until(()=>gates.has('slowA'),'bridge native fallback stream');
 const bridgeMessage=await registration.control.execute({action:'message',runId:bridgeNative.runId,targetId:'bridge',body:'bridge-only operator steering'});assert(bridgeMessage.ok,JSON.stringify(bridgeMessage));assert(['queued','handled'].includes(bridgeMessage.data.message.status),JSON.stringify(bridgeMessage));
 events.emit('subagent:slash:started',{requestId:bridgeNative.runId});events.emit('subagent:slash:response',{requestId:bridgeNative.runId,error:'late external response',result:{isError:true}});
 assert.equal((await registration.control.execute({action:'runs.show',runId:bridgeNative.runId})).data.run.status,'running');
 gates.get('slowA')?.();await until(async()=>(await registration.control.execute({action:'runs.show',runId:bridgeNative.runId})).data.run.status==='done','bridge native completion');
 assert(requests.some(r=>r.model==='slowA'&&JSON.stringify(r.messages).includes('bridge-only operator steering')));
 console.log('PASS bridge-native targeted messaging and late peer response cannot overwrite native-owned state');
 events.emit('subagent:slash:started',{requestId:bridgeNative.runId});events.emit('subagent:slash:response',{requestId:bridgeNative.runId,data:{isError:true},isError:true});events.emit('subagent:slash:update',{requestId:bridgeNative.runId,status:'running'});
 assert.equal((await registration.control.execute({action:'runs.show',runId:bridgeNative.runId})).data.run.status,'done');
 assert.equal((await registration.control.execute({action:'interrupt',runId:bridgeNative.runId})).ok,false);
 assert.equal((await registration.control.execute({action:'runs.show',runId:bridgeNative.runId})).data.run.status,'done');
 const invalidMode=await registeredTool.execute('bad-mode',{action:'message',targetId:'bridge',runId:bridgeNative.runId,body:'invalid',mode:'invalid'});assert.equal(invalidMode.details.error.code,'invalid_request');
 console.log('PASS terminal bridge-native run ignores late peer events/interrupt and invalid message mode is rejected');
 assert((await registration.control.execute({action:'agents.update',id:'bridge',model:'fixture/ok'})).ok);start=requests.length;
 const pending2=await registration.control.execute({action:'run',agent:'bridge',task:'Do not start after disposal.',background:true});assert(pending2.ok);const disposedRegistration=registration;registration.dispose();registration=undefined;await sleep(500);assert.equal(requests.length,start);
 assert.equal((await disposedRegistration.control.execute({action:'runs.show',runId:pending2.runId})).data.run.status,'cancelled');
 assert.equal((await disposedRegistration.control.execute({action:'run',agent:'bridge',task:'No launch after disposal.',background:true})).ok,false);
 const shutdownHooks=[];
 registration=zerg.registerZergSwarmExtension({events,on(event,handler){if(event==='session_shutdown')shutdownHooks.push(handler);},registerCommand(){},registerTool(){}});
 assert((await registration.control.execute({action:'agents.create',id:'shutdown',prompt:'No tools.',tools:[],model:'fixture/ok'})).ok);
 const shutdownRun=await registration.control.execute({action:'run',agent:'shutdown',task:'Do not start after shutdown.',background:true});assert(shutdownRun.ok);assert(shutdownHooks.length>0,'session_shutdown hook must be installed');
 for(const hook of shutdownHooks)await hook({},{});await sleep(500);assert.equal(requests.length,start);
 assert.equal((await registration.control.execute({action:'runs.show',runId:shutdownRun.runId})).data.run.status,'cancelled');
 console.log('PASS public bridge cancellation/disposal/shutdown: queued runs cancelled, no provider requests or post-dispose launch');
 const extensionDir=join(dir,'.pi','extensions');mkdirSync(extensionDir,{recursive:true});
 const startupExtension=join(extensionDir,'startup.js');
 writeFileSync(startupExtension,"export default function(pi) { pi.on('session_start', async () => { globalThis.__zergStartupEntered = true; await new Promise(resolve => { globalThis.__zergStartupRelease = resolve; }); }); }");
 const startupControl=zerg.createZergControl();
 try {
  assert((await startupControl.execute({action:'agents.create',id:'startup-cancel',model:'fixture/ok',tools:[],prompt:'No tools.'})).ok);
  const startupRun=await startupControl.execute({action:'run',agent:'startup-cancel',task:'Cancel during startup.',background:true});assert(startupRun.ok);
  await until(()=>globalThis.__zergStartupEntered,'session_start barrier');
  assert((await startupControl.execute({action:'interrupt',runId:startupRun.runId})).ok);globalThis.__zergStartupRelease();
  await until(async()=>(await startupControl.execute({action:'runs.show',runId:startupRun.runId})).data.run.status==='cancelled','startup cancellation');
  const stopped=(await startupControl.execute({action:'runs.show',runId:startupRun.runId})).data.run;
  assert(stopped.memberProgress.length>0);assert(stopped.memberProgress.every(member=>member.status==='cancelled'),JSON.stringify(stopped.memberProgress));
 } finally { globalThis.__zergStartupRelease?.();startupControl.dispose();rmSync(startupExtension,{force:true}); }
 console.log('PASS session-start cancellation also terminalizes member progress');
 console.log(`PASS all phase1 host checks (${requests.length} localhost model requests only)`);
}finally{
 clearTimeout(deadline);globalThis.__zergStartupRelease?.();for(const release of gates.values())release();registration?.dispose();control.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});
}
