/**
 * Status bar preview — replicates the real implementation.
 *
 * Renders status bars built from the section model (statusbar.md), colored
 * with the REAL theme system (src/ui/theme) + the fixed theme-independent
 * mode-glyph colors from AgentUI.tsx.
 *
 * The mode chip replicates the real implementation (AgentUI.tsx:3077-3085):
 *   - default mode → NO chip (the real app hides it entirely)
 *   - plan        → `● PLAN `  in orange  #ff9d3f
 *   - automode    → `● AUTO `  in red     #ff6b6b
 *   - yolo        → `● YOLO `  in purple  #c678dd
 *
 * The session name (from /rename or --rename) appears as an inset in the TOP
 * RIGHT of the composer's top rule (the `▔▔▔` bar above the input), with a
 * DETERMINISTIC emoji derived from the name — the same name always gets the
 * same emoji, so humans can recognize sessions at a glance. The emoji helper
 * is the REAL production module: src/ui/statusbar/sessionEmoji.ts.
 *
 * Scenarios:
 *   1. Idle on main        — real data (cwd, git branch, model) + random session
 *   2. Idle in a worktree  — simulated worktree with an open PR + random session
 *   3. Working             — spinner + status replaces the identity sections
 *   4-6. Mode chips        — plan / automode / yolo, as the app renders them
 *   7. Cockpit             — ALL sections enabled, rich two-line layout
 *   8. Priority drop       — narrow terminal, sections dropped by tier
 *   9. Emoji gallery       — many names → their deterministic emoji
 *
 * Each example gets its own RANDOM session name (seeded by the clock, so it
 * changes on every run). At least two examples are forced to share a name so
 * the deterministic-emoji rule is visible: same name → same emoji, different
 * name → different emoji.
 *
 * Data is real, not mocked:
 *   - project    = basename of the current working directory
 *   - git        = current branch (git symbolic-ref --short HEAD), or
 *                  worktree:<name> when inside a git worktree
 *   - gitAhead   = unpushed commits (git rev-list --count @{upstream}..HEAD)
 *   - gitBehind  = commits behind remote (git rev-list --count HEAD..@{upstream})
 *   - dirty      = changed file count (git status --porcelain | wc -l)
 *   - pr         = open PR for current branch (gh pr view --json number,title)
 *   - model      = the configured model for the active provider
 *                  (read from ~/.autohand/config.json, or $AUTOHAND_CONFIG)
 *   - provider   = plan tier from config (Max/Pro/Free), if available
 *   - session    = a random name from a curated pool (see NAME_POOL)
 *   - context    = a placeholder bar (no live context data in a preview)
 *   - tokens     = simulated cumulative up/down (no live token data in a preview)
 *   - cost       = derived from simulated token count
 *   - clock      = simulated elapsed session time
 *   - mcp        = simulated MCP server connection state
 *   - diff       = session diff stats (git diff --numstat HEAD)
 *   - research   = simulated auto-research experiment state
 *   - tasks      = todo_write activity (read from .autohand/agents/tasks/todos.json)
 *
 * The bar spans the full width: identity sections flow left-to-right, and
 * trailing sections are right-aligned to the terminal edge. When the terminal
 * is too narrow, the three-stage overflow pipeline fires:
 *   1. Context-aware hiding (sections with no data hide themselves)
 *   2. Priority drop (lowest tier dropped first, reverse config order within tier)
 *   3. Flow-wrap (dropped sections promote to line 2, then wrap to line 3)
 *
 * Run:  bun docs/design/statusbar-preview.ts [theme] [width] [session-name]
 *   theme       — any built-in theme name (default: aurora).
 *   width       — column width to render at (default: full terminal width).
 *   session-name — override the random session name for all examples.
 *
 * This is a design artifact, not production code.
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { loadTheme } from '../../src/ui/theme/loader.js';
import type { Theme } from '../../src/ui/theme/Theme.js';
import type { ColorToken } from '../../src/ui/theme/types.js';
import { SESSION_EMOJI, PROJECT_EMOJI, emojiForName, emojiForProject } from '../../src/ui/statusbar/sessionEmoji.js';

// ── fixed mode-glyph colors (theme-independent, from AgentUI.tsx) ─────────
const MODE = {
  plan: '#ff9d3f',
  automode: '#ff6b6b',
  yolo: '#c678dd',
} as const;

// ── ANSI helpers (truecolor) ──────────────────────────────────────────────
const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
};
const fgHex = (hex: string, text: string): string => {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};
const bold = (text: string): string => `\x1b[1m${text}\x1b[22m`;
const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;

// ── theme-backed helpers ──────────────────────────────────────────────────
const theme: Theme = loadTheme(process.argv[2] ?? 'aurora');
const fg = (token: ColorToken, text: string): string => theme.fg(token, text);
const fgBg = (fgToken: ColorToken, bgToken: ColorToken, text: string): string =>
  theme.fgBg(fgToken, bgToken, text);

// Visible width ignores ANSI escapes so wrapping measures real characters.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleWidth = (text: string): number => text.replace(ANSI_RE, '').length;

// ── real data ─────────────────────────────────────────────────────────────
const cwd = process.cwd();
const projectName = basename(cwd);
const projectEmoji = emojiForProject(cwd);

function tryExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function resolveGitLabel(): string {
  const branch = tryExec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch) return branch;
  const insideWorktree = tryExec('git', ['rev-parse', '--is-inside-work-tree']);
  return insideWorktree === 'true' ? `worktree:${projectName}` : '';
}

function resolveGitAhead(): number {
  const count = tryExec('git', ['rev-list', '--count', '@{upstream}..HEAD']);
  const n = parseInt(count, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveGitBehind(): number {
  const count = tryExec('git', ['rev-list', '--count', 'HEAD..@{upstream}']);
  const n = parseInt(count, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveDirtyCount(): number {
  const output = tryExec('git', ['status', '--porcelain']);
  if (!output) return 0;
  return output.split('\n').filter(Boolean).length;
}

function resolvePrNumber(): number | null {
  const output = tryExec('gh', ['pr', 'view', '--json', 'number']);
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as { number?: number };
    return parsed.number ?? null;
  } catch {
    return null;
  }
}

function resolveModelName(): string {
  try {
    const configPath = process.env.AUTOHAND_CONFIG ?? join(homedir(), '.autohand', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      provider?: string;
      [key: string]: unknown;
    };
    const provider = config.provider ?? 'openrouter';
    const providerConfig = config[provider] as { model?: string } | undefined;
    return providerConfig?.model ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveProviderTier(): string {
  try {
    const configPath = process.env.AUTOHAND_CONFIG ?? join(homedir(), '.autohand', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      provider?: string;
      plan?: string;
      [key: string]: unknown;
    };
    if (config.plan) return config.plan;
    // Heuristic: some providers embed tier info
    const provider = config.provider ?? 'openrouter';
    const providerConfig = config[provider] as { tier?: string } | undefined;
    return providerConfig?.tier ?? '';
  } catch {
    return '';
  }
}

function resolveSessionTitle(): string {
  try {
    const sessionsDir = join(homedir(), '.autohand', 'sessions');
    const index = JSON.parse(readFileSync(join(sessionsDir, 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string; projectPath: string; createdAt: string }>;
    };
    const canonicalCwd = cwd.replace(/\/+$/, '');
    const matches = index.sessions
      .filter((s) => s.projectPath.replace(/\/+$/, '') === canonicalCwd)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (matches.length === 0) return '';
    const metadata = JSON.parse(
      readFileSync(join(sessionsDir, matches[0].id, 'metadata.json'), 'utf8'),
    ) as { title?: string; summary?: string };
    return metadata.title?.trim() || metadata.summary?.trim() || '';
  } catch {
    return '';
  }
}

interface TodoTask {
  content?: string;
  status?: string;
  activeForm?: string;
}

function resolveTaskCounts(): { pending: number; total: number } {
  try {
    const todoPath = join(cwd, '.autohand', 'agents', 'tasks', 'todos.json');
    if (!existsSync(todoPath)) return { pending: 0, total: 0 };
    const todos = JSON.parse(readFileSync(todoPath, 'utf8')) as TodoTask[];
    if (!Array.isArray(todos)) return { pending: 0, total: 0 };
    const total = todos.length;
    const pending = todos.filter((t) => t.status !== 'completed').length;
    return { pending, total };
  } catch {
    return { pending: 0, total: 0 };
  }
}

function resolveDiffStats(): { added: number; removed: number } {
  const output = tryExec('git', ['diff', '--numstat', 'HEAD']);
  if (!output) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
      const a = parseInt(parts[0], 10);
      const r = parseInt(parts[1], 10);
      if (Number.isFinite(a)) added += a;
      if (Number.isFinite(r)) removed += r;
    }
  }
  return { added, removed };
}

const gitLabel = resolveGitLabel();
const gitAhead = resolveGitAhead();
const gitBehind = resolveGitBehind();
const dirtyCount = resolveDirtyCount();
const prNumber = resolvePrNumber();
const modelName = resolveModelName();
const providerTier = resolveProviderTier();
const taskCounts = resolveTaskCounts();
const diffStats = resolveDiffStats();
// --session <name> overrides the real session title for previewing.
const sessionTitle = process.argv[4] ?? resolveSessionTitle();

// ── context bar ───────────────────────────────────────────────────────────
/**
 * Filled/empty progress bar. Always shows at least one filled block when
 * usage > 0 so the bar is visible on every theme (a 2% bar used to render as
 * ten empty blocks in the border color, which vanished on dark themes).
 * Empty blocks use `muted` — more visible than `border` across themes.
 */
