import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileWorkflowScript, inspectWorkflowScriptDefinition } from '../workflow-script.js';
import { createReadOnlyReviewDefinition, validateWorkflowDefinition, workflowHash, type WorkflowDefinition } from '../workflow-model.js';
import { WORKFLOW_SCRIPT_LIMITS as L } from '../workflow-script-format.js';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const wrap = (body: string, schema: unknown = empty) => `workflow({id:'demo',label:'Demo',inputSchema:${JSON.stringify(schema)}},()=>{${body}});`;
const aggregate = `const a=aggregate('a',{inputs:{n:value(1)},operation:'collect'});`;
async function accepted(source: string) {
  const result = await compileWorkflowScript(source);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected compilation');
  return result;
}
async function rejected(source: string) {
  const result = await compileWorkflowScript(source);
  assert.equal(result.ok, false, source.slice(0, 160));
  if (result.ok) throw new Error('Expected rejection');
  assert.ok(result.diagnostics.length >= 1 && result.diagnostics.length <= L.diagnostics);
  for (const d of result.diagnostics) {
    assert.ok(d.message.length <= L.diagnosticLength);
    assert.ok(!d.message.includes('SECRET_SENTINEL'));
    if (d.span) assert.ok(d.span.start >= 0 && d.span.end <= source.length);
  }
  return result;
}

test('deterministic canonical graph, exact UTF16 map, raw UTF8 hash and display-only name', async () => {
  const source = wrap(`// Unicode 😀\nconst json={x:[null,true,false,-1.25e2,'雪']};\nconst a=aggregate('a',{inputs:{n:value(json)},operation:'collect'});\nphase('read',[a]);`);
  const a = await accepted(source), b = await accepted(source);
  assert.deepEqual(a, b);
  const { authoring, ...graph } = a.definition;
  assert.ok(authoring);
  assert.equal(authoring.sourceHash, createHash('sha256').update(source).digest('hex'));
  assert.equal(authoring.graphHash, workflowHash(graph));
  assert.equal(authoring.sourceBytes, Buffer.byteLength(source));
  assert.equal(authoring.sourceLength, source.length);
  assert.equal(source.slice(authoring.steps[0].span.start, authoring.steps[0].span.end), `aggregate('a',{inputs:{n:value(json)},operation:'collect'})`);
  assert.equal(authoring.steps[0].span.line, 3);
  assert.equal(authoring.steps[0].span.column, 8);
  assert.deepEqual(authoring.phases[0].paths, [['a']]);
  assert.deepEqual(a.inspection.counts, { authored: 1, expanded: 1, native: 0, coding: 0, familyAdmissions: 0 });
  assert.ok(Object.isFrozen(a.definition));
  const renamed = await compileWorkflowScript(source, { sourceName: '../../SECRET\u001b[0m😀.workflow.js' });
  assert.ok(renamed.ok);
  assert.match(renamed.definition.authoring!.sourceName, /^[A-Za-z0-9_.-]{1,128}$/);
  assert.equal(renamed.definition.authoring!.graphHash, authoring.graphHash);
  assert.notEqual(workflowHash(renamed.definition), workflowHash(a.definition));
  const edited = await accepted(source + '\n// edit');
  assert.equal(edited.definition.authoring!.graphHash, authoring.graphHash);
  assert.notEqual(workflowHash(edited.definition), workflowHash(a.definition));
  assert.deepEqual(inspectWorkflowScriptDefinition(graph).phases, []);
  assert.equal(inspectWorkflowScriptDefinition(graph).source, undefined);
});

test('immutable constants, optional semicolons, earlier handles and parallel join', async () => {
  const result = await accepted(wrap(`
const output={type:'boolean'}
const a=native('one',{agentId:'generalist',prompt:'Read only',inputs:{},outputSchema:output})
const b=native('two',{agentId:'reviewer',prompt:'Read only',inputs:{},outputSchema:output})
const c=aggregate('join',{dependsOn:[a,b],inputs:{left:ref(a,[]),right:ref(b,[])},operation:'collect',consumeFailures:true,consumeSkips:true})
phase('parallel',[a,b])
phase('report',[c])`));
  assert.deepEqual(result.definition.steps.map(s => s.dependsOn), [[], [], ['one', 'two']]);
  assert.deepEqual(result.inspection.agentIds, ['generalist', 'reviewer']);
  assert.deepEqual(result.inspection.counts, { authored: 3, expanded: 3, native: 2, coding: 0, familyAdmissions: 6 });
});

