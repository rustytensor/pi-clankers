import assert from 'node:assert/strict';
import test from 'node:test';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import type { NativeTranscriptKey, NativeTranscriptReadHandle, NativeTranscriptSnapshot } from '../../native-transcript.js';
import type { NativeContinuationPrepare, NativeContinuationReview } from '../../native-continuation.js';
import type { ZergNativeSessionReference } from '../../types.js';
import { openZergAgentOverlay, sanitizeTranscriptText, ZergAgentOverlayComponent, type ZergAgentOverlayOptions, type ZergComposerReceipt, type ZergComposerState, type ZergOverlayComposer } from '../../ui/agent-overlay.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function reference(member = 'worker-a', parent = 'team-a'): ZergNativeSessionReference {
  return { schemaVersion: 1, parentRunId: parent, memberRunId: member, piSessionId: `pi-${parent}-${member}`, agentDefinitionId: 'same-definition', sessionFile: '/never-opened-by-ui', cwd: '/fixture', createdAt: '2026-10-02T00:00:00Z', attachment: 'attached' };
}
function snapshot(key: NativeTranscriptKey, patch: Partial<NativeTranscriptSnapshot> = {}): NativeTranscriptSnapshot {
  return { key, revision: 1, source: 'live', status: 'running', defaultLeafBasis: 'live', inspectedLeafId: 'tip', liveLeafId: 'tip', branches: [{ leafId: 'old-leaf', label: 'old branch' }, { leafId: 'tip', label: 'current branch' }], blocks: [{ id: 'a', kind: 'text', role: 'assistant', text: 'hello' }], truncated: false, droppedBlocks: 0, ...patch };
}
function fixture(refs = [reference()]) {
  let references = refs;
  let referenceListener: () => void = () => undefined;
  const opened: NativeTranscriptKey[] = [];
  const handles: Array<{ value: NativeTranscriptSnapshot; disposeCount: number; unsubscribeCount: number; readCount: number; selections: Array<{ leafId?: string | null } | undefined>; listener: () => void; signal?: AbortSignal }> = [];
  let renders = 0;
  let done = 0;
  let referenceUnsubscribes = 0;
  const options: ZergAgentOverlayOptions = {
    getReferences: () => references,
    subscribeReferences: (listener) => { referenceListener = listener; return () => { referenceUnsubscribes += 1; }; },
    open: async (key, options) => {
      opened.push(key);
      const state = { value: snapshot(key), disposeCount: 0, unsubscribeCount: 0, readCount: 0, selections: [] as Array<{ leafId?: string | null } | undefined>, listener: (() => undefined) as () => void, signal: options?.signal };
      handles.push(state);
      return { getSnapshot: (selection) => { state.readCount += 1; state.selections.push(selection); return { ...state.value, blocks: selection?.leafId === null ? [] : state.value.blocks, inspectedLeafId: selection?.leafId === null ? null : selection?.leafId ?? state.value.inspectedLeafId }; }, subscribe: (listener) => { state.listener = listener; return () => { state.unsubscribeCount += 1; }; }, dispose: () => { state.disposeCount += 1; } };
    },
  };
  const component = new ZergAgentOverlayComponent({ requestRender: () => { renders += 1; } }, undefined, () => { done += 1; }, options);
  component.render(180, 30); // A chooser action requires an actually displayed selection.
  return { component, options, opened, handles, get renders() { return renders; }, get done() { return done; }, get referenceUnsubscribes() { return referenceUnsubscribes; }, setReferences: (refs: ZergNativeSessionReference[]) => { references = refs; referenceListener(); }, referenceListener: () => referenceListener() };
}

test('coding chooser never implicitly chooses a leader; concurrent definitions use exact triples', async () => {
  const refs = [reference('leader'), reference('worker'), reference('worker', 'team-b')];
  const f = fixture(refs);
  assert.equal(f.opened.length, 0);
  assert.match(f.component.render(180, 20).join('\n'), /team-b/);
  f.component.handleInput('down');
  f.component.handleInput('down');
  f.component.render(180, 20);
  f.component.handleInput('enter');
  await tick();
  assert.deepEqual(f.opened, [{ parentRunId: 'team-b', memberRunId: 'worker', piSessionId: 'pi-team-b-worker' }]);
  f.component.handleInput('home');
  assert.match(f.component.render(100, 20).join('\n'), /parent run: team-b/);
  assert.match(f.component.render(100, 20).join('\n'), /Pi session: pi-team-b-worker/);
  f.component.dispose();
});

test('empty, removed and stale references are explicit and do not fall back', async () => {
  const f = fixture([]);
  f.component.handleInput('enter');
  assert.equal(f.opened.length, 0);
  assert.match(f.component.render(100, 20).join('\n'), /No native sessions/);
  f.setReferences([reference()]);
  f.component.render(100, 20);
  f.component.handleInput('enter');
  await tick();
  f.setReferences([reference('other')]);
  assert.match(f.component.render(100, 20).join('\n'), /no longer available/);
  assert.equal(f.handles[0]!.disposeCount, 1);
  assert.equal(f.opened.length, 1);
  f.component.dispose();
  let refs = [reference()];
  const stale = new ZergAgentOverlayComponent(undefined, undefined, undefined, { getReferences: () => refs, subscribeReferences: () => () => undefined, open: async () => { throw new Error('must not open stale'); } });
  stale.render(100, 20);
  refs = [];
  stale.handleInput('enter');
  await tick();
  assert.match(stale.render(100, 20).join('\n'), /Selected reference is stale/);
  stale.dispose();
});

test('raw branch inspection uses only handle selection; default leaf is not a navigation action', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  f.component.handleInput('b');
  assert.match(f.component.render(100, 20).join('\n'), /old branch/);
  f.component.handleInput('down');
  f.component.handleInput('enter');
  assert.deepEqual(f.handles[0]!.selections.at(-1), { leafId: 'old-leaf' });
  assert.equal(f.handles[0]!.value.liveLeafId, 'tip');
  assert.match(f.component.render(100, 20).join('\n'), /branch inspection/);
  f.handles[0]!.listener();
  assert.deepEqual(f.handles[0]!.selections.at(-1), { leafId: 'old-leaf' });
  f.component.handleInput('b');
  f.component.handleInput('enter');
  assert.deepEqual(f.handles[0]!.selections.at(-1), { leafId: undefined });
  assert.match(f.component.render(100, 20).join('\n'), /hello/);
  f.component.dispose();
});

test('streamed text/thinking/tool cards render IDs, arguments/results and raw context notices', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { blocks: [
    { id: 'thinking', kind: 'thinking', text: '[thinking signature omitted]\nreasoning' },
    { id: 'tool', kind: 'tool', text: 'read output', toolName: 'read', toolCallId: 'call-2', parentToolCallId: 'call-1', status: 'done', argumentsText: '{\n    "path": "x.ts"\n}', resultText: '    indented result\n[image omitted]' },
    { id: 'event', kind: 'event', text: 'compaction/context_edit notice' },
  ] });
  h.listener();
  f.component.handleInput('home');
  const output = f.component.render(140, 40).join('\n');
  for (const text of ['thinking', 'read output', 'tool call: call-2 · parent: call-1', 'arguments:', '    "path"', '    indented result', '[image omitted]', 'not effective model context', 'compaction/context_edit']) assert.ok(output.includes(text), text);
  f.component.dispose();
});

