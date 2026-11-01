import { truncateToWidth } from '@earendil-works/pi-tui';
import { sanitizeNativeTranscriptText } from './native-transcript.js';
import { ZERG_COMMAND_INVOCATIONS, ZERG_EXTENSION_VERSION, type AgentIdentity, type HookLifecycleEvent, type TaskRecord, type TeamIdentity, type ZergTimelineSnapshot, type ZergNativeSessionReference, type ZergAgentDefinition, type ZergConfigOverlayTab, type ZergLogRecord, type ZergLogState, type ZergPermissionQueueState, type ZergPermissionRequest, type ZergState, type ZergSubagentRunSnapshot, type ZergTreeNode } from './types.js';

export interface RenderOptions {
  width?: number;
}

const DEFAULT_WIDTH = 88;
const MAX_RENDER_LINES = 400;
const MAX_MONITOR_EVENTS = 8;

export interface MonitorRenderOptions extends RenderOptions {
  recentEventCount?: number;
}

export interface ZergManagementOverlayRow {
  id: string;
  label: string;
  kind: 'text' | 'target' | 'permission' | 'run' | 'log' | 'intervention' | 'config' | 'event';
  selectable?: boolean;
  targetId?: string;
  runId?: string;
  requestId?: string;
  detailLines?: string[];
}

export interface ZergManagementOverlayRenderOptions extends RenderOptions {
  height?: number;
  activeTab: ZergConfigOverlayTab;
  tabs: readonly ZergConfigOverlayTab[];
  rows: readonly ZergManagementOverlayRow[];
  selectedIndex?: number;
  scrollOffset?: number;
  detailRowId?: string;
  statusMessage?: string;
  confirmMessage?: string;
  adapterKind?: string;
}

export function renderZergManagementOverlay(
  state: ZergState,
  options: ZergManagementOverlayRenderOptions,
): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const rows = [...options.rows];
  const selectableRows = rows.filter((row) => row.selectable !== false);
  const hasSelectableRows = selectableRows.length > 0;
  const clampedSelectedIndex = rows.length === 0
    ? 0
    : Math.max(0, Math.min(options.selectedIndex ?? 0, rows.length - 1));
  const desiredVisibleRows = Math.max(6, Math.min(20, (options.height ?? 22) - 8));
  const maxScrollOffset = Math.max(0, rows.length - desiredVisibleRows);
  const baseScrollOffset = Math.max(0, Math.min(options.scrollOffset ?? 0, maxScrollOffset));
  const scrollOffset = rows.length === 0
    ? 0
    : clampedSelectedIndex < baseScrollOffset
      ? clampedSelectedIndex
      : clampedSelectedIndex >= baseScrollOffset + desiredVisibleRows
        ? Math.max(0, clampedSelectedIndex - desiredVisibleRows + 1)
        : baseScrollOffset;
  const visibleRows = rows.slice(scrollOffset, scrollOffset + desiredVisibleRows);
  const tabLine = options.tabs.map((tab) => tab === options.activeTab ? `[${tab}]` : ` ${tab} `).join(' ');
  const lines = [
    'clankers config',
    tabLine,
    overlayKeyHelp(options.activeTab),
  ];

  if (options.statusMessage) {
    lines.push(`status: ${sanitizeRuntimeActivity(options.statusMessage)}`);
  }
  if (options.confirmMessage) {
    lines.push(`confirm: ${sanitizeRuntimeActivity(options.confirmMessage)}`);
  }
  if (state.mode?.readOnly) {
    lines.push('warning: read-only enabled; mutations may queue permission or be blocked');
  }
  if (options.adapterKind) {
    lines.push(`adapter: ${sanitizeRuntimeActivity(options.adapterKind)}`);
  }
  lines.push('');

  if (rows.length === 0) {
    lines.push(`${options.activeTab}: none`);
  } else {
    for (let index = 0; index < visibleRows.length; index += 1) {
      const row = visibleRows[index]!;
      const rowIndex = scrollOffset + index;
      const selected = rowIndex === clampedSelectedIndex;
      const marker = selected && hasSelectableRows && row.selectable !== false ? '>' : ' ';
      lines.push(`${marker} ${sanitizeRuntimeActivity(row.label)}`);
      if (options.detailRowId === row.id) {
        for (const detailLine of row.detailLines ?? []) {
          lines.push(`    ${sanitizeRuntimeActivity(detailLine) || 'none'}`);
        }
      }
    }
  }

  lines.push('');
  lines.push(`footer: rows ${rows.length === 0 ? '0/0' : `${scrollOffset + 1}-${Math.min(rows.length, scrollOffset + visibleRows.length)}/${rows.length}`} | revision ${state.revision} | updated ${state.metadata.updatedAt}`);
  return lines.map((line) => fit(line, width)).join('\n');
}

function overlayKeyHelp(tab: ZergConfigOverlayTab): string {
  const common = 'keys: tab/shift-tab/←/→ tabs | ↑/↓ rows | enter detail/select | q/esc close';
  if (tab === 'permissions') {
    return `${common} | p approve | d deny | / filter deferred`;
  }
  if (tab === 'targets' || tab === 'lifecycle') {
    return `${common} | i interrupt | / filter deferred`;
  }
  if (tab === 'intervene') {
    return `${common} | enter record intervention | / filter deferred`;
  }
  return `${common} | r read-only | m manual | a assisted | u automatic | / filter deferred`;
}