test('all existing review aggregations, fanout, item refs lower exactly to ordinary graph', async () => {
  const expected = { ...createReadOnlyReviewDefinition(), version: 2 as const };
  const binding = (b: any): string => 'value' in b ? `value(${JSON.stringify(b.value)})` : `ref(${b.ref.source === 'step' ? `h${expected.steps.findIndex(s => s.id === b.ref.stepId)}` : JSON.stringify(b.ref.source)},${JSON.stringify(b.ref.path)})`;
  const body = expected.steps.map((step, i) => {
    const { id, kind, dependsOn, inputs, fanout, ...rest } = step;
    return `const h${i}=${kind}(${JSON.stringify(id)},{${Object.entries(rest).map(([k,v]) => `${k}:${JSON.stringify(v)}`).join(',')},dependsOn:[${dependsOn.map(d => `h${expected.steps.findIndex(s => s.id === d)}`).join(',')}],inputs:{${Object.entries(inputs!).map(([k,v]) => `${k}:${binding(v)}`).join(',')}}${fanout ? `,fanout:{from:${binding({ref:fanout.from})},maxItems:${fanout.maxItems}}` : ''}});`;
  }).join('\n');
  const result = await accepted(`workflow(${JSON.stringify({id:expected.id,label:expected.label,inputSchema:expected.inputSchema})},()=>{${body}});`);
  const { authoring, ...graph } = result.definition;
  assert.deepEqual(graph, expected);
  assert.equal(result.inspection.counts.native, 49);
  assert.equal(result.inspection.counts.familyAdmissions, 147);
  assert.equal(authoring!.steps.length, 5);
});

test('repeat captures outer data only, explicit feedback/until/output and local phases', async () => {
  const result = await accepted(wrap(`
const shape={type:'integer'};
const r=repeat('refine',{initial:value(0),stateSchema:shape,outputSchema:shape,maxIterations:3,when:{op:'boolean',value:value(true)}},()=>{
const n=native('next',{agentId:'generalist',prompt:'Refine',inputs:{state:ref('iteration',[])},outputSchema:shape});
phase('iteration',[n]);
return {feedback:ref(n,[]),until:{op:'gte',left:ref('iteration',[]),right:value(2)},output:ref(n,[])};
});
phase('outer',[r]);
const report=aggregate('report',{dependsOn:[r],inputs:{result:ref(r,[])},operation:'collect'});`));
  assert.equal(result.definition.version, 2);
  assert.deepEqual(result.definition.authoring!.steps.map(s => s.path), [['refine'], ['refine', 'next'], ['report']]);
  assert.deepEqual(result.inspection.counts, { authored: 3, expanded: 5, native: 3, coding: 0, familyAdmissions: 9 });
  assert.deepEqual(result.definition.steps[0].feedback, { ref: { source: 'step', stepId: 'next', path: [] } });
});

for (const op of ['boolean','eq','ne','lt','lte','gt','gte','not','all','any']) {
  const condition = op === 'boolean' ? `{op:'boolean',value:value(true)}` : op === 'not' ? `{op:'not',condition:{op:'boolean',value:value(false)}}` : ['all','any'].includes(op) ? `{op:'${op}',conditions:[{op:'boolean',value:value(true)}]}` : `{op:'${op}',left:value(1),right:value(2)}`;
  test(`typed condition ${op}`, async () => { await accepted(wrap(`const a=aggregate('a',{inputs:{},operation:'collect',when:${condition}});`)); });
}

