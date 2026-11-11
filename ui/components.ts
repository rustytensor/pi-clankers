import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { AgentStatus, ClankersRuntimeHealth } from '../types.js';

export interface UiThemeLike {
  fg?(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

export interface RenderPaneOptions {
  title: string;
  focused?: boolean;
  width: number;
  height?: number;
  theme?: UiThemeLike;
}

export function sanitizeUiText(value: unknown): string {
  // Retained/recovered fields are data, never terminal instructions. Bound before regex work.
  const text = typeof value === 'string' ? value.slice(0, 4096)
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  return text
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/** Host failures may be arbitrary, even objects with throwing accessors/coercion. */
export function uiErrorText(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? error.message : error;
    return typeof message === 'string' ? sanitizeUiText(`${error instanceof Error ? 'Error: ' : ''}${message.slice(0, 256)}`).slice(0, 256)
      : 'Unknown failure (non-text error).';
  } catch { return 'Unknown failure (unreadable error).'; }
}
export function fitLine(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const clean = sanitizeUiText(value);
  if (clean.length <= safeWidth) {
    return clean.padEnd(safeWidth, ' ');
  }
  return `${clean.slice(0, Math.max(0, safeWidth - 1))}…`;
}

export function fitRawLine(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  return truncateToWidth(value, safeWidth, '', true);
}

export function renderPane(lines: readonly string[], options: RenderPaneOptions): string[] {
  const width = Math.max(8, Math.floor(options.width));
  const title = `${options.focused ? '◆' : '◇'} ${options.title}`;
  const borderColor = options.focused ? 'borderAccent' : 'borderMuted';
  const titleColor = options.focused ? 'accent' : 'muted';
  const border = styleText(options.theme, borderColor, `${options.focused ? '╔' : '┌'}${'═'.repeat(Math.max(0, width - 2))}${options.focused ? '╗' : '┐'}`);
  const bottom = styleText(options.theme, borderColor, `${options.focused ? '╚' : '└'}${'═'.repeat(Math.max(0, width - 2))}${options.focused ? '╝' : '┘'}`);
  const side = styleText(options.theme, borderColor, '│');
  const bodyHeight = options.height === undefined ? lines.length : Math.max(0, options.height - 3);
  const body = lines.slice(0, bodyHeight).map((line) => `${side}${fitRawLine(line, width - 2)}${side}`);
  while (body.length < bodyHeight) {
    body.push(`${side}${' '.repeat(Math.max(0, width - 2))}${side}`);
  }
  return [border, `${side}${fitRawLine(styleText(options.theme, titleColor, fitLine(title, width - 2)), width - 2)}${side}`, ...body, bottom];
}

export function columns(left: readonly string[], right: readonly string[], width: number): string[] {
  const safeWidth = Math.max(42, Math.floor(width));
  const gap = '  ';
  const leftWidth = Math.max(30, Math.floor((safeWidth - gap.length) * 0.42));
  const rightWidth = Math.max(10, safeWidth - gap.length - leftWidth);
  const rows = Math.max(left.length, right.length);
  const output: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    output.push(`${fitRawLine(left[index] ?? '', leftWidth)}${gap}${fitRawLine(right[index] ?? '', rightWidth)}`);
  }
  return output;
}

export function displayWidth(value: string): number {
  return visibleWidth(value);
}

export function styleText(theme: UiThemeLike | undefined, color: string, text: string): string {
  return typeof theme?.fg === 'function' ? theme.fg(color, text) : text;
}

export function boldText(theme: UiThemeLike | undefined, text: string): string {
  return typeof theme?.bold === 'function' ? theme.bold(text) : text;
}

export function statusGlyph(status?: AgentStatus | string): string {
  switch (status) {
    case 'running': return '▶';
    case 'blocked': return '■';
    case 'needs-attention': return '!';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'idle': return '○';
    default: return '·';
  }
}

export function healthGlyph(health?: ClankersRuntimeHealth): string {
  switch (health) {
    case 'healthy': return 'healthy';
    case 'degraded': return 'degraded';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    default: return 'unknown';
  }
}

export function visibleSlice<T>(items: readonly T[], selectedIndex: number, height: number): { rows: T[]; offset: number; selectedIndex: number } {
  const clampedHeight = Math.max(1, Math.floor(height));
  const clampedSelected = items.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex, items.length - 1));
  const maxOffset = Math.max(0, items.length - clampedHeight);
  let offset = Math.max(0, Math.min(clampedSelected - Math.floor(clampedHeight / 2), maxOffset));
  if (clampedSelected < offset) {
    offset = clampedSelected;
  } else if (clampedSelected >= offset + clampedHeight) {
    offset = Math.max(0, clampedSelected - clampedHeight + 1);
  }
  return {
    rows: items.slice(offset, offset + clampedHeight),
    offset,
    selectedIndex: clampedSelected,
  };
}
