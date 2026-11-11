// Explicit opt-in process preload; instruments only public SDK lifecycle APIs.
import fs from 'node:fs';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports, createRequire, registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { installSessionLifecycleProbe } from './automation-cli-acceptance.mjs';
if (process.env.CLANKERS_WORKFLOW_AUTOMATION_ACCEPTANCE !== 'parent-approved') throw new Error('acceptance-opt-in-required');
const root=process.env.S8E_OWNED_ROOT, layout=process.env.S8E_LAYOUT, port=Number(process.env.S8E_PORT);
const log=x=>fs.appendFileSync(root+'/probe.jsonl',JSON.stringify({pid:process.pid,...x})+'\n');
const deny=x=>{log({blocked:x});throw new Error('acceptance-guard-denied');};
registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context);if(resolved.url.startsWith('file:')){const p=fileURLToPath(resolved.url);if(!p.startsWith(layout+'/') && p!==fileURLToPath(import.meta.url))deny('checkout-dependency-fallback');}return resolved;}});
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let o=args[0];if(Array.isArray(o))o=o[0];const host=typeof o==='object'?o.host:typeof args[1]==='string'?args[1]:'localhost';const p=typeof o==='object'?o.port:o;if(Number(p)!==port||!['127.0.0.1','localhost','::1'].includes(host??'localhost'))deny('unexpected-socket');log({transportConnection:true});return connect.apply(this,args);};
const fetch0=globalThis.fetch;
globalThis.fetch=(input,...args)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||Number(u.port)!==port)deny('unexpected-fetch');return fetch0(input,...args);};
syncBuiltinESMExports();
const require=createRequire(layout+'/package.json');
const pkg=JSON.parse(fs.readFileSync(layout+'/node_modules/@earendil-works/pi-coding-agent/package.json'));
const sdk=await import(pathToFileURL(path.resolve(layout+'/node_modules/@earendil-works/pi-coding-agent',pkg.main)).href);
log({sdkVersion:pkg.version});
const create=sdk.ModelRuntime.create;sdk.ModelRuntime.create=async function(...args){log({modelPreparation:true});return create.apply(this,args);};
const observations=new WeakMap();const prompted=new WeakSet();
installSessionLifecycleProbe(sdk.AgentSession.prototype,log,{
 onPrompt(session,sessionId){
  if(prompted.has(session))return;prompted.add(session);
  log({sessionPrompted:true,sessionId,tools:session.getActiveToolNames(),thinking:session.thinkingLevel,model:{provider:session.model?.provider,id:session.model?.id},systemPromptHash:createHash('sha256').update(session.systemPrompt).digest('hex')});
  // Public SDK events prove TEXT delivery even without a follow-up HTTP request.
  // Preserve only lengths/hashes, never raw tool text.
  const unsubscribe=session.subscribe(event=>{if(event.type!=='tool_execution_end'||event.toolName!=='read')return;const text=(event.result?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('');log({toolExecutionEnd:true,toolName:event.toolName,toolCallId:event.toolCallId,isError:event.isError,textBytes:Buffer.byteLength(text,'utf8'),textHash:createHash('sha256').update(text).digest('hex')});});observations.set(session,unsubscribe);
  const prepare=session.agent.prepareRequest;session.agent.prepareRequest=async(...a)=>{log({providerPreparation:true});return prepare?.apply(session.agent,a);};
 },
 beforeDispose(session){const unsubscribe=observations.get(session);observations.delete(session);unsubscribe?.();}
});
// Owned conventional-resource traps must not be consulted, even for reading.
const traps=[root+'/home/.pi/agent',root+'/project/.pi',root+'/project/AGENTS.md'];
for(const name of ['readFileSync','openSync','statSync','lstatSync','readdirSync']){const original=fs[name];fs[name]=function(p,...a){if(typeof p==='string'&&traps.some(t=>p===t||p.startsWith(t+'/')))deny('resource-discovery');return original.call(this,p,...a);};}
for(const name of ['readFile','open','stat','lstat','readdir']){const original=fs.promises[name];fs.promises[name]=function(p,...a){if(typeof p==='string'&&traps.some(t=>p===t||p.startsWith(t+'/')))deny('resource-discovery');return original.call(this,p,...a);};}
syncBuiltinESMExports();

// Observe exact owned filesystem commits and owner lifecycle, never invoke a writer API.
const marker=root+'/state/snapshot.json.recovery-writer.lock/owner.json';
const readOwner=()=>{try{return JSON.parse(fs.readFileSync(marker,'utf8')).owner;}catch{return undefined;}};
const markerDescriptors=new Set();const open0=fs.openSync;fs.openSync=function(p,...a){const fd=open0.call(this,p,...a);if(p===marker)markerDescriptors.add(fd);return fd;};
const close0=fs.closeSync;fs.closeSync=function(fd,...a){markerDescriptors.delete(fd);return close0.call(this,fd,...a);};
const write0=fs.writeFileSync;fs.writeFileSync=function(p,...a){const result=write0.call(this,p,...a);if(p===marker||markerDescriptors.has(p))log({ownerCreated:true,owner:readOwner()});return result;};
const rename0=fs.renameSync;fs.renameSync=function(from,to,...a){const result=rename0.call(this,from,to,...a);if(to===root+'/state/snapshot.json'){const s=JSON.parse(fs.readFileSync(to,'utf8'));const runs=s.state.extensions.workflows?.runs??[],run=runs[0];log({snapshotCommitted:true,owner:readOwner(),runCount:runs.length,checkpoint:run?.recovery,cleanupSettled:run?.cleanupSettled??false});}return result;};
const unlink0=fs.unlinkSync;fs.unlinkSync=function(p,...a){const owner=p===marker?readOwner():undefined;const result=unlink0.call(this,p,...a);if(p===marker)log({ownerRemoved:true,owner});return result;};
syncBuiltinESMExports();