test('switch and close abort only viewer loads; late handles disposed and callbacks ignored', async () => {
  let referenceListener: () => void = () => undefined;
  const pending: Array<{ key: NativeTranscriptKey; signal?: AbortSignal; resolve(handle: NativeTranscriptReadHandle): void }> = [];
  const disposals = [0, 0];
  let subscriptions = 0;
  let done = 0;
  let renders = 0;
  const component = new ZergAgentOverlayComponent({ requestRender: () => { renders += 1; } }, undefined, () => { done += 1; }, {
    getReferences: () => [reference('a'), reference('b')],
    subscribeReferences: (listener) => { referenceListener = listener; return () => undefined; },
    open: (key, options) => new Promise((resolve) => { pending.push({ key, signal: options?.signal, resolve }); }),
  });
  component.render(180, 30);
  component.handleInput('enter');
  component.handleInput('s');
  component.handleInput('down');
  component.render(180, 30);
  component.handleInput('enter');
  assert.equal(pending[0]!.signal?.aborted, true);
  pending[0]!.resolve({ getSnapshot: () => snapshot(pending[0]!.key), subscribe: () => { subscriptions += 1; return () => undefined; }, dispose: () => { disposals[0]! += 1; } });
  await tick();
  assert.deepEqual(disposals, [1, 0]);
  assert.equal(subscriptions, 0);
  component.handleInput('q');
  component.dispose();
  assert.equal(done, 1);
  assert.equal(pending[1]!.signal?.aborted, true);
  pending[1]!.resolve({ getSnapshot: () => snapshot(pending[1]!.key), subscribe: () => { subscriptions += 1; return () => undefined; }, dispose: () => { disposals[1]! += 1; } });
  const before = renders;
  await tick();
  referenceListener();
  assert.deepEqual(disposals, [1, 1]);
  assert.equal(renders, before);
  assert.equal(subscriptions, 0);
});

test('close removes both watchers once and never receives a runner API', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  f.component.handleInput('s');
  assert.equal(f.handles[0]!.unsubscribeCount, 1);
  assert.equal(f.handles[0]!.disposeCount, 1);
  f.component.render(180, 30);
  f.component.handleInput('enter');
  await tick();
  f.component.dispose();
  f.component.dispose();
  const before = f.renders;
  f.handles[1]!.listener();
  f.referenceListener();
  assert.equal(f.renders, before);
  assert.equal(f.handles[1]!.unsubscribeCount, 1);
  assert.equal(f.handles[1]!.disposeCount, 1);
  assert.equal(f.referenceUnsubscribes, 1);
  assert.equal(f.done, 1);
});

test('failed open, identity mismatch and throwing observers cannot leak handles', async () => {
  for (const fault of ['open', 'snapshot', 'identity', 'subscribe']) {
    let disposed = 0;
    const component = new ZergAgentOverlayComponent(undefined, undefined, undefined, {
      getReferences: () => [reference()], subscribeReferences: () => () => { throw new Error('watcher'); },
      open: async (key) => {
        if (fault === 'open') throw new Error('missing transcript file');
        return { getSnapshot: () => { if (fault === 'snapshot') throw new Error('corrupt history'); return snapshot(fault === 'identity' ? reference('wrong') : key); }, subscribe: () => { if (fault === 'subscribe') throw new Error('observer unavailable'); return () => { throw new Error('unsubscribe'); }; }, dispose: () => { disposed += 1; throw new Error('cleanup'); } };
      },
    });
    component.render(180, 30);
    component.handleInput('enter');
    await tick();
    assert.match(component.render(120, 20).join('\n'), /unavailable/i, fault);
    component.dispose();
    component.dispose();
    assert.equal(disposed, fault === 'open' ? 0 : 1, fault);
  }
});

test('saved/unavailable/truncated are honest; missing file never reports live', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { source: 'saved', status: 'closed', defaultLeafBasis: 'recorded-tip', liveLeafId: null, diagnostic: 'saved raw history', truncated: true, droppedBlocks: 4 });
  h.listener();
  f.component.handleInput('home');
  assert.match(f.component.render(150, 30).join('\n'), /saved · closed/);
  assert.match(f.component.render(150, 30).join('\n'), /last recorded entry \(not proven active leaf\)/);
  assert.match(f.component.render(150, 30).join('\n'), /4 dropped blocks/);
  h.value = snapshot(h.value.key, { source: 'unavailable', status: 'unavailable', diagnostic: 'missing transcript file', blocks: [] });
  h.listener();
  assert.match(f.component.render(150, 30).join('\n'), /missing transcript file/);
  assert.match(f.component.render(150, 30).join('\n'), /unavailable · unavailable/);
  f.component.dispose();
});

test('user scroll pauses live follow; End follows again without changing branch', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value.blocks = [{ id: 'long', kind: 'text', text: Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n') }];
  h.listener();
  assert.match(f.component.render(100, 14).join('\n'), /line 69/);
  f.component.handleInput('home');
  const paused = f.component.render(100, 14).join('\n');
  h.value.blocks[0]!.text += '\nNEW TAIL';
  h.value.revision += 1;
  h.listener();
  assert.equal(f.component.render(100, 14).join('\n'), paused);
  f.component.handleInput('end');
  assert.match(f.component.render(100, 14).join('\n'), /NEW TAIL/);
  f.component.handleInput('pageup');
  assert.match(f.component.render(100, 14).join('\n'), /scroll paused/);
  f.component.dispose();
});

test('untrusted ANSI/OSC/C1/APC stripped; Unicode, indentation and narrow widths fit', async () => {
  assert.equal(sanitizeTranscriptText('\x1b]8;;https://evil\x07link\x1b]8;;\x07\x1b[31m red\x1b[0m\x1b[2J\x9b2J\x1b_Gimagebytes\x1b\\\x9d52;secret\x9c\x00\n\t界👩‍💻é'), 'link red\n    界👩‍💻é');
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  f.handles[0]!.value.blocks[0]!.text = '    界👩‍💻é\n\x1b]8;;bad\x07LINK\x1b]8;;\x07\n\x1b[2Jscreen';
  f.handles[0]!.listener();
  f.component.handleInput('home');
  for (const width of [1, 2, 3, 8, 21, 80]) {
    const lines = f.component.render(width, 60);
    assert.ok(lines.length <= 60);
    for (const line of lines) { assert.ok(visibleWidth(line) <= width, `${width}: ${line}`); assert.equal(line.replace(/\x1b\[[0-9;]*m/g, '').includes('\x1b'), false); } // Pi truncation inserts trusted SGR resets.
  }
  assert.match(f.component.render(80, 60).join('\n'), /    界👩‍💻é/);
  f.component.dispose();
});

test('formatted cache is single-width, bounded and invalidated for theme/revision changes', async () => {
  const f = fixture();
  let color = '31';
  let styles = 0;
  const component = new ZergAgentOverlayComponent(undefined, { fg: (_token, text) => { styles += 1; return `\x1b[${color}m${text}\x1b[0m`; } }, undefined, f.options);
  component.render(180, 30);
  component.handleInput('enter');
  await tick();
  component.handleInput('home');
  const first = component.render(80, 30);
  assert.ok(first.some((line) => line.includes('\x1b[31m')));
  const before = styles;
  component.render(80, 30);
  assert.equal(styles - before, 2); // only title/footer; transcript layout reused
  color = '32';
  component.invalidate();
  assert.ok(component.render(80, 30).some((line) => line.includes('\x1b[32m')));
  const h = f.handles.at(-1)!;
  h.value.blocks = Array.from({ length: 300 }, (_, i) => ({ id: `b-${i}`, kind: 'text', text: 'x\n'.repeat(40000) }));
  h.listener();
  assert.match(component.render(30, 40).join('\n'), /UI display truncated/);
  for (let width = 1; width < 60; width += 7) for (const line of component.render(width, 18)) assert.ok(visibleWidth(line) <= width);
  component.dispose();
  f.component.dispose();
});

test('public overlay awaits custom completion, exposes no composer and rejects absent TUI', async () => {
  const f = fixture();
  let component: ZergAgentOverlayComponent | undefined;
  let seen: unknown;
  let resolved = false;
  const promise = openZergAgentOverlay({ ui: { custom: (factory, options) => {
    seen = options;
    return new Promise<void>((resolve) => { component = (factory as (tui: undefined, theme: undefined, keys: undefined, done: () => void) => ZergAgentOverlayComponent)(undefined, undefined, undefined, resolve); });
  } } }, f.options).then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false);
  assert.equal((seen as { overlay: boolean }).overlay, true);
  assert.equal('minWidth' in (seen as { overlayOptions: object }).overlayOptions, false);
  assert.equal(component!.render(80).join('\n').includes('composer'), false);
  component!.handleInput('\x1b');
  await promise;
  assert.equal(resolved, true);
  await assert.rejects(openZergAgentOverlay({}, f.options), /interactive Pi TUI/);
  f.component.dispose();
});

test('detached captured output remains visible without implying live connection or persistence', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { source: 'captured', status: 'settled', diagnostic: 'live observation detached; captured output is not a persistence claim', blocks: [{ id: 'final', kind: 'text', text: 'FINAL CAPTURE' }] });
  h.listener();
  f.component.handleInput('home');
  const output = f.component.render(160, 30).join('\n');
  assert.match(output, /captured · settled/);
  assert.match(output, /not connected or proven saved/);
  assert.match(output, /FINAL CAPTURE/);
  h.value.status = 'unavailable';
  h.listener();
  assert.match(f.component.render(160, 30).join('\n'), /captured · unavailable/);
  assert.match(f.component.render(160, 30).join('\n'), /FINAL CAPTURE/);
  f.component.dispose();
});