const forbidden = [
  `import x from 'SECRET_SENTINEL';`, `export default 1;`, `await import('SECRET_SENTINEL');`,
  `process.exit(123);`, `require('node:fs').writeFileSync('SECRET_SENTINEL','bad');`, `eval('SECRET_SENTINEL');`, `new Function('SECRET_SENTINEL')();`,
  wrap(`while(true){}`), wrap(`for(;;){}`), wrap(`try{}catch(e){}`), wrap(`throw 'SECRET_SENTINEL';`),
  wrap(`let a=1;${aggregate}`), wrap(`var a=1;${aggregate}`), wrap(`const a=1,b=2;`), wrap(`const {a}=value(1);`),
  wrap(`const x=1; x=2;${aggregate}`), wrap(`const x=()=>1;${aggregate}`), wrap(`const x=function(){};${aggregate}`),
  wrap(`const a: number=1;`), wrap(`const x=1 as number;${aggregate}`), wrap(`const x=<div/>;${aggregate}`),
  wrap(`const x=\`SECRET_SENTINEL\`;${aggregate}`), wrap(`const x=/SECRET_SENTINEL/;${aggregate}`), wrap(`const x=1n;${aggregate}`),
  wrap(`const x=0xff;${aggregate}`), wrap(`const x=0b10;${aggregate}`), wrap(`const x=1_000;${aggregate}`), wrap(`const x=+1;${aggregate}`),
  wrap(`const x=1+1;${aggregate}`), wrap(`const x=1e999;${aggregate}`), wrap(`const x=[,1];${aggregate}`),
  wrap(`const x={a:1};const y={...x};${aggregate}`), wrap(`const x={get a(){return 1;}};${aggregate}`), wrap(`const x={a(){}};${aggregate}`),
  wrap(`const x={['a']:1};${aggregate}`), wrap(`const n=1;const x={n};${aggregate}`), wrap(`const x={a:1,a:2};${aggregate}`),
  wrap(`const x={'__proto__':{}};${aggregate}`), wrap(`const x={constructor:1};${aggregate}`), wrap(`const x={prototype:1};${aggregate}`),
  wrap(`const x={a:1};const y=x.a;${aggregate}`), wrap(`const x={a:1};const y=x['a'];${aggregate}`),
  wrap(`const native=1;${aggregate}`), wrap(`const x=1;const x=2;${aggregate}`), wrap(`${aggregate}const alias=a;`),
  wrap(`const a=aggregate?.('a',{inputs:{},operation:'collect'});`), wrap(`const a=aggregate<string>('a',{inputs:{},operation:'collect'});`),
  wrap(`const a=aggregate('a',{inputs:{x:ref(b,[])},operation:'collect'});`),
  wrap(`const a=aggregate('a',{dependsOn:['x'],inputs:{},operation:'collect'});`),
  wrap(`const a=aggregate('a',{inputs:{x:{value:1}},operation:'collect'});`),
  wrap(`const a=aggregate('a',{inputs:{x:{ref:{source:'inputs',path:[]}}},operation:'collect'});`),
  wrap(`const path=[];const a=aggregate('a',{inputs:{x:ref('inputs',path)},operation:'collect'});`),
  wrap(`const a=aggregate('a',{inputs:{x:ref('inputs',['constructor'])},operation:'collect'});`),
  wrap(`const a=aggregate('a',{inputs:{x:ref('iteration',[])},operation:'collect'});`),
  wrap(`const a=aggregate('a',{inputs:{x:ref('item',[])},operation:'collect'});`),
  wrap(`${aggregate}const b=aggregate('b',{inputs:{x:ref(a,[])},operation:'collect'});`),
  wrap(`${aggregate}const b=aggregate('a',{inputs:{},operation:'collect'});`),
  wrap(`${aggregate}phase('p',[a]);phase('p',[]);`), wrap(`${aggregate}phase('p',[a,a]);`), wrap(`${aggregate}phase('p',[a]);phase('q',[a]);`),
  wrap(`${aggregate}phase('p',[]);`), wrap(`${aggregate}return {};`), wrap(`;${aggregate}`), wrap(aggregate) + wrap(aggregate),
  wrap(`const a=aggregate('a',{inputs:{},operation:'collect',approved:true});`),
  wrap(`const a=native('a',{inputs:{},agentId:'generalist',model:'SECRET_SENTINEL',prompt:'x',outputSchema:{type:'null'}});`),
  wrap(`const a=aggregate('a',{inputs:{},operation:'collect',when:{op:'lt',left:value(true),right:value(1)}});`),
  wrap(`const a=aggregate('a',{inputs:{},operation:'collect',when:{op:'boolean',value:value(true),approved:true}});`),
  wrap(`const a=aggregate('a',{inputs:{},operation:'collect'});`, {...empty, approved:true}),
  wrap(`const a=native('a',{inputs:{},agentId:'g',prompt:'x',outputSchema:{type:'array',maxItems:1,items:{type:'null',approved:true}}});`),
];
for (const [i, source] of forbidden.entries()) test(`unsupported syntax/data ${i + 1}`, async () => { await rejected(source); });

