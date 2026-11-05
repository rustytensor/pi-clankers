// Independent actual controller host; no transport mocks.
import { createJiti } from 'jiti';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.env.TMUX_GATE_ROOT, sdk = process.env.TMUX_GATE_SDK;
assert(root.startsWith('/srv/devops/scratch/'));
assert.equal(JSON.parse(fs.readFileSync(path.resolve(path.dirname(sdk), '../package.json'))).version, '1.5.0');
const host = createJiti(sdk, { fsCache: false });
const jiti = createJiti(import.meta.url, { fsCache: false, alias: { '@earendil-works/pi-coding-agent': sdk, '@earendil-works/pi-tui': host.esmResolve('@earendil-works/pi-tui') } });
const { ProjectTrustStore } = await import(pathToFileURL(sdk).href);
new ProjectTrustStore(path.join(root, 'agent')).set(path.join(root, 'workspace'), true);
const { createTmuxControl } = await jiti.import('../../tmux-control.ts');
const { createZergState, createZergStateContainer, upsertAgentDefinition } = await jiti.import('../../state.ts');
const state = createZergStateContainer({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } });
for (const id of ['a','b','c','lead','solo','s','slead']) state.replace(upsertAgentDefinition(state.read(), { id, label: id, source: 'user', prompt: id, tools: [], model: 'team-fixture/fixed:off' }));
const next = state.read();
next.teams.team = { id:'team', label:'Team', kind:'team', status:'idle', leaderAgentId:'lead', memberAgentIds:['a','b','a','c','lead'] };
next.teams.sibling = { id:'sibling', label:'Sibling', kind:'team', status:'idle', leaderAgentId:'slead', memberAgentIds:['s'] };
state.replace(next);
let n = 0;
const control = createTmuxControl(state, { cwd:path.join(root,'workspace'), assertAuthority(){}, ids:()=>({runId:`run-${++n}`,taskId:`task-${n}`}), trusted:{sdkModulePath:sdk,agentDir:path.join(root,'agent'),rootDir:path.join(root,'workers'),fixtureNodeImportPath:path.join(root,'no-network.mjs'),fixtureExtensionPaths:[path.join(root,'provider.ts')]} });
try {
 for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  assert(Buffer.byteLength(line)<65536);
  const q=JSON.parse(line); let r;
  try {
   if(q.action==='start') r=control.start({agent:q.agent??'team',task:q.task,backend:'tmux',background:true,concurrency:q.agent==='solo'?1:2});
   else if(q.action==='list') r={ok:true,rows:await control.list()};
   else if(q.action==='results') r={ok:true,rows:control.retainedResults(),agents:state.read().agents};
   else if(q.action==='interrupt') r=control.interrupt(q.runId);
   else if(q.action==='prompt') r=await control.prompt(q.workerId,q.task,true);
   else if(q.action==='close') r={ok:true,result:await control.close(q.workerId)};
   else if(q.action==='dispose') {control.dispose();await control.drain();r={ok:true};}
   else throw new Error('fixture request');
  } catch {r={ok:false};}
  process.stdout.write(JSON.stringify(r)+'\n');
 }
} finally { control.dispose();await control.drain(); }