test('branch Default restores live and saved history; null would mean before-root', async () => {
  for (const source of ['live', 'saved'] as const) {
    const f = fixture();
    f.component.handleInput('enter');
    await tick();
    const h = f.handles[0]!;
    h.value = snapshot(h.value.key, { source, status: source === 'live' ? 'running' : 'closed', defaultLeafBasis: source === 'live' ? 'live' : 'recorded-tip', blocks: [{ id: 'tip', kind: 'text', text: 'DEFAULT HISTORY' }] });
    h.listener();
    f.component.handleInput('b');
    f.component.handleInput('down');
    f.component.handleInput('enter');
    f.component.handleInput('b');
    f.component.handleInput('enter');
    assert.deepEqual(h.selections.at(-1), { leafId: undefined });
    assert.match(f.component.render(140, 30).join('\n'), /DEFAULT HISTORY/);
    f.component.dispose();
  }
});

test('throwing redraw callbacks are contained across async open, updates and close', async () => {
  const f = fixture();
  let done = 0;
  const component = new ZergAgentOverlayComponent({ requestRender: () => { throw new Error('host redraw'); } }, undefined, () => { done += 1; }, f.options);
  component.render(180, 30);
  assert.doesNotThrow(() => component.handleInput('enter'));
  await tick(); // An unhandled rejection here fails the Node test runner.
  const h = f.handles[0]!;
  assert.doesNotThrow(() => h.listener());
  assert.match(component.render(100, 30).join('\n'), /Viewer redraw unavailable/);
  assert.doesNotThrow(() => component.handleInput('s'));
  component.render(180, 30);
  component.handleInput('enter');
  await tick();
  assert.doesNotThrow(() => component.handleInput('q'));
  assert.equal(done, 1);
  assert.equal(f.handles.at(-1)!.disposeCount, 1);
  f.component.dispose();
});

test('public coding helper rejects RPC/print/JSON and hasUI=false even with custom stubs', async () => {
  const f = fixture();
  let customCalls = 0;
  for (const mode of ['rpc', 'print', 'json'] as const) {
    await assert.rejects(openZergAgentOverlay({ mode, hasUI: true, ui: { custom: () => { customCalls += 1; } } }, f.options), /interactive Pi TUI/);
  }
  await assert.rejects(openZergAgentOverlay({ mode: 'tui', hasUI: false, ui: { custom: () => { customCalls += 1; } } }, f.options), /interactive Pi TUI/);
  assert.equal(customCalls, 0);
  f.component.dispose();
});

test('chooser metadata and diagnostic newlines never escape a rendered terminal row', async () => {
  const ref = reference();
  ref.agentDefinitionId = 'label\nforged row';
  const f = fixture([ref]);
  for (const line of f.component.render(100, 20)) assert.equal(line.includes('\n'), false);
  f.options.open = async () => { throw new Error('missing\nforged row'); };
  f.component.handleInput('enter');
  await tick();
  for (const line of f.component.render(100, 20)) assert.equal(line.includes('\n'), false);
  f.component.dispose();
});


test('truncation notices reserve space without hiding retained tail or full identity at Home', async () => {
  const f = fixture();
  f.component.handleInput('enter');
  await tick();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { truncated: true, droppedBlocks: 3, blocks: [
    { id: 'long', kind: 'text', text: Array.from({ length: 3000 }, (_, i) => `TAIL-${i}`).join('\n') },
  ] });
  h.listener();
  const output = f.component.render(100, 14).join('\n');
  assert.match(output, /Transcript truncated/);
  assert.match(output, /UI display truncated/);
  assert.match(output, /TAIL-2040/); // Last retained line at the bounded 2048-line layout, not the unbounded input tail.
  assert.match(output, /q\/Esc close/);
  f.component.handleInput('home');
  assert.match(f.component.render(100, 14).join('\n'), /parent run: team-a/);
  for (const height of [4, 5, 6]) {
    const lines = f.component.render(100, height);
    assert.equal(lines.length, height);
    assert.match(lines.at(-1)!, /q\/Esc close/);
  }
  f.component.dispose();
});
function composerFixture() {
  const f = fixture([reference('a'), reference('b'), reference('a', 'team-b')]);
  const calls: Parameters<ZergOverlayComposer['send']>[0][] = [];
  const watchers: Array<{ key: NativeTranscriptKey; listener(): void; unsubscribed: number }> = [];
  let state: Omit<ZergComposerState, 'key'> = { canSend: true, allowedModes: ['steer', 'followUp'], persistence: 'memory', receipts: [] };
  const receipt = (request: Parameters<ZergOverlayComposer['send']>[0], patch: Partial<ZergComposerReceipt> = {}): ZergComposerReceipt => ({
    key: { ...request.key }, messageId: request.messageId, status: 'queued', detail: 'SDK queued; not consumed',
    createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', persistence: 'memory', ...patch,
  });
  const composer: ZergOverlayComposer = {
    getState: (key) => ({ ...state, key, receipts: state.receipts.filter((item) => item.key.parentRunId === key.parentRunId && item.key.memberRunId === key.memberRunId && item.key.piSessionId === key.piSessionId) }),
    subscribe: (key, listener) => { const watcher = { key, listener, unsubscribed: 0 }; watchers.push(watcher); return () => { watcher.unsubscribed += 1; }; },
    send: async (request) => { calls.push(request); const value = receipt(request); state.receipts.push(value); return { ok: true, message: 'Queued, not delivered.', receipt: value }; },
  };
  const component = new ZergAgentOverlayComponent({ terminal: { rows: 32 }, requestRender: () => undefined }, undefined, undefined, { ...f.options, composer });
  component.focused = true;
  component.render(180, 30);
  return { ...f, component, composer, calls, watchers, receipt, get state() { return state; }, setState(patch: Partial<Omit<ZergComposerState, 'key'>>) { state = { ...state, ...patch }; watchers.at(-1)?.listener(); },
    close() { component.dispose(); f.component.dispose(); } };
}
async function compose(f: ReturnType<typeof composerFixture>): Promise<void> {
  f.component.handleInput('enter');
  await tick();
  f.component.render(160, 24);
  f.component.handleInput('c');
}