test('repeat scope, shadowing, boundaries and nested repeat reject', async () => {
  const prefix = `const r=repeat('r',{initial:value(0),stateSchema:{type:'integer'},outputSchema:{type:'integer'},maxIterations:2},()=>{`;
  const next = `const n=native('n',{agentId:'g',prompt:'x',inputs:{},outputSchema:{type:'integer'}});`;
  const boundary = `return {feedback:ref(n,[]),until:{op:'boolean',value:value(true)},output:ref(n,[])};`;
  for (const source of [
    wrap(`${aggregate}${prefix}${next}phase('p',[a]);${boundary}});`),
    wrap(`${aggregate}${prefix}const n=native('n',{dependsOn:[a],agentId:'g',prompt:'x',inputs:{},outputSchema:{type:'integer'}});${boundary}});`),
    wrap(`const x=1;${prefix}const x=2;${next}${boundary}});`),
    wrap(`${prefix}${next}});`), wrap(`${prefix}${next}${boundary}const x=1;});`),
    wrap(`${prefix}${next}return {feedback:ref(n,[]),output:ref(n,[])};});`),
    wrap(`${prefix}const nested=repeat('nested',{},()=>{});${next}${boundary}});`),
    wrap(`${prefix}${next}return {feedback:ref(n,[]),output:ref(n,[]),until:{op:'eq',left:ref(n,[]),right:value(1)}};});`),
  ]) await rejected(source);
});

function codingPolicy() {
  const profile = {id:'check',executable:'/not/executed',argv:['--never'],cwd:'src',env:{ONLY:'literal'},timeoutMs:1000,allowGeneratedOutputs:false};
  return {version:3,capabilities:['investigate','stage-write','check','review','apply'],identity:{parentRunId:'parent',taskId:'task',attemptNo:1,rootAgentId:'reviewer',workerAgentId:'writer',model:'provider/model'},scope:{task:'Do not execute during compilation',writablePaths:['a.txt'],protectedPaths:['secret'],readonlyPaths:['readme'],baseline:{projectRootId:'root',stateHash:'baseline',packageVersion:'1'},manifest:[{path:'a.txt',sha256:createHash('sha256').update('a').digest('hex'),bytes:1,text:'a'}],dependencies:[]},bounds:{maxFiles:1},reviewRequired:true,checkProfiles:[{...profile,profileHash:workflowHash(profile)}]};
}
const codingSource = (policy: unknown, operation = 'investigate') => wrap(`const policy=${JSON.stringify(policy)};const c=coding('c',{inputs:{},outputSchema:${JSON.stringify(empty)},coding:{operation:'${operation}',policy:policy${operation==='check'?",checkProfileId:'check'":''}}});`);
test('all five existing coding capabilities compile as v3 data, never execute a check or grant approval', async () => {
  for (const operation of ['investigate','stage-write','check','review','apply']) {
    const result = await accepted(codingSource(codingPolicy(), operation));
    assert.equal(result.definition.version, 3);
    assert.deepEqual(result.inspection.codingCapabilities, [operation]);
    assert.deepEqual(result.inspection.agentIds, ['reviewer','writer']);
    assert.equal(result.inspection.counts.coding, 1);
    assert.equal((result.definition.steps[0].coding as any).approved, undefined);
    assert.deepEqual(validateWorkflowDefinition(result.definition), result.definition);
  }
});
test('strict recursive coding policy fields including fields ignored by underlying legacy validator', async () => {
  const paths = [[],['identity'],['scope'],['scope','baseline'],['scope','manifest',0],['bounds'],['checkProfiles',0]];
  for (const path of paths) {
    const policy: any = codingPolicy(); let target = policy;
    for (const key of path) target = target[key];
    target.approved = true;
    await rejected(codingSource(policy));
  }
  for (const [path,value] of [
    [['identity','model'],1], [['scope','baseline','gitCommit'],true], [['scope','readonlyPaths'],[1]],
    [['reviewRequired'],'yes'], [['checkProfiles',0,'env'],[]], [['checkProfiles',0,'env'],{x:{approved:true}}],
  ] as Array<[Array<string|number>,unknown]>) {
    const policy: any = codingPolicy(); let target = policy;
    for (const key of path.slice(0,-1)) target = target[key];
    target[path.at(-1)!] = value; await rejected(codingSource(policy));
  }
  await rejected(codingSource(codingPolicy()).replace("operation:'investigate',policy:policy", "operation:'investigate',approved:true,policy:policy"));
});