function contextBar(percentUsed: number, width = 10): string {
  const filled = percentUsed > 0
    ? Math.max(1, Math.round((percentUsed / 100) * width))
    : 0;
  const color: ColorToken = percentUsed > 85 ? 'error' : percentUsed > 60 ? 'warning' : 'success';
  return fg(color, '█'.repeat(filled)) + fg('muted', '░'.repeat(width - filled));
}

// ── mode chip (replicates AgentUI.tsx HelpLineSection) ────────────────────
/**
 * The real app renders the mode as `● LABEL ` in a fixed, theme-independent
 * color, and hides it entirely in default mode. `getInteractionModeLabel`
 * maps automode → 'AUTO', everything else → uppercase.
 */
function modeChip(mode: 'plan' | 'automode' | 'yolo'): string {
  const color = MODE[mode];
  const label = mode === 'automode' ? 'AUTO' : mode.toUpperCase();
  return fgHex(color, `● ${label} `);
}

// ── composer box (replicates InputLine.tsx) ───────────────────────────────
/**
 * The real composer draws a `▔` top rule and `▁` bottom rule in borderAccent
 * on userMessageBg (InputLine.tsx:26-29, 195-197). The session name sits on
 * its OWN line ABOVE the top rule, right-aligned, so the blue rule runs the
 * full width of the terminal uninterrupted.
 *
 * The cursor (`› ▊`) renders on the input line BETWEEN the two rules, not
 * above the top rule.
 */