test('optional composer uses public Editor, explicit exact-key send, multiline code and literal q/s/b', async () => {
  const f = composerFixture();
  assert.equal(f.calls.length, 0);
  await compose(f);
  f.component.handleInput('qsb');
  f.component.handleInput('\r'); // Plain Enter is a newline, never execute.
  f.component.handleInput('\x1b[200~    const x = "界👩‍💻é";\n    return x;\x1b[201~');
  assert.equal(f.calls.length, 0);
  assert.match(f.component.render(160, 24).join('\n'), /Ctrl\+s send/);
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.key, { parentRunId: 'team-a', memberRunId: 'a', piSessionId: 'pi-team-a-a' });
  assert.equal(f.calls[0]!.mode, 'followUp');
  assert.equal(f.calls[0]!.body, 'qsb\n    const x = "界👩‍💻é";\n    return x;');
  assert.match(f.calls[0]!.messageId, /^[0-9a-f-]{36}$/);
  const output = f.component.render(240, 24).join('\n');
  assert.match(output, /queued \(not delivered\)/);
  assert.match(output, /receipt memory only/);
  assert.match(output, /not provider acknowledgement\/completion/);
  assert.ok(output.includes(CURSOR_MARKER));
  f.close();
});

test('Escape leaves composer with draft retained; second Escape closes observers, never calls send', async () => {
  const f = composerFixture();
  await compose(f);
  f.component.handleInput('keep qsb');
  f.component.handleInput('\x1b');
  assert.equal(f.handles[0]!.disposeCount, 0);
  assert.equal(f.component.render(160, 24).join('\n').includes(CURSOR_MARKER), false);
  f.component.handleInput('c');
  assert.match(f.component.render(160, 24).join('\n'), /keep qsb/);
  f.component.handleInput('\x1b');
  f.component.handleInput('\x1b');
  assert.equal(f.handles[0]!.disposeCount, 1);
  assert.equal(f.watchers[0]!.unsubscribed, 1);
  assert.equal(f.calls.length, 0);
  f.close();
});

test('failed or unknown send preserves draft and attempt ID; changes to draft/mode create new attempt', async () => {
  const f = composerFixture();
  f.composer.send = async (request) => { f.calls.push(request); if (f.calls.length === 1) throw new Error('connection outcome unknown'); return { ok: false, message: 'Rejected: still streaming unavailable' }; };
  await compose(f);
  f.component.handleInput('    keep exact body');
  f.component.handleInput('\x13');
  await tick();
  assert.match(f.component.render(180, 24).join('\n'), /outcome unknown/);
  assert.match(f.component.render(180, 24).join('\n'), /keep exact body/);
  assert.equal(f.calls.length, 1);
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[1]!.messageId, f.calls[0]!.messageId);
  f.component.handleInput(' changed');
  f.component.handleInput('\x13');
  await tick();
  assert.notEqual(f.calls[2]!.messageId, f.calls[1]!.messageId);
  f.component.handleInput('\x1bm'); // Alt+m selects steer.
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[3]!.mode, 'steer');
  assert.notEqual(f.calls[3]!.messageId, f.calls[2]!.messageId);
  f.close();
});

test('in-flight sends are not duplicated and successful completion never clears later edits', async () => {
  const f = composerFixture();
  let resolve!: (value: Awaited<ReturnType<ZergOverlayComposer['send']>>) => void;
  f.composer.send = (request) => { f.calls.push(request); return new Promise((done) => { resolve = done; }); };
  await compose(f);
  f.component.handleInput('first');
  f.component.handleInput('\x13');
  f.component.handleInput('\x13');
  assert.equal(f.calls.length, 1);
  f.component.handleInput(' later');
  resolve({ ok: true, message: 'Queued', receipt: f.receipt(f.calls[0]!) });
  await tick();
  assert.match(f.component.render(160, 24).join('\n'), /first later/);
  f.component.handleInput('\x13');
  assert.equal(f.calls[1]!.body, 'first later');
  assert.notEqual(f.calls[1]!.messageId, f.calls[0]!.messageId);
  f.component.handleInput('\x1b');
  f.component.handleInput('s');
  f.component.handleInput('down');
  f.component.handleInput('down');
  f.component.render(180, 30);
  f.component.handleInput('enter');
  await tick();
  f.component.handleInput('c');
  f.component.handleInput('other exact session');
  resolve({ ok: true, message: 'LATE OLD RESPONSE', receipt: f.receipt(f.calls[1]!) });
  await tick();
  const output = f.component.render(160, 24).join('\n');
  assert.match(output, /other exact session/);
  assert.equal(output.includes('LATE OLD RESPONSE'), false);
  assert.equal(f.watchers[0]!.unsubscribed, 1);
  f.watchers[0]!.listener(); // stale callback must not overwrite current state
  f.component.handleInput('\x1b');
  f.component.handleInput('q');
  assert.equal(f.watchers.at(-1)!.unsubscribed, 1);
  f.close();
});

test('branch, saved, captured, terminal and backend readonly states disable sending; no fallback', async () => {
  const f = composerFixture();
  await compose(f);
  f.component.handleInput('retained draft');
  f.component.handleInput('\x1b');
  f.component.handleInput('b');
  f.component.handleInput('down');
  f.component.handleInput('enter');
  f.component.handleInput('c');
  assert.match(f.component.render(180, 24).join('\n'), /branch inspection is read-only/);
  f.component.handleInput('\x13');
  assert.equal(f.calls.length, 0);
  f.component.handleInput('b');
  f.component.handleInput('enter');
  f.component.handleInput('c');
  for (const patch of [{ source: 'saved' as const }, { source: 'captured' as const }, { source: 'unavailable' as const }, { status: 'settled' as const }]) {
    const h = f.handles[0]!;
    h.value = snapshot(h.value.key, patch); h.listener();
    f.component.handleInput('\x13');
    assert.equal(f.calls.length, 0);
    assert.match(f.component.render(180, 24).join('\n'), /only the running live default branch/);
  }
  f.handles[0]!.value = snapshot(f.handles[0]!.value.key); f.handles[0]!.listener();
  f.setState({ canSend: false, reason: 'Readonly task' });
  f.component.handleInput('\x13');
  assert.match(f.component.render(180, 24).join('\n'), /Readonly task/);
  assert.equal(f.calls.length, 0);
  f.close();
});

