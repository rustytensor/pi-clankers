# Workflow script language (Stage 8D)

Stage 8D adds an optional **compiled authoring surface** for workflow definitions.
You write a small declarative script, the compiler turns it into the existing
validated workflow graph (version 2, or version 3 when coding steps are present),
and you start it with the ordinary `workflows.start` controls. Everything else
about workflows — frozen identities, bounded attempts, trusted gates, recovery —
is unchanged.

The parser is the pinned TypeScript 5.9.3 runtime dependency. The package requires
Node.js 22.19 or newer; authoring actions never install dependencies.

## What the script language is — and is not

| It is | It is not |
| --- | --- |
| A restricted expression of the existing declarative workflow graph | Ordinary JavaScript; there are no async/await/runtime JS semantics |
| Parsed as pure data into a validated definition | An execution engine, interpreter, or template system |
| Compiled without network, provider, workspace, check, or shell effects | A sandbox for user code — user code is never executed by the compiler |
| Optional provenance (`definition.authoring`) recorded next to the graph | Automatic discovery, recompilation, or restart of anything |

The script never runs. Compilation extracts a graph plus provenance; starting
the workflow uses the same trusted admission and approval gates as a
hand-written `workflows.define` graph.

## Authoring surface

A script is a single zero-argument builder arrow passed to one `workflow(...)`
call:

```js
workflow({ id: 'read-only-review', label: 'Read-only review', inputSchema: { /* schema */ } }, () => {
  const load = native('load', { /* options */ });
  const summarize = aggregate('summarize', { dependsOn: [load], /* options */ });
  phase('review-phase', [load, summarize]);
});
```

Recognized builder calls (everything else is rejected):

| Builder | Purpose |
| --- | --- |
| `workflow({id, label, inputSchema}, () => { ... })` | Exactly one per script; root of the graph |
| `native(id, options)` / `aggregate(id, options)` / `coding(id, options)` | Declares a step; returns an immutable step handle |
| `repeat(id, options, () => { ...; return { feedback, until, output }; })` | Declares a bounded repeat block; returns a step handle |
| `phase(id, [earlier local step handles])` | Groups already-declared local steps for display; unique ID |
| `value(json)` | Immutable JSON constant binding |
| `ref('inputs'\|'item'\|'iteration', [literal path segments])` | Reference binding to inputs, fan-out item, or iteration state |
| `ref(stepHandle, [segments])` | Reference binding to an earlier step's output |

`options` are plain literal objects using the existing definition option fields
(`dependsOn`, `fanout`, conditions as existing operator records, coding
configuration, and so on). `fanout.from` unwraps the `ref(...)` wrapper.
A `repeat` block must declare **both** `stateSchema` and `outputSchema` as
explicit options; shorthand such as `stateSchema` alone is rejected.
Step aliases (`const x = native(...); const y = x;`) are rejected: each handle
must be used under its declared name.

### Accepted literal forms

Only the following may appear in a script (and only as immutable data):

