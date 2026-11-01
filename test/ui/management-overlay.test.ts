import assert from 'node:assert/strict';
import test from 'node:test';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import { sanitizeUiText } from '../../ui/components.js';
import { renderChatPane } from '../../ui/chat-pane.js';
import { renderDetailPane } from '../../ui/detail-pane.js';
import { renderManagementFooter } from '../../ui/footer.js';
import { renderSettingsPane, createSettingsPaneState } from '../../ui/settings-pane.js';
import { createManagementUiState } from '../../ui/state.js';
import { renderTreePane, createTreePaneState } from '../../ui/tree-pane.js';
import { createZergState, createZergStateContainer } from '../../state.js';
import type { StructuralPiCommandContext, ZergManagementTargetKind } from '../../types.js';
import { openZergManagementOverlay, ZergManagementOverlayComponent, type ZergManagementOverlayActions } from '../../ui/management-overlay.js';

test('M9 management overlay uses ctx.ui.custom component path and disposes subscription exactly once', () => {
  const container = createZergStateContainer();
  let requestRenderCount = 0;
  let doneCount = 0;
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void; invalidate(): void } | undefined;
  let optionsSeen: Record<string, unknown> | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };
  const context: StructuralPiCommandContext = {
    ui: {
      custom(factory, options) {
        optionsSeen = options as Record<string, unknown>;
        assert.equal(optionsSeen.overlay, true);
        component = (factory as (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: () => void) => typeof component)(
          { requestRender: () => { requestRenderCount += 1; } },
          undefined,
          undefined,
          () => { doneCount += 1; },
        );
        return { close: () => component?.dispose?.() };
      },
    },
  };

  openZergManagementOverlay(context, {
    getSnapshot: () => container.snapshot(),
    subscribe: (listener) => container.subscribe?.(listener) ?? (() => undefined),
    adapterKind: 'unavailable',
    actions,
  });

  assert.equal((optionsSeen?.overlayOptions as { title?: string } | undefined)?.title, 'clankers config');
  const initialRender = component?.render(100, 24).join('\n') ?? '';
  assert.ok(initialRender.includes('clankers config'));
  assert.ok(initialRender.includes('Use three steps'));
  assert.ok(initialRender.includes('1 Select'));
  assert.ok(initialRender.includes('2 Settings'));
  assert.ok(initialRender.includes('3 Message'));
  container.update({ metadata: { ...container.snapshot().metadata, updatedAt: '2026-05-01T00:00:01.000Z' } });
  assert.equal(requestRenderCount, 1);
  component?.handleInput?.('q');
  component?.dispose?.();
  assert.equal(doneCount, 1);
  const afterDispose = requestRenderCount;
  container.update({ metadata: { ...container.snapshot().metadata, updatedAt: '2026-05-01T00:00:02.000Z' } });
  assert.equal(requestRenderCount, afterDispose);
});