test('composer contains state/subscribe/send throws and mismatched exact receipt without inventing delivery', async () => {
  for (const fault of ['state', 'subscribe', 'send', 'key', 'id', 'status']) {
    const f = composerFixture();
    if (fault === 'state') f.composer.getState = () => { throw new Error('state boom'); };
    if (fault === 'subscribe') f.composer.subscribe = () => { throw new Error('subscribe boom'); };
    if (fault === 'send') f.composer.send = async () => { throw new Error('send boom'); };
    if (fault === 'key' || fault === 'id' || fault === 'status') f.composer.send = async (request) => ({ ok: true, message: 'MUST NOT ACCEPT', receipt: f.receipt(request, fault === 'key' ? { key: reference('wrong') } : fault === 'id' ? { messageId: 'wrong-id' } : { status: 'fake' as ZergComposerReceipt['status'] }) });
    await compose(f);
    f.component.handleInput('keep');
    f.component.handleInput('\x13');
    await tick();
    const output = f.component.render(240, 24).join('\n');
    assert.match(output, /unavailable|boom|mismatch/);
    assert.equal(output.includes('MUST NOT ACCEPT'), false);
    assert.equal(output.includes('delivered (native'), false);
    f.close();
  }
});

test('bounded safe paste admission preserves draft, whitespace and split bracketed paste; blank never sends', async () => {
  const f = composerFixture();
  await compose(f);
  f.component.handleInput('  ');
  f.component.handleInput('\x13');
  assert.equal(f.calls.length, 0);
  f.component.handleInput('\x1b[200~line1\r\n\tline2\x1b[20');
  f.component.handleInput('1~');
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[0]!.body, '  line1\n    line2');
  f.component.handleInput('keep');
  f.component.handleInput(`\x1b[200~${'x'.repeat(16385)}\x1b[201~`);
  assert.match(f.component.render(180, 24).join('\n'), /Paste rejected/);
  f.component.handleInput('\x1b[200~\x1b]52;clipboard\x07\x1b[201~');
  assert.match(f.component.render(180, 24).join('\n'), /Paste rejected/);
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[1]!.body, 'keep');
  f.component.handleInput(`\x1b[200~${'x'.repeat(16384)}\x1b[201~`);
  f.component.handleInput('y');
  assert.match(f.component.render(180, 24).join('\n'), /Draft input rejected/);
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[2]!.body.length, 16384);
  f.close();
});

test('composer layout keeps trusted IME cursor, safe receipts, retained tail and bounded narrow resize', async () => {
  const f = composerFixture();
  await compose(f);
  const h = f.handles[0]!;
  h.value.blocks = [{ id: 'tail', kind: 'text', text: Array.from({ length: 70 }, (_, index) => `tail ${index}`).join('\n') }]; h.listener();
  f.component.handleInput('\x1b[200~' + '    界👩‍💻é\n'.repeat(20) + '\x1b[201~');
  const key = h.value.key;
  f.setState({ receipts: Array.from({ length: 50 }, (_, index) => f.receipt({ key, messageId: `receipt-${index}`, body: '', mode: 'followUp' }, { status: index === 49 ? 'delivered' : 'queued', persistence: 'saved', detail: '\x1b]52;clipboard\x07detail\nforged row', body: 'HIDDEN BODY' } as Partial<ZergComposerReceipt>)), droppedReceipts: 2 });
  for (const width of [1, 2, 3, 8, 12, 21, 80, 240]) {
    for (const height of [4, 8, 10, 14, 24, 60]) {
      const lines = f.component.render(width, height);
      assert.ok(lines.length <= height);
      for (const line of lines) { assert.ok(visibleWidth(line) <= width); assert.equal(line.includes('\n'), false); assert.equal(line.includes('clipboard'), false); assert.equal(line.includes('HIDDEN BODY'), false); }
      if (width >= 12 && height >= 10) assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), `${width}x${height}`);
    }
  }
  assert.match(f.component.render(240, 24).join('\n'), /tail 69/);
  assert.match(f.component.render(240, 24).join('\n'), /omitted from view/);
  assert.match(f.component.render(240, 24).join('\n'), /not native transcript\/fsync/);
  f.component.focused = false;
  assert.equal(f.component.render(240, 24).join('\n').includes(CURSOR_MARKER), false);
  f.component.focused = true;
  f.component.invalidate();
  assert.ok(f.component.render(240, 24).join('\n').includes(CURSOR_MARKER));
  f.component.render(8, 8);
  f.component.handleInput('\x13');
  assert.equal(f.calls.length, 0);
  f.close();
});


test('ok alone, recorded-only, failed and needs-attention never clear draft or replace attempt ID', async () => {
  for (const status of ['missing', 'recorded', 'failed', 'needs-attention', 'queued', 'delivered'] as const) {
    const f = composerFixture();
    f.composer.send = async (request) => { f.calls.push(request); return { ok: true, message: 'Backend says accepted', receipt: status === 'missing' ? undefined : f.receipt(request, { status }) }; };
    await compose(f);
    f.component.handleInput('exact draft');
    f.component.handleInput('\x13');
    await tick();
    const output = f.component.render(180, 24).join('\n');
    if (status === 'queued' || status === 'delivered') assert.equal(output.includes('exact draft'), false);
    else {
      assert.match(output, /Send not confirmed/);
      assert.match(output, /exact draft/);
      f.component.handleInput('\x13');
      await tick();
      assert.equal(f.calls[0]!.messageId, f.calls[1]!.messageId);
    }
    assert.match(output, /raw history \+ explicit composer/);
    f.close();
  }
});

test('mixed prefix/paste packets visibly reject as a unit and never execute a control prefix', async () => {
  const f = composerFixture();
  await compose(f);
  f.component.handleInput('keep');
  for (const prefix of ['prefix', '\x13', 'qsb']) {
    f.component.handleInput(prefix + '\x1b[200~pasted code\x1b[201~');
    assert.match(f.component.render(180, 24).join('\n'), /Paste rejected: mixed prefix/);
    assert.equal(f.calls.length, 0);
  }
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[0]!.body, 'keep');
  f.component.handleInput('\x1b[200~line\r');
  f.component.handleInput('\n\tindent\x1b[201~');
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[1]!.body, 'line\n    indent');
  f.close();
});

test('selected mode survives empty or changing capabilities and unavailable selected mode cannot send', async () => {
  const f = composerFixture();
  await compose(f);
  f.component.handleInput('mode retained');
  f.component.handleInput('\x1bm');
  f.setState({ allowedModes: [] });
  f.component.handleInput('\x1bm'); // No allowed alternative: leave explicit steer selection unchanged.
  f.component.handleInput('\x13');
  assert.equal(f.calls.length, 0);
  assert.match(f.component.render(180, 24).join('\n'), /Composer steer/);
  f.setState({ allowedModes: ['followUp'] });
  f.component.handleInput('\x13');
  assert.equal(f.calls.length, 0);
  assert.match(f.component.render(180, 24).join('\n'), /selected mode steer unavailable/);
  f.setState({ allowedModes: ['steer'] });
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[0]!.mode, 'steer');
  f.close();
});