- finite decimal numeric literals matching
  `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, including fractional and
  exponent notation (`1.5`, `1e2`, `-2e-3`); no leading/trailing decimal dot,
  numeric separators, `Infinity`, `NaN`, hexadecimal/binary/octal or bigint
- strings, `null`, booleans
- dense arrays and plain literal objects (no holes, no duplicate keys)
- earlier immutable data constants declared with `const`

### Rejected syntax

Any of the following is a compile-time rejection with a bounded diagnostic:

- `import` / `export`, `await`, `async`
- function expressions outside the recognized zero-arg builder arrows
- operators, control-flow statements, `new`, `eval`, getters, spread,
  shorthand properties, computed keys, member traversal of values
- TypeScript-only syntax, JSX, template literals, regular expressions, bigint
- unsafe or duplicate object keys
- shadowing, reassignment, or step-handle aliasing
- nested `repeat` blocks

Semicolons are shown in examples; ordinary optional trailing semicolons are
accepted. The AST whitelist remains exact — accepted syntax is the set above,
nothing more.

### Example: accepted vs rejected

The accepted snippet below is an abridged illustration, not a complete script;
the complete, compile-verified public scripts live in
`workflow-script-examples.ts`.

```js
// Accepted shape (abridged; see the examples module for a full script)
workflow({ id: 'docs-parallel', label: 'Parallel review', inputSchema: s }, () => {
  const reviewA = native('review-a', { dependsOn: [], /* ... */ });
  const reviewB = native('review-b', { dependsOn: [], /* ... */ });
  const merged = aggregate('merge', { dependsOn: [reviewA, reviewB] });
  phase('review', [reviewA, reviewB]);
});
```

```js
// Rejected: expression logic, member traversal, async
workflow({ id: 'bad' }, () => {
  const n = native('n', { retries: 1 + 1 });          // operator
  const t = Date.now();                                // member traversal / call
  const s = await native('s', {});                     // await
});
```

### Dependencies, parallelism, joins, phases

- Every sequencing relationship is expressed with explicit `dependsOn` arrays
  on step handles. There is no separate scheduler or combinator owner.
- Independent ready steps may run in parallel, subject to the existing admission
  and concurrency limits; a step depending on several predecessors is a join.
- `phase(id, [handles])` declares display grouping: phase IDs are globally
  unique, membership is local-scope, each step belongs to at most one phase,
  and only steps declared earlier in the same scope may be members.

### Conditional repeat and feedback

This example is complete and was compile-verified against the frozen grammar;
`repeat` requires both explicit `stateSchema` and `outputSchema`:

```js
workflow({ id: 'bounded-fix', label: 'Bounded fix',
  inputSchema: { type: 'object', additionalProperties: false, required: ['target'],
    properties: { target: { type: 'string', maxLength: 512 } } } }, () => {
  const S = { type: 'object', additionalProperties: false, required: ['passed', 'notes'],
    properties: { passed: { type: 'boolean' }, notes: { type: 'string', maxLength: 512 } } };
  const fix = repeat('fix', {
    maxIterations: 3,
    initial: value({ passed: false, notes: '' }),
    stateSchema: S, outputSchema: S,
  }, () => {
    const attempt = native('attempt', {
      dependsOn: [], agentId: 'generalist', prompt: 'Inspect only; return schema JSON.',
      inputs: { priorNotes: ref('iteration', ['notes']) },
      outputSchema: S,
    });
    return {
      feedback: ref(attempt, []),
      until: { op: 'boolean', value: ref('iteration', ['passed']) },
      output: ref('iteration', []),
    };
  });
});
```

Semantics match the existing version-2 repeat graph exactly:

- The first iteration always runs from the validated `initial` state.
- `feedback` feeds the previous iteration's structured observation into the
  next one; `until` is an existing-operator condition over iteration state;
  `output` selects the final iteration value. `feedback` and `output` must be
  compatible with `stateSchema`/`outputSchema`; a path segment such as
  `ref('iteration', ['notes'])` is valid wherever the referenced field has a
  compatible type.
- A false condition at `maxIterations` is non-convergence, not success.
- Repeat bodies capture outer **data constants only**, never step handles;
  body steps depend only on explicit body-local handles.
- No nested `repeat`. Iterations are sequential and bounded.

### Coding steps

`coding(id, options)` supports only the five existing Stage 8B operations:
`investigate`, `stage-write`, `check`, `review`, `apply`, with the exact
existing literal policy object. Native options have no `model` override;
models resolve through existing agent definitions. There is no script approval
builder or supported `approved` flag. A script using coding steps compiles to a
version-3 definition; coding authority still comes only from trusted host
configuration and operator approvals — never from the script, its inputs or
its compilation.

The existing `workflow-coding-example.ts` policy shapes remain the reference
for what a coding policy object contains (capabilities, identity, scope,
manifest, bounds, check profiles). A script expresses that same existing chain
by declaring coding steps with an inline literal policy of exactly that shape;
the guide does not reproduce a runnable approval. Illustrative shape only —
not a runnable script:

```js
const review = coding('review', {
  dependsOn: [check],
  coding: { operation: 'review', policy: { /* literal, shape of workflow-coding-example.ts */ } },
});
```

## Inputs, schema, and agentId/model resolution

- `inputSchema` is the existing JSON schema for start inputs; it is validated
  at `workflows.start`, unchanged.
- Step `agentId` values name existing agents. Model and policy resolution
  happens at engine start against the current explicit agent configuration.
- Compilation does **not** resolve or certify model availability, and
  inspection does not certify runtime approval status.

## Explicit validate / compile / inspect / save / import — separate start

Compilation is always explicit. Nothing scans, watches, or auto-starts.

| Step | Meaning |
| --- | --- |
| `validate` | Parse and check only; returns a bounded summary, no graph |
| `compile` | Produces the canonical definition plus inspection (bounded) |
| `inspect` | Returns an already-saved frozen definition plus inspection, without parsing or service initialization |
| `save` | Compile, then the existing `workflows.define` (replaces a name only when its prior work is settled) |
| `import` | Explicit bounded read of one local regular file, then compile + define |

Public API:

```ts
compileWorkflowScript(source: string, options?: {
  sourceName?: string; signal?: AbortSignal;
}): Promise<{ ok: true; definition; inspection } | { ok: false; diagnostics }>;
inspectWorkflowScriptDefinition(definition): /* pure summary, no effects */;
```

Structured control actions (a separate `WorkflowScriptAction` union, distinct
from the scheduler `WorkflowAction`), routed before lazy service creation:

| Action | Payload |
| --- | --- |
| `workflows.scripts.validate` / `compile` / `save` | `{ source, sourceName? }` |
| `workflows.scripts.inspect` | `{ definitionId }` |
| `workflows.scripts.import` | `{ path }` |

Slash parity: `/clankers workflows scripts <validate|compile|inspect|save|import> <JSON>`; `/clank`, `/zerg`, `/zerg-swarm`, and `/swarm` remain aliases.
The original workflow aliases and commands are unchanged; there is no start
flag and no autostart on any script action. Import paths are normalized
relative to cwd; `..` components, absolute paths, backslashes, NUL, symlinks, and
non-regular files are rejected. Safe file import currently requires Linux
no-follow descriptor traversal and fails closed elsewhere; inline source
compilation does not require that file-import capability. Unknown action keys
are rejected early.

Return shapes: `validate` returns `{ inspection }` (no graph); `compile` and
`inspect` return `{ definition, inspection }`; `save` and `import` return
`{ saved, inspection }`. No action ever starts a workflow.

## Public examples

`workflow-script-examples.ts` exports the scripts
`READ_ONLY_PARALLEL_SCRIPT` and `CONDITIONAL_REFINEMENT_SCRIPT` (strings only;
importing the module compiles and starts nothing) plus equivalent graph
exports `READ_ONLY_PARALLEL_DEFINITION` and
`CONDITIONAL_REFINEMENT_DEFINITION` without authoring metadata. Example definition IDs are `read-only-parallel-review` (label
`Read-only parallel review`) and `bounded-conditional-refinement` (label
`Bounded conditional refinement`), declared in that module.

## Bounded parser and compile/runtime failure distinction

Pure compilation runs in an **owned, bounded parser subprocess**:

- Installed maintained TypeScript 5.9.3, used hermetically: one in-memory
  file (`ScriptKind.JS`), `noLib`/`noResolve`/no emit; it never resolves,
  imports, or reads project modules.
- The child is a non-persistent Node `.mjs` process: no shell, no inherited
  `execArgv`/`NODE_OPTIONS`/`NODE_PATH`, minimal owned environment, a
  256 MiB V8 old-generation heap cap (not a total-memory/RSS limit or OS sandbox),
  a 5000 ms total deadline, and abort/timeout/overflow kill + reap.
- Bounded budgets: source ≤ 65536 UTF-8 bytes; lexical depth ≤ 32, ≤ 8192
  tokens, decoded literal ≤ 16384; AST ≤ 12000 nodes, depth ≤ 64, and compiler
  work ≤ 100000 units. Child output is ≤ 65536 bytes, with host stdout/stderr
  transport limits of 131072/4096 bytes. Diagnostics are ≤ 8 × 256 characters,
  with known messages and source positions where available; source is not
  echoed by default. The shared parser admits 1 active + 4 queued jobs per
  loaded compiler module, with a bounded queue+run deadline and cleanup before
  reuse. Disposing one control owner cancels its own jobs, not another owner's.
  Parser failure is isolated from the host.
- The subprocess never runs submitted code, shell commands, approved checks, or
  agents. The host re-validates child output with the ordinary validator and
  conservatively rejects worst-case native **plus coding** admissions across
  all three attempts above the existing family cap of 256. Aggregate/repeat
  containers do not themselves consume native/coding admissions.

**Compile failures** (diagnostics): rejected syntax, unknown builders, bad
bindings, duplicate IDs, budget overruns. Nothing is saved or started.

**Runtime failures** are the existing workflow semantics: validation at
start, admission, attempt, check, review, approval, and recovery behavior are
unchanged by authoring via script.

## Provenance and invalidation

Compiled definitions carry `definition.authoring`
(`WorkflowScriptAuthoring`, format/language/compiler version 1):

| Field | Meaning |
| --- | --- |
| `parserVersion` | `'typescript@5.9.3'` |
| `sourceHash` | sha256 of the accepted raw UTF-8 source |
| `graphHash` | workflowHash of the validated definition **omitting** authoring |
| `sourceName` | sanitized bounded (128) display-only name, default `workflow.workflow.js` |
| `sourceBytes` / `sourceLength` | UTF-8 bytes / UTF-16 length, both ≤ 65536 |
| `steps` / `phases` | Step entries `{path, span}` and display groups `{id, paths, span}`; spans use 1-based lines, 0-based columns and UTF-16 offsets (start inclusive, end exclusive) |

Metadata is bounded (≤ 8192 bytes; full definition still ≤ 65536). The
existing full `definitionHash` binds authoring/source/compiler/location edits
and is used by unit, checkpoint, and recovery fingerprints; unsupported
versions fail as migration-required, and existing definitions without
authoring are unchanged.

Invalidation is **explicit only**:

- Unsaved edits and pure compiles never mutate a registered frozen definition.
- An explicit `save` or `import` replaces only a settled named definition and
  invalidates dependent plans via the namespace/hash change.
- Unseen external edits to a file on disk do **not** alter frozen imports or
  already-saved definitions; source metadata is provenance, not proof of
  external state. There are no filesystem watchers, no automatic discovery,
  no automatic recompilation, and no automatic restart authority.

## Preserved limitations

All previously documented workflow limitations remain in force, including the
Stage 8C recovery limits: settlement callbacks that cannot positively bind all
identity/input/dependency/policy fields must return `unknown` (result reuse is
not certified by inference); a zero-write run cannot be shortcut through a
blocked claim — it requires an explicit fresh-observation path or stays
blocked; and prepared ≠ checked ≠ reviewed ≠ approved ≠ applied. Recovery
remains inspect/prepare/authorize with fresh trusted authority; neither
scripting nor compilation adds restart, replay, or model-facing grant power.

The compile path performs no model calls; documentation examples that start
workflows require configured existing generalist/reviewer agents with explicit
provider/models at start, and example tests use a scripted native fake port
with no external providers.
