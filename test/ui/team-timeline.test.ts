import assert from 'node:assert/strict';
import test from 'node:test';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import type { StructuralPiCommandContext, ClankersSessionMessageKey, ClankersTimelineEntry, ClankersTimelineFilter, ClankersTimelineSnapshot } from '../../types.js';
import { openClankersTeamTimeline, ClankersTeamTimelineComponent, type ClankersTeamTimelineOptions } from '../../ui/team-timeline.js';
const key = { parentRunId: 'parent-a', memberRunId: 'member-a', piSessionId: 'pi-a' };
const row = (id: string, patch: Partial<ClankersTimelineEntry> = {}): ClankersTimelineEntry => ({
  id, kind: 'operator-receipt', timestamp: '2026-10-03T00:00:00Z', timestampMeaning: 'created',
  summary: id, bodyPreview: `body ${id}`, clipped: false, teamId: 'team-a', ...key, exactKey: { ...key },
  messageId: `msg-${id}`, mode: 'followUp', status: 'queued', persistence: 'memory', updatedAt: '2026-10-03T00:00:01Z', ...patch,
} as ClankersTimelineEntry);
function snap(entries: ClankersTimelineEntry[], filter: ClankersTimelineFilter = {}): ClankersTimelineSnapshot {
  return { schemaVersion: 1, revision: 1, filter, entries, omittedEntries: 0, clippedEntries: 0, limitations: ['retained sources only; unknown completeness'] };
}
function fixture(initial = [row('a'), row('b')], patch: Partial<ClankersTeamTimelineOptions> = {}) {
  let rows = initial; let listener: () => void = () => undefined; let reads = 0; let renders = 0; let unsubscribed = 0; let done = 0; let result: unknown;
  const filters: ClankersTimelineFilter[] = [];
  const options: ClankersTeamTimelineOptions = {
    getSnapshot: (filter) => { reads++; filters.push(filter); return snap(rows.filter((entry) => ['teamId', 'parentRunId', 'memberRunId', 'piSessionId'].every((field) => filter[field as keyof ClankersTimelineFilter] === undefined || filter[field as keyof ClankersTimelineFilter] === entry[field as keyof ClankersTimelineEntry])), filter); },
    subscribe: (next) => { listener = next; return () => { unsubscribed++; }; }, viewCoding: async () => undefined, ...patch,
  };
  const component = new ClankersTeamTimelineComponent({ requestRender: () => { renders++; } }, undefined, (value) => { done++; result = value; }, options);
  return { component, options, filters, update: (next: ClankersTimelineEntry[]) => { rows = next; listener(); }, late: () => listener(),
    get reads() { return reads; }, get renders() { return renders; }, get done() { return done; }, get result() { return result as { key: ClankersSessionMessageKey; state: { selectedId?: string; filter: ClankersTimelineFilter; follow: boolean; detail: boolean } } | undefined; }, get unsubscribed() { return unsubscribed; } };
}
const out = (component: ClankersTeamTimelineComponent, width = 180, height = 30) => component.render(width, height).join('\n');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('timeline distinguishes receipt/output/events/current snapshots and unknown time with full scrollable identity', () => {
  const f = fixture([row('receipt', { piSessionId: 'p'.repeat(256), exactKey: { ...key, piSessionId: 'p'.repeat(256) } }),
    row('output', { kind: 'native-output', source: 'log', sourceId: 'log-1', timestamp: undefined }),
    row('event', { kind: 'recorded-event', source: 'lifecycle', sourceId: 'e' }), row('snapshot', { kind: 'member-snapshot', status: 'done' })]);
  const text = out(f.component);
  for (const match of ['receipt queued/memory', 'output NOT reply', 'UNKNOWN TIME', 'recorded event', 'member current snapshot', 'retained sources only']) assert.ok(text.includes(match), match);
  f.component.handleInput('home'); f.component.handleInput('enter');
  const detail = out(f.component, 400, 40);
  for (const match of ['row id: receipt', 'messageId: msg-receipt', 'parentRunId: parent-a', 'memberRunId: member-a', `piSessionId: ${'p'.repeat(256)}`, 'persistence: memory', 'native consumed']) assert.ok(detail.includes(match), match);
  f.component.dispose();
});