test('close while send is pending never aborts it and ignores late rejection/delivered watchers', async () => {
  const f = composerFixture();
  let reject!: (error: Error) => void;
  f.composer.send = (request) => { f.calls.push(request); return new Promise((_resolve, fail) => { reject = fail; }); };
  await compose(f);
  f.component.handleInput('pending body');
  f.component.handleInput('\x13');
  assert.equal('signal' in f.calls[0]!, false);
  f.component.handleInput('\x1b');
  f.component.handleInput('q');
  f.setState({ receipts: [f.receipt(f.calls[0]!, { status: 'delivered' })] });
  reject(new Error('LATE REJECTION'));
  await tick(); // No unhandled rejection or backend cancellation.
  assert.equal(f.calls.length, 1);
  assert.equal(f.watchers[0]!.unsubscribed, 1);
  assert.equal(f.handles[0]!.disposeCount, 1);
  assert.equal(f.component.render(180, 24).join('\n').includes('LATE REJECTION'), false);
  f.close();
});

test('composer rejects state identity mismatch and reference failures without opening another member', async () => {
  const f = composerFixture();
  f.composer.getState = (key) => ({ ...f.state, key: { ...key, memberRunId: 'wrong member' } });
  await compose(f);
  assert.match(f.component.render(180, 24).join('\n'), /Composer identity mismatch/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.opened.length, 1);
  f.composer.getState = (key) => ({ ...f.state, key });
  f.component.handleInput('c');
  f.component.handleInput('removed draft');
  f.setReferences([]);
  f.component.handleInput('\x13');
  assert.equal(f.calls.length, 0);
  assert.match(f.component.render(180, 24).join('\n'), /no longer available/);
  f.close();
});

test('public Editor history bound preserves middle-code cursor and permits explicit move-to-end recovery', async () => {
  const f = composerFixture();
  await compose(f);
  for (let index = 0; index < 256; index += 1) f.component.handleInput('x');
  f.component.handleInput('\x1b[D');
  f.component.handleInput('REJECTED');
  assert.match(f.component.render(180, 24).join('\n'), /Editing history limit/);
  f.component.handleInput('\x05'); // Configurable public Editor line-end action.
  f.component.handleInput('accepted');
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.calls[0]!.body, 'x'.repeat(256) + 'accepted');
  f.close();
});

test('rejected paste packets cannot erase rejection notices or insert their trailing suffix', async () => {
  const packets = [
    'lost-prefix\x1b[200~lost-paste\x1b[201~TRAIL',
    'lost-prefix\x1b[200~lost-paste\x1b[201~\x13',
    `\x1b[200~${'x'.repeat(16385)}\x1b[201~TRAIL`,
    '\x1b[200~bad\x1b[31m\x1b[201~TRAIL',
  ];
  for (const packet of packets) {
    const f = composerFixture();
    try {
      f.component.handleInput('enter'); await tick();
      f.component.render(120, 32);
      f.component.handleInput('c');
      f.component.handleInput('seed');
      f.component.handleInput(packet);
      const rendered = f.component.render(120, 32).join('\n');
      assert.match(rendered, /Paste rejected/);
      assert.doesNotMatch(rendered, /seedTRAIL/);
      assert.equal(f.calls.length, 0, 'packet suffix must never submit');
      f.component.handleInput('\x13'); await tick();
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]!.body, 'seed', 'whole rejected packet leaves original draft intact');
    } finally { f.close(); }
  }
});

test('explicit initialKey resolves full exact tuple beyond bounded chooser, revalidates, never defaults', async () => {
  const refs = Array.from({ length: 300 }, (_, index) => reference(`member-${index}`));
  const wanted = refs[299]!;
  const key = { parentRunId: wanted.parentRunId, memberRunId: wanted.memberRunId, piSessionId: wanted.piSessionId };
  const opened: NativeTranscriptKey[] = [];
  const component = new ZergAgentOverlayComponent(undefined, undefined, undefined, {
    initialKey: key, getReferences: () => refs, subscribeReferences: () => () => undefined,
    open: async (exact) => { opened.push(exact); return { getSnapshot: () => snapshot(exact), subscribe: () => () => undefined, dispose: () => undefined }; },
  });
  await tick();
  assert.deepEqual(opened, [key]);
  component.handleInput('home');
  assert.match(component.render(140, 24).join('\n'), /member-299/);
  component.dispose();
  for (const initialKey of [{ ...key, piSessionId: 'other' }, { ...key, memberRunId: 'bad\x1b[31m' }, { ...key, parentRunId: 'a'.repeat(257) }]) {
    const invalid = new ZergAgentOverlayComponent(undefined, undefined, undefined, {
      initialKey, getReferences: () => refs, subscribeReferences: () => () => undefined,
      open: async () => { throw new Error('must not open'); },
    });
    await tick(); invalid.handleInput('enter'); invalid.handleInput('s'); invalid.handleInput('enter');
    const text = invalid.render(140, 24).join('\n');
    assert.doesNotMatch(text, /Exact session chooser/);
    assert.match(text, /stale|Invalid exact/);
    invalid.dispose();
  }
  let reads = 0;
  const stale = new ZergAgentOverlayComponent(undefined, undefined, undefined, {
    initialKey: key, getReferences: () => ++reads === 1 ? refs : [], subscribeReferences: () => () => undefined,
    open: async () => { opened.push(key); throw new Error('must not open'); },
  });
  await tick(); assert.equal(opened.length, 1); assert.match(stale.render(140, 24).join('\n'), /stale/); stale.dispose();
});

test('explicit initialKey ambiguity and removal stay unavailable without chooser retargeting', async () => {
  const ref = reference(); let refs = [ref, { ...ref, agentDefinitionId: 'conflicting' }];
  let listener: () => void = () => undefined; let opens = 0;
  const options: ZergAgentOverlayOptions = {
    initialKey: ref, getReferences: () => refs, subscribeReferences: (next) => { listener = next; return () => undefined; },
    open: async (key) => { opens++; return { getSnapshot: () => snapshot(key), subscribe: () => () => undefined, dispose: () => undefined }; },
  };
  const ambiguous = new ZergAgentOverlayComponent(undefined, undefined, undefined, options);
  await tick(); assert.equal(opens, 0); assert.match(ambiguous.render(140, 24).join('\n'), /ambiguous/); ambiguous.dispose();
  refs = [ref]; const removed = new ZergAgentOverlayComponent(undefined, undefined, undefined, options);
  await tick(); refs = [reference('replacement')]; listener(); removed.handleInput('enter');
  assert.equal(opens, 1); assert.doesNotMatch(removed.render(140, 24).join('\n'), /Exact session chooser/); removed.dispose();
});

test('legacy no-initialKey read-only chooser retains canonical keys longer than timeline/message cap', async () => {
  const ref = reference('m'.repeat(600), 'parent-long');
  const f = fixture([ref]); f.component.handleInput('enter'); await tick();
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0]?.memberRunId, ref.memberRunId); assert.equal(f.opened[0]?.piSessionId, ref.piSessionId);
  f.component.handleInput('home'); assert.doesNotMatch(f.component.render(140, 30).join('\n'), /Invalid exact/); f.component.dispose();
});