export function renderMonitor(state: ZergState, options: MonitorRenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const snapshot = state ?? ({} as ZergState);
  const eventCount = options.recentEventCount ?? MAX_MONITOR_EVENTS;
  const readOnly = Boolean(snapshot.mode?.readOnly) ? 'enabled' : 'disabled';
  const permissions = readRenderPermissionQueueState(snapshot);
  const latestPermission = permissions.requests.filter((request) => request.status === 'pending').at(-1);
  const logs = readRenderLogState(snapshot);
  const latestWarning = logs.records.filter((record) => record.level === 'warn' || record.level === 'error').at(-1);
  const monitorEventLimit = Math.max(1, eventCount);
  const recentEvents = [...(snapshot.events ?? [])].slice(-monitorEventLimit);
  const lines = [
    'clankers monitor',
    `status: ${renderStatusLine(snapshot, { width })}`,
    `read-only: ${readOnly}`,
    `permissions: ${permissions.pendingCount} pending${latestPermission ? ` latest:${renderPermissionRequestInline(latestPermission)}` : ''}`,
    `logs: ${logs.records.length}/${logs.maxRecords}${latestWarning ? ` latest:${renderLogRecordInline(latestWarning)}` : ''}`,
    'tree:',
  ];

  lines.push(...renderAgentTree(snapshot, { width }).split('\n').map((line) => `  ${line}`));
  lines.push('recent events:');

  if (recentEvents.length === 0) {
    lines.push('  none');
  } else {
    for (const event of recentEvents) {
      lines.push(renderMonitorEventLine(event, width));
    }
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderStatusLine(state: ZergState, options: RenderOptions = {}): string {
  const snapshot = state ?? ({} as ZergState);
  const agents = recordValues(snapshot.agents);
  const tasks = recordValues(snapshot.tasks);
  const teams = recordValues(snapshot.teams);
  const intervention = snapshot.mode?.activeIntervention;
  const controller = snapshot.mode?.controller ?? 'operator';
  const runningAgents = agents.filter((agent) => agent.status === 'running').length;
  const runningTeams = teams.filter((team) => team.status === 'running').length;
  const unhealthy = [...agents, ...teams].filter(hasUnhealthyRuntime).length;
  const blocked = [...agents, ...tasks, ...teams].filter((item) => item.status === 'blocked' || item.status === 'needs-attention').length;
  const latestActivity = renderLatestRuntimeActivity([...agents, ...teams]);
  const activity = latestActivity ? ` | last ${latestActivity}` : '';
  const control = `control ${controller}`;
  const mode = `mode ${snapshot.mode?.automation ?? 'manual'}`;
  const activeIntervention = intervention
    ? ` | intervention ${intervention.kind} ${intervention.targetId} (${renderInterventionMessagePreview(intervention.message)})`
    : ' | no active intervention';
  const permissionQueue = readRenderPermissionQueueState(snapshot);
  const permissions = ` | permissions ${permissionQueue.pendingCount} pending`;
  const width = options.width ?? DEFAULT_WIDTH;
  const brand = `clankers v${ZERG_EXTENSION_VERSION}`;
  let header = `${brand} command surface`;
  const counts = ` | agents ${agents.length} (${runningAgents} running) | teams ${teams.length} (${runningTeams} running) | tasks ${tasks.length} | blocked ${blocked} | unhealthy ${unhealthy}`;
  // Reserve fit's ellipsis column before sacrificing any current activity.
  if (activity && width > 3 && `${header}${counts}${activity}`.length > width - 1) {
    header = brand;
  }

  return fit(
    `${header}${counts}${activity} | ${control} | ${mode}${permissions}${activeIntervention}`,
    options.width,
  );
}


function readRenderPermissionQueueState(state: ZergState): ZergPermissionQueueState {
  const candidate = state.extensions?.zergPermissions;
  const maxRequests = isPlainRecord(candidate) && typeof candidate.maxRequests === 'number' ? candidate.maxRequests : 50;
  const requests = isPlainRecord(candidate) && Array.isArray(candidate.requests)
    ? candidate.requests.filter(isRenderPermissionRequest).map(cloneRenderPermissionRequest)
    : [];

  return {
    requests,
    maxRequests,
    lastRequestId: isPlainRecord(candidate) && typeof candidate.lastRequestId === 'string' ? candidate.lastRequestId : requests.at(-1)?.id,
    pendingCount: requests.filter((request) => request.status === 'pending').length,
  };
}

function readRenderLogState(state: ZergState): ZergLogState {
  const candidate = state.extensions?.zergLogs;
  const maxRecords = isPlainRecord(candidate) && typeof candidate.maxRecords === 'number' ? Math.max(1, Math.floor(candidate.maxRecords)) : 200;
  const records = isPlainRecord(candidate) && Array.isArray(candidate.records)
    ? candidate.records.filter(isRenderLogRecord).map(cloneRenderLogRecord).slice(-maxRecords)
    : [];

  return {
    records,
    maxRecords,
    lastRecordId: isPlainRecord(candidate) && typeof candidate.lastRecordId === 'string' ? candidate.lastRecordId : records.at(-1)?.id,
  };
}

function renderLogRecordInline(record: ZergLogRecord): string {
  const target = record.runId ? ` run:${sanitizeRuntimeActivity(record.runId)}` : record.agentId ? ` agent:${sanitizeRuntimeActivity(record.agentId)}` : '';
  return `${record.id} [${record.level}/${record.source}/${record.kind}]${target} ${sanitizeRuntimeActivity(record.message)}`;
}

function cloneRenderLogRecord(record: ZergLogRecord): ZergLogRecord {
  return {
    ...record,
    data: isPlainRecord(record.data) ? { ...record.data } : undefined,
  };
}

function isRenderLogRecord(value: unknown): value is ZergLogRecord {
  return isPlainRecord(value)
    && typeof value.id === 'string'
    && typeof value.source === 'string'
    && typeof value.level === 'string'
    && typeof value.kind === 'string'
    && typeof value.message === 'string'
    && typeof value.createdAt === 'string';
}

export function renderZergLogStatus(logState: ZergLogState, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const latest = logState.records.at(-1);
  const errors = logState.records.filter((record) => record.level === 'error').length;
  const warnings = logState.records.filter((record) => record.level === 'warn').length;
  const lines = [
    'clankers logs',
    `records: ${logState.records.length}`,
    `max: ${logState.maxRecords}`,
    `warnings: ${warnings}`,
    `errors: ${errors}`,
    `latest: ${latest ? renderLogRecordInline(latest) : 'none'}`,
  ];

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderZergLogList(records: readonly ZergLogRecord[], options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  if (records.length === 0) {
    return fit('clankers logs: no matching records', width);
  }

  const lines = ['clankers logs:'];
  for (const record of records) {
    lines.push(`- ${renderLogRecordInline(record)}`);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderZergLogSummary(record: ZergLogRecord, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const lines = [
    `clankers log: ${record.id}`,
    `source: ${record.source}`,
    `level: ${record.level}`,
    `kind: ${record.kind}`,
    ...(record.runId ? [`run-id: ${record.runId}`] : []),
    ...(record.agentId ? [`agent-id: ${record.agentId}`] : []),
    ...(record.taskId ? [`task-id: ${record.taskId}`] : []),
    ...(record.teamId ? [`team-id: ${record.teamId}`] : []),
    `created-at: ${record.createdAt}`,
    `message: ${sanitizeRuntimeActivity(record.message)}`,
    ...(record.data ? [`data: ${sanitizeRuntimeActivity(JSON.stringify(record.data))}`] : []),
  ];

  return lines.map((line) => fit(line, width)).join('\n');
}

function renderPermissionRequestInline(request: ZergPermissionRequest): string {
  const target = request.targetId ? ` target:${sanitizeRuntimeActivity(request.targetId)}` : '';
  const summary = sanitizeRuntimeActivity(request.summary);
  return `${request.id} [${request.status}/${request.kind}]${target} ${summary}`;
}

function cloneRenderPermissionRequest(request: ZergPermissionRequest): ZergPermissionRequest {
  return { ...request };
}

function isRenderPermissionRequest(value: unknown): value is ZergPermissionRequest {
  return isPlainRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.status === 'string'
    && typeof value.requester === 'string'
    && typeof value.summary === 'string'
    && typeof value.createdAt === 'string';
}

function getInterventionTargetIds(mode: ZergState['mode'] = { automation: 'manual', interventionEnabled: true, controller: 'operator' } as ZergState['mode']): Set<string> {
  const targetIds = new Set<string>();
  const targetId = mode.activeIntervention?.targetId;

  if (targetId) {
    targetIds.add(targetId);
  }

  return targetIds;
}

function renderInterventionMessagePreview(message: string, maxLength = 48): string {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 1)}…`;
}

function renderMonitorEventLine(event: HookLifecycleEvent, width: number): string {
  const action = event.action ? ` (${event.action})` : '';
  const substate = event.substate ? `/${event.substate}` : '';
  const reason = event.substateReason ? ` reason:${sanitizeRuntimeActivity(event.substateReason)}` : '';
  const sequence = `#${event.revision ?? 'event'} `;
  const details = sanitizeRuntimeActivity(event.message || event.type) || event.type;
  return fit(`  ${sequence}${event.type}${action}${substate} ${event.createdAt} ${details}${reason}`, width);
}

export function renderAgentTree(state: ZergState, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const snapshot = state ?? ({} as ZergState);
  const agents = recordValues(snapshot.agents).sort(byLabel);
  const tasks = recordValues(snapshot.tasks).sort(byTitle);
  const teams = recordValues(snapshot.teams).sort(byLabel);
  const treeNodes = recordValues(snapshot.tree).sort(byLabel);
  const selectedNodeId = snapshot.selectedNodeId;
  const interventionTargetIds = getInterventionTargetIds(snapshot.mode);

  if (treeNodes.length > 0) {
    return renderExplicitTree(treeNodes, width, selectedNodeId, agents, teams, interventionTargetIds);
  }

  if (agents.length === 0 && tasks.length === 0 && teams.length === 0) {
    return fit('clankers tree: scaffold ready; no agents, teams, or tasks are running yet.', width);
  }

  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const agentIds = new Set(agentById.keys());
  const teamIds = new Set(teamById.keys());
  const childrenByParent = new Map<string, AgentIdentity[]>();
  const childReferencedAgentIds = new Set<string>();
  const tasksByOwner = new Map<string, TaskRecord[]>();
  const teamsByParent = new Map<string, TeamIdentity[]>();
  const agentsByTeam = new Map<string, AgentIdentity[]>();
  const tasksByTeam = new Map<string, TaskRecord[]>();
  const renderedTeams = new Set<string>();
  const renderedAgents = new Set<string>();
  const renderedTasks = new Set<string>();
  const lines = ['clankers tree'];

  for (const agent of agents) {
    if (agent.parentId && agentIds.has(agent.parentId)) {
      addToMap(childrenByParent, agent.parentId, agent);
    }

    for (const childId of uniqueStrings(agent.childIds)) {
      const child = agentById.get(childId);
      if (child) {
        addToMap(childrenByParent, agent.id, child);
        childReferencedAgentIds.add(child.id);
      }
    }

    if (agent.teamId && teamIds.has(agent.teamId)) {
      addToMap(agentsByTeam, agent.teamId, agent);
    }
  }

  for (const task of tasks) {
    if (task.ownerAgentId && agentIds.has(task.ownerAgentId)) {
      addToMap(tasksByOwner, task.ownerAgentId, task);
    }

    if (task.teamId && teamIds.has(task.teamId)) {
      addToMap(tasksByTeam, task.teamId, task);
    }
  }

  for (const team of teams) {
    if (team.parentTeamId && teamIds.has(team.parentTeamId)) {
      addToMap(teamsByParent, team.parentTeamId, team);
    }
  }

  const renderAgent = (agent: AgentIdentity, depth: number, ancestry = new Set<string>()): void => {
    const indent = '│  '.repeat(depth);

    if (ancestry.has(agent.id)) {
      pushRenderLine(lines, renderCycleLine('agent', agent.label, width, `${indent}└─`), width);
      return;
    }

    if (renderedAgents.has(agent.id)) {
      return;
    }

    if (!pushRenderLine(lines, renderAgentLine(agent, width, `${indent}├─`, selectedNodeId, interventionTargetIds), width)) {
      return;
    }

    renderedAgents.add(agent.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(agent.id);

    for (const child of uniqueById(childrenByParent.get(agent.id) ?? []).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderAgent(child, depth + 1, nextAncestry);
    }

    for (const task of (tasksByOwner.get(agent.id) ?? []).sort(byTitle)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      if (renderedTasks.has(task.id)) {
        continue;
      }
      if (!pushRenderLine(lines, renderTaskLine(task, width, `${'│  '.repeat(depth + 1)}└─`, selectedNodeId), width)) {
        return;
      }
      renderedTasks.add(task.id);
    }
  };

  const renderTeam = (team: TeamIdentity, depth: number, ancestry = new Set<string>()): void => {
    const indent = '│  '.repeat(depth);

    if (ancestry.has(team.id)) {
      pushRenderLine(lines, renderCycleLine('team', team.label, width, `${indent}└─`), width);
      return;
    }

    if (renderedTeams.has(team.id)) {
      return;
    }

    if (!pushRenderLine(lines, renderTeamLine(team, width, `${indent}├─`, selectedNodeId, interventionTargetIds), width)) {
      return;
    }

    renderedTeams.add(team.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(team.id);

    for (const childTeam of (teamsByParent.get(team.id) ?? []).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderTeam(childTeam, depth + 1, nextAncestry);
    }

    for (const agent of collectTeamAgents(team, agentById, agentsByTeam).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderAgent(agent, depth + 1);
    }

    for (const task of collectTeamTasks(team, taskById, tasksByTeam).sort(byTitle)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      if (renderedTasks.has(task.id)) {
        continue;
      }
      if (!pushRenderLine(lines, renderTaskLine(task, width, `${'│  '.repeat(depth + 1)}└─`, selectedNodeId), width)) {
        return;
      }
      renderedTasks.add(task.id);
    }
  };

  for (const team of teams.filter((candidate) => !candidate.parentTeamId || !teamIds.has(candidate.parentTeamId))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderTeam(team, 0);
  }

  for (const team of teams) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderTeam(team, 0);
  }

  for (const agent of agents.filter((candidate) => (!candidate.parentId || !agentIds.has(candidate.parentId)) && !childReferencedAgentIds.has(candidate.id))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderAgent(agent, 0);
  }

  for (const agent of agents) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderAgent(agent, 0);
  }

  for (const task of tasks.filter((candidate) => !renderedTasks.has(candidate.id) && (!candidate.ownerAgentId || !agentIds.has(candidate.ownerAgentId)))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    if (!pushRenderLine(lines, renderTaskLine(task, width, '└─', selectedNodeId), width)) {
      break;
    }
    renderedTasks.add(task.id);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderHelp(state: ZergState, options: RenderOptions = {}): string {
  return [
    `clankers v${ZERG_EXTENSION_VERSION} command-surface scaffold`,
    `Commands: ${ZERG_COMMAND_INVOCATIONS.join(', ')}`,
    renderStatusLine(state, options),
    '',
    'Lifecycle syntax: /clankers agent create|start|progress|stop|fail|reset <agent-id> [label|activity]',
    'Lifecycle syntax: /clankers team create|start|progress|stop|fail|reset <team-id> [label|activity]',
    'Control syntax: /clankers mode status|manual|assisted|automatic|revert [reason]',
    'Control syntax: /clankers control status|controller pi|zerg|operator|readonly on|off|toggle|mode manual|assisted|automatic',
    'Permission syntax: /clankers permission status|list [all|pending|resolved]|request <kind> <target> <summary>|approve <id> [reason]|deny <id> [reason]|cancel <id> [reason]',
    'Logs syntax: /clankers logs status|list [--run <id>] [--level debug|info|warn|error] [--limit <n>] | /clankers logs show <id|run-id> [--json] | /clankers logs json [--run <id>] [--limit <n>]',
    'Registry syntax: /clankers agents [list] | show <id> | create|update <id> --prompt <text> [--model <model>] [--tools a,b] | delete <id>',
    'Config syntax: /clankers config opens the Pi overlay configuration window when available',
    'Run syntax: /clankers run <agent> <task> [--bg] [--fresh|--fork] [--concurrency <n>] (fresh is default isolated launch; native team workers default to concurrency 8; native execution rejects unsupported fork/maxTurns/fallbackModels before SDK startup; use a supported external adapter/acknowledged bridge for those capabilities) | /clankers runs [list] | /clankers runs show <run-id> | /clankers interrupt [run-id]',
    'Sessions syntax: /clankers sessions [parent-run-id] opens exact coding history with an explicit live composer | /clankers sessions list [parent-run-id] prints exact references (no resume/branch mutation)',
    'Exact message syntax: /clankers sessions send <parent> <member> <pi-id> <message-id> <steer|followUp> -- <literal body> | /clankers sessions messages <parent> <member> <pi-id> [limit] (queued is not consumed; no automatic retry/replay)',
    'Timeline syntax: /clankers timeline [list] [--team ID] [--run PARENT] [--member MEMBER] [--session PI] [--limit 1..256] (read-only retained state; receipts are not replies; no transcript scan/replay)',
    'Monitor syntax: /clankers monitor [readonly on|off|toggle|status]',
    'Intervention syntax: /clankers intervene agent <agent-id> <message> | /clankers intervene subagent <agent-id> <message> | /clankers intervene leader <team-id> <message>',
    'Available now: slash-free Pi command registration, aliases, lifecycle state updates, mode/intervention/monitor/control/config commands, runtime health/activity summaries, scaffold status/tree output, thinking-step parsing, text rendering, and Pi event-bus observation.',
    'Live monitor/config TUI overlays are rendered with ctx.ui.custom when available; fall back to text output otherwise.',
  ].join('\n');
}

export function renderPermissionQueueStatus(queue: ZergPermissionQueueState, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const pending = queue.requests.filter((request) => request.status === 'pending');
  const latest = pending.at(-1);
  const lines = [
    'permission queue',
    `pending: ${queue.pendingCount}`,
    `total: ${queue.requests.length}`,
    `max: ${queue.maxRequests}`,
    `latest: ${latest ? renderPermissionRequestInline(latest) : 'none'}`,
  ];

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderPermissionQueueList(queue: ZergPermissionQueueState, filter: 'all' | 'pending' | 'resolved' = 'pending', options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const requests = queue.requests.filter((request) => filter === 'all'
    ? true
    : filter === 'pending'
      ? request.status === 'pending'
      : request.status !== 'pending');

  if (requests.length === 0) {
    return fit(`permission queue: no ${filter} requests`, width);
  }

  const lines = [`permission requests (${filter}):`];
  for (const request of requests.slice(-20)) {
    lines.push(`- ${renderPermissionRequestInline(request)}`);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderAgentDefinitionsList(definitions: ZergAgentDefinition[], options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;

  if (definitions.length === 0) {
    return fit('No agent definitions are currently registered.', width);
  }

  const lines = ['agent definitions:'];

  for (const definition of definitions) {
    const promptHint = definition.prompt.trim();
    const suffix = definition.description || (promptHint ? `prompt: ${promptHint.slice(0, 32)}${promptHint.length > 32 ? '…' : ''}` : 'no prompt');
    const model = definition.model ? ` model:${definition.model}` : '';
    const maxTurns = definition.maxTurns ? ` max-turns:${definition.maxTurns}` : '';
    const line = `- ${definition.id} (${definition.source}) ${definition.label}${model}${maxTurns} | ${suffix}`;
    lines.push(line);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderAgentDefinitionSummary(definition: ZergAgentDefinition, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const lines = [
    `agent definition: ${definition.id}`,
    `label: ${definition.label}`,
    `source: ${definition.source}`,
    `description: ${definition.description ?? 'none'}`,
    `model: ${definition.model ?? 'default'}`,
    `fallback-models: ${definition.fallbackModels?.join(', ') || 'none'}`,
    `max-turns: ${definition.maxTurns ?? 'default'}`,
    `tools: ${definition.tools?.join(', ') || 'default'}`,
    `disallowed-tools: ${definition.disallowedTools?.join(', ') || 'none'}`,
    `permission-mode: ${definition.permissionMode ?? 'inherit'}`,
  ];

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderZergSubagentRunList(runs: readonly ZergSubagentRunSnapshot[], options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;

  if (runs.length === 0) {
    return fit('No subagent runs are currently known.', width);
  }

  const lines = ['subagent runs:'];

  for (const run of runs) {
    const task = run.task ? ` task:${run.task}` : '';
    const label = run.agentLabel ? ` label:${run.agentLabel}` : '';
    const launchMode = run.launchMode ? ` mode:${run.launchMode}` : '';
    const taskId = run.taskId ? ` task-id:${run.taskId}` : '';
    const model = typeof run.metadata?.model === 'string' ? ` model:${run.metadata.model}` : '';
    const substate = run.substate ? `/${run.substate}` : '';
    const startedAt = run.startedAt ? ` started:${run.startedAt}` : '';
    const completedAt = run.completedAt ? ` completed:${run.completedAt}` : '';
    const memberSummary = run.memberProgress?.length ? ` members:${run.memberProgress.map((member) => `${member.agentId}:${member.status}`).join(',')}` : '';
    lines.push(`- ${run.runId} (${run.status}${substate}) agent:${run.agentId}${label}${launchMode}${model}${task}${taskId}${startedAt}${completedAt}${memberSummary}`);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderZergSubagentRunSummary(run: ZergSubagentRunSnapshot, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const lines = [
    `subagent run: ${run.runId}`,
    `agent: ${run.agentId}`,
    `label: ${run.agentLabel ?? 'unknown'}`,
    `status: ${run.status}${run.substate ? `/${run.substate}` : ''}`,
    ...(run.agentDefinitionId ? [`agent-definition-id: ${run.agentDefinitionId}`] : []),
    ...(run.substateReason ? [`substate-reason: ${sanitizeRuntimeActivity(run.substateReason)}`] : []),
    ...(run.taskId ? [`task-id: ${run.taskId}`] : []),
    ...(run.launchMode ? [`launch-mode: ${run.launchMode}`] : []),
    `model: ${typeof run.metadata?.model === 'string' ? run.metadata.model : 'default'}`,
    `fallback-models: ${Array.isArray(run.metadata?.fallbackModels) ? run.metadata.fallbackModels.join(', ') : 'none'}`,
    `max-turns: ${typeof run.metadata?.maxTurns === 'number' ? run.metadata.maxTurns : 'default'}`,
    `task: ${run.task ?? 'none'}`,
    `started-at: ${run.startedAt ?? 'unknown'}`,
    `updated-at: ${run.updatedAt ?? 'unknown'}`,
    `completed-at: ${run.completedAt ?? 'unknown'}`,
    ...(run.finalSummary ? [`final-summary: ${sanitizeRuntimeActivity(run.finalSummary)}`] : []),
    ...(run.errorSummary ? [`error-summary: ${sanitizeRuntimeActivity(run.errorSummary)}`] : []),
  ];

  if (run.memberProgress?.length) {
    lines.push('member-progress:');
    for (const member of run.memberProgress) {
      lines.push(`- ${member.agentId}: ${member.status}${member.handoffPath ? ` handoff:${member.handoffPath}` : ''}${member.message ? ` ${sanitizeRuntimeActivity(member.message)}` : ''}`);
    }
  }

  if (run.nativeSessions?.length) {
    lines.push(`native-sessions: ${run.nativeSessions.length} (locators; transcript may be absent)`);
    for (const reference of run.nativeSessions.slice(0, 8)) {
      lines.push(`- ${sanitizeRuntimeActivity(reference.memberRunId)}: ${reference.attachment} pi:${sanitizeRuntimeActivity(reference.piSessionId)}`);
      lines.push(`  file: ${sanitizeRuntimeActivity(reference.sessionFile)}`);
    }
    if (run.nativeSessions.length > 8) lines.push(`  ... ${run.nativeSessions.length - 8} more; use structured runs.show`);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

function renderAgentLine(agent: AgentIdentity, width: number, prefix: string, selectedNodeId: string | undefined, interventionTargetIds: Set<string> = new Set()): string {
  const kind = agent.kind ?? 'agent';
  const status = agent.status ?? 'unknown';
  const runtime = renderRuntimeHint(agent.runtime);
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, agent.id), interventionTargetIds.has(agent.id))} ${safeLabel(agent.label, agent.id)} [${kind}/${renderStatusWithSubstate(status, agent.runtime)}]${runtime}`, width);
}

function renderTeamLine(team: TeamIdentity, width: number, prefix: string, selectedNodeId: string | undefined, interventionTargetIds: Set<string> = new Set()): string {
  const kind = team.kind ?? 'team';
  const status = team.status ?? 'unknown';
  const runtime = renderRuntimeHint(team.runtime);
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, team.id), interventionTargetIds.has(team.id))} team ${safeLabel(team.label, team.id)} [${kind}/${renderStatusWithSubstate(status, team.runtime)}]${runtime}`, width);
}

function renderTaskLine(task: TaskRecord, width: number, prefix: string, selectedNodeId?: string): string {
  const status = task.status ?? 'unknown';
  const blockers = task.blockedBy?.length ? ` blocked-by:${task.blockedBy.join(',')}` : '';
  const reason = task.substateReason ? ` reason:${sanitizeRuntimeActivity(task.substateReason)}` : '';
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, task.id), false)} task ${safeLabel(task.title, task.id)} [${task.substate ? `${status}/${task.substate}` : status}]${blockers}${reason}`, width);
}

function renderExplicitTree(
  nodes: ZergTreeNode[],
  width: number,
  selectedNodeId: string | undefined,
  agents: AgentIdentity[],
  teams: TeamIdentity[],
  interventionTargetIds: Set<string>,
): string {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, ZergTreeNode[]>();
  const missingChildrenByParent = new Map<string, string[]>();
  const referenced = new Set<string>();
  const visited = new Set<string>();
  const lines = ['clankers tree'];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  for (const node of nodes) {
    for (const childId of uniqueStrings(node.childIds)) {
      const child = nodeById.get(childId);
      if (!child) {
        addToMap(missingChildrenByParent, node.id, childId);
        continue;
      }
      addToMap(childrenByParent, node.id, child);
      referenced.add(child.id);
    }
  }

  for (const node of nodes) {
    if (node.parentId && nodeById.has(node.parentId)) {
      addToMap(childrenByParent, node.parentId, node);
      referenced.add(node.id);
    }
  }

  const renderNode = (node: ZergTreeNode, depth: number, ancestry = new Set<string>()): void => {
    const indent = '│  '.repeat(depth);

    if (ancestry.has(node.id)) {
      pushRenderLine(lines, renderCycleLine(node.kind, node.label, width, `${indent}└─`), width);
      return;
    }

    if (visited.has(node.id)) {
      return;
    }

    if (!pushRenderLine(
      lines,
      renderTreeNodeLine(
        node,
        width,
        `${indent}├─`,
        selectedNodeId,
        interventionTargetIds,
        node.parentId && !nodeById.has(node.parentId) ? node.parentId : undefined,
        findExplicitTreeRuntimeRef(node, agentById, teamById),
      ),
      width,
    )) {
      return;
    }

    visited.add(node.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.id);

    for (const child of uniqueById(childrenByParent.get(node.id) ?? []).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderNode(child, depth + 1, nextAncestry);
    }

    for (const missingChildId of uniqueStrings(missingChildrenByParent.get(node.id)).sort()) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      if (!pushRenderLine(lines, renderMissingChildLine(missingChildId, width, `${'│  '.repeat(depth + 1)}└─`), width)) {
        return;
      }
    }
  };

  for (const node of nodes.filter((candidate) => (!candidate.parentId || !nodeById.has(candidate.parentId)) && !referenced.has(candidate.id))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderNode(node, 0);
  }

  for (const node of nodes) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderNode(node, 0);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

function renderTreeNodeLine(
  node: ZergTreeNode,
  width: number,
  prefix: string,
  selectedNodeId: string | undefined,
  interventionTargetIds: Set<string>,
  orphanParent: string | undefined,
  runtime: AgentIdentity['runtime'] | TeamIdentity['runtime'] | undefined,
): string {
  const status = node.status ?? 'unknown';
  const marker = statusMarker(status, isSelected(selectedNodeId, node.id, node.refId), interventionTargetIds.has(node.id) || Boolean(node.refId && interventionTargetIds.has(node.refId)));
  const orphan = orphanParent ? ` orphan-parent:${orphanParent}` : '';
  const runtimeHint = renderRuntimeHint(runtime);
  return fit(`${prefix}${marker} ${node.kind} ${safeLabel(node.label, node.id)} [${renderStatusWithSubstate(status, runtime)}]${orphan}${runtimeHint}`, width);
}

function findExplicitTreeRuntimeRef(
  node: ZergTreeNode,
  agentById: Map<string, AgentIdentity>,
  teamById: Map<string, TeamIdentity>,
): AgentIdentity['runtime'] | TeamIdentity['runtime'] | undefined {
  if (node.kind === 'agent') {
    const agentByRef = node.refId ? agentById.get(node.refId) : undefined;
    return (agentByRef ?? agentById.get(node.id))?.runtime;
  }

  if (node.kind === 'team') {
    const teamByRef = node.refId ? teamById.get(node.refId) : undefined;
    return (teamByRef ?? teamById.get(node.id))?.runtime;
  }

  return undefined;
}

function renderMissingChildLine(childId: string, width: number, prefix: string): string {
  return fit(`${prefix}⚠ missing-child:${safeLabel(childId, 'unknown')} [missing]`, width);
}

function renderCycleLine(kind: string, label: string | undefined, width: number, prefix: string): string {
  return fit(`${prefix}↻ ${kind} ${safeLabel(label, 'unknown')} [cycle]`, width);
}

function pushRenderLine(lines: string[], line: string, width: number): boolean {
  if (lines.length < MAX_RENDER_LINES - 1) {
    lines.push(line);
    return true;
  }

  if (lines.length < MAX_RENDER_LINES) {
    lines.push(renderTruncationLine(width));
  }

  return false;
}

function isRenderLineLimitReached(lines: string[]): boolean {
  return lines.length >= MAX_RENDER_LINES;
}

function renderTruncationLine(width: number): string {
  return fit(`└─… render output truncated at ${MAX_RENDER_LINES} lines`, width);
}


function renderRuntimeHint(runtime: AgentIdentity['runtime'] | TeamIdentity['runtime']): string {
  if (!runtime) {
    return '';
  }

  const parts = [`health:${runtime.health}`];
  if (runtime.substate) {
    parts.push(`state:${runtime.substate}`);
  }
  const reason = runtime.substateReason ? sanitizeRuntimeActivity(runtime.substateReason) : '';
  if (reason) {
    parts.push(`reason:${reason}`);
  }
  const lastActivity = runtime.lastActivity ? sanitizeRuntimeActivity(runtime.lastActivity) : '';

  if (lastActivity) {
    parts.push(`last:${lastActivity}`);
  }

  return ` {${parts.join(' ')}}`;
}

function renderLatestRuntimeActivity(items: Array<AgentIdentity | TeamIdentity>): string | undefined {
  const latestDisplayable = items
    .map((item) => ({
      label: safeLabel(item.label, item.id),
      runtime: item.runtime,
    }))
    .filter((item): item is { label: string; runtime: NonNullable<AgentIdentity['runtime']> } => Boolean(item.runtime?.lastActivity))
    .map((item) => ({
      label: item.label,
      runtime: item.runtime,
      activity: sanitizeRuntimeActivity(item.runtime.lastActivity ?? ''),
    }))
    .filter((item): item is { label: string; runtime: NonNullable<AgentIdentity['runtime']>; activity: string } => Boolean(item.activity))
    .sort((left, right) => runtimeActivityCompare(left.runtime, right.runtime))[0];

  if (!latestDisplayable) {
    return undefined;
  }

  const substate = latestDisplayable.runtime.substate ? ` [${latestDisplayable.runtime.substate}]` : '';
  const reason = latestDisplayable.runtime.substateReason ? ` ${sanitizeRuntimeActivity(latestDisplayable.runtime.substateReason)}` : '';
  return `${latestDisplayable.label}: ${latestDisplayable.activity}${substate}${reason}`;
}

function renderStatusWithSubstate(status: string, runtime: AgentIdentity['runtime'] | TeamIdentity['runtime']): string {
  return runtime?.substate ? `${status}/${runtime.substate}` : status;
}

function runtimeActivityCompare(
  left: NonNullable<AgentIdentity['runtime']>,
  right: NonNullable<AgentIdentity['runtime']>,
): number {
  const timestampCompare = runtimeActivityTimestamp(right).localeCompare(runtimeActivityTimestamp(left));
  if (timestampCompare !== 0) {
    return timestampCompare;
  }

  const leftSequence = left.lastActivitySequence ?? left.lastActivityRevision ?? 0;
  const rightSequence = right.lastActivitySequence ?? right.lastActivityRevision ?? 0;
  const sequenceCompare = rightSequence - leftSequence;
  if (sequenceCompare !== 0) {
    return sequenceCompare;
  }

  return (right.lastActivity ?? '').localeCompare(left.lastActivity ?? '');
}

function runtimeActivityTimestamp(runtime: NonNullable<AgentIdentity['runtime']>): string {
  return runtime.lastActivityAt ?? runtime.updatedAt;
}

function hasUnhealthyRuntime(item: AgentIdentity | TeamIdentity): boolean {
  return item.runtime?.health === 'blocked'
    || item.runtime?.health === 'degraded'
    || item.runtime?.health === 'failed'
    || item.status === 'blocked'
    || item.status === 'needs-attention'
    || item.status === 'failed';
}

function fit(value: string, width = DEFAULT_WIDTH): string {
  if (width <= 3 || value.length <= width) {
    return value;
  }
  return `${value.slice(0, width - 1)}…`;
}

function sanitizeRuntimeActivity(activity: string): string {
  return activity
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function recordValues<T>(values: Record<string, T> | undefined): T[] {
  if (!values) {
    return [];
  }

  return Object.values(values).filter((value): value is T => value !== undefined && value !== null);
}

function addToMap<T>(map: Map<string, T[]>, key: string | undefined, item: T): void {
  if (!key) {
    return;
  }

  const values = map.get(key) ?? [];
  values.push(item);
  map.set(key, values);
}

function collectTeamAgents(team: TeamIdentity, agentById: Map<string, AgentIdentity>, agentsByTeam: Map<string, AgentIdentity[]>): AgentIdentity[] {
  const collected: AgentIdentity[] = [];

  pushExistingAgent(collected, agentById, team.leaderAgentId);
  for (const memberId of uniqueStrings(team.memberAgentIds)) {
    pushExistingAgent(collected, agentById, memberId);
  }
  for (const agent of agentsByTeam.get(team.id) ?? []) {
    pushUniqueById(collected, agent);
  }

  return collected;
}

function collectTeamTasks(team: TeamIdentity, taskById: Map<string, TaskRecord>, tasksByTeam: Map<string, TaskRecord[]>): TaskRecord[] {
  const collected: TaskRecord[] = [];

  for (const taskId of uniqueStrings(team.taskIds)) {
    const task = taskById.get(taskId);
    if (task) {
      pushUniqueById(collected, task);
    }
  }

  for (const task of tasksByTeam.get(team.id) ?? []) {
    pushUniqueById(collected, task);
  }

  return collected;
}

function pushExistingAgent(collected: AgentIdentity[], agentById: Map<string, AgentIdentity>, agentId: string | undefined): void {
  const agent = agentId ? agentById.get(agentId) : undefined;
  if (agent) {
    pushUniqueById(collected, agent);
  }
}

function pushUniqueById<T extends { id: string }>(collected: T[], item: T): void {
  if (!collected.some((candidate) => candidate.id === item.id)) {
    collected.push(item);
  }
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const collected: T[] = [];
  for (const item of items) {
    pushUniqueById(collected, item);
  }
  return collected;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

function statusMarker(status: string | undefined, selected: boolean, interventionTarget: boolean): string {
  if (selected) {
    return '▶';
  }

  if (interventionTarget) {
    return '◉';
  }

  return status === 'running' ? '●' : ' ';
}

function isSelected(selectedNodeId: string | undefined, ...candidateIds: Array<string | undefined>): boolean {
  return Boolean(selectedNodeId && candidateIds.includes(selectedNodeId));
}

function safeLabel(label: string | undefined, fallback: string): string {
  return label?.trim() || fallback;
}

function byLabel<T extends { label: string }>(left: T, right: T): number {
  return safeLabel(left.label, '').localeCompare(safeLabel(right.label, ''));
}

function byTitle(left: TaskRecord, right: TaskRecord): number {
  return safeLabel(left.title, '').localeCompare(safeLabel(right.title, ''));
}

export function renderNativeSessionReferences(references: ZergNativeSessionReference[], options: RenderOptions = {}): string {
  const lines = ['Native Pi sessions (attachment is not proof of a live observer or durable file):'];
  for (const ref of references.slice(0, 40)) {
    lines.push(`${ref.agentDefinitionId} | parent:${ref.parentRunId} | member:${ref.memberRunId} | pi:${ref.piSessionId} | ${ref.attachment}`);
  }
  if (!references.length) lines.push('No native session references available.');
  if (references.length > 40) lines.push(`${references.length - 40} additional references omitted.`);
  return lines.map((line) => fit(sanitizeRuntimeActivity(line), options.width ?? DEFAULT_WIDTH)).join('\n');
}

/** Width-bounded text fallback for the same typed read projection as the TUI. */
export function renderZergTimeline(timeline: ZergTimelineSnapshot, options: RenderOptions = {}): string {
  const width = Number.isFinite(options.width) ? Math.max(1, Math.min(512, Math.floor(options.width!))) : DEFAULT_WIDTH;
  const clean = (value: string, maximum = 256) => sanitizeNativeTranscriptText(value.slice(0, maximum)).replace(/\s+/g, ' ').slice(0, maximum);
  const abbreviation = (value: string | undefined, maximum = 18) => {
    if (!value) return '-';
    const safe = clean(value);
    return safe.length <= maximum ? safe : `${safe.slice(0, Math.ceil((maximum - 1) / 2))}…${safe.slice(-Math.floor((maximum - 1) / 2))}`;
  };
  const header = [
    `Team/run timeline: ${timeline.entries.length} rows; ${timeline.omittedEntries} known matching projection rows omitted; ${timeline.clippedEntries} clipped`,
    'Actor/run/member/Pi abbreviations are display-only; exact identities remain in structured data/details.',
  ];
  const notices = timeline.limitations.slice(0, 8).map((text) => clean(text, 512));
  const availableLines = MAX_RENDER_LINES - header.length - notices.length - 1;
  const groups: string[][] = [];
  let usedLines = 0;
  let shownRows = 0;
  // Select bounded complete row groups from the NEWEST tail, then restore the
  // source's chronological ordering. Display omissions are not projection loss.
  for (let index = timeline.entries.length - 1; index >= Math.max(0, timeline.entries.length - 256); index--) {
    const entry = timeline.entries[index]!;
    const type = entry.kind === 'operator-receipt' ? 'receipt' : entry.kind;
    const actor = entry.kind === 'operator-receipt' ? `operator→${abbreviation(entry.agentDefinitionId, 16)}` : abbreviation(entry.agentDefinitionId, 20);
    const label = entry.kind === 'native-output' ? 'native output/handoff (NOT addressed reply)'
      : entry.kind === 'operator-receipt' ? `operator receipt/current status ${entry.status}/${entry.persistence}`
      : entry.kind === 'recorded-event' ? 'recorded event' : `current snapshot (NOT historical event): ${entry.status}`;
    const content = entry.bodyPreview || entry.summary;
    const group = [
      `[${type}] ${actor} run:${abbreviation(entry.parentRunId)} member:${abbreviation(entry.memberRunId)} Pi:${abbreviation(entry.piSessionId, 14)}${entry.exactKey ? '' : ' unlinked'}${entry.clipped ? ' [clipped]' : ''}`,
      `content${content.length > 256 ? ' (display clipped)' : ''}: ${clean(content)}`,
      `${entry.timestamp ?? 'unknown time'} (${entry.timestampMeaning}) | ${label}`,
    ];
    if (entry.kind === 'operator-receipt') group.push(`message ID: ${clean(entry.messageId)}; mode:${entry.mode}; updated:${entry.updatedAt || 'unknown time'}`);
    if (usedLines + group.length > availableLines) break;
    groups.push(group); usedLines += group.length; shownRows++;
  }
  const displayOmitted = timeline.entries.length - shownRows;
  const lines = [...header, ...groups.reverse().flat()];
  if (!timeline.entries.length) lines.push('No matching retained timeline rows (filters never fall back to all).');
  else if (displayOmitted) lines.push(`Display omitted ${displayOmitted} older row(s); newest tail retained (separate from projection omissions).`);
  lines.push(...notices);
  return lines.map((line) => truncateToWidth(sanitizeNativeTranscriptText(line.slice(0, 4096)), width)).join('\n');
}