test('exact four-field AND form uses public Input, unknown stays empty, Esc cancels, blanks explicitly clear', () => {
  const f = fixture(); f.component.focused = true; f.component.handleInput('f');
  assert.ok(out(f.component).includes(CURSOR_MARKER));
  for (const [index, value] of ['team-a', 'parent-a', 'member-a', 'pi-a'].entries()) { f.component.handleInput(value); if (index < 3) f.component.handleInput('tab'); }
  f.component.handleInput('enter'); out(f.component);
  assert.deepEqual(f.filters.at(-1), { teamId: 'team-a', parentRunId: 'parent-a', memberRunId: 'member-a', piSessionId: 'pi-a' });
  f.component.handleInput('f'); f.component.handleInput('unknown'); f.component.handleInput('escape'); out(f.component);
  assert.equal(f.filters.at(-1)?.teamId, 'team-a');
  f.component.handleInput('f'); for (let i = 0; i < 6; i++) f.component.handleInput('backspace'); f.component.handleInput('unknown'); f.component.handleInput('enter');
  assert.match(out(f.component), /No matching timeline entries. No fallback/);
  f.component.handleInput('f'); for (let field = 0; field < 4; field++) { f.component.handleInput('\x15'); f.component.handleInput('tab'); }
  f.component.handleInput('enter'); out(f.component); assert.deepEqual(f.filters.at(-1), {}); f.component.dispose();
});

test('invalid/oversized/control filter packets and paste suffixes cannot apply/change scope or execute shortcuts', () => {
  const f = fixture(); out(f.component); f.component.handleInput('f');
  for (const packet of ['a'.repeat(257), 'with space', '\x1b]52;c;evil\x07enter', 'prefix\x1b[200~bad\x1b[201~\r']) {
    f.component.handleInput(packet); assert.match(out(f.component), /rejected/); assert.equal(f.done, 0);
  }
  f.component.handleInput('enter'); out(f.component); assert.deepEqual(f.filters.at(-1), {});
  f.component.handleInput('\x1b[200~q'); f.component.handleInput('v\x1b[201~q'); assert.equal(f.done, 0);
  f.component.handleInput('v\x1b[Aq'); assert.equal(f.done, 0); f.component.handleInput('enter');
  f.component.handleInput('f'); f.component.handleInput('escape'); f.component.dispose();
});

test('malformed initial filter fails closed; explicit form apply needed before any broad projection', () => {
  const f = fixture(undefined, { initialFilter: { memberRunId: 'bad id' } }); assert.match(out(f.component), /Invalid exact|Invalid initial/); assert.equal(f.reads, 0);
  f.component.handleInput('v'); assert.equal(f.done, 0);
  f.component.handleInput('f'); f.component.handleInput('enter'); out(f.component); assert.ok(f.reads > 0); f.component.dispose();
});

test('tail follows; paused selection uses stable ID across same-revision changes, missing row clears target', () => {
  const f = fixture(); assert.match(out(f.component), /follow tail/);
  f.component.handleInput('home'); f.component.handleInput('enter');
  f.update([row('new'), row('a', { status: 'delivered' }), row('b')]);
  assert.match(out(f.component), /row id: a/); assert.match(out(f.component), /delivered/);
  f.update([row('new'), row('b')]); assert.match(out(f.component), /missing\/evicted/);
  f.component.handleInput('v'); assert.equal(f.result, undefined);
  f.component.handleInput('end'); assert.match(out(f.component), /row id: b/); f.component.dispose();
});

