import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertAncestorIsolation, cleanHostEnvironment, guardSource, readFixtureBody, spawnOwnedController, settleOwnedController } from './host-fixture-safety.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
function resolveInstalledPiCli() {
  const requireFromHere = createRequire(import.meta.url);
  const packageName = '@earendil-works/pi-coding-agent';
  const roots = new Set();
  for (const base of [dirname(fileURLToPath(import.meta.url)), ...(requireFromHere.resolve.paths(packageName) ?? [])]) {
    let dir = base;
    for (;;) {
      const candidate = base.endsWith('node_modules') ? join(base, packageName) : join(dir, 'node_modules', packageName);
      if (existsSync(join(candidate, 'package.json'))) roots.add(candidate);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const root of roots) for (const rel of ['dist/bundle/cli.js', 'dist/cli.js', 'cli.js']) {
    const candidate = join(root, rel);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Installed Pi CLI required: searched package ancestors without finding a known CLI');
}
const cli = resolveInstalledPiCli();
const evidence = mkdtempSync(join(tmpdir(), 'clankers-workflow-coding-pty-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = text => createHash('sha256').update(text).digest('hex');
const ORIGINAL_BYTES = 'export const value = 1;\n';
const CANDIDATE2_BYTES = 'export const value = 2;\n';
const CANDIDATE3_BYTES = 'export const value = 3;\n';
const results = [];

function smokeSource(root, phaseDir, mode) { return `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { registerClankersExtension } from ${JSON.stringify(join(repo, 'index.ts'))};
import { workflowHash, workflowStepEntries } from ${JSON.stringify(join(repo, 'workflow-model.ts'))};
import { ClankersWorkflowComponent } from ${JSON.stringify(join(repo, 'ui/workflow-overlay.ts'))};
const root=${JSON.stringify(root)}, phaseDir=${JSON.stringify(phaseDir)}, mode=${JSON.stringify(mode)};
const put=(name,value)=>writeFileSync(join(phaseDir,name),JSON.stringify(value));
const phase=(name,extra={})=>put('phase.json',{name,...extra});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=t=>createHash('sha256').update(t).digest('hex');
async function until(check,label){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await sleep(25);}throw Error('Timeout: '+label);}
function obj(properties){return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};} const str=(maxLength=256)=>({type:'string',maxLength}); const arr=items=>({type:'array',maxItems:8,items}); const bool={type:'boolean'};
function profile(){const base={id:'node',executable:process.execPath,argv:['-e',${JSON.stringify("const fs=require('fs'); const v=fs.readFileSync('bug.js','utf8'); if(v!=="+JSON.stringify('export const value = 2;\n')+"&&v!=="+JSON.stringify('export const value = 3;\n')+") process.exit(2)")}],cwd:'src',env:{},timeoutMs:10000,allowGeneratedOutputs:false};return {...base,profileHash:workflowHash(base)};}
function policy(){const text='export const value = 1;\\n', p=profile(); return {version:3,capabilities:['investigate','stage-write','check','review','apply'],identity:{parentRunId:'host',taskId:'host-'+mode,attemptNo:1,rootAgentId:'reviewer',workerAgentId:'writer',model:'fixture/writer'},scope:{task:'Host coding acceptance: investigate original readonly, use stagewrite, preserve unrelated, apply exact bytes.',writablePaths:['src/bug.js'],readonlyPaths:['src/untouched.txt','src/original.txt'],baseline:{projectRootId:join(root,'work'),stateHash:sha(text)},manifest:[{path:'src/bug.js',text,bytes:Buffer.byteLength(text),sha256:sha(text)}]},checkProfiles:[p],reviewRequired:true};}
function definition(){const p=policy(); const investigationOut=obj({summary:str(512),readonlyPaths:arr(str(128))}); const stageOut=obj({candidateHash:str(80),changedPaths:arr(str(128))}); const passOut=obj({passed:bool,profileId:str(80),candidateHash:str(80)}); const reviewOut=obj({passed:bool,candidateHash:str(80),reviewer:str(160),findings:arr(obj({id:str(20),severity:str(10),path:str(128),message:str(256)}))}); const applyOut=obj({status:str(16),candidateHash:str(80),appliedPaths:arr(str(128)),rejectedPaths:arr(str(128)),diagnostics:arr(str(256)),outcomeHash:str(80)}); const body=[{id:'stage',kind:'coding',dependsOn:[],inputs:{},outputSchema:stageOut,coding:{operation:'stage-write',policy:p}},{id:'check',kind:'coding',dependsOn:['stage'],inputs:{},outputSchema:passOut,coding:{operation:'check',policy:p,checkProfileId:'node'}},{id:'review',kind:'coding',dependsOn:['check'],inputs:{},outputSchema:reviewOut,coding:{operation:'review',policy:p}}]; return {id:'host-coding-'+mode,version:3,label:'Host coding '+mode,inputSchema:obj({}),steps:[{id:'investigate',kind:'coding',dependsOn:[],inputs:{},outputSchema:investigationOut,coding:{operation:'investigate',policy:p}},{id:'loop',kind:'repeat',dependsOn:['investigate'],initial:{value:{passed:false,candidateHash:'',reviewer:'',findings:[]}},stateSchema:reviewOut,maxIterations:2,body,feedback:{ref:{source:'step',stepId:'review',path:[]}},until:{op:'boolean',value:{ref:{source:'iteration',path:['passed']}}},output:{ref:{source:'iteration',path:[]}},outputSchema:reviewOut},{id:'apply',kind:'coding',dependsOn:['loop'],inputs:{},outputSchema:applyOut,coding:{operation:'apply',policy:p}}]};}
export default function(pi){let handler, started=false, cleaned=false; const components=[]; const proxy=new Proxy(pi,{get(target,key){if(key==='registerCommand')return(name,options)=>{if(name==='clankers')handler=options.handler;return target.registerCommand(name,options);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const registration=registerClankersExtension(proxy,{persistence:{enabled:true,snapshotFile:join(root,'snapshot.json')},coding:{enabled:true,projectRoot:join(root,'work'),stagingParent:join(root,'stage'),checkProfiles:{node:{id:'node',executable:process.execPath,argv:profile().argv,cwd:'src',env:{},timeoutMs:10000,outputBytes:4096}}}}); const control=registration.control; const get=id=>control.getState().extensions.workflows.runs.find(r=>r.workflowRunId===id); function cleanup(){if(cleaned)return;cleaned=true;registration.dispose();}
 pi.on('session_shutdown',cleanup); pi.on('session_start',(_e,ctx)=>{if(started)return;started=true;setTimeout(()=>void smoke(ctx).catch(error=>{put('result.json',{ok:false,error:String(error.stack??error).slice(-12000)});try{cleanup();}finally{ctx.shutdown();}}),0);});
 async function execute(input){const result=await control.execute(input);assert(result.ok,JSON.stringify(result));return result;} function terminal(run){return run.cleanupSettled&&['completed','failed','cancelled'].includes(run.status);} function safe(line,width){const plain=line.split(CURSOR_MARKER).join('').replace(/\\u001b\\[[0-9;]*m/g,'');assert(!/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]/.test(plain));assert(visibleWidth(line)<=width);} function observedContext(ctx){const ui=new Proxy(ctx.ui,{get(target,key){if(key==='custom')return(factory,options)=>target.custom((tui,theme,kb,done)=>{const component=factory(tui,theme,kb,done);const item={workflow:component instanceof ClankersWorkflowComponent,frames:0,disposed:false};components.push(item);const render=component.render.bind(component),dispose=component.dispose?.bind(component);component.render=(w,h)=>{const lines=render(w,h);for(const line of lines)safe(line,Math.min(w,tui.terminal?.columns??w));item.frames++;return lines;};component.dispose=()=>{dispose?.();item.disposed=true;};return component;},options);const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});return new Proxy(ctx,{get(target,key){return key==='ui'?ui:Reflect.get(target,key);}});}
 async function smoke(ctx){assert.equal(ctx.mode,'tui');assert.equal(typeof handler,'function');const facade=observedContext(ctx);for(const [id,model,prompt] of [['writer','fixture/writer','Use stage tools only; call workflow_stage_write.'],['reviewer','fixture/reviewer','Readonly review distinct session.']]) await execute({action:'agents.create',id,model,tools:['read','bash','edit','write','clankers_control'],prompt}); const def=definition(); await execute({action:'workflows.define',definition:def}); const runId=(await execute({action:'workflows.start',definitionId:def.id,inputs:{},concurrency:1})).data.view.workflowRunId; const runReport=(label)=>{const run=get(runId); put('run-report.json',{label,run,approvals:control.workflowApprovals.inspect()}); if(run&&['failed','cancelled'].includes(run.status)) throw Error('Run '+run.status+' before '+label+': '+JSON.stringify(run).slice(-4000));}; const wait=async(check,label)=>until(async()=>{runReport(label); return check();},label); await wait(()=>control.workflowApprovals.inspect().some(r=>r.kind==='implementation'&&r.status==='pending'),'implementation approval surfaced'); const impl=control.workflowApprovals.inspect().find(r=>r.kind==='implementation'&&r.status==='pending'); phase('impl',{workflowRunId:runId,approvalId:impl.id,hash:impl.requestHash}); const watched=(async()=>{await wait(()=>existsSync(join(root,'grant-impl'))&&readFileSync(join(root,'grant-impl'),'utf8').includes('go'),'grant impl'); control.workflowApprovals.grantFingerprint(impl.id,impl.requestHash); await wait(()=>control.workflowApprovals.inspect().some(r=>r.kind==='application'&&r.status==='pending'),'application approval surfaced'); const app=control.workflowApprovals.inspect().find(r=>r.kind==='application'&&r.status==='pending'); put('application.json',{workflowRunId:runId,id:app.id,hash:app.requestHash,stageApprovalId:impl.id}); await wait(()=>existsSync(join(root,'grant-app'))&&readFileSync(join(root,'grant-app'),'utf8').includes('go'),'grant app'); control.workflowApprovals.grantFingerprint(app.id,app.requestHash); await control.drain(); await wait(()=>terminal(get(runId)),'coding terminal'); assert.equal(get(runId).status,'completed'); assert.equal(readFileSync(join(root,'work/src/bug.js'),'utf8'),'export const value = 3;\\n'); assert.equal(readFileSync(join(root,'work/src/untouched.txt'),'utf8'),'HOST_UNRELATED_USER_MODIFICATION\\n'); const allUnits=workflowStepEntries(get(runId)).flatMap(e=>e.step.units); const stageHashes=allUnits.filter(u=>u.stepId.includes('stage')&&u.result?.candidateHash).map(u=>u.result.candidateHash); assert(stageHashes.length>=2&&new Set(stageHashes).size>=2,'host correction produced distinct candidate hashes'); put('done.json',{ok:true,status:get(runId).status,stageHashes});})().then(()=>({}),error=>({error})); await handler('workflows monitor '+runId,facade); const r=await watched;if(r.error)throw r.error; runReport('complete'); assert(components.some(c=>c.workflow&&c.frames>0)); assert(components.every(c=>c.disposed)); put('result.json',{ok:true,mode,workflowRunId:runId,implApproval:impl.id,instances:components.length,stageHashes:readFileSync(join(phaseDir,'done.json'),'utf8')}); phase('complete'); cleanup(); ctx.shutdown(); }
}
`; }

const pythonSource = String.raw`import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
root, phase_dir, node, cli, mode = sys.argv[1:]
master, slave = pty.openpty()
def resize(cols,rows): fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
resize(140,45)
env=dict(os.environ); env['TERM']='xterm-256color'
args=[node,'--import',root+'/guard.mjs',cli,'--offline','--no-session','--no-approve','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-tools','--model','fixture/writer','--thinking','off','--tui-mode',mode,'-e',phase_dir+'/smoke.ts']
proc=subprocess.Popen(args,cwd=root+'/work',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave); raw=bytearray(); start=time.monotonic()
ansi=re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]')
def pump(wait=.04):
  if select.select([master],[],[],wait)[0]:
    try: data=os.read(master,65536)
    except OSError as e:
      if e.errno==errno.EIO: return
      raise
    raw.extend(data)
    if len(raw)>4*1024*1024: raise Exception('terminal ceiling')
    if b'\x1b[6n' in data: os.write(master,b'\x1b[1;1R')
    if b'\x1b[c' in data: os.write(master,b'\x1b[?1;2c')
    if b'\x1b[>c' in data: os.write(master,b'\x1b[>0;0;0c')
def text(s=0): return ansi.sub('',bytes(raw[s:]).decode('utf-8','replace'))
def emitted(v,s=0): return re.sub(r'\s+','',v) in re.sub(r'\s+','',text(s))
def read(name):
  try: return json.load(open(phase_dir+'/'+name))
  except Exception: return {}
def until(check,label):
  while time.monotonic()-start<85:
    pump()
    if check(): return
    if read('result.json').get('ok') is False: raise Exception('host failure '+str(read('result.json')))
    if proc.poll() is not None:
      if check(): return
      raise Exception('host exited '+label+'\n'+text()[-5000:])
  raise Exception('deadline '+label+'\n'+text()[-5000:])
def pause(sec=.25):
  end=time.monotonic()+sec
  while time.monotonic()<end: pump()
def key(v,label): os.write(master,v); report['keys'].append(label); pause()
def mark(n): report['segments'][n]=len(raw); return len(raw)
def touch(name): open(root+'/'+name,'w').write('go')
def resized():
  for cols,rows in [(24,9),(80,30),(140,45)]:
    before=len(raw); resize(cols,rows); os.kill(proc.pid,signal.SIGWINCH); pause(.3); assert len(raw)>before, 'resize redraw'
report={'ok':False,'mode':mode,'keys':[],'segments':{},'sizes':[140]}
try:
  until(lambda: read('phase.json').get('name')=='impl','implementation approval phase')
  data=read('phase.json'); begin=mark('impl'); resized()
  until(lambda: emitted(data['workflowRunId'],begin) and emitted('running',begin),'workflow monitor rendered exact run')
  key(b'\x1b[B','Down to loop'); key(b'\r','Enter loop iterations'); key(b'\r','Enter iteration body'); until(lambda: emitted('stage',begin) and (emitted(data['approvalId'],begin) or emitted('approval',begin) or emitted('awaiting',begin)),'navigated pending implementation body unit')
  touch('grant-impl'); until(lambda: read('application.json').get('id'),'application approval backing evidence')
  app=read('application.json'); assert app.get('workflowRunId')==data['workflowRunId']; assert app.get('stageApprovalId')==data['approvalId']; begin=mark('app'); resized(); until(lambda: emitted(data['workflowRunId'],begin) and (emitted(app['id'],begin) or emitted('approval',begin) or emitted('apply',begin)),'same run and pending application gate')
  touch('grant-app'); until(lambda: read('done.json').get('ok') is True,'apply completion')
  begin=mark('done'); resized(); until(lambda: emitted('completed',begin) or emitted(data['workflowRunId'],begin),'completion rendered')
  key(b'\x03','Ctrl+C close monitor'); until(lambda: read('result.json').get('ok') is True,'host result'); until(lambda: proc.poll() is not None,'natural shutdown'); assert proc.returncode==0; report['ok']=True
except BaseException as e: report['error']=str(e)[-12000:]
finally:
  if proc.poll() is None:
    report['forcedCleanup']=True; os.killpg(proc.pid,signal.SIGTERM)
    try: proc.wait(timeout=3)
    except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL); proc.wait(timeout=3)
  try: pump(0)
  except BaseException as e: report['cleanupError']=str(e)[-1000:]
  os.close(master); report['hostExit']=proc.returncode; report['bytes']=len(raw)
  report['phase']=read('phase.json'); report['application']=read('application.json'); report['runReport']=read('run-report.json')
  open(phase_dir+'/terminal.ansi','wb').write(raw); open(phase_dir+'/pty-result.json','w').write(json.dumps(report,indent=2))
if not report['ok']: sys.exit(1)
`;

async function runMode(mode) {
  const root = join(evidence, mode), budget = { hits: 0, max: 80 }; let controller, serverFailure, responseBytes = 0; const requests = [];
  const server = createServer(async (req, res) => { try {
    const input = JSON.parse(await readFixtureBody(req, budget, 524288)); requests.push(input); assert.equal(req.headers.authorization, 'Bearer dummy-host-coding-only'); assert.equal(input.stream, true);
    const tools = (input.tools ?? []).map(t => t.function.name).sort(); if (input.model === 'writer') assert.deepEqual(tools, ['workflow_stage_inspect','workflow_stage_read','workflow_stage_write'].sort()); else { assert.equal(input.model, 'reviewer'); assert.deepEqual(tools, ['workflow_stage_inspect','workflow_stage_read'].sort()); }
    const rows = input.messages.filter(r => r.role === 'tool'); const calls = new Map(input.messages.filter(r => r.role === 'assistant').flatMap(r => r.tool_calls ?? []).map(c => [c.id,c])); for (const row of rows) assert(calls.has(row.tool_call_id));
    const text = row => typeof row.content === 'string' ? row.content : (row.content ?? []).map(b => b.text ?? '').join(''); let tool, answer;
    const promptText = input.messages.filter(r => r.role === 'user').map(text).join('\n');
    if (input.model === 'writer') { if (rows.length === 0) tool = ['workflow_stage_read', { path: 'src/bug.js' }]; else if (rows.length === 1) { const readBytes=text(rows[0]); if (readBytes.includes(ORIGINAL_BYTES)) tool = ['workflow_stage_write', { path: 'src/bug.js', text: CANDIDATE2_BYTES }]; else if (readBytes.includes(CANDIDATE2_BYTES)) tool = ['workflow_stage_write', { path: 'src/bug.js', text: CANDIDATE3_BYTES }]; else assert.fail('host writer read unexpected staged bytes: '+readBytes); } else if (rows.length === 2) tool = ['workflow_stage_inspect', {}]; else answer = JSON.stringify({ ok: true }); }
    else if (!/Review exact staged candidate/i.test(promptText) && /investigate|original readonly/i.test(promptText)) { if (rows.length === 0) tool = ['workflow_stage_read', { path: 'src/original.txt' }]; else { assert(text(rows[0]).includes('ORIGINAL_UNCHANGED')); answer = JSON.stringify({ summary: 'readonly investigation completed before implementation approval', readonlyPaths: ['src/original.txt'] }); } }
    else { if (rows.length === 0) tool = ['workflow_stage_read', { path: 'src/bug.js' }]; else { const reviewedBytes=text(rows[0]); if (reviewedBytes.includes(CANDIDATE2_BYTES)) answer = JSON.stringify({ verdict: 'fail', findings: [{ id: 'h1', severity: 'high', path: 'src/bug.js', message: 'candidate still needs value 3' }] }); else if (reviewedBytes.includes(CANDIDATE3_BYTES)) answer = JSON.stringify({ verdict: 'pass', findings: [] }); else assert.fail('host reviewer read unexpected staged bytes: '+reviewedBytes); } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const emit = (delta, finish_reason=null) => { const packet='data: '+JSON.stringify({ id:'host-coding-'+requests.length, object:'chat.completion.chunk', created:1, model:input.model, choices:[{ index:0, delta, finish_reason }] })+'\n\n'; responseBytes += Buffer.byteLength(packet); assert(responseBytes <= 8388608); res.write(packet); };
    emit({ role: 'assistant' }); if (tool) { emit({ tool_calls: [{ index: 0, id: 'host-coding-call-' + requests.length, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }); emit({}, 'tool_calls'); } else { emit({ content: answer }); emit({}, 'stop'); } res.end('data: [DONE]\n\n');
  } catch (error) { serverFailure ??= String(error.stack ?? error).slice(-12000); writeFileSync(join(root, 'server-error.txt'), serverFailure); res.destroy(error); } });
  async function host() { const phaseDir = join(root, 'live'); writeFileSync(join(phaseDir, 'smoke.ts'), smokeSource(root, phaseDir, mode)); writeFileSync(join(phaseDir, 'controller.py'), pythonSource); controller = spawnOwnedController('/usr/bin/python3', [join(phaseDir, 'controller.py'), root, phaseDir, process.execPath, cli, mode], root, 95000); const output=[]; let bytes=0; for (const s of [controller.stdout, controller.stderr]) s.on('data', c => { bytes += c.length; if (bytes <= 65536) output.push(c); else controller.kill('SIGTERM'); }); await controller.fixtureClosed; writeFileSync(join(phaseDir, 'diagnostics.txt'), Buffer.concat(output)); await settleOwnedController(controller); const load=n=>existsSync(join(phaseDir,n))?JSON.parse(readFileSync(join(phaseDir,n),'utf8')):{}; const pty=load('pty-result.json'), result=load('result.json'); assert.equal(controller.exitCode, 0, JSON.stringify({ pty, result, serverFailure })); const supervision=JSON.parse(readFileSync(join(root,'supervisor-result.json'),'utf8')); assert.equal(supervision.ok, true); assert.deepEqual(supervision.remaining, []); assert(pty.ok && result.ok); assert.equal(pty.hostExit, 0); assert(!serverFailure, serverFailure); assert(!existsSync(join(root,'network-refused.txt'))); return { ...result, terminalBytes: pty.bytes, keys: pty.keys }; }
  try { assertAncestorIsolation(root); cleanHostEnvironment(root); for (const leaf of ['work/.pi','work/src','agent/extensions','live','stage']) mkdirSync(join(root, leaf), { recursive: true }); writeFileSync(join(root,'work/src/bug.js'),ORIGINAL_BYTES); writeFileSync(join(root,'work/src/untouched.txt'),'HOST_UNRELATED_USER_MODIFICATION\n'); writeFileSync(join(root,'work/src/original.txt'),'ORIGINAL_UNCHANGED\n'); writeFileSync(join(root,'agent/auth.json'),'{}'); const settings={packages:[],extensions:['-builtin:mcp','-builtin:llama.cpp','-builtin:codemode','-builtin:tool-search'],skills:[],prompts:[],themes:[],noExtensions:false,noSkills:false,noPromptTemplates:false,noThemes:true,defaultProjectTrust:'never',enableInstallTelemetry:false,enableAnalytics:false,cacheWarming:'off',compaction:{enabled:false},retry:{enabled:false}}; writeFileSync(join(root,'agent/settings.json'),JSON.stringify(settings)); writeFileSync(join(root,'work/.pi/settings.json'),JSON.stringify(settings)); await new Promise((resolve,reject)=>{server.once('error',reject); server.listen(0,'127.0.0.1',resolve);}); const origin='http://127.0.0.1:'+server.address().port; writeFileSync(join(root,'agent/models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:origin+'/v1',apiKey:'dummy-host-coding-only',models:['writer','reviewer'].map(id=>({id,reasoning:false,input:['text'],contextWindow:65536,maxTokens:2048}))}}})); writeFileSync(join(root,'guard.mjs'),guardSource(root,origin)); const live=await host(); assert(requests.some(r=>r.model==='writer'&&JSON.stringify(r).includes('workflow_stage_write')), 'real writer stagewrite in host'); const writerReads=requests.filter(r=>r.model==='writer'&&r.messages.filter(x=>x.role==='tool').length===1).map(r=>r.messages.filter(x=>x.role==='tool').map(x=>typeof x.content==='string'?x.content:(x.content??[]).map(b=>b.text??'').join('')).join('\n')); assert(writerReads.some(t=>t.includes(CANDIDATE2_BYTES)),'host second writer iteration read prior candidate2 actual tool bytes'); const writePayloads=requests.filter(r=>r.model==='writer').flatMap(r=>r.messages.filter(x=>x.role==='assistant').flatMap(x=>x.tool_calls??[]).filter(c=>c.function.name==='workflow_stage_write').map(c=>JSON.parse(c.function.arguments).text)); assert(writePayloads.includes(CANDIDATE2_BYTES)&&writePayloads.includes(CANDIDATE3_BYTES),'host writer made actual distinct candidate2/candidate3 write tool calls'); const reviewReads=requests.filter(r=>r.model==='reviewer'&&r.messages.filter(x=>x.role==='tool').length===1&&/Review exact staged candidate/i.test(r.messages.filter(x=>x.role==='user').map(x=>typeof x.content==='string'?x.content:(x.content??[]).map(b=>b.text??'').join('')).join('\n'))).length; assert.equal(reviewReads,2,'host regular/fullscreen must exercise Stage8A first review failure and correction'); const investigationBeforeImpl=requests.findIndex(r=>r.model==='reviewer'&&!/Review exact staged candidate/i.test(r.messages.filter(x=>x.role==='user').map(x=>typeof x.content==='string'?x.content:(x.content??[]).map(b=>b.text??'').join('')).join('\n'))&&/investigate|original readonly/i.test(r.messages.filter(x=>x.role==='user').map(x=>typeof x.content==='string'?x.content:(x.content??[]).map(b=>b.text??'').join('')).join('\n'))); assert(investigationBeforeImpl>=0,'host must perform actual readonly investigation before implementation gate'); const result={mode,localhostRequests:requests.length,live,reviewReads,investigationBeforeImpl}; results.push(result); writeFileSync(join(root,'checks.json'),JSON.stringify(result,null,2)); writeFileSync(join(root,'live','check-report.json'),JSON.stringify({result,requests:requests.map(r=>({model:r.model,toolCount:r.messages.filter(x=>x.role==='tool').length,toolNames:(r.tools??[]).map(t=>t.function.name)}))},null,2)); }
  finally { await settleOwnedController(controller); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); const keep=new Set(['live','checks.json','server-error.txt','network-refused.txt','supervisor-result.json']); for (const leaf of existsSync(root)?readdirSync(root):[]) if(!keep.has(leaf)) rmSync(join(root,leaf),{recursive:true,force:true}); }
}
try { await runMode('regular'); await runMode('fullscreen'); writeFileSync(join(evidence,'summary.json'),JSON.stringify({ok:true,results,boundary:'Actual Pi CLI TUI regular/fullscreen with trusted host approval API and loopback dummy model; no manual visual claim.'},null,2)); console.log('PASS workflow coding host acceptance; bounded synthetic evidence: '+evidence); } catch (error) { console.error('FAIL workflow coding host acceptance; bounded synthetic evidence: '+evidence); throw error; }
