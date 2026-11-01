import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { ACTIVITY_LIMITS, EMPTY_NATIVE_ACTIVITY, UNAVAILABLE_WORKFLOW_ACTIVITY, projectActivity } from '../activity.js';
import type { ActivityProjection, ActivitySource, NativeActivitySnapshot, WorkflowActivitySnapshot } from '../activity.js';

export const BACKGROUND_ACTIVITY_WIDGET = 'pi-zerg-swarm.background-activity';
export interface BackgroundActivityContext {
  mode?: string;
  hasUI: boolean;
  ui: Pick<ExtensionUIContext, 'setWidget'>;
}
/** Timer injection is for deterministic offline lifecycle tests, not execution scheduling. */
export interface BackgroundActivityClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface BackgroundActivityOptions {
  native?: ActivitySource<NativeActivitySnapshot>;
  workflows?: ActivitySource<WorkflowActivitySnapshot>;
  permissions?: ActivitySource<number>;
  visible?: boolean;
  activeShortcut?: string;
  ascii?: boolean;
  onTui?: (handle: TUI | undefined) => void;
  clock?: BackgroundActivityClock;
}
export interface BackgroundActivityController {
  /** Returns a generation-specific cleanup; an old session cannot clear a newer one. */
  attach(ctx: BackgroundActivityContext): () => void;
  setVisible(visible: boolean): void;
  /** Supply only the effective active binding, never desired/reload-pending configuration. */
  setActiveShortcut(key: string | undefined): void;
  dispose(): void;
}
const systemClock: BackgroundActivityClock = {
  now: Date.now,
  setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
// Focus may need attention while other runs work; only actual projected work drives the clock.
const active = ({ counts: c }: ActivityProjection) => c.working > 0 || c.starting > 0
  || c.checking > 0 || c.applying > 0 || c.cleanup > 0;
const safely = (callback: () => void) => { try { callback(); } catch { /* Observation never controls execution. */ } };
/** Strip terminal escapes first, then remaining C0/C1 and bidi display controls. Bound before processing. */
export function sanitizeActivityLabel(text: string): string {
  return stripTerminalSequences(text.slice(0, 512)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim();
}
const count = (n: number) => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
const elapsed = (start: string, end: string | undefined, now: number) => {
  const a = Date.parse(start), b = end ? Date.parse(end) : now;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const seconds = Math.floor(Math.max(0, b - a) / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export interface BackgroundActivityRenderOptions {
  nowMs: number; height?: number; permissions?: number; permissionUnavailable?: boolean;
  activeShortcut?: string; ascii?: boolean; theme?: Pick<Theme, 'fg'>;
}
/** Bounded display-only rendering. No sources, runtime reads, actions, or stored theme strings. */
export function renderBackgroundActivity(p: ActivityProjection, width: number, options: BackgroundActivityRenderOptions): string[] {
  const height = options.height ?? 24;
  if (!Number.isFinite(width) || width < 8 || height < 5) return [];
  const w = width >= 90 ? Math.floor(width * 2 / 3) : Math.floor(width);
  const pending = count(options.permissions ?? 0), f = p.focus, c = p.counts;
  if (!f && !pending && !options.permissionUnavailable && !Object.values(c).some(n => n > 0)) return [];
  const sep = options.ascii ? ' | ' : ' · ';
  const parts: string[] = [];
  const attention = pending > 0 || options.permissionUnavailable || p.attention.length > 0 || c.unknown > 0;
  parts.push(`${attention ? '!' : active(p) ? (options.ascii ? '*' : '●')
    : f?.phase === 'paused' ? (options.ascii ? '||' : 'Ⅱ') : (options.ascii ? '-' : '○')} Clankers`);
  if (pending) parts.push(`${pending} permissions pending`);
  if (options.permissionUnavailable) parts.push('permission visibility unavailable');
  if (f) {
    const label = sanitizeActivityLabel(f.label ?? '').slice(0, 128) || sanitizeActivityLabel(f.runId).slice(0, 128);
    parts.push(`${f.kind === 'workflow' ? `Workflow${f.attemptNo ? ` attempt ${count(f.attemptNo)}` : ''}` : 'Run'}: ${sanitizeActivityLabel(f.phase).replace(/-/g, ' ')}${label ? ` (${label})` : ''}`);
  }
  const n = (value: number) => `${p.clipped ? '>=' : ''}${count(value)}`;
  if (c.working) parts.push(`${n(c.working)} agents working`);
  if (c.starting) parts.push(`${n(c.starting)} starting`);
  if (c.queuedAgents) parts.push(`${n(c.queuedAgents)} agents queued`);
  if (c.queuedUnits) parts.push(`${n(c.queuedUnits)} units queued`);
  if (c.waitingApproval) parts.push(`${n(c.waitingApproval)} workflow approvals pending`);
  if (c.checking) parts.push(`${n(c.checking)} checking`);
  if (c.applying) parts.push(`${n(c.applying)} applying`);
  if (c.cleanup) parts.push(`${n(c.cleanup)} cleanup pending`);
  if (c.unknown) parts.push(`${n(c.unknown)} uncertain`);
  if (f?.progress) {
    const progress = f.progress;
    parts.push(progress.total === null ? `${count(progress.completed)} steps completed (total unknown)`
      : `${count(progress.completed)}/${count(progress.total)} steps completed`);
    for (const field of ['reused', 'failed', 'skipped', 'cancelled', 'unverified'] as const) {
      if (progress[field]) parts.push(`${count(progress[field])} steps ${field}`);
    }
    if (progress.reusedUnits) parts.push(`${count(progress.reusedUnits)} units reused`);
  }
  if (f && f.phase !== 'recovered' && f.phase !== 'unknown') {
    const duration = elapsed(f.startedAt, f.endedAt, options.nowMs);
    if (duration) parts.push(`${f.kind === 'workflow' ? 'attempt' : 'run'} ${duration}`);
  }
  if (p.moreRuns) parts.push(`+${count(p.moreRuns)} runs`);
  if (p.clipped) parts.push('counts lower bounds');
  // The parent supplies the effective binding. Validate, never sanitize it into a different key.
  const key = options.activeShortcut;
  const hint = key && key.length <= 10 && /^(?:ctrl\+alt|alt\+ctrl|ctrl|alt)\+[a-z0-9]$/i.test(key) ? `  [${key}] Manage` : '';
  const reserve = w >= 48 ? visibleWidth(hint) : 0;
  let primary = truncateToWidth(parts.join(sep), w - reserve, options.ascii ? '...' : '…');
  // Usable layouts reserve the whole hint; short layouts may omit it, never show a partial key.
  if (hint && visibleWidth(primary) + visibleWidth(hint) <= w) primary += hint;
  const color = attention ? 'warning' : f?.phase === 'completed' ? 'success' : 'accent';
  const style = (text: string, token: 'warning' | 'success' | 'accent' | 'dim') => {
    try { return truncateToWidth(options.theme?.fg(token, text) ?? text, w); } catch { return text; }
  };
  const lines = [style(primary, color)];
  if (height >= 10 && w >= 48 && p.detail.length) {
    const detail = p.detail.slice(0, 2).map(row => `${sanitizeActivityLabel(row.agentDefinitionId)}: ${sanitizeActivityLabel(row.phase).replace(/-/g, ' ')}`).join(sep);
    lines.push(style(truncateToWidth(`  ${detail}`, w, options.ascii ? '...' : '…'), 'dim'));
  }
  return lines;
}

/** Cache only actual visibility expiries, not raw terminal statuses. At most 48 bounded DTO
 * deadlines are checked on source refresh with the canonical pure projector, avoiding a second
 * implementation of cleanup/dedup/join/history eligibility. Never called on elapsed ticks or expiry. */
function successExpiries(native: Readonly<NativeActivitySnapshot>, workflows: Readonly<WorkflowActivitySnapshot>,
  now: number, projection: ActivityProjection): number[] {
  const deadlines = new Set<number>();
  const add = (stamp: string | undefined) => {
    const end = stamp ? Date.parse(stamp) : NaN, deadline = end + ACTIVITY_LIMITS.successGraceMs;
    if (end <= now && deadline > now) deadlines.add(deadline);
  };
  for (const run of native.runs.slice(0, ACTIVITY_LIMITS.nativeRuns)) {
    if (run.local && run.phase === 'completed') add(run.endedAt);
  }
  for (const run of workflows.runs.slice(0, ACTIVITY_LIMITS.workflowRuns)) {
    if (run.local && !run.recovered && run.status === 'completed') add(run.updatedAt);
  }
  let visibleRuns = projection.moreRuns + Number(!!projection.focus);
  const expiries: number[] = [];
  for (const deadline of [...deadlines].sort((a, b) => a - b)) {
    const after = projectActivity(native, workflows, deadline, projection.focus?.key);
    const remaining = after.moreRuns + Number(!!after.focus);
    if (remaining < visibleRuns) expiries.push(deadline);
    visibleRuns = remaining;
  }
  return expiries;
}

interface Generation { retire(): void }
// Shared UI ownership protects a new controller from late old reload/session disposal.
const widgetOwners = new WeakMap<object, Generation>();
export function createBackgroundActivityController(options: BackgroundActivityOptions): BackgroundActivityController {
  const clock = options.clock ?? systemClock;
  let visible = options.visible ?? true, shortcut = options.activeShortcut, disposed = false;
  let generation: Generation | undefined, context: BackgroundActivityContext | undefined, serial = 0;
  const notify = (tui: TUI | undefined) => safely(() => options.onTui?.(tui));
  return {
    attach(ctx) {
      if (disposed) return () => {};
      if (ctx === context && generation) return generation.retire;
      const request = ++serial;
      generation?.retire();
      if (serial !== request || disposed) return () => {};
      if (ctx.mode !== 'tui' || !ctx.hasUI) return () => {};
      widgetOwners.get(ctx.ui)?.retire();
      if (serial !== request || disposed) return () => {};
      let dead = false, tui: TUI | undefined, component: (Component & { dispose(): void }) | undefined;
      let coalesce: unknown, tick: unknown, grace: unknown;
      const subscriptions: Array<() => void> = [];
      let native = EMPTY_NATIVE_ACTIVITY, workflows = UNAVAILABLE_WORKFLOW_ACTIVITY;
      let permissions = 0, permissionUnavailable = false, now = clock.now();
      let projection = projectActivity(native, workflows, now), dirty = true;
      let expiries: number[] = [];
      let nativeSubscriptionFailed = false, workflowSubscriptionFailed = false, permissionSubscriptionFailed = false;
      const live = () => !dead && generation === owner && widgetOwners.get(ctx.ui) === owner;
      const clear = () => {
        for (const timer of [coalesce, tick, grace]) if (timer !== undefined) clock.clearTimeout(timer);
        coalesce = tick = grace = undefined;
      };
      const render = () => { if (live()) safely(() => tui?.requestRender()); };
      const expire = () => {
        if (expiries[0] === undefined || expiries[0] > now) return;
        expiries = expiries.filter(deadline => deadline > now);
        safely(() => { projection = projectActivity(native, workflows, now, projection.focus?.key); });
      };
      const timers = () => {
        for (const timer of [tick, grace]) if (timer !== undefined) clock.clearTimeout(timer);
        tick = grace = undefined;
        if (!live() || !visible || !tui) return;
        if (active(projection)) tick = clock.setTimeout(() => {
          tick = undefined;
          if (!live() || !visible) return;
          now = clock.now(); render(); timers(); // Cached projection only: zero source reads/rescans.
        }, 1000);
        const deadline = expiries[0];
        if (deadline !== undefined) grace = clock.setTimeout(() => {
          grace = undefined;
          if (!live() || !visible) return;
          now = clock.now(); expire();
          render(); timers(); // One expiry projection from cached bounded DTOs, never a pull.
        }, Math.max(0, deadline - clock.now()));
      };
      const refresh = () => {
        if (!live() || !visible) return;
        dirty = false; now = clock.now();
        let nativeUnavailable = nativeSubscriptionFailed;
        try { native = nativeSubscriptionFailed ? EMPTY_NATIVE_ACTIVITY : options.native?.snapshot() ?? EMPTY_NATIVE_ACTIVITY; }
        catch { native = EMPTY_NATIVE_ACTIVITY; nativeUnavailable = true; }
        if (!live()) return;
        try { workflows = workflowSubscriptionFailed ? { ...UNAVAILABLE_WORKFLOW_ACTIVITY, uncertain: true }
          : options.workflows?.snapshot() ?? UNAVAILABLE_WORKFLOW_ACTIVITY; }
        catch { workflows = { ...UNAVAILABLE_WORKFLOW_ACTIVITY, uncertain: true }; }
        if (nativeUnavailable) workflows = { ...workflows, uncertain: true, available: false };
        if (!live()) return;
        try { permissions = permissionSubscriptionFailed ? 0 : count(options.permissions?.snapshot() ?? 0); permissionUnavailable = permissionSubscriptionFailed; }
        catch { permissions = 0; permissionUnavailable = true; }
        if (!live()) return;
        expiries = [];
        try {
          projection = projectActivity(native, workflows, now, projection.focus?.key);
          expiries = successExpiries(native, workflows, now, projection);
        } catch { projection = projectActivity(EMPTY_NATIVE_ACTIVITY, { ...UNAVAILABLE_WORKFLOW_ACTIVITY, uncertain: true }, now); }
        // Sources are observer contracts; reentrant session changes must not restore stale UI.
        if (!live()) return;
        render(); timers();
      };
      const invalidate = () => {
        if (!live()) return;
        dirty = true;
        if (visible && coalesce === undefined) coalesce = clock.setTimeout(() => {
          coalesce = undefined; refresh();
        }, 50);
      };
      const owner: Generation & { visibility(): void; hint(): void } = {
        retire() {
          if (dead) return;
          const owned = widgetOwners.get(ctx.ui) === owner;
          dead = true; clear();
          if (generation === owner) { generation = undefined; context = undefined; }
          if (owned) widgetOwners.delete(ctx.ui);
          for (const unsubscribe of subscriptions.splice(0)) safely(unsubscribe);
          // Clear before callbacks: reentrant attach may install a new widget.
          if (owned && !widgetOwners.has(ctx.ui)) safely(() => ctx.ui.setWidget(BACKGROUND_ACTIVITY_WIDGET, undefined));
          if (owned && !widgetOwners.has(ctx.ui)) notify(undefined);
          tui = undefined; component = undefined;
        },
        visibility() {
          clear();
          if (visible) {
            if (dirty) refresh();
            else {
              now = clock.now();
              // Hiding is not a source invalidation; catch up ALL cached success expiries once.
              expire();
              timers();
            }
          }
          render();
        },
        hint: render,
      };
      generation = owner; context = ctx; widgetOwners.set(ctx.ui, owner);
      for (const source of [options.native, options.workflows, options.permissions]) {
        if (!source || !live()) continue;
        try {
          const unsubscribe = source.subscribe(invalidate);
          if (live()) subscriptions.push(unsubscribe); else safely(unsubscribe);
        } catch {
          if (source === options.native) nativeSubscriptionFailed = true;
          if (source === options.workflows) workflowSubscriptionFailed = true;
          if (source === options.permissions) permissionSubscriptionFailed = true;
        }
      }
      if (!live()) return owner.retire;
      if (visible) refresh();
      if (!live()) return owner.retire;
      try { ctx.ui.setWidget(BACKGROUND_ACTIVITY_WIDGET, (handle, theme) => {
        if (!live()) return { render: () => [], invalidate() {}, dispose() {} };
        if (component) return component;
        tui = handle;
        component = {
          render(width) {
            if (!live() || !visible) return [];
            try { return renderBackgroundActivity(projection, width, { nowMs: now, height: handle.terminal.rows,
              permissions, permissionUnavailable, activeShortcut: shortcut, ascii: options.ascii, theme }); }
            catch { return []; }
          },
          invalidate() {},
          dispose: owner.retire,
        };
        return component ?? { render: () => [], invalidate() {}, dispose() {} };
      }, { placement: 'belowEditor' }); }
      catch { owner.retire(); }
      // Publish only after setWidget returns: a reentrant callback cannot be overwritten by its outer factory.
      if (live() && tui) { notify(tui); if (live()) timers(); }
      return owner.retire;
    },
    setVisible(value) {
      if (disposed || visible === value) return;
      visible = value;
      (generation as (Generation & { visibility(): void }) | undefined)?.visibility();
    },
    setActiveShortcut(key) {
      if (disposed || shortcut === key) return;
      shortcut = key;
      (generation as (Generation & { hint(): void }) | undefined)?.hint();
    },
    dispose() { if (disposed) return; disposed = true; ++serial; generation?.retire(); },
  };
}