test('M9 management overlay preserves existing selected target and shows zerg control controller', async () => {
  const container = createZergStateContainer(createZergState({
    selectedNodeId: 'node-b',
    agents: {
      a: { id: 'a', label: 'Alpha', kind: 'subagent', status: 'idle' },
      b: { id: 'b', label: 'Beta', kind: 'subagent', status: 'running' },
    },
    tree: {
      'node-b': { id: 'node-b', label: 'Beta', kind: 'agent', refId: 'b', childIds: [] },
    },
    extensions: {
      zergControl: { controller: 'pi' },
    },
  }));
  let component: { render(width?: number, height?: number): string[]; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };

  void openZergManagementOverlay({
    ui: {
      custom(factory) {
        component = (factory as () => typeof component)();
        return undefined;
      },
    },
  }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  const rendered = component?.render(110, 24).join('\n') ?? '';
  assert.ok(rendered.includes('Controller pi'));
  assert.ok(rendered.includes('Selected: agent b'));
  assert.ok(rendered.includes('agent: Beta (b)'));
  assert.equal(rendered.includes('Selected: agent a'), false);
  component?.dispose?.();
});

test('M9 management overlay keeps tree navigation usable after default selection render', async () => {
  const container = createZergStateContainer(createZergState({
    agents: {
      a: { id: 'a', label: 'Alpha', kind: 'subagent', status: 'idle' },
      b: { id: 'b', label: 'Beta', kind: 'subagent', status: 'idle' },
    },
  }));
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };
  void openZergManagementOverlay({ ui: { custom(factory) { component = (factory as () => typeof component)(); return undefined; } } }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  component?.render(110, 24);
  component?.handleInput?.('down');
  component?.render(110, 24);
  component?.handleInput?.('enter');
  const rendered = component?.render(110, 24).join('\n') ?? '';
  assert.ok(rendered.includes('Selected: agent b'));
  component?.dispose?.();
});

test('M9 management overlay routes focus and chat keys through focused pane', () => {
  const container = createZergStateContainer({
    agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' } },
  });
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: () => 'selected target',
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: (_target, body) => ({ status: 'intervention-recorded', statusDetail: `intervention recorded: ${body}`, routedTargetId: 'worker' }),
  };
  openZergManagementOverlay({ ui: { custom(factory) { component = (factory as () => typeof component)(); return undefined; } } }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  component?.handleInput?.('down');
  component?.handleInput?.('down');
  component?.handleInput?.('enter');
  component?.handleInput?.('tab');
  component?.handleInput?.('tab');
  for (const char of 'remote rapid quorum') component?.handleInput?.(char);
  component?.handleInput?.('enter');
  const rendered = component?.render(110, 30).join('\n') ?? '';
  assert.ok(rendered.includes('intervention-recorded'));
  assert.ok(rendered.includes('remote rapid quorum'));
  assert.ok((component?.render(110) ?? []).length <= 32);
});

function codingManagementFixture(viewCoding?: (target: { id: string; kind: ZergManagementTargetKind } | undefined) => Promise<void>, onRender?: () => void, viewTimeline?: (target: { id: string; kind: ZergManagementTargetKind } | undefined) => Promise<void>) {
  const container = createZergStateContainer({ agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' } } });
  let mutations = 0;
  let renders = 0;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-10-02T00:00:00Z'),
    toggleReadOnly: () => { mutations += 1; return 'toggle'; },
    setAutomation: () => { mutations += 1; return 'mode'; },
    setController: () => { mutations += 1; return 'controller'; },
    approvePermission: () => { mutations += 1; return 'approve'; },
    denyPermission: () => { mutations += 1; return 'deny'; },
    selectTarget: () => 'selected', interruptSelected: () => { mutations += 1; return 'interrupt'; },
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'unavailable' }),
  };
  const component = new ZergManagementOverlayComponent({ requestRender: () => { renders += 1; onRender?.(); } }, undefined, undefined, {
    getSnapshot: () => container.snapshot(), subscribe: () => () => undefined, adapterKind: 'fake', actions, viewCoding, viewTimeline,
  });
  component.render(110, 30);
  return { component, get mutations() { return mutations; }, get renders() { return renders; } };
}
const codingTick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('coding view is separate from mutations, guards nested opens and preserves exact selected target', async () => {
  const targets: Array<{ id: string; kind: ZergManagementTargetKind } | undefined> = [];
  let finish: () => void = () => undefined;
  const f = codingManagementFixture((target) => { targets.push(target); return new Promise<void>((resolve) => { finish = resolve; }); });
  f.component.handleInput('v');
  f.component.handleInput('v');
  await codingTick();
  assert.deepEqual(targets, [{ id: 'worker', kind: 'agent' }]);
  assert.equal(f.mutations, 0);
  finish();
  await codingTick();
  assert.match(f.component.getStateForTests().statusMessage ?? '', /viewer closed/);
  f.component.handleInput('v');
  await codingTick();
  assert.equal(targets.length, 2);
  finish();
  await codingTick();
  f.component.dispose();
});

test('coding key only applies to tree/detail, remains chat text and leaves settings usable', async () => {
  let calls = 0;
  const f = codingManagementFixture(async () => { calls += 1; });
  f.component.handleInput('tab'); // settings
  f.component.handleInput('v');
  await codingTick();
  assert.equal(calls, 0);
  f.component.handleInput('tab'); // chat
  f.component.handleInput('v');
  assert.equal(f.component.getStateForTests().chatDraft, 'v');
  f.component.handleInput('tab'); // detail
  f.component.handleInput('v');
  await codingTick();
  assert.equal(calls, 1);
  f.component.handleInput('r');
  assert.equal(f.mutations, 1);
  assert.equal(f.component.getStateForTests().chatDraft, 'v');
  f.component.dispose();
});