test('source byte/UTF8/literal/token/delimiter/AST depth/clone bounds and bounded diagnostics', async () => {
  const cases = [
    ' '.repeat(L.sourceBytes + 1), '\ud800', '//'+ '雪'.repeat(22000),
    wrap(`const x='${'x'.repeat(L.literalLength+1)}';${aggregate}`),
    wrap(`const x='\\uD800';${aggregate}`),
    wrap(`const x=${'['.repeat(33)}0${']'.repeat(33)};${aggregate}`),
    wrap(`const x=[${Array(4200).fill('0').join(',')}];${aggregate}`),
    wrap(`const x=${Array(100).fill('0').join('+')};${aggregate}`),
    wrap(`const x='${'x'.repeat(16000)}';const y=[x,x,x,x,x,x,x];${aggregate}`),
    wrap(Array.from({length:17},(_,i)=>`const a${i}=aggregate('a${i}',{inputs:{},operation:'collect'});`).join('')),
    `workflow({id:'SECRET_SENTINEL'},()=>{${'const = ;'.repeat(100)}});`,
  ];
  for (const source of cases) await rejected(source);
});

test('full 64KiB source survives JSON escaping expansion, accepted comments never run', async () => {
  const source = wrap(aggregate);
  const padded = source + '/*' + '\u0000'.repeat(L.sourceBytes - Buffer.byteLength(source) - 4) + '*/';
  assert.equal(Buffer.byteLength(padded), L.sourceBytes);
  assert.ok(Buffer.byteLength(JSON.stringify({source:padded})) > L.stdoutBytes);
  assert.ok((await accepted(padded)).definition.authoring!.sourceBytes === L.sourceBytes);
});