function continuationFixture() {
  const ref = { ...reference(), attachment: 'disposed' as const, disposedAt: '2026-10-03T00:00:00Z' };
  const f = fixture([ref]);
  const prepares: NativeContinuationPrepare[] = [];
  const starts: Array<{ reviewId: string; confirm: true }> = [];
  const discards: string[] = [];
  let serviceDisposals = 0;
  const candidate = (request: NativeContinuationPrepare): NativeContinuationReview => ({ reviewId: 'review-viewer', expiresAt: new Date(Date.now() + 60000).toISOString(),
    key: { parentRunId: request.parentRunId, memberRunId: request.memberRunId, piSessionId: request.piSessionId }, entryId: request.entryId, body: request.body,
    sourceFingerprint: 'source-file-fingerprint', policyDigest: 'current-policy-digest', warnings: ['Normal Pi startup authority'], policy: { tools: ['read'], denies: ['write'], model: 'current-model', cwd: '/fixture', resources: 'normal Pi' } as unknown as NativeContinuationReview['policy'] });
  f.options.nativeContinuationService = {
    prepare: async (request) => { prepares.push(request); return candidate(request); },
    start: async (request) => { starts.push(request); return { runId: 'destination-run', taskId: 'destination-task' }; },
    discard: ({ reviewId }) => { discards.push(reviewId); }, dispose: () => { serviceDisposals++; },
  };
  f.component.focused = true;
  const saved = async () => {
    f.component.handleInput('enter'); await tick();
    const h = f.handles[0]!;
    h.value = snapshot(h.value.key, { source: 'saved', status: 'closed', defaultLeafBasis: 'recorded-tip', liveLeafId: null });
    h.listener();
    f.component.render(180, 40);
  };
  return { ...f, ref, prepares, starts, discards, candidate, saved, get serviceDisposals() { return serviceDisposals; } };
}

test('n is distinct from b inspection and c composer: saved exact inspected at-entry prepares a NEW task', async () => {
  const f = continuationFixture();
  await f.saved();
  f.component.handleInput('b');
  f.component.handleInput('down');
  f.component.handleInput('enter');
  f.component.render(180, 40);
  assert.deepEqual(f.handles[0]?.selections.at(-1), { leafId: 'old-leaf' });
  f.component.handleInput('n');
  const editing = f.component.render(180, 40).join('\n');
  assert.match(editing, /clankers NEW continuation/);
  assert.match(editing, /Selected entry \(at\): old-leaf/);
  assert.equal(f.prepares.length, 0);
  assert.equal(f.starts.length, 0);
  f.component.handleInput('qsb c n literal task');
  f.component.handleInput('\r'); await tick();
  assert.deepEqual(f.prepares, [{ parentRunId: 'team-a', memberRunId: 'worker-a', piSessionId: 'pi-team-a-worker-a', entryId: 'old-leaf', body: 'qsb c n literal task' }]);
  f.component.render(180, 60);
  f.component.handleInput('\r');
  assert.equal(f.starts.length, 0);
  f.component.handleInput('\x19'); await tick();
  assert.deepEqual(f.starts, [{ reviewId: 'review-viewer', confirm: true }]);
  assert.match(f.component.render(180, 40).join('\n'), /destination-run/);
  f.component.handleInput('\x1b');
  f.component.handleInput('home');
  const returned = f.component.render(180, 40).join('\n');
  assert.match(returned, /parent run: team-a/);
  assert.match(returned, /inspected leaf: old-leaf/);
  assert.doesNotMatch(returned, /destination-run/);
  assert.equal(f.opened.length, 1);
  f.component.dispose();
  assert.equal(f.serviceDisposals, 0);
});

test('n never selects unseen saved source after publication, ignored key or branch entry change', async () => {
  const f = continuationFixture();
  await f.saved();
  const h = f.handles[0]!;
  h.value = { ...h.value, revision: 2, inspectedLeafId: 'UNSEEN-entry' };
  h.listener(); // Publication requests redraw, but no frame has yet been rendered.
  f.component.handleInput('ignored-key');
  f.component.handleInput('n');
  assert.match(f.component.render(180, 40).join('\n'), /NEW continuation disabled/);
  assert.equal(f.prepares.length, 0);
  f.component.handleInput('b');
  f.component.handleInput('down');
  f.component.handleInput('enter'); // old-leaf selected, not yet rendered.
  f.component.handleInput('n');
  assert.match(f.component.render(180, 40).join('\n'), /NEW continuation disabled/);
  assert.equal(f.prepares.length, 0);
  f.component.handleInput('n');
  assert.match(f.component.render(180, 40).join('\n'), /Selected entry \(at\): old-leaf/);
  f.component.dispose();
});

test('n disabled live/attached, missing inspected entry, service absent and ambiguous source; no fallback', async () => {
  const f = continuationFixture();
  f.component.handleInput('enter'); await tick();
  f.component.render(180, 40);
  f.component.handleInput('n');
  assert.match(f.component.render(180, 40).join('\n'), /NEW continuation disabled/);
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { source: 'saved', status: 'closed', inspectedLeafId: null }); h.listener();
  f.component.render(180, 40); f.component.handleInput('n');
  assert.match(f.component.render(180, 40).join('\n'), /NEW continuation disabled/);
  h.value.inspectedLeafId = 'tip'; h.listener();
  f.setReferences([{ ...f.ref, attachment: 'attached' }]);
  f.component.render(180, 40); f.component.handleInput('n');
  assert.match(f.component.render(180, 40).join('\n'), /NEW continuation disabled/);
  f.setReferences([f.ref, { ...f.ref, agentDefinitionId: 'duplicate' }]);
  f.component.render(180, 40); f.component.handleInput('n');
  assert.match(f.component.render(180, 40).join('\n'), /NEW continuation disabled/);
  assert.equal(f.prepares.length, 0);
  assert.equal(f.starts.length, 0);
  f.component.dispose();
  const legacy = fixture(); legacy.component.handleInput('n');
  assert.equal(legacy.opened.length, 0); legacy.component.dispose();
});

test('source reference/attachment/definition changes invalidate visible token before confirm', async () => {
  for (const change of ['definition', 'attachment', 'revision', 'removed']) {
    const f = continuationFixture(); await f.saved();
    f.component.handleInput('n'); f.component.render(180, 40);
    f.component.handleInput('NEW task'); f.component.handleInput('\r'); await tick();
    f.component.render(180, 60);
    if (change === 'definition') f.setReferences([{ ...f.ref, agentDefinitionId: 'changed-definition' }]);
    if (change === 'attachment') f.setReferences([{ ...f.ref, attachment: 'attached' }]);
    if (change === 'removed') f.setReferences([]);
    if (change === 'revision') { f.handles[0]!.value.revision++; f.handles[0]!.listener(); }
    f.component.handleInput('\x19');
    assert.equal(f.starts.length, 0, change);
    assert.deepEqual(f.discards, ['review-viewer'], change);
    f.component.dispose();
  }
});

test('unavailable canonical attachment requires explicit source-copy acknowledgement', async () => {
  const f = continuationFixture(); await f.saved();
  const h = f.handles[0]!;
  h.value = snapshot(h.value.key, { source: 'unavailable', status: 'unavailable', inspectedLeafId: 'saved-known-entry', diagnostic: 'Live attachment unavailable', blocks: [] }); h.listener();
  f.setReferences([{ ...f.ref, attachment: 'unavailable', recoveredAt: '2026-10-03T00:00:00Z' }]);
  f.component.render(180, 40); f.component.handleInput('n');
  f.component.render(180, 40); f.component.handleInput('NEW recovery task'); f.component.handleInput('\r'); await tick();
  assert.equal(f.prepares.length, 0);
  f.component.handleInput('\x1ba'); f.component.handleInput('\r'); await tick();
  assert.equal(f.prepares[0]?.entryId, 'saved-known-entry');
  assert.equal(f.prepares[0]?.acknowledgeUnconfirmedSource, true);
  assert.equal(f.starts.length, 0);
  assert.match(f.component.render(180, 60).join('\n'), /not proof of closure/);
  f.component.dispose();
});