test('coding callback synchronous/async failures are contained and retryable', async () => {
  for (const synchronous of [true, false]) {
    let calls = 0;
    const f = codingManagementFixture(() => { calls += 1; if (synchronous) throw new Error('host failure'); return Promise.reject(new Error('host failure')); });
    f.component.handleInput('v');
    await codingTick();
    assert.match(f.component.getStateForTests().statusMessage ?? '', /coding viewer unavailable: Error: host failure/);
    f.component.handleInput('v');
    await codingTick();
    assert.equal(calls, 2);
    f.component.handleInput('r');
    assert.equal(f.mutations, 1);
    f.component.dispose();
  }
  const absent = codingManagementFixture();
  absent.component.handleInput('v');
  assert.match(absent.component.getStateForTests().statusMessage ?? '', /coding viewer unavailable/);
  absent.component.dispose();
});

test('disposing management during nested viewer ignores late completion/failure', async () => {
  for (const reject of [true, false]) {
    let finish: (error?: Error) => void = () => undefined;
    const f = codingManagementFixture(() => new Promise<void>((resolve, rejectPromise) => { finish = (error) => error ? rejectPromise(error) : resolve(); }));
    f.component.handleInput('v');
    await codingTick();
    f.component.dispose();
    const before = f.renders;
    const status = f.component.getStateForTests().statusMessage;
    finish(reject ? new Error('late failure') : undefined);
    await codingTick();
    assert.equal(f.renders, before);
    assert.equal(f.component.getStateForTests().statusMessage, status);
  }
  let calls = 0;
  const immediate = codingManagementFixture(async () => { calls += 1; });
  immediate.component.handleInput('v');
  immediate.component.dispose();
  await codingTick();
  assert.equal(calls, 0);
});

test('nested coding management survives injected redraw throws without unhandled rejection', async () => {
  let calls = 0;
  const f = codingManagementFixture(async () => { calls += 1; }, () => { throw new Error('redraw failed'); });
  assert.doesNotThrow(() => f.component.handleInput('v'));
  await codingTick();
  assert.equal(calls, 1);
  assert.match(f.component.getStateForTests().statusMessage ?? '', /management redraw unavailable/);
  assert.doesNotThrow(() => f.component.handleInput('v'));
  await codingTick();
  assert.equal(calls, 2);
  f.component.dispose();
});

test('timeline t is read-only tree/detail navigation, shares open guard, preserves draft and scoped target', async () => {
  const targets: Array<{ id: string; kind: ZergManagementTargetKind } | undefined> = [];
  let finish: () => void = () => undefined; let coding = 0;
  const f = codingManagementFixture(async () => { coding++; }, undefined, (target) => { targets.push(target); return new Promise<void>((resolve) => { finish = resolve; }); });
  f.component.handleInput('t'); f.component.handleInput('t'); f.component.handleInput('v');
  await codingTick(); assert.deepEqual(targets, [{ id: 'worker', kind: 'agent' }]); assert.equal(coding, 0); assert.equal(f.mutations, 0);
  finish(); await codingTick(); assert.match(f.component.getStateForTests().statusMessage ?? '', /timeline viewer closed/);
  f.component.handleInput('tab'); f.component.handleInput('t'); await codingTick(); assert.equal(targets.length, 1);
  f.component.handleInput('tab'); f.component.handleInput('t'); assert.equal(f.component.getStateForTests().chatDraft, 't');
  f.component.handleInput('tab'); f.component.handleInput('t'); await codingTick(); assert.equal(targets.length, 2);
  finish(); await codingTick(); assert.equal(f.component.getStateForTests().chatDraft, 't'); assert.equal(f.mutations, 0); f.component.dispose();
});

