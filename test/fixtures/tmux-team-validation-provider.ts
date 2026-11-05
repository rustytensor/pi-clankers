// Synthetic deterministic Pi1.5 provider; evidence and release barriers per PID.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
export default async function(pi:any) {
 const sdk=process.env.TMUX_GATE_SDK!, root=process.env.TMUX_GATE_ROOT!;
 const {createJiti}=createRequire(sdk)('jiti');
 const {createAssistantMessageEventStream}=await import(createJiti(sdk,{fsCache:false}).esmResolve('@earendil-works/pi-ai'));
 const file=path.join(root,`provider-${process.pid}.json`);
 const calls:any[]=[]; let sessionId:string|null=null, error:string|null=null;
 const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,sessionId,calls,error}),{mode:0o600});fs.renameSync(file+'.tmp',file);};
 // Setup barrier is released by the supervisor, before startup completes; no provider request.
 if(fs.existsSync(path.join(root,'hold-setup'))) {
  fs.writeFileSync(path.join(root,`setup-${process.pid}`),'held',{mode:0o600});
  const end=Date.now()+25000;
  while(!fs.existsSync(path.join(root,'release-setup'))) {assert(Date.now()<end);await new Promise(r=>setTimeout(r,20));}
 }
 pi.on('session_start',(_e:any,ctx:any)=>{sessionId=ctx.sessionManager.getSessionId();save();fs.writeFileSync(path.join(root,`ui-${process.pid}.json`),JSON.stringify({pid:process.pid,sessionId,mode:ctx.mode,hasUI:ctx.hasUI,stdinTTY:!!process.stdin.isTTY,stdoutTTY:!!process.stdout.isTTY}),{mode:0o600});});
 pi.registerProvider('team-fixture',{baseUrl:'http://fixture.invalid',apiKey:'synthetic-not-a-key',api:'openai-completions',models:[{id:'fixed',name:'Offline team fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}],
 streamSimple(model:any,context:any,options:any) {
  const stream=createAssistantMessageEventStream();
  const msg:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],timestamp:Date.now(),stopReason:'pending',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  void(async()=>{try{
   const user=[...context.messages].reverse().find((m:any)=>m.role==='user');
   const raw=typeof user.content==='string'?user.content:user.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('');
   const envelope=JSON.parse(raw),text=envelope.text;
   assert.deepEqual(envelope,{source:'coordinator',authority:'delegated-not-human-authorization',text});
   const role=/You are team (?:member|lead) ([^.]+)\./.exec(text)?.[1]??'solo';
   const scenario=/Task: ([A-Z]+)/.exec(text)?.[1]??text;
   assert(['SUCCESS','FAILURE','CANCEL','SIBLING','SOLO','REUSE','BOUNDED','PARENTLOSS'].includes(scenario));
   const item={role,scenario,text,started:Date.now(),finished:null as number|null};calls.push(item);save();
   stream.push({type:'start',partial:msg});msg.content=[{type:'text',text:''}];stream.push({type:'text_start',contentIndex:0,partial:msg});
   const partial=role.toUpperCase()+'_PARTIAL';msg.content[0].text=partial;stream.push({type:'text_delta',contentIndex:0,delta:partial,partial:msg});
   const end=Date.now()+30000;
   while(!options?.signal?.aborted&&!fs.existsSync(path.join(root,`release-${process.pid}-${calls.length}`))) {assert(Date.now()<end,'provider_deadline');await new Promise(r=>setTimeout(r,20));}
   stream.push({type:'text_end',contentIndex:0,content:partial,partial:msg});
   let output=scenario==='REUSE'?'REUSE_OK':role==='lead'?'LEAD_OK':role.toUpperCase()+'_OK';
   if(scenario==='BOUNDED'&&role==='a') output='X'.repeat(128)+'ANSWER=42';
   if(scenario==='BOUNDED'&&role==='b') output=('😀'+String.fromCharCode(34,92,10)).repeat(1100);
   if(options?.signal?.aborted) {msg.stopReason='aborted';msg.errorMessage='synthetic cancel';stream.push({type:'error',reason:'aborted',error:msg});}
   else if(scenario==='FAILURE'&&role==='a') {msg.stopReason='error';msg.errorMessage='synthetic required failure';stream.push({type:'error',reason:'error',error:msg});}
   else stream.push({type:'done',reason:'stop',message:{...msg,content:[{type:'text',text:output}],stopReason:'stop'}});
   item.finished=Date.now();save();stream.end();
  }catch{error='fixture_contract_failed';save();msg.stopReason='error';msg.errorMessage=error;stream.push({type:'error',reason:'error',error:msg});stream.end();}})();
  return stream;
 }});
}