test('continuation Escape retains original viewer; late prepares are discarded without new runs', async () => {
  const f = continuationFixture(); await f.saved();
  let resolve!: (value: NativeContinuationReview) => void;
  f.options.nativeContinuationService!.prepare = (request) => { f.prepares.push(request); return new Promise((done) => { resolve = done; }); };
  f.component.handleInput('n'); f.component.render(180, 40);
  f.component.handleInput('new draft'); f.component.handleInput('\r');
  f.component.handleInput('\x1b');
  assert.equal(f.handles[0]?.disposeCount, 0);
  assert.match(f.component.render(180, 40).join('\n'), /saved · closed/);
  resolve(f.candidate(f.prepares[0]!)); await tick();
  assert.deepEqual(f.discards, ['review-viewer']);
  assert.equal(f.starts.length, 0);
  assert.equal(f.opened.length, 1);
  f.component.dispose();
});


test('service-present live viewer preserves b inspection and c send; typed n remains composer body', async () => {
  const f = composerFixture();
  let continuationCalls = 0;
  const component = new ZergAgentOverlayComponent({ terminal: { rows: 40 }, requestRender: () => undefined }, undefined, undefined, {
    ...f.options, composer: f.composer,
    nativeContinuationService: {
      prepare: async () => { continuationCalls++; throw new Error('must not prepare live source'); },
      start: async () => { continuationCalls++; throw new Error('must not start from n'); },
      discard: () => undefined, dispose: () => undefined,
    },
  });
  component.focused = true;
  component.render(180, 40);
  component.handleInput('enter'); await tick();
  component.render(180, 40); component.handleInput('n');
  assert.match(component.render(180, 40).join('\n'), /NEW continuation disabled/);
  component.handleInput('c');
  component.handleInput('n');
  component.handleInput('\r'); // Existing composer still inserts newline, never prepares.
  component.handleInput('b c q s');
  component.handleInput('\x13'); await tick();
  assert.equal(continuationCalls, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.body, 'n\nb c q s');
  component.handleInput('\x1b');
  component.handleInput('b'); component.handleInput('down'); component.handleInput('enter');
  component.handleInput('c');
  assert.match(component.render(180, 40).join('\n'), /branch inspection is read-only/);
  assert.equal(continuationCalls, 0);
  assert.equal(f.calls.length, 1);
  component.dispose(); f.close();
});

test('captured and recovered displays preserve confirmed disposed closure without acknowledgement', async () => {
  for (const kind of ['captured', 'recovered']) {
    const f = continuationFixture();
    await f.saved();
    if (kind === 'captured') {
      const h = f.handles[0]!;
      h.value = { ...h.value, source: 'captured' };
      h.listener();
    } else f.setReferences([{ ...f.ref, recoveredAt: '2026-10-03T00:00:00Z' }]);
    f.component.render(180, 40);
    f.component.handleInput('n');
    const editing = f.component.render(180, 40).join('\n');
    assert.match(editing, /Unconfirmed source-copy acknowledgment: not required/, kind);
    assert.doesNotMatch(editing, /REQUIRED: Alt\+a/, kind);
    f.component.handleInput(`NEW ${kind} task`);
    f.component.handleInput('\r'); await tick();
    assert.equal(f.prepares.length, 1, kind);
    assert.equal(f.prepares[0]?.acknowledgeUnconfirmedSource, undefined, kind);
    assert.equal(f.prepares[0]?.body, `NEW ${kind} task`, kind);
    assert.equal(f.starts.length, 0, kind);
    f.component.dispose();
  }
});


test('chooser only opens the last rendered selected tuple, never an unseen replacement or navigation', async () => {
  const f = fixture([reference('a'), reference('b')]);
  f.setReferences([reference('replacement'), reference('b')]);
  f.component.handleInput('ignored-key');
  f.component.handleInput('enter'); await tick();
  assert.equal(f.opened.length, 0);
  assert.match(f.component.render(180, 30).join('\n'), /stale or not yet displayed/);
  f.component.handleInput('down');
  f.component.handleInput('enter'); await tick();
  assert.equal(f.opened.length, 0, 'moving a cursor does not prove a new selected frame');
  f.component.render(180, 30);
  f.setReferences([reference('b'), reference('replacement')]);
  f.component.handleInput('enter'); await tick();
  assert.equal(f.opened.length, 0, 'reordered selected index requires a new frame');
  f.component.render(180, 2);
  f.component.handleInput('enter'); await tick();
  assert.equal(f.opened.length, 0, 'clipped-away choice is not displayed');
  f.component.render(180, 30);
  f.component.handleInput('enter'); await tick();
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0]?.memberRunId, 'b');
  f.component.dispose();
});

test('noncoercible reference/open/snapshot/composer failures are contained and readable', async () => {
  const faults: unknown[] = [Object.create(null), { toString() { throw new Error('coercion forbidden'); } },
    Object.defineProperty(new Error(), 'message', { get() { throw new Error('message forbidden'); } })];
  for (const error of faults) {
    for (const fault of ['references', 'referenceSubscribe', 'open', 'snapshot']) {
      let done = 0;
      const c = new ZergAgentOverlayComponent(undefined, undefined, () => { done++; }, {
        getReferences: () => { if (fault === 'references') throw error; return [reference()]; },
        subscribeReferences: () => { if (fault === 'referenceSubscribe') throw error; return () => undefined; },
        open: async (key) => { if (fault === 'open') throw error; return { getSnapshot: () => { throw error; }, subscribe: () => () => undefined, dispose: () => undefined }; },
      });
      assert.doesNotThrow(() => c.render(180, 30));
      if (fault === 'open' || fault === 'snapshot') { c.handleInput('enter'); await tick(); }
      assert.match(c.render(180, 30).join('\n'), /Unknown failure/);
      c.dispose(); assert.equal(done, 1);
    }
    for (const fault of ['state', 'subscribe', 'send']) {
      const f = composerFixture();
      if (fault === 'state') f.composer.getState = () => { throw error; };
      if (fault === 'subscribe') f.composer.subscribe = () => { throw error; };
      if (fault === 'send') f.composer.send = async () => { throw error; };
      await compose(f);
      f.component.handleInput('retained body'); f.component.handleInput('\x13'); await tick();
      assert.match(f.component.render(240, 30).join('\n'), /Unknown failure/);
      f.close();
    }
  }
});

test('coding custom host sync throw and async rejection release watchers and finish even if cleanup throws', async () => {
  for (const sync of [true, false]) {
    let watchers = 0; let done = 0; let unsubs = 0; let renders = 0;
    let listener: () => void = () => undefined;
    const error = Object.create(null);
    const promise = openZergAgentOverlay({ ui: { custom(factory) {
      (factory as (tui: { requestRender(): void }, theme: undefined, keys: undefined, done: () => void) => ZergAgentOverlayComponent)(
        { requestRender: () => { renders++; } }, undefined, undefined, () => { done++; throw error; });
      if (sync) throw error;
      return Promise.reject(error);
    } } }, {
      getReferences: () => [reference()], subscribeReferences: (next) => { watchers++; listener = next; return () => { watchers--; unsubs++; throw error; }; },
      open: async () => { throw new Error('must not open'); },
    });
    await assert.rejects(promise);
    const before = renders; listener();
    assert.equal(watchers, 0); assert.equal(unsubs, 1); assert.equal(done, 1); assert.equal(renders, before);
  }
});
