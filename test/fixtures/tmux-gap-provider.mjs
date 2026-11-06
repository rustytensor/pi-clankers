// Offline Pi 1.5 stream/tool fixture. Usage literals are independent gate inputs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
export default async function(pi) {
  const sdk=process.env.TMUX_GATE_SDK, root=process.env.TMUX_GATE_ROOT;
  assert(root.startsWith('/srv/devops/scratch/'));
  const {createJiti}=createRequire(sdk)('jiti');
  const {createAssistantMessageEventStream}=await import(createJiti(sdk,{fsCache:false}).esmResolve('@earendil-works/pi-ai'));
  const file=path.join(root,`provider-${process.pid}.json`);
  const calls=[]; let sessionId=null, error=null;
  const save=()=>{fs.writeFileSync(file+'.tmp',JSON.stringify({pid:process.pid,sessionId,calls,error}),{mode:0o600});fs.renameSync(file+'.tmp',file);};
  const tool=(name,exposure='direct')=>pi.registerTool({name,label:name,description:'Synthetic gate effect counter',defaultActive:false,exposure,
    parameters:{type:'object',properties:{},additionalProperties:false},
    async execute(){fs.appendFileSync(path.join(root,'effects.jsonl'),JSON.stringify({pid:process.pid,name})+'\n',{mode:0o600});return {content:[{type:'text',text:'DIRECT_OK'}],details:{}};}});
  tool('gap_direct'); tool('gap_undeclared');
  if(fs.existsSync(path.join(root,'deferred'))) tool('gap_deferred','deferred');
  pi.on('session_start',(_event,ctx)=>{sessionId=ctx.sessionManager.getSessionId();save();fs.writeFileSync(path.join(root,`ui-${process.pid}.json`),JSON.stringify({pid:process.pid,sessionId,mode:ctx.mode,hasUI:ctx.hasUI,stdinTTY:!!process.stdin.isTTY,stdoutTTY:!!process.stdout.isTTY}),{mode:0o600});});
  pi.registerProvider('team-fixture',{baseUrl:'http://fixture.invalid',apiKey:'synthetic-not-a-key',api:'openai-completions',
    models:[{id:'fixed',name:'Offline gap fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:32768}],
    streamSimple(model,context,options) {
      const stream=createAssistantMessageEventStream();
      const msg={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],timestamp:Date.now(),stopReason:'pending',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      void(async()=>{try {
        const user=[...context.messages].reverse().find(m=>m.role==='user');
        const raw=typeof user.content==='string'?user.content:user.content.filter(b=>b.type==='text').map(b=>b.text).join('');
        const envelope=JSON.parse(raw), scenario=envelope.text;
        assert.deepEqual(envelope,{source:'coordinator',authority:'delegated-not-human-authorization',text:scenario});
        assert(['LARGE','REUSE','TURN_LIMIT','UNDECLARED'].includes(scenario),'scenario');
        const turn=calls.filter(c=>c.scenario===scenario).length+1;
        // REUSE occurs at most once per process. Any unexpected request fails the fixture.
        assert(turn<=(scenario==='LARGE'?2:1),'unexpected_extra_provider_request');
        const usage=scenario==='LARGE'?(turn===1?[11,7,2,3]:[13,5,1,2]):scenario==='REUSE'?[17,9,4,1]:scenario==='TURN_LIMIT'?[19,3,0,2]:[23,2,1,0];
        const item={scenario,turn,usage,started:Date.now(),finished:null};calls.push(item);save();
        stream.push({type:'start',partial:msg});
        if((scenario==='LARGE'&&turn===1)||scenario==='TURN_LIMIT'||scenario==='UNDECLARED') {
          const tools=scenario==='LARGE'?[{name:'write',arguments:{path:'coord/out.txt',content:'WRITE_OK\n'}},{name:'gap_direct',arguments:{}}]:[{name:scenario==='UNDECLARED'?'gap_undeclared':'gap_direct',arguments:{}}];
          for(const [index,tool] of tools.entries()) {
            msg.content.push({type:'toolCall',id:`gap-${calls.length}-${index}`,name:tool.name,arguments:tool.arguments});
            stream.push({type:'toolcall_start',contentIndex:index,partial:msg});
            stream.push({type:'toolcall_delta',contentIndex:index,delta:JSON.stringify(tool.arguments),partial:msg});
            stream.push({type:'toolcall_end',contentIndex:index,toolCall:msg.content[index],partial:msg});
          }
          msg.stopReason='toolUse';
        } else {
          const partial=scenario==='LARGE'?'LIVE_HEAD\n  exact\t😀\nLIVE_TAIL':'REUSE_LIVE';
          msg.content=[{type:'text',text:''}];stream.push({type:'text_start',contentIndex:0,partial:msg});
          msg.content[0].text=partial;stream.push({type:'text_delta',contentIndex:0,delta:partial,partial:msg});
          if(scenario==='LARGE') {
            fs.writeFileSync(path.join(root,`paused-${process.pid}`),'paused',{mode:0o600});
            const end=Date.now()+30000;
            while(!fs.existsSync(path.join(root,`release-${process.pid}`))) {assert(Date.now()<end,'stream_release_deadline');assert(!options?.signal?.aborted,'unexpected_abort');await new Promise(r=>setTimeout(r,20));}
          }
          const final=scenario==='LARGE'?'HEAD'+'x'.repeat(24000)+'TAIL':'REUSE_OK';
          // The paused partial is replaced in the final message, matching existing accepted fixtures.
          msg.content[0].text=final;stream.push({type:'text_end',contentIndex:0,content:final,partial:msg});
          msg.stopReason='stop';
        }
        const [input,output,cacheRead,cacheWrite]=usage;
        msg.usage={...msg.usage,input,output,cacheRead,cacheWrite,totalTokens:input+output+cacheRead+cacheWrite};
        stream.push({type:'done',reason:msg.stopReason,message:msg});
        item.finished=Date.now();save();stream.end();
      } catch {
        error='fixture_contract_failed';save();msg.stopReason='error';msg.errorMessage=error;
        stream.push({type:'error',reason:'error',error:msg});stream.end();
      }})();
      return stream;
    }
  });
}