test('timeline callback faults/absence/disposal never launch a fallback coding viewer', async () => {
  let coding = 0;
  const absent = codingManagementFixture(async () => { coding++; }); absent.component.handleInput('t');
  assert.match(absent.component.getStateForTests().statusMessage ?? '', /timeline viewer unavailable/); absent.component.dispose();
  for (const sync of [true, false]) {
    let calls = 0;
    const f = codingManagementFixture(async () => { coding++; }, undefined, () => { calls++; if (sync) throw new Error('timeline host failed'); return Promise.reject(new Error('timeline host failed')); });
    f.component.handleInput('t'); await codingTick(); assert.match(f.component.getStateForTests().statusMessage ?? '', /timeline viewer unavailable/);
    f.component.handleInput('t'); await codingTick(); assert.equal(calls, 2); f.component.dispose();
  }
  let calls = 0;
  const closed = codingManagementFixture(undefined, undefined, async () => { calls++; }); closed.component.handleInput('t'); closed.component.dispose();
  await codingTick(); assert.equal(calls, 0); assert.equal(coding, 0);
});

test('shared viewer callbacks keep options receiver and contain noncoercible thrown values/redraw failures', async () => {
  let coding = 0; let timeline = 0;
  const container = createZergStateContainer({ agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' } } });
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-10-03T00:00:00Z'), toggleReadOnly: () => '', setAutomation: () => '', setController: () => '', approvePermission: () => '', denyPermission: () => '', selectTarget: () => '', interruptSelected: () => '', sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: '' }),
  };
  const options = {
    marker: 'options-receiver', getSnapshot: () => container.snapshot(), subscribe: () => () => undefined, adapterKind: 'fake', actions,
    async viewCoding() { assert.equal(this.marker, 'options-receiver'); coding++; },
    async viewTimeline() { assert.equal(this.marker, 'options-receiver'); timeline++; },
  };
  const c = new ZergManagementOverlayComponent(undefined, undefined, undefined, options); c.render(110, 30);
  c.handleInput('v'); await codingTick(); c.handleInput('t'); await codingTick(); assert.equal(coding, 1); assert.equal(timeline, 1); c.dispose();
  for (const synchronous of [true, false]) {
    const nonText = Object.assign(Object.create(null), { toString: null });
    const f = codingManagementFixture(undefined, () => { throw nonText; }, () => { if (synchronous) throw nonText; return Promise.reject(nonText); });
    f.component.handleInput('t'); await codingTick(); assert.match(f.component.getStateForTests().statusMessage ?? '', /management redraw unavailable/); f.component.dispose();
    const visible = codingManagementFixture(undefined, undefined, () => { throw nonText; }); visible.component.handleInput('t'); await codingTick(); assert.match(visible.component.getStateForTests().statusMessage ?? '', /Unknown failure/); visible.component.dispose();
  }
});


function hardeningActions(): ZergManagementOverlayActions {
  return { now: () => new Date('2026-10-03T00:00:00Z'), toggleReadOnly: () => 'toggle', setAutomation: () => 'mode', setController: () => 'controller', approvePermission: () => 'approve', denyPermission: () => 'deny', selectTarget: () => 'select', interruptSelected: () => 'interrupt', sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'unavailable' }) };
}

test('management host sync/async failure disposes every observer and completes despite throwing cleanup', async () => {
  for (const sync of [true, false]) {
    let watchers = 0; let unsubs = 0; let done = 0; let renders = 0;
    let listener: () => void = () => undefined;
    let component: ZergManagementOverlayComponent | undefined;
    const error = Object.create(null);
    const promise = openZergManagementOverlay({ ui: { custom(factory) {
      component = (factory as (tui: { requestRender(): void }, theme: undefined, keys: undefined, done: () => void) => ZergManagementOverlayComponent)(
        { requestRender: () => { renders++; } }, undefined, undefined, () => { done++; throw error; });
      if (sync) throw error;
      return Promise.reject(error);
    } } }, {
      getSnapshot: () => createZergState(), subscribe: (next) => { watchers++; listener = next; return () => { watchers--; unsubs++; throw error; }; }, adapterKind: 'fake', actions: hardeningActions(),
    });
    await assert.rejects(promise);
    const before = renders; const state = component!.getStateForTests();
    listener(); component!.handleInput('r'); component!.dispose();
    assert.equal(watchers, 0); assert.equal(unsubs, 1); assert.equal(done, 1); assert.equal(renders, before);
    assert.deepEqual(component!.getStateForTests(), state);
  }
});

