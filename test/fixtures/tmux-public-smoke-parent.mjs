// Public registered control host; actual worker transport, no runtime mocks.
import { createJiti } from 'jiti';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.env.TMUX_GATE_ROOT, sdk=process.env.TMUX_GATE_SDK;
assert(root.startsWith('/srv/devops/scratch/'));
assert.equal(JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdk),'../package.json'))).version,'1.5.0');
const host=createJiti(sdk,{fsCache:false});
const jiti=createJiti(import.meta.url,{fsCache:false,alias:{'@earendil-works/pi-coding-agent':sdk,'@earendil-works/pi-tui':host.esmResolve('@earendil-works/pi-tui')}});
const {ProjectTrustStore}=await import(pathToFileURL(sdk).href);
new ProjectTrustStore(path.join(root,'agent')).set(path.join(root,'workspace'),true);
const {registerZergSwarmExtension}=await jiti.import('../../index.ts');
const {createZergState,replaceSharedZergState}=await jiti.import('../../state.ts');
replaceSharedZergState(createZergState({mode:{...createZergState().mode,automation:'automatic',readOnly:false}}));
let nr=0,nt=0;const commands=new Map(),tools=new Map();
const registration=registerZergSwarmExtension({registerCommand(name,def){commands.set(name,def);},registerTool(def){tools.set(def.name,def);}}, {cwd:path.join(root,'workspace'),idFactory:{runId:()=>`pub-run-${++nr}`,taskId:()=>`pub-task-${++nt}`},trustedTmux:{sdkModulePath:sdk,agentDir:path.join(root,'agent'),rootDir:path.join(root,'workers'),fixtureNodeImportPath:path.join(root,'no-network.mjs'),fixtureExtensionPaths:[path.join(root,'provider.ts')]}});
const control=registration.control;
assert(commands.has('clankers')&&tools.has('clankers_control'));
try {
 for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  assert(Buffer.byteLength(line)<65536);const q=JSON.parse(line);let r;
  if(q.fixture==='state') r={ok:true,data:control.getState()};
  else if(q.fixture==='dispose'){registration.dispose();await control.drain();r={ok:true};}
  else if(q.fixture==='slash') {const notifications=[];await commands.get('clankers').handler(q.text,{hasUI:false,ui:{notify:(text,type)=>notifications.push({text,type})}});r={ok:true,notifications};}
  else if(q.fixture==='tool') {const v=await tools.get('clankers_control').execute('public-smoke',q.action);assert.equal(v.isError,!v.details.ok);r=v.details;}
  else r=await control.execute(q);
  fs.appendFileSync(path.join(root,'public-responses.jsonl'),JSON.stringify({q,r})+'\n',{mode:0o600});
  process.stdout.write(JSON.stringify(r)+'\n');
 }
} finally {registration.dispose();await control.drain();}