test('source effects stay inert in literals and hidden side-effect AST never writes or exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clankers-script-effects-'));
  const marker = join(directory, 'must-not-exist');
  const payload = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'SECRET_SENTINEL')`;
  try {
    const result = await accepted(wrap(`const a=aggregate('a',{inputs:{text:value(${JSON.stringify(payload)})},operation:'collect'});`));
    assert.deepEqual(result.definition.steps[0].inputs!.text, {value:payload});
    for (const source of [
      payload,
      wrap(`const x=(()=>{${payload};return 1;})();${aggregate}`),
      wrap(`const x={get hidden(){${payload};return 1;}};${aggregate}`),
      wrap(`const x={hidden:(${payload},1)};${aggregate}`),
      wrap(`const x=process.exit(23);${aggregate}`),
      wrap(`const x=fetch('http://127.0.0.1:1/SECRET_SENTINEL');${aggregate}`),
      wrap(`const x=setTimeout(()=>{${payload}},0);${aggregate}`),
    ]) {
      await rejected(source);
      assert.equal(existsSync(marker), false);
    }
    assert.equal(existsSync(marker), false);
    assert.ok((await accepted(wrap(aggregate))).ok);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('ordinary validator enforces invalid reference paths and expansion caps', async () => {
  await rejected(wrap(`const a=native('a',{inputs:{},agentId:'g',prompt:'x',outputSchema:{type:'integer'}});const b=aggregate('b',{dependsOn:[a],inputs:{x:ref(a,['x'])},operation:'collect'});`));
  await rejected(wrap(`const a=native('a',{inputs:{},agentId:'g',prompt:'x',outputSchema:{type:'integer'},fanout:{from:ref('inputs',['xs']),maxItems:32,approved:true}});`, {type:'object',properties:{xs:{type:'array',items:{type:'null'},maxItems:32}},additionalProperties:false}));
  await rejected(wrap(Array.from({length:3},(_,i)=>`const a${i}=native('a${i}',{inputs:{},agentId:'g',prompt:'x',outputSchema:{type:'null'},fanout:{from:ref('inputs',['xs']),maxItems:32}});`).join(''), {type:'object',properties:{xs:{type:'array',items:{type:'null'},maxItems:32}},additionalProperties:false}));
});

function admissionSource(bodyKinds: string[], iterations: number, extraCoding = 0) {
  const operations = ['investigate', 'stage-write', 'check', 'review', 'apply'];
  const coding = (id: string, operation: string) => `const ${id}=coding('${id}',{inputs:{},outputSchema:${JSON.stringify(empty)},coding:{operation:'${operation}',policy:policy${operation === 'check' ? ",checkProfileId:'check'" : ''}}});`;
  const body = bodyKinds.map((kind, i) => kind === 'native'
    ? `const n${i}=native('n${i}',{agentId:'reviewer',prompt:'Read only',inputs:{},outputSchema:{type:'boolean'}});`
    : coding(`c${i}`, kind === 'investigate' ? kind : operations[i % operations.length])).join('\n');
  return wrap(`const policy=${JSON.stringify(codingPolicy())};
const r=repeat('r',{initial:value(false),stateSchema:{type:'boolean'},outputSchema:{type:'boolean'},maxIterations:${iterations}},()=>{
${body}
return {feedback:ref('iteration',[]),until:{op:'boolean',value:value(false)},output:ref('iteration',[])};
});
${Array.from({length:extraCoding},(_,i)=>coding(`extra${i}`, 'investigate')).join('\n')}
${aggregate}`);
}

for (const mixed of [false, true]) test(`authored admission budget ${mixed ? 'mixed native/coding' : 'coding-only'} allows 255 and rejects first over 258`, async () => {
  const kinds = Array<string>(12).fill('coding');
  if (mixed) kinds[0] = 'native';
  const result = await accepted(admissionSource(kinds, 7, 1));
  assert.deepEqual(result.inspection.counts, {
    authored: 15, expanded: 87, native: mixed ? 7 : 0, coding: mixed ? 78 : 85, familyAdmissions: 255,
  });
  assert.equal(result.inspection.caps.admissions, 256);
  assert.equal(result.inspection.caps.attempts, 3);
  assert.deepEqual(result.inspection.codingCapabilities, ['apply', 'check', 'investigate', 'review', 'stage-write']);
  // Container and aggregate are expanded units, but neither consumes an admission.
  // Existing ordinary/legacy validation still accepts the 86-unit graph as data.
  const {authoring, ...graph} = result.definition;
  const extra = {...graph.steps.find(step => step.id === 'extra0')!, id:'extra1'};
  const legacy = validateWorkflowDefinition({...graph, steps:[...graph.steps, extra]});
  assert.equal(inspectWorkflowScriptDefinition(legacy).counts.familyAdmissions, 258);
  const over = await rejected(admissionSource(kinds, 7, 2));
  assert.deepEqual(over.diagnostics, [{code:'budget', message:'Authored worst-case admissions exceed workflow budget'}]);
});

test('review reproduction: eleven investigate steps repeated eight times reject 264 admissions', async () => {
  const result = await rejected(admissionSource(Array<string>(11).fill('investigate'), 8));
  assert.deepEqual(result.diagnostics, [{code:'budget', message:'Authored worst-case admissions exceed workflow budget'}]);
});