test('management subscribe failures are readable and cannot prevent close', () => {
  let done = 0;
  const c = new ZergManagementOverlayComponent(undefined, undefined, () => { done++; }, {
    getSnapshot: () => createZergState(), subscribe: () => { throw Object.create(null); }, adapterKind: 'fake', actions: hardeningActions(),
  });
  assert.match(c.render(180, 30).join('\n'), /Unknown failure/);
  c.dispose(); c.dispose(); assert.equal(done, 1);
});

test('management render honors narrow/tiny/Unicode geometry and retains normal Pi Input focus marker', () => {
  const state = createZergState({ agents: { a: { id: 'a', label: '界👩‍💻é', kind: 'subagent', status: 'running' } } });
  const c = new ZergManagementOverlayComponent({ terminal: { rows: 5 } }, undefined, undefined, {
    getSnapshot: () => state, subscribe: () => () => undefined, adapterKind: 'fake', actions: hardeningActions(),
  });
  for (const width of [1, 2, 10, 42, 71, 72, 100, 180, 512]) {
    for (const height of [1, 2, 5, 17, 18, 30, 80]) {
      const lines = c.render(width, height);
      assert.ok(lines.length <= height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), 'frame fits physical width');
    }
  }
  assert.ok(c.render(10).length <= 5);
  c.focused = true; c.handleInput('tab'); c.handleInput('tab'); c.handleInput('code界');
  assert.ok(c.render(180, 30).some((line) => line.includes(CURSOR_MARKER)), 'public Input IME marker preserved');
  assert.equal(c.getStateForTests().chatDraft, 'code界');
  c.render(10, 5); c.render(180, 30);
  assert.equal(c.getStateForTests().chatDraft, 'code界'); c.dispose();
});

test('retained malicious fields are bounded/sanitized before styling without stripping trusted Pi ANSI', () => {
  // Fake strings only: never send these controls to a terminal or print raw payloads in assertions.
  const attack = 'safe\x1b]52;c;FAKE_OSC\x07\x1b[2J\x9b2J\x9d8;;FAKE_C1\x9c\x1b_GFAKE_APC\x1b\\\nforged\rrow';
  const state = createZergState();
  state.agents[attack] = { id: attack, label: attack, kind: 'subagent', status: 'idle' };
  state.extensions.zergPermissions = { requests: [{ id: attack, kind: attack, summary: attack, status: 'pending', targetId: attack }] };
  state.extensions.zergLogs = { records: [{ id: attack, level: 'warn', source: attack, message: attack, agentId: attack }] };
  const ui = createManagementUiState(); ui.selectedTargetId = attack; ui.selectedTargetKind = 'agent'; ui.statusMessage = attack;
  ui.messages = [{ id: 'fake', targetId: attack, targetKind: 'agent', routedTargetId: attack, body: attack, status: 'queued-local', statusDetail: attack, createdAt: attack }];
  ui.chatDraft = attack;
  const theme = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
  const settings = createSettingsPaneState(); settings.confirmation = { action: 'approve', requestId: attack };
  const frames = [
    renderTreePane(state, ui, createTreePaneState(), 200, 40, theme),
    renderSettingsPane(state, ui, settings, attack, 200, 40, theme),
    renderChatPane(state, ui, 200, 40, undefined, theme),
    renderDetailPane(state, ui, 200, 40, theme),
    renderManagementFooter(state, ui, attack, 200, theme),
  ];
  ui.selectedTargetId = undefined; ui.selectedTargetKind = undefined;
  frames.push(renderDetailPane(state, ui, 200, 40, theme));
  for (const lines of frames) {
    assert.ok(lines.some((line) => line.includes('\x1b[32m')), 'trusted theme survives');
    for (const line of lines) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
      assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(plain), false, 'no terminal/control/newline instructions from retained fields');
      assert.equal(/FAKE_OSC|FAKE_C1|FAKE_APC/.test(plain), false, 'sequence payload removed');
      assert.ok(visibleWidth(line) <= 200);
    }
  }
  assert.ok(sanitizeUiText('x'.repeat(100000)).length <= 4096);
  assert.equal(sanitizeUiText(Object.create(null)), '');
  assert.equal(state.agents[attack]?.id, attack, 'display cleaning never rewrites identities');
});