function composerBox(sessionName: string, maxWidth: number): string[] {
  const lines: string[] = [];
  if (sessionName) {
    const label = ` ${emojiForName(sessionName)} ${sessionName} `;
    const labelWidth = visibleWidth(label);
    const padding = Math.max(0, maxWidth - labelWidth);
    lines.push(' '.repeat(padding) + fg('text', label));
  }
  const topRule = fgBg('borderAccent', 'userMessageBg', '▔'.repeat(maxWidth));
  const cursor = `${fg('accent', '›')} ${fg('warning', '▊')}`;
  const inputLine = fgBg('userMessageText', 'userMessageBg', cursor);
  const bottomRule = fgBg('borderAccent', 'userMessageBg', '▁'.repeat(maxWidth));
  lines.push(topRule, inputLine, bottomRule);
  return lines;
}

// ── section model (from statusbar.md) ─────────────────────────────────────
type SectionPriority = 'critical' | 'high' | 'normal' | 'low' | 'ambient';

interface Section {
  id: string;
  text: string;
  priority: SectionPriority;
  /** Which line this section belongs to (1 = identity, 2 = state). */
  line: 1 | 2;
}

const DEFAULT_PRIORITY: Record<string, SectionPriority> = {
  project: 'critical',
  mode: 'critical',
  git: 'high',
  context: 'high',
  model: 'high',
  worktree: 'normal',
  pr: 'normal',
  tokens: 'normal',
  clock: 'normal',
  agents: 'normal',
  tasks: 'normal',
  diff: 'normal',
  gitAhead: 'low',
  gitBehind: 'low',
  dirty: 'low',
  provider: 'low',
  cost: 'low',
  mcp: 'low',
  research: 'low',
  hints: 'ambient',
};

const PRIORITY_ORDER: SectionPriority[] = ['ambient', 'low', 'normal', 'high', 'critical'];

function section(id: string, text: string, line: 1 | 2 = 1): Section {
  return { id, text, priority: DEFAULT_PRIORITY[id] ?? 'normal', line };
}

interface Scenario {
  title: string;
  note: string;
  sections: Section[];
  /** Section ids that right-align to the terminal edge. */
  rightIds: Set<string>;
  /** The session name this example renders (random per run; see name pool). */
  sessionName: string;
}

/**
 * The session name now lives ONLY in the composer top-rule inset (see
 * composerBox). It is no longer a status-bar section, so this helper
 * returns empty. Kept for reference; remove once callers are cleaned up.
 */
function sessionSection(_name: string): Section[] {
  return [];
}