test('drilldown rereads exact current row, rejects stale replacement or unproven row', () => {
  let reads = 0;
  const f = fixture([row('a')], { getSnapshot: () => snap([++reads === 1 ? row('a') : row('a', { memberRunId: 'other', exactKey: { ...key, memberRunId: 'other' } })]) });
  out(f.component); f.component.handleInput('v'); assert.equal(f.done, 0); assert.match(out(f.component), /changed\/missing/); f.component.dispose();
  const unlinked = fixture([row('a', { exactKey: undefined })]); out(unlinked.component); unlinked.component.handleInput('v'); assert.equal(unlinked.done, 0); assert.match(out(unlinked.component), /No proven exact/); unlinked.component.dispose();
});

test('duplicate IDs withheld, mismatched key cannot drill, filter mismatch never broadens', () => {
  const duplicate = fixture([row('same'), row('same', { memberRunId: 'other' })]); assert.match(out(duplicate.component), /duplicate rows withheld/); duplicate.component.handleInput('v'); assert.equal(duplicate.done, 0); duplicate.component.dispose();
  const forged = fixture([row('a', { exactKey: { ...key, piSessionId: 'forged' } })]); out(forged.component); forged.component.handleInput('v'); assert.equal(forged.done, 0); forged.component.dispose();
  const mismatch = fixture([row('a')], { initialFilter: { memberRunId: 'unknown' }, getSnapshot: () => snap([row('a')]) }); assert.match(out(mismatch.component), /No matching/); mismatch.component.dispose();
});

test('subscriber storms only mark dirty, read once per render; cleanup/disposal and late callbacks isolated', () => {
  const f = fixture(); out(f.component); const before = f.reads;
  for (let i = 0; i < 100; i++) f.late(); assert.equal(f.reads, before);
  out(f.component); assert.equal(f.reads, before + 1);
  f.component.dispose(); f.component.dispose(); const renders = f.renders; f.late(); assert.equal(f.renders, renders); assert.equal(f.unsubscribed, 1); assert.equal(f.done, 1);
});

test('faulty projection/subscribe/redraw/theme/dispose callbacks are bounded and isolated', () => {
  let done = 0;
  const component = new ClankersTeamTimelineComponent({ requestRender: () => { throw new Error('redraw'); } }, { fg: () => { throw new Error('theme'); } }, () => { done++; throw new Error('done'); }, {
    getSnapshot: () => { throw new Error('\x1b]52;c;bad\x07projection'); }, subscribe: () => { throw new Error('subscribe'); },
  });
  assert.doesNotThrow(() => component.handleInput('home')); assert.doesNotThrow(() => out(component)); component.dispose(); component.dispose(); assert.equal(done, 1);
  const f = fixture([], { subscribe: () => () => { throw new Error('unsubscribe'); } }); f.component.dispose(); assert.equal(f.done, 1);
});