// ── random session names per example ──────────────────────────────────────
// Each example gets its own random session name (seeded by the clock, so it
// changes on every run). At least two examples are forced to share a name so
// the deterministic-emoji rule is visible: same name → same emoji, different
// name → different emoji.
const NAME_POOL = [
  'fix login bug',
  'ship the caret fix',
  'autohand login',
  'tune the status bar',
  'refactor session store',
  'chase the flaky test',
  'polish onboarding flow',
  'wire up the emoji',
  'trim the context bar',
  'rename the sessions',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(Date.now() % 2147483647);
const shuffledNames = [...NAME_POOL].sort(() => rand() - 0.5);
// Eight examples: seven distinct names + one forced duplicate of the first.
const exampleNames = [
  shuffledNames[0],
  shuffledNames[1],
  shuffledNames[2],
  shuffledNames[3],
  shuffledNames[4],
  shuffledNames[5],
  shuffledNames[6],
  shuffledNames[0],
];

// ── helper: build sections from real data ─────────────────────────────────
function buildRealSections(opts: {
  mode?: 'plan' | 'automode' | 'yolo';
  contextPercent?: number;
  agents?: number;
  showAll?: boolean;
  simulated?: {
    gitAhead?: number;
    gitBehind?: number;
    dirtyCount?: number;
    prNumber?: number;
    worktreeName?: string;
    tokensUp?: string;
    tokensDown?: string;
    cost?: string;
    clock?: string;
    mcpConnected?: number;
    mcpTotal?: number;
    mcpFailed?: number;
    diffAdded?: number;
    diffRemoved?: number;
    researchIter?: number;
    researchMax?: number;
    researchBest?: string;
    taskPending?: number;
    taskTotal?: number;
  };
}): Section[] {
  const s: Section[] = [];
  const sim = opts.simulated ?? {};
  const showAll = opts.showAll ?? false;

  // Line 1: identity
  const projName = sim.worktreeName ?? projectName;
  s.push(section('project', bold(fg('accent', `${projectEmoji} ${projName}`)), 1));

  // When in a worktree, git shows the branch name; worktree shows the label.
  const gitText = gitLabel;
  if (gitText) s.push(section('git', fg('success', gitText), 1));

  const ahead = sim.gitAhead ?? gitAhead;
  if (ahead > 0) s.push(section('gitAhead', fg('success', `↑${ahead}`), 1));

  const behind = sim.gitBehind ?? gitBehind;
  if (behind > 0) s.push(section('gitBehind', fg('warning', `↓${behind}`), 1));

  const dirty = sim.dirtyCount ?? dirtyCount;
  if (dirty > 0) s.push(section('dirty', fg('error', `✗${dirty}`), 1));

  if (sim.worktreeName) s.push(section('worktree', fg('success', `worktree:${sim.worktreeName}`), 1));

  const pr = sim.prNumber ?? prNumber;
  if (pr) s.push(section('pr', fg('muted', `PR #${pr}`), 1));

  s.push(section('model', fg('text', modelName), 1));

  if (providerTier || showAll) {
    s.push(section('provider', fg('muted', providerTier || 'Max'), 1));
  }

  if (opts.mode) {
    s.push(section('mode', modeChip(opts.mode), 1));
  }

  const ctxPct = opts.contextPercent ?? 2;
  s.push(section('context', contextBar(ctxPct), 1));

  if (sim.tokensUp || showAll) {
    const up = sim.tokensUp ?? '15.7k';
    const down = sim.tokensDown ?? '3.2k';
    s.push(section('tokens', fg('text', `↑${up} ↓${down}`), 1));
  }

  if (sim.cost || showAll) {
    s.push(section('cost', fg('warning', sim.cost ?? '$0.042'), 1));
  }

  if (sim.clock || showAll) {
    s.push(section('clock', fg('muted', sim.clock ?? '5h12m'), 1));
  }

  // Line 2: state
  if (opts.agents || showAll) {
    s.push(section('agents', fg('accent', `← ${opts.agents ?? 1} agent`), 2));
  }

  if (sim.mcpTotal || showAll) {
    const connected = sim.mcpConnected ?? 4;
    const total = sim.mcpTotal ?? 4;
    const failed = sim.mcpFailed ?? 0;
    if (failed > 0) {
      s.push(section('mcp', fg('error', `🔌 ${connected}/${total} ⚠ ${failed} failed`), 2));
    } else {
      s.push(section('mcp', fg('accent', `🔌 ${connected}/${total}`), 2));
    }
  }

  const diffA = sim.diffAdded ?? diffStats.added;
  const diffR = sim.diffRemoved ?? diffStats.removed;
  if (diffA > 0 || diffR > 0 || showAll) {
    s.push(section('diff', `${fg('success', `+${diffA || 42}`)} ${fg('error', `−${diffR || 8}`)}`, 2));
  }

  if (sim.researchIter || showAll) {
    const iter = sim.researchIter ?? 7;
    const max = sim.researchMax ?? 30;
    const best = sim.researchBest ?? '142ms';
    s.push(section('research', fg('accent', `🧪 iter ${iter}/${max} · best ${best}`), 2));
  }

  const tPending = sim.taskPending ?? taskCounts.pending;
  const tTotal = sim.taskTotal ?? taskCounts.total;
  if (tTotal > 0 || showAll) {
    if (tPending === 0) {
      s.push(section('tasks', fg('success', `☑ ${tTotal}/${tTotal}`), 2));
    } else {
      s.push(section('tasks', fg('accent', `☐ ${tPending}/${tTotal || 4}`), 2));
    }
  }

  s.push(section('hints', fg('muted', '? / @ $ !'), 2));

  return s;
}

// ── scenario 1: idle on main (real data, default mode → no chip) ─────────
const mainScenario: Scenario = {
  title: 'Idle · main (real data)',
  note: `project=${projectName} · git=${gitLabel || 'none'} · model=${modelName} · session="${exampleNames[0]}" → ${emojiForName(exampleNames[0])}`,
  sections: [
    section('project', bold(fg('accent', `${projectEmoji} ${projectName}`))),
    ...(gitLabel ? [section('git', fg('success', gitLabel))] : []),
    section('model', fg('text', modelName)),
    section('context', contextBar(2)),
    section('agents', fg('accent', '← 1 agent'), 2),
    section('hints', fg('muted', '? / @ $ !'), 2),
    ...sessionSection(exampleNames[0]),
  ],
  rightIds: new Set(['agents', 'hints']),
  sessionName: exampleNames[0],
};

// ── scenario 2: idle in a worktree with an open PR + named session ────────
const worktreeScenario: Scenario = {
  title: 'Idle · worktree with PR + named session (simulated)',
  note: `The pr section only renders when a PR exists; worktree label replaces the branch. Session "${exampleNames[1]}" → ${emojiForName(exampleNames[1])}`,
  sections: [
    section('project', bold(fg('accent', `${emojiForProject('/Users/faceleg/Work/phoenix')} phoenix`))),
    section('git', fg('success', 'worktree:phoenix')),
    section('model', fg('text', modelName)),
    section('context', contextBar(2)),
    section('pr', fg('muted', 'PR #456')),
    section('agents', fg('accent', '← 1 agent'), 2),
    section('hints', fg('muted', '? / @ $ !'), 2),
    ...sessionSection(exampleNames[1]),
  ],
  rightIds: new Set(['pr', 'agents', 'hints']),
  sessionName: exampleNames[1],
};

// ── scenario 3: working (spinner + status replaces identity) ──────────────
const workingScenario: Scenario = {
  title: 'Working',
  note: 'While the agent runs, line 1 becomes the live status (spinner · verb · elapsed · tokens · esc to cancel).',
  sections: [
    section('spinner', fg('accent', '◐')),
    section('status', fg('text', 'Gathering context')),
    section('metrics', fg('muted', '(12s · 4.2K tokens)')),
    section('context', contextBar(2)),
    section('cancel', fg('muted', 'esc to cancel')),
    section('agents', fg('accent', '← 1 agent'), 2),
    ...sessionSection(exampleNames[2]),
  ],
  rightIds: new Set(['cancel', 'agents']),
  sessionName: exampleNames[2],
};

// ── scenarios 4-6: mode chips (as the real app renders them) ──────────────
function modeChipScenario(mode: 'plan' | 'automode' | 'yolo', nameIndex: number): Scenario {
  const label = mode === 'automode' ? 'AUTO' : mode.toUpperCase();
  const name = exampleNames[nameIndex];
  return {
    title: `Mode · ${label}`,
    note: `The real app renders the mode as \`● ${label} \` in a fixed, theme-independent color. Session "${name}" → ${emojiForName(name)}`,
    sections: [
      section('project', bold(fg('accent', `${projectEmoji} ${projectName}`))),
      ...(gitLabel ? [section('git', fg('success', gitLabel))] : []),
      section('model', fg('text', modelName)),
      section('mode', modeChip(mode)),
      section('context', contextBar(2)),
      section('agents', fg('accent', '← 1 agent'), 2),
      section('hints', fg('muted', '? / @ $ !'), 2),
      ...sessionSection(name),
    ],
    rightIds: new Set(['agents', 'hints']),
    sessionName: name,
  };
}

// ── scenario 7: cockpit (ALL sections enabled, rich two-line layout) ─────
const cockpitScenario: Scenario = {
  title: 'Cockpit · all sections enabled (simulated)',
  note: 'Every section with a data source, rendered across two lines. This is the maximum-density layout.',
  sections: buildRealSections({
    showAll: true,
    contextPercent: 24,
    agents: 1,
    simulated: {
      gitAhead: 2,
      gitBehind: 0,
      dirtyCount: 3,
      prNumber: 456,
      worktreeName: 'phoenix',
      tokensUp: '15.7k',
      tokensDown: '3.2k',
      cost: '$0.042',
      clock: '5h12m',
      mcpConnected: 4,
      mcpTotal: 4,
      diffAdded: 42,
      diffRemoved: 8,
      researchIter: 7,
      researchMax: 30,
      researchBest: '142ms',
      taskPending: 2,
      taskTotal: 4,
    },
  }),
  rightIds: new Set(['hints']),
  sessionName: exampleNames[6],
};

// ── scenario 8: priority drop at narrow width ────────────────────────────
const priorityDropScenario: Scenario = {
  title: 'Priority drop · narrow terminal (40 cols)',
  note: 'Stage 1 (context-aware hiding) already removed empty sections. Stage 2 drops by tier: ambient → low → normal. Stage 3 flow-wraps to line 2.',
  sections: buildRealSections({
    showAll: true,
    contextPercent: 24,
    agents: 1,
    simulated: {
      gitAhead: 2,
      dirtyCount: 3,
      prNumber: 456,
      worktreeName: 'phoenix',
      tokensUp: '15.7k',
      tokensDown: '3.2k',
      cost: '$0.042',
      clock: '5h12m',
      mcpConnected: 4,
      mcpTotal: 4,
      diffAdded: 42,
      diffRemoved: 8,
      researchIter: 7,
      researchMax: 30,
      researchBest: '142ms',
      taskPending: 2,
      taskTotal: 4,
    },
  }),
  rightIds: new Set(['hints']),
  sessionName: exampleNames[7],
};

const scenarios: Scenario[] = [
  mainScenario,
  worktreeScenario,
  workingScenario,
  modeChipScenario('plan', 3),
  modeChipScenario('automode', 4),
  modeChipScenario('yolo', 5),
  cockpitScenario,
];

// ── priority overflow pipeline ─────────────────────────────────────────────
/**
 * Three-stage overflow pipeline (from statusbar.md):
 *   1. Context-aware hiding — sections with empty text are removed.
 *   2. Priority drop — lowest priority tier dropped first, reverse order
 *      within a tier, until the line fits.
 *   3. Flow-wrap — dropped sections promote to the next line.
 */

function applyOverflow(
  sections: Section[],
  maxWidth: number,
  maxLines = 3,
): Section[][] {
  // Stage 1: context-aware hiding — drop sections with no visible text.
  const visible = sections.filter((s) => visibleWidth(s.text) > 0);
  if (visible.length === 0) return [];

  const sepWidth = 3; // ' · '
  const measureLine = (list: Section[]): number =>
    list.reduce((sum, s, i) => sum + visibleWidth(s.text) + (i > 0 ? sepWidth : 0), 0);

  // Group sections by their assigned line.
  const line1 = visible.filter((s) => s.line === 1);
  const line2 = visible.filter((s) => s.line === 2);

  // Stage 2: priority drop per line.
  function dropByPriority(sections: Section[], width: number): { kept: Section[]; dropped: Section[] } {
    if (measureLine(sections) <= width) {
      return { kept: sections, dropped: [] };
    }
    // Sort by priority ascending (ambient first = dropped first), then by reverse config order.
    const indexed = sections.map((s, i) => ({ s, i }));
    const sorted = [...indexed].sort((a, b) => {
      const pa = PRIORITY_ORDER.indexOf(a.s.priority);
      const pb = PRIORITY_ORDER.indexOf(b.s.priority);
      if (pa !== pb) return pa - pb; // lower priority first (dropped first)
      return b.i - a.i; // reverse config order within tier
    });

    const toDrop = new Set<number>();
    let kept = [...sections];
    let dropped: Section[] = [];

    for (const { i } of sorted) {
      if (measureLine(kept) <= width) break;
      toDrop.add(i);
      kept = sections.filter((_, idx) => !toDrop.has(idx));
      dropped = sections.filter((_, idx) => toDrop.has(idx));
    }
    return { kept, dropped };
  }

  const result: Section[][] = [];
  const l1Result = dropByPriority(line1, maxWidth);
  result.push(l1Result.kept);

  // Stage 3: flow-wrap — dropped line 1 sections promote to line 2.
  let promoted = l1Result.dropped;
  let line2Pool = [...line2, ...promoted];

  const l2Result = dropByPriority(line2Pool, maxWidth);
  result.push(l2Result.kept);

  // If line 2 also overflows, promote to line 3 (if allowed).
  if (l2Result.dropped.length > 0 && result.length < maxLines) {
    const l3Result = dropByPriority(l2Result.dropped, maxWidth);
    result.push(l3Result.kept);
    if (l3Result.dropped.length > 0) {
      // Last resort: append a truncation marker.
      const lastLine = result[result.length - 1];
      lastLine.push(section('trunc', fg('muted', '…'), lastLine[0]?.line ?? 2));
    }
  }

  return result.filter((l) => l.length > 0);
}

// ── full-width layout: left identity, right-aligned trailing sections ─────
function fullWidthLayout(
  sections: Section[],
  rightIds: Set<string>,
  maxWidth: number,
): string[] {
  const sepText = fg('muted', ' · ');
  const sepWidth = visibleWidth(sepText);

  const left = sections.filter((s) => !rightIds.has(s.id));
  const right = sections.filter((s) => rightIds.has(s.id));

  const joinSections = (list: Section[]): string =>
    list.map((s) => s.text).join(sepText);

  const leftText = joinSections(left);
  const rightText = joinSections(right);
  const leftWidth = visibleWidth(leftText);
  const rightWidth = rightText ? visibleWidth(rightText) + sepWidth : 0;

  // If everything fits on one line, right-align the trailing group.
  if (leftWidth + rightWidth <= maxWidth) {
    const gap = ' '.repeat(maxWidth - leftWidth - rightWidth);
    return [leftText + gap + rightText];
  }

  // Otherwise flow-wrap like a terminal prompt.
  const lines: string[] = [];
  let line = '';
  let width = 0;
  for (const s of sections) {
    const w = visibleWidth(s.text);
    if (width > 0 && width + sepWidth + w > maxWidth) {
      lines.push(line);
      line = '';
      width = 0;
    }
    if (width > 0) {
      line += sepText;
      width += sepWidth;
    }
    line += s.text;
    width += w;
  }
  if (width > 0) {
    lines.push(line);
  }
  return lines;
}

// ── render with overflow pipeline ─────────────────────────────────────────
function renderBar(scenario: Scenario, maxWidth: number, sessionName: string): void {
  for (const line of composerBox(sessionName, maxWidth)) {
    console.log(line);
  }

  // Apply the overflow pipeline to get lines of sections.
  const lines = applyOverflow(scenario.sections, maxWidth);

  for (const lineSections of lines) {
    const rendered = fullWidthLayout(lineSections, scenario.rightIds, maxWidth);
    for (const line of rendered) {
      console.log(line);
    }
  }
}

// ── render with explicit priority drop annotations ───────────────────────
function renderBarWithDropAnnotations(scenario: Scenario, maxWidth: number, sessionName: string): void {
  for (const line of composerBox(sessionName, maxWidth)) {
    console.log(line);
  }

  // Show what stage 1 (context-aware hiding) removed.
  const all = scenario.sections;
  const visible = all.filter((s) => visibleWidth(s.text) > 0);
  const hidden = all.filter((s) => visibleWidth(s.text) === 0);

  if (hidden.length > 0) {
    console.log(dim(`  [stage 1] hidden (no data): ${hidden.map((s) => s.id).join(', ')}`));
  }

  // Apply stages 2+3.
  const lines = applyOverflow(scenario.sections, maxWidth);

  // Show what stage 2 dropped from each line.
  const line1Input = visible.filter((s) => s.line === 1);
  const line1Output = lines[0] ?? [];
  const line1Dropped = line1Input.filter((s) => !line1Output.includes(s));

  if (line1Dropped.length > 0) {
    console.log(dim(`  [stage 2] dropped from line 1: ${line1Dropped.map((s) => `${s.id}(${s.priority})`).join(', ')}`));
  }

  for (let i = 0; i < lines.length; i++) {
    const rendered = fullWidthLayout(lines[i], scenario.rightIds, maxWidth);
    for (const line of rendered) {
      console.log(line);
    }
    if (i === 0 && lines.length > 1) {
      console.log(dim(`  [stage 3] promoted overflow to line ${i + 2}:`));
    }
  }
}

// ── emoji gallery: many names → their deterministic emoji ─────────────────
const GALLERY_NAMES = [
  'fix wb feeding notification',
  'fix login bug',
  'ship the caret fix',
  'autohand login',
  'Idle timeout — session ended',
  'which is the most rich?',
  'Inspect our status line preview code',
  'add the bars to the preview',
  'why am I not seeing different emoji',
  'try again',
];

function renderEmojiGallery(): void {
  console.log('');
  console.log(bold(fg('accent', '◆ Session emoji gallery — deterministic per name')));
  console.log(dim(`The same name always maps to the same emoji (${SESSION_EMOJI.length} in the set).`));
  console.log('');
  for (const name of GALLERY_NAMES) {
    console.log(`  ${fg('text', `${emojiForName(name)} ${name}`)}`);
  }

  console.log('');
  console.log(bold(fg('accent', '◆ Project emoji gallery — deterministic per path')));
  console.log(dim(`Disjoint pool from session emoji (${PROJECT_EMOJI.length} in the set). Same path → same emoji.`));
  console.log('');
  const projectPaths = [
    '/Users/faceleg/Work/code-cli',
    '/Users/faceleg/Work/phoenix',
    '/home/user/projects/my-app',
    '/Users/faceleg/Work/watchie-besti',
    '/dev/shm/scratch',
    'C:\\Users\\dev\\projects\\win-tool',
    '/Users/faceleg/Work/dotfiles',
    '/tmp/throwaway',
  ];
  for (const path of projectPaths) {
    console.log(`  ${fg('text', `${emojiForProject(path)} ${basename(path)}`)}  ${dim(path)}`);
  }
  console.log('');
  console.log(dim('Try: bun docs/design/statusbar-preview.ts aurora 100 "fix login bug"'));
  console.log('');
}

// ── priority tier reference ───────────────────────────────────────────────
function renderPriorityReference(): void {
  console.log('');
  console.log(bold(fg('accent', '◆ Priority tiers (drop order)')));
  console.log(dim('Stage 2 drops lowest tier first; within a tier, last configured = first dropped.'));
  console.log('');
  const tiers: [SectionPriority, string[]][] = [
    ['critical', ['project', 'mode']],
    ['high', ['git', 'context', 'model']],
    ['normal', ['worktree', 'pr', 'tokens', 'clock', 'agents', 'tasks', 'diff']],
    ['low', ['gitAhead', 'gitBehind', 'dirty', 'provider', 'cost', 'mcp', 'research']],
    ['ambient', ['hints']],
  ];
  for (const [tier, ids] of tiers) {
    const color: ColorToken = tier === 'critical' ? 'error' : tier === 'high' ? 'warning' : tier === 'normal' ? 'accent' : tier === 'low' ? 'muted' : 'muted';
    console.log(`  ${fg(color, tier.padEnd(8))} ${ids.join(', ')}`);
  }
  console.log('');
}

// ══════════════════════════════════════════════════════════════════════════
const widthArg = process.argv[3];
const fullWidth = process.stdout.columns ?? 100;

console.log(bold(`Autohand status bar — scenarios (theme: ${theme.name})`));
console.log(dim('Replicates the real implementation: mode chip hidden in default mode,'));
console.log(dim('● PLAN / ● AUTO / ● YOLO with fixed colors when active.'));
console.log(dim('Session name on its own line above the top rule (right-aligned), with a'));
console.log(dim('deterministic emoji (same name → same emoji). The blue rule runs full width.'));
console.log(dim('Identity sections left, trailing sections right-aligned; wraps when narrow.'));
console.log(dim('Three-stage overflow: context-aware hiding → priority drop → flow-wrap.'));

if (widthArg) {
  const width = Math.max(20, parseInt(widthArg, 10) || fullWidth);
  for (const scenario of scenarios) {
    console.log('');
    console.log(bold(fg('accent', `◆ ${scenario.title}`)));
    console.log(dim(scenario.note));
    console.log('');
    renderBar(scenario, width, scenario.sessionName);
  }

  // Priority drop scenario at narrow width.
  console.log('');
  console.log(bold(fg('accent', `◆ ${priorityDropScenario.title}`)));
  console.log(dim(priorityDropScenario.note));
  console.log('');
  renderBarWithDropAnnotations(priorityDropScenario, 40, priorityDropScenario.sessionName);

  renderPriorityReference();
  renderEmojiGallery();
} else {
  for (const scenario of scenarios) {
    console.log('');
    console.log(bold(fg('accent', `◆ ${scenario.title}`)));
    console.log(dim(scenario.note));
    console.log('');
    renderBar(scenario, fullWidth, scenario.sessionName);
  }

  // Priority drop scenario at narrow width.
  console.log('');
  console.log(bold(fg('accent', `◆ ${priorityDropScenario.title}`)));
  console.log(dim(priorityDropScenario.note));
  console.log('');
  renderBarWithDropAnnotations(priorityDropScenario, 40, priorityDropScenario.sessionName);

  console.log('');
  console.log(dim('Narrow (60 cols) — sections stack:'));
  console.log('');
  renderBar(mainScenario, 60, mainScenario.sessionName);

  renderPriorityReference();
  renderEmojiGallery();
}

console.log(dim(`Try: bun docs/design/statusbar-preview.ts dracula 60 "fix login bug"`));
console.log('');