test('bounded rows/text/lines, sanitization before wrapping, Unicode/narrow heights/resize/theme invalidation', () => {
  const unsafe = '\x1b]52;c;secret\x07\x9d8;;url\x9c\x1b_apc\x1b\\\x1b[31m界😀é\x00\x9b31m';
  const f = fixture(Array.from({ length: 300 }, (_, index) => row(`r${index}`, { summary: unsafe + 'x'.repeat(10000), bodyPreview: '\n'.repeat(100000) })));
  for (const w of [1, 2, 10, 45, 512, 10000]) for (const h of [1, 2, 3, 8, 30, 2000]) {
    const lines = f.component.render(w, h); assert.ok(lines.length <= Math.min(h, 128));
    for (const line of lines) { assert.ok(visibleWidth(line) <= Math.min(w, 512)); assert.doesNotMatch(line.replace(/\x1b\[[0-9;]*m/g, ''), /[\x00-\x1f\x7f-\x9f]/); }
  }
  assert.ok(out(f.component, 512).includes('256 retained')); f.component.handleInput('enter');
  for (let i = 0; i < 100; i++) f.component.handleInput('pagedown'); assert.ok(f.component.render(1, 128).length <= 128);
  f.component.invalidate(); f.component.dispose();
  let theme = 'first'; const c = new ClankersTeamTimelineComponent(undefined, { fg: (_token, text) => `${theme}:${text}` }, undefined, { getSnapshot: () => snap([row('a')]), subscribe: () => () => undefined });
  assert.match(out(c), /first:/); theme = 'second'; c.invalidate(); assert.match(out(c), /second:/); c.dispose();
});

test('closing and read-only shortcuts never call viewCoding or mutate runtime', () => {
  let calls = 0; const f = fixture(undefined, { viewCoding: async () => { calls++; } }); out(f.component);
  for (const packet of ['c', '\x13', 'i', 'r', 'u']) f.component.handleInput(packet);
  assert.equal(calls, 0); f.component.handleInput('q'); assert.equal(f.done, 1); assert.equal(f.unsubscribed, 1);
});

test('fresh custom roundtrip preserves filter/stable selection/detail/pause and no watcher while coding', async () => {
  let rows = [row('a'), row('b')]; let listeners = 0; let phase = 0; let reads = 0; const keys: ClankersSessionMessageKey[] = [];
  const options: ClankersTeamTimelineOptions = {
    initialFilter: { memberRunId: key.memberRunId }, getSnapshot: (filter) => { reads++; return snap(rows, filter); },
    subscribe: () => { listeners++; return () => { listeners--; }; },
    viewCoding: async (exact) => { assert.equal(listeners, 0); keys.push(exact); rows = [row('new'), row('a', { status: 'delivered' }), row('b')]; await tick(); },
  };
  const context: StructuralPiCommandContext = { mode: 'tui', hasUI: true, ui: { custom(factory) {
    return new Promise<void>((resolve) => {
      const c = (factory as Exclude<typeof factory, (width: number) => string>)(undefined, undefined, undefined, () => resolve()) as ClankersTeamTimelineComponent;
      if (phase++ === 0) { out(c); c.handleInput('home'); c.handleInput('enter'); out(c); c.handleInput('v'); }
      else { assert.match(out(c), /row id: a/); assert.match(out(c), /scroll paused/); assert.match(out(c), /delivered/); assert.match(out(c), /memberRunId=member-a/); c.handleInput('q'); }
    });
  } } };
  await openClankersTeamTimeline(context, options); assert.equal(phase, 2); assert.deepEqual(keys, [key]); assert.equal(listeners, 0); assert.ok(reads >= 3);
});

test('failed exact coding callback returns a fresh timeline with visible bounded error; RPC rejects', async () => {
  let phase = 0; let subscriptions = 0;
  const options: ClankersTeamTimelineOptions = { getSnapshot: () => snap([row('a')]), subscribe: () => { subscriptions++; return () => { subscriptions--; }; }, viewCoding: () => { throw new Error('\x1b]52;c;evil\x07host failure'); } };
  await openClankersTeamTimeline({ ui: { custom(factory) {
    return new Promise<void>((resolve) => {
      const c = (factory as Exclude<typeof factory, (width: number) => string>)(undefined, undefined, undefined, () => resolve()) as ClankersTeamTimelineComponent;
      out(c); if (phase++ === 0) c.handleInput('v'); else { assert.match(out(c), /host failure/); assert.doesNotMatch(out(c), /evil|\x1b/); c.handleInput('q'); }
    });
  } } }, options);
  assert.equal(subscriptions, 0); await assert.rejects(() => openClankersTeamTimeline({ mode: 'rpc', hasUI: true, ui: { custom: () => undefined } }, options), /interactive Pi TUI/);
});

test('v pins the previously displayed tail row before dirty refresh; never drills an unseen newer row', () => {
  const f = fixture([row('a')]); out(f.component);
  f.update([row('a'), row('b', { memberRunId: 'member-b', piSessionId: 'pi-b', exactKey: { ...key, memberRunId: 'member-b', piSessionId: 'pi-b' } })]);
  // Deliberately no render between publication and keypress.
  f.component.handleInput('v'); assert.equal(f.done, 1); assert.deepEqual(f.result?.key, key); assert.equal(f.result?.state.selectedId, 'a');
  const changed = fixture([row('a')]); out(changed.component);
  changed.update([row('a', { exactKey: { ...key, memberRunId: 'new-member' }, memberRunId: 'new-member' })]);
  changed.component.handleInput('v'); assert.equal(changed.done, 0); assert.match(out(changed.component), /changed\/missing/); changed.component.dispose();
});

test('large composite IDs retain full identities and selection; UI key copies contain only exact three fields', () => {
  const identity = '\\'.repeat(256);
  const exact = { parentRunId: identity, memberRunId: identity, piSessionId: identity };
  const id = JSON.stringify(['log', identity, '2026-10-03T00:00:00Z', identity, identity, identity, identity]);
  assert.ok(id.length > 2048 && id.length < 4096);
  const extraKey = { ...exact, privileged: { dispose: () => { throw new Error('must not retain'); } } };
  const entry = row(id, { ...exact, exactKey: extraKey, summary: 'max composite retained', bodyPreview: 'max composite retained' });
  const f = fixture([entry]); assert.match(out(f.component), /max composite retained/);
  f.component.handleInput('home'); f.update([row('before'), { ...entry, status: 'delivered' } as ClankersTimelineEntry]);
  out(f.component); f.component.handleInput('v'); assert.deepEqual(f.result?.key, exact); assert.equal(f.result?.state.selectedId, id);
  assert.deepEqual(Object.keys(f.result?.key ?? {}).sort(), ['memberRunId', 'parentRunId', 'piSessionId']);
});

test('unknown initial fields never silently broaden; undefined extras alone do not create scope', () => {
  for (const filter of [{ runId: 'parent-a' }, { team: 'team-a' }, { targetId: 'x' }, { memberRunID: 'member-a' }]) {
    const f = fixture(undefined, { initialFilter: filter as ClankersTimelineFilter });
    assert.match(out(f.component), /Unsupported timeline filter field/); assert.equal(f.reads, 0); f.component.handleInput('v'); assert.equal(f.done, 0); f.component.dispose();
  }
  const undefinedExtra = fixture(undefined, { initialFilter: { memberRunId: key.memberRunId, runId: undefined } as ClankersTimelineFilter });
  out(undefinedExtra.component); assert.deepEqual(undefinedExtra.filters.at(-1), { memberRunId: key.memberRunId }); undefinedExtra.component.dispose();
});

test('UI independently clamps tab expansion/aggregate budget newest-first, preserving actual tail text', () => {
  const f = fixture(Array.from({ length: 256 }, (_, index) => row(`r${index}`, {
    summary: '\t'.repeat(100000), bodyPreview: '\t'.repeat(100000),
    ...(index === 255 ? { summary: 'LATEST actual communication', bodyPreview: 'TAIL BODY LATEST actual communication' } : {}),
  })));
  assert.match(out(f.component), /LATEST actual communication/); assert.match(out(f.component), /UI text\/row bound/);
  const entries = (f.component as unknown as { entries: ClankersTimelineEntry[] }).entries;
  const retainedText = entries.reduce((sum, entry) => sum + entry.summary.length + entry.bodyPreview.length, 0);
  assert.ok(retainedText <= 256 * 1024, retainedText.toString());
  for (const entry of entries) { assert.ok(entry.summary.length <= 256); assert.ok(entry.bodyPreview.length <= 1024); }
  assert.equal(entries.at(-1)?.bodyPreview, 'TAIL BODY LATEST actual communication');
  f.component.handleInput('enter'); assert.match(out(f.component), /TAIL BODY/); f.component.dispose();
});

test('detail line clipping is explicit; notice remains scrollable without replacing retained content', () => {
  const identity = 'x'.repeat(256); const id = JSON.stringify(['log', identity, identity, identity, identity, identity]);
  const f = fixture([row(id, { bodyPreview: 'B'.repeat(1024) })]); out(f.component); f.component.handleInput('enter');
  f.component.render(2, 30); for (let i = 0; i < 100; i++) f.component.handleInput('pagedown');
  const cache = (f.component as unknown as { cache?: { lines: string[] } }).cache;
  f.component.render(2, 30);
  const lines = (f.component as unknown as { cache?: { lines: string[] } }).cache?.lines ?? cache?.lines ?? [];
  assert.ok(lines.length <= 512); assert.match(lines.at(-1) ?? '', /UI detail truncated/); assert.ok(lines.length > 1); f.component.dispose();
});

test('async/sync custom host failures after factory always dispose once; noncoercible errors stay contained', async () => {
  for (const sync of [true, false]) {
    let unsubs = 0;
    await assert.rejects(() => openClankersTeamTimeline({ ui: { custom(factory) {
      (factory as Exclude<typeof factory, (width: number) => string>)(undefined, undefined, undefined, () => undefined);
      if (sync) throw new Error('host postfactory failure');
      return Promise.reject(new Error('host postfactory failure'));
    } } }, { getSnapshot: () => snap([row('a')]), subscribe: () => () => { unsubs++; } }), /host postfactory failure/);
    assert.equal(unsubs, 1);
  }
  const nonText = Object.assign(Object.create(null), { toString: null });
  const f = fixture(undefined, { getSnapshot: () => { throw nonText; }, subscribe: () => { throw nonText; } });
  assert.doesNotThrow(() => out(f.component)); assert.match(out(f.component), /Unknown failure/);
  f.component.handleInput('v'); assert.equal(f.done, 0); f.component.dispose();
});

test('other input-triggered refreshes cannot make unseen replacements actionable before a frame', () => {
  const f = fixture([row('a')]); out(f.component);
  f.update([row('a'), row('b', { memberRunId: 'other', piSessionId: 'pi-other', exactKey: { ...key, memberRunId: 'other', piSessionId: 'pi-other' } })]);
  f.component.handleInput('c'); // Not a timeline action; may request but no frame has rendered.
  f.component.handleInput('v'); assert.equal(f.done, 0); assert.equal(f.result, undefined); f.component.dispose();
  const changed = fixture([row('a')]); out(changed.component);
  changed.update([row('a', { memberRunId: 'other', exactKey: { ...key, memberRunId: 'other' } })]);
  changed.component.handleInput('enter'); // Detail toggle is not permission to change key silently.
  changed.component.handleInput('v'); assert.equal(changed.done, 0); assert.match(out(changed.component), /changed\/missing/); changed.component.dispose();
});

test('120-column communication scan exposes actor/run/member and actual body without duplicate summary crowding', () => {
  const rows = ['parent-a', 'parent-b'].map((parentRunId, index) => row(`receipt-${index}`, {
    parentRunId, agentDefinitionId: 'same-def', memberRunId: 'same-worker', piSessionId: `pi-${index}`,
    exactKey: { parentRunId, memberRunId: 'same-worker', piSessionId: `pi-${index}` },
    summary: 'queued current receipt status '.repeat(20), bodyPreview: `MESSAGE_${index}_distinct content`,
  }));
  const f = fixture(rows); const text = out(f.component, 120, 24);
  for (const match of ['same-def r:parent-a m:same-worker', 'same-def r:parent-b m:same-worker', '[receipt queued/memory]', 'MESSAGE_0_distinct', 'MESSAGE_1_distinct']) assert.ok(text.includes(match), match);
  assert.doesNotMatch(text, /queued current receipt status/);
  f.component.handleInput('home'); out(f.component, 120); f.component.handleInput('v'); assert.deepEqual(f.result?.key, { parentRunId: 'parent-a', memberRunId: 'same-worker', piSessionId: 'pi-0' });
  const unlinked = fixture([row('legacy', { kind: 'recorded-event', source: 'log', sourceId: 'legacy', exactKey: undefined, parentRunId: undefined, memberRunId: undefined, piSessionId: undefined, agentDefinitionId: undefined, bodyPreview: 'legacy preview' })]);
  assert.match(out(unlinked.component, 120), /\? r:\? m:\? \[recorded event\] legacy preview/); unlinked.component.dispose();
});

test('complete literal identity paste works only in form, including long IDs and shortcut-looking words', () => {
  const paste = (value: string) => `\x1b[200~${value}\x1b[201~`;
  for (const value of ['enter', 'backspace', 'q', 'v', 'P'.repeat(256)]) {
    const f = fixture(); out(f.component); f.component.handleInput('f'); f.component.handleInput(paste(value));
    assert.equal(f.done, 0); assert.match(out(f.component, 400), /Literal identity pasted/);
    f.component.handleInput('enter'); out(f.component); assert.equal(f.filters.at(-1)?.teamId, value); f.component.dispose();
  }
  const outside = fixture(); out(outside.component); outside.component.handleInput(paste('v')); assert.equal(outside.done, 0); assert.match(out(outside.component), /Paste rejected/); outside.component.dispose();
  for (const packet of [`prefix${paste('member')}`, `${paste('member')}\rv`, paste('x'.repeat(257)), paste('bad id'), paste('\x1b]52;c;evil\x07'), paste('enter\n')]) {
    const f = fixture(); out(f.component); f.component.handleInput('f'); f.component.handleInput(packet); assert.equal(f.done, 0);
    assert.match(out(f.component), /Paste rejected/); f.component.handleInput('enter'); out(f.component); assert.deepEqual(f.filters.at(-1), {}); f.component.dispose();
  }
  const split = fixture(); out(split.component); split.component.handleInput('f'); split.component.handleInput('\x1b[200~member');
  assert.match(out(split.component), /Incomplete paste rejected/); split.component.handleInput('-a\x1b[201~\rv'); assert.equal(split.done, 0);
  split.component.handleInput('enter'); out(split.component); assert.deepEqual(split.filters.at(-1), {}); split.component.dispose();
});

test('last rendered selected identity cannot redirect to merely visible reordered row before redraw', () => {
  const b = row('b', { memberRunId: 'member-b', piSessionId: 'pi-b', exactKey: { ...key, memberRunId: 'member-b', piSessionId: 'pi-b' } });
  const f = fixture([b, row('a')]); out(f.component); f.update([row('a'), b]);
  f.component.handleInput('x'); f.component.handleInput('v'); assert.equal(f.done, 0); assert.match(out(f.component), /not yet redrawn/); f.component.dispose();
});

test('End/fast selection/form cancel before redraw cannot grant a different coding identity', () => {
  const b = row('b', { memberRunId: 'member-b', piSessionId: 'pi-b', exactKey: { ...key, memberRunId: 'member-b', piSessionId: 'pi-b' } });
  const f = fixture([row('a'), b]); out(f.component); f.component.handleInput('home'); f.component.handleInput('v'); assert.equal(f.done, 0);
  out(f.component); f.component.handleInput('end'); f.component.handleInput('v'); assert.equal(f.done, 0);
  out(f.component); f.component.handleInput('v'); assert.deepEqual(f.result?.key, b.exactKey);
  const cancelled = fixture([b, row('a')]); out(cancelled.component); cancelled.component.handleInput('f'); cancelled.update([row('a'), b]);
  // The frame displays a form, NOT permission to select a newly reordered timeline row.
  out(cancelled.component); cancelled.component.handleInput('escape'); cancelled.component.handleInput('v'); assert.equal(cancelled.done, 0); cancelled.component.dispose();
});
