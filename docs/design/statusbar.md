# Status Bar Redesign — Design Options

> Design artifact. Not production code.
> Preview: `bun docs/design/statusbar-preview.ts` (renders real aurora-theme colors).

## Goal

Replace the single, always-on help line with a **Spaceship-style status bar**:
an ordered list of **pluggable, context-aware sections** that can be arranged
across one or two lines, colored per-section, and extended by extensions.

Inspiration: [spaceship-prompt](https://spaceship-prompt.sh) — `SPACESHIP_PROMPT_ORDER`
is an ordered array of sections; each is independently enabled, colored, and
context-aware (only renders when relevant).

## Current state (what we're replacing)

The help line is built by `getComposerHelpLine()` (`src/ui/ink/AgentUI.tsx:700`)
plus `buildStatusLineExtension()` (`src/core/agent/StatusLineSettings.ts:182`):

```
Autohand (Max) (Autohand AI, moa) · 100% context left · ? shortcuts · / commands · @ mention files · $ skills · ! terminal · ~/Work/code-cli · main · PR #123
```

Problems:
- One long line, fixed order, no reordering.
- `PR #123` is a **hardcoded default** (`DEFAULT_PULL_REQUEST_NUMBER = 123`) shown even with no PR.
- Full model string is noisy; full path is long.
- 12 scattered booleans, not a composable model.
- Mode (`[AUTO]`) renders *above* the composer, not in the bar.

## The section model (the real change)

Promote "segment" → "section". A section is:

```ts
interface StatusSection {
  id: string;            // see Section reference below for the full list
  line: 1 | 2;           // which line it renders on
  enabled?: boolean;     // default true
  color?: ColorToken;    // override theme default
  prefix?: string;       // e.g. '📦 ' (deterministic project emoji)
  postfix?: string;
  // context-aware: returns null/'' to hide itself
}
```

Config shape:

```jsonc
"ui": {
  "statusLine": {
    "layout": "two-line",          // "classic" | "two-line"
    "sections": [
      // ── line 1: identity ──
      { "id": "project",    "line": 1 },
      { "id": "git",        "line": 1 },
      { "id": "gitAhead",   "line": 1 },
      { "id": "gitBehind",  "line": 1 },
      { "id": "dirty",      "line": 1 },
      { "id": "worktree",   "line": 1 },
      { "id": "pr",         "line": 1 },
      { "id": "model",      "line": 1 },
      { "id": "provider",   "line": 1 },
      { "id": "mode",       "line": 1 },
      { "id": "context",    "line": 1 },
      { "id": "tokens",     "line": 1 },
      { "id": "cost",       "line": 1 },
      { "id": "clock",      "line": 1 },
      // ── line 2: state ──
      { "id": "agents",     "line": 2 },
      { "id": "mcp",        "line": 2 },
      { "id": "diff",       "line": 2 },
      { "id": "research",   "line": 2 },
      { "id": "tasks",      "line": 2 },
      { "id": "hints",      "line": 2 }
    ]
  }
}
```

Extensions register new section IDs via the existing `api.ui.setHelpLine` /
`setStatusLine` path (`ExtensionRuntimeHost.ts:618`), now keyed by section id.

### Section reference

Every section has a data source, a context-awareness rule (when to hide), and a
default line assignment. Sections not in the default config are still available
to enable via settings.

#### Identity sections (line 1 by default)

| ID | Glyph | Example | Data source | Context-aware (hide when) |
|---|---|---|---|---|
| `project` | deterministic | `📦 code-cli` | `basename(cwd)` + `emojiForProject(cwd)` | never (always shown) |
| `git` | — | `main` | `git symbolic-ref --short HEAD` | no git repo |
| `gitAhead` | `↑` | `↑2` | `git rev-list --count @{upstream}..HEAD` | no upstream or 0 ahead |
| `gitBehind` | `↓` | `↓5` | `git rev-list --count HEAD..@{upstream}` | no upstream or 0 behind |
| `dirty` | `✗` | `✗3` | `git status --porcelain \| wc -l` | clean worktree (0 changed files) |
| `worktree` | — | `worktree:phoenix` | `git rev-parse --is-inside-work-tree` + worktree path | not in a worktree |
| `pr` | — | `PR #456` | `gh pr view --json number,title` for current branch | no open PR |
| `model` | — | `Opus 5` | `~/.autohand/config.json` provider model, shortened to family | never (always shown) |
| `provider` | — | `Max` | Plan tier from config / account info | no plan tier available |
| `mode` | `●` | `● AUTO ` | Interaction mode (plan/auto/yolo) | default mode (hidden, dim `[I]` in classic) |
| `context` | `█░` | `█░░░░░░░░░` | Token usage / context window % | never (always shown; 100% before first prompt) |
| `tokens` | `↑↓` | `↑15.7k ↓3.2k` | `features.tokenUsageStatus` cumulative up/down | feature disabled or 0 tokens used |
| `cost` | `$` | `$0.042` | Derived from token count × per-1K pricing | `tokens` hidden or 0 cost |
| `clock` | — | `5h12m` | `formatElapsedTime` from session start | session < 60s old |

#### State sections (line 2 by default)

| ID | Glyph | Example | Data source | Context-aware (hide when) |
|---|---|---|---|---|
| `agents` | `←` | `← 1 agent` | Team/sub-agent activity count | no active agents |
| `mcp` | `🔌` | `🔌 3/4` or `⚠ 1 failed` | `McpStartupCoordinator` connection state | all servers connected (hide after settle) or no MCP servers configured |
| `diff` | `+−` | `+42 −8` | `SessionDiffStatsTracker` (git diff vs session baseline) | 0 lines changed |
| `research` | `🧪` | `🧪 iter 7/30 · best 142ms` | Auto-research experiment state (`/autoresearch`) | no active experiment |
| `tasks` | `☐` | `☐ 2/4` | `todo_write` activity todos (`.autohand/agents/tasks/todos.json`) | no todo list active (0 tasks) |
| `hints` | — | `? / @ $ !` | Static shortcut hints | input non-empty or agent working |

### Session section (new)

The session name (from `/rename` or `--rename`) renders as an **inset in the
top-right of the composer's top rule** (`▔▔▔ 🐙 name ▔▔▔`), not as a bar
section. It carries a **deterministic emoji** derived from the name:

```ts
// src/ui/statusbar/sessionEmoji.ts (production module, used by the preview)
emojiForName('fix wb feeding notification') // → '🐙' (always)
emojiForName('fix login bug')               // → different, stable emoji
```

- Same name → same emoji (djb2 hash over the name, `% 16` into a curated set).
- Empty/unnamed session → no emoji, no inset.
- The inset is right-aligned on the top rule; the rule shortens to make room.
- Emoji are monospace-safe and distinct so sessions are recognizable at a glance.

## Candidate layouts

### A · Spaceship (recommended default)
Two lines. Line 1 = identity, line 2 = state. Minimal, context-aware.

```
› ▊
📦 code-cli · main · Opus 5 · [I]
← 1 agent
```

### B · Cockpit
Two lines + worktree + context bar + tokens + diff on line 1. The "rich" state.

```
› ▊ What's next?
📦 phoenix · worktree:phoenix · ↑2 · ✗3 · PR #456 · Opus 5 · Max · ● AUTO  · █░░░░░░░░░ · ↑15.7k ↓3.2k · $0.042 · 5h12m
← 1 agent · 🔌 4/4 · +42 −8 · 🧪 iter 7/30 · best 142ms
```

### C · Single-line dense
One line, everything. Compact but busy; good for wide terminals.

```
› ▊
📦 code-cli · main · ↑2 · ✗3 · Opus 5 · ● AUTO  · █░░░░░░░░░ · ↑15.7k ↓3.2k · $0.042 · 5h12m · ← 1 agent · +42 −8
```

### D · Classic+ (safe fallback)
Keeps today's single-line shape, shortens names, drops hardcoded PR #123.
Lowest risk; preserves muscle memory. This is the `layout: "classic"` path.

```
› ▊
Autohand (Max) · Opus 5 · 100% context left · ~/Work/code-cli · main · ? / @ $ !
```

## Coloration (real aurora tokens)

| Section      | Token     | Hex       | Notes                          |
|--------------|-----------|-----------|--------------------------------|
| project      | `accent`  | `#9b9ef5` | bold, with deterministic project emoji prefix |
| git          | `success` | `#86cfa3` | branch / worktree label        |
| gitAhead     | `success` | `#86cfa3` | `↑N` unpushed commits          |
| gitBehind    | `warning` | `#e0a95e` | `↓N` behind remote             |
| dirty        | `error`   | `#e06c75` | `✗N` changed files             |
| worktree     | `success` | `#86cfa3` | `worktree:<name>` label        |
| pr           | `muted`   | `#a4a6b2` | `PR #N` from real `gh` data    |
| model        | `text`    | `#e4e5ec` | short model name               |
| provider     | `muted`   | `#a4a6b2` | plan tier (Max/Pro/Free)       |
| mode chip     | fixed     | see below | theme-independent, always legible |
| context bar   | `success`→`warning`→`error` | | green <60% ≤ used, amber 60–85%, red >85% |
| tokens       | `text`    | `#e4e5ec` | `↑N ↓N` cumulative             |
| cost         | `warning` | `#e0a95e` | `$X.XXX` running session cost  |
| clock        | `muted`   | `#a4a6b2` | elapsed session time           |
| agents       | `accent`  | `#9b9ef5` | `← N agent(s)`                 |
| mcp          | `accent`  | `#9b9ef5` | `🔌 N/M` or `⚠ N failed`       |
| mcp (error)  | `error`   | `#e06c75` | failed server count            |
| diff         | `success` / `error` | | `+N` in success, `−M` in error |
| research     | `accent`  | `#9b9ef5` | `🧪 iter N/M · best X`         |
| tasks        | `accent`  | `#9b9ef5` | `☐ N/M` (pending/total)        |
| tasks (done) | `success` | `#86cfa3` | `☑ N/M` when all complete     |
| separator    | `muted`   | `#a4a6b2` | ` · `                          |

Mode chip uses the **existing fixed, theme-independent** colors
(`INTERACTION_MODE_GLYPH_COLOR`, `AgentUI.tsx:94`):
plan `#ff9d3f`, auto `#ff6b6b`, yolo `#c678dd`, default dim.

## Emoji / glyph use

- `📦🏗️🧩…` project (deterministic per path, from a disjoint pool — `emojiForProject(cwd)`).
- `🦊🐙🦄…` session (deterministic per name — see Session section above).
- `←` agents (incoming/background work).
- `↑↓` tokens (cumulative up/down).
- `█░` context bar (filled/empty).
- `✗` dirty worktree (changed file count).
- `🔌` MCP servers (connected/total).
- `🧪` research (active experiment).
- `+−` diff (lines added/removed this session).
- `☐` tasks (pending/total); `☑` when all complete.
- `◐` working spinner (reuses existing `ink-spinner`).

Keep emoji to **one per section max**, and only on identity sections.
State sections use ASCII glyphs (portable, monospace-safe).

## Interactivity

| Element      | Interaction                                                        |
|--------------|--------------------------------------------------------------------|
| mode chip    | Click / `Shift+Tab` cycles edit → plan → auto → yolo (existing)    |
| agents       | Click opens the team/agent-runs panel (existing `cmd+t`)           |
| worktree     | Click opens worktree picker / `Open worktree <name>`               |
| context bar  | Click opens context/token breakdown                                |
| tokens       | Click opens `/usage` dashboard                                     |
| cost         | Click opens `/usage` dashboard                                     |
| diff         | Click opens `/diff` (session changes vs baseline)                  |
| pr           | Click opens PR in browser (`gh pr view --web`)                     |
| mcp          | Click opens `/mcp list`                                             |
| research     | Click opens `/autoresearch status`                                  |
| tasks        | Click opens the task list panel (existing `TodoListOutput` / `cmd+t`) |
| hints        | `?` opens shortcuts panel (existing); section auto-hides when input non-empty or agent working |

All click targets route through the existing mouse-target controls
(`enableMouseTargetControls` in `FixedBottom`).

## Context-awareness (Spaceship's core idea)

A section renders only when its data exists:

- `worktree` — only when in a session worktree.
- `gitAhead` — only when upstream is configured and commits are unpushed.
- `gitBehind` — only when upstream is configured and local is behind.
- `dirty` — only when `git status --porcelain` reports changed files.
- `pr` — only when `gh pr view` returns an open PR for the current branch.
- `provider` — only when a plan tier is resolvable from config/account info.
- `agents` — only when team/sub-agent activity is present.
- `hints` — only when input is empty **and** agent is idle.
- `context` — always (defaults to 100% before first prompt).
- `mode` — always (dim `[I]` in default mode).
- `tokens` — only when `features.tokenUsageStatus` is enabled and tokens > 0.
- `cost` — only when `tokens` is visible and cost > 0.
- `clock` — only when session age ≥ 60 seconds.
- `mcp` — only when MCP servers are configured; auto-hides after all connect successfully (stays visible if any fail).
- `diff` — only when `SessionDiffStatsTracker` reports non-zero line changes.
- `research` — only when an auto-research experiment is active.
- `tasks` — only when `todo_write` has created a todo list with ≥ 1 task. Shows `☐ pending/total`; switches to `☑` in `success` color when all tasks are completed, then auto-hides after 5s.

## Working state

While the agent runs, **line 1 becomes the live status** (spinner · verb ·
elapsed · tokens · esc to cancel); line 2 stays as state. This reuses the
existing `StatusLine` working segments (`buildStatusSegments`,
`StatusLine.tsx:167`).

During working state, `tokens` and `clock` sections remain visible on line 1
alongside the spinner — they are the live metrics. `diff`, `mcp`, `research`,
and `tasks` stay on line 2 as ambient state.

## Priority and overflow (space budget)

When a user enables many sections but the terminal is too narrow to fit them
all, the bar must decide which to keep and which to drop. This is a
**three-stage pipeline**: context-aware hiding → priority drop → flow-wrap.

### Stage 1: Context-aware hiding (first pass)

Already defined above — each section's hide-when rule fires independently.
Sections with no data (no PR, no agents, clean worktree, no experiment) remove
themselves before any width calculation. This typically eliminates 5–10
sections in a normal session.

### Stage 2: Priority drop (second pass)

After context-aware hiding, if the remaining visible sections still exceed the
line width, sections are dropped by **priority tier** (lowest tier dropped
first). Within a tier, sections are dropped in **reverse config order** (last
configured = first dropped), so user-configured order is respected as a
tiebreaker.

```ts
interface StatusSection {
  // ...existing fields...
  priority?: SectionPriority;  // overrides the default for this section
}

type SectionPriority = 'critical' | 'high' | 'normal' | 'low' | 'ambient';
```

| Tier | Priority | Sections | Drop rule |
|---|---|---|---|
| 0 | `critical` | `project`, `mode` | **Never dropped.** Identity + interaction mode are always visible. |
| 1 | `high` | `git`, `context`, `model` | Dropped only if the terminal is extremely narrow (< 40 cols). |
| 2 | `normal` | `worktree`, `pr`, `tokens`, `clock`, `agents`, `tasks`, `diff` | Dropped one at a time (reverse order) until the line fits. |
| 3 | `low` | `gitAhead`, `gitBehind`, `dirty`, `provider`, `cost`, `mcp`, `research` | Dropped before `normal` sections. First to go when space is tight. |
| 4 | `ambient` | `hints` | Dropped first. `hints` is already context-aware (hidden on input). |

Drop algorithm per line:

1. Collect all visible sections assigned to this line (after stage 1).
2. Measure total width = Σ section widths + separators.
3. If total ≤ terminal width → render all, done.
4. While total > terminal width:
   a. Find the lowest-priority tier with any remaining sections on this line.
   b. Drop the **last** section in that tier (reverse config order).
   c. Recalculate total width.
5. If only `critical` sections remain and they still don't fit, truncate the
   `project` name (e.g. `code-cli` → `code…`) as a last resort.

### Stage 3: Flow-wrap (fallback)

If the layout is `"two-line"` and stage 2 drops any `normal` or `high`
section, the bar **promotes** the dropped sections to line 2 (if line 2 has
room). If line 2 is also full, sections wrap onto a third line. This is the
existing `fullWidthLayout` flow-wrap behavior from the preview.

In `"classic"` (single-line) layout, there is no line 2 — stage 2 drops
continue until the line fits, and a `…` truncation marker appears at the end
to signal that sections were hidden.

### User override

Users can pin a section to `critical` to prevent it from ever being dropped:

```jsonc
{ "id": "cost", "line": 1, "priority": "critical" }
```

Conversely, users can demote a section to `ambient` so it only shows when
there's plenty of space:

```jsonc
{ "id": "clock", "line": 1, "priority": "ambient" }
```

### Default priority assignment

The default priority for each section (used when `priority` is not set in
config):

| Section | Default priority | Rationale |
|---|---|---|
| `project` | `critical` | Where am I? — always needed. |
| `mode` | `critical` | What mode am I in? — always needed. |
| `git` | `high` | Which branch? — high value, short. |
| `context` | `high` | How much context left? — core metric. |
| `model` | `high` | Which model? — core identity. |
| `worktree` | `normal` | Only shows in worktrees; useful but not essential. |
| `pr` | `normal` | Only shows with an open PR; useful for review workflows. |
| `tokens` | `normal` | Only shows with tokenUsageStatus; useful for cost-aware sessions. |
| `clock` | `normal` | Session duration; nice-to-have. |
| `agents` | `normal` | Only shows with active agents; important while running. |
| `tasks` | `normal` | Only shows with a todo list; important while working. |
| `diff` | `normal` | Session impact; nice-to-have. |
| `gitAhead` | `low` | Useful but secondary to branch name. |
| `gitBehind` | `low` | Useful but secondary to branch name. |
| `dirty` | `low` | Nice signal, but `diff` covers similar ground. |
| `provider` | `low` | Plan tier rarely changes mid-session. |
| `cost` | `low` | Derived from `tokens`; redundant if `tokens` is visible. |
| `mcp` | `low` | Transient during startup; rarely needed after. |
| `research` | `low` | Niche; only relevant during experiments. |
| `hints` | `ambient` | Already auto-hides on input; lowest value when working. |

## Open decisions

1. **Short model name** — "Opus 5" vs full "Autohand (Max) (Autohand AI, moa)".
   Need a model-name shortening rule (strip provider/plan, keep model family).
2. **`layout` default** — recommend `"two-line"` (Option A) as new default,
   `"classic"` (Option D) as opt-out for the 1M existing users.
3. **Cost pricing model** — the `$0.003/1K` heuristic in `share.ts` is a rough
   estimate. Real cost requires per-model pricing tables. Recommend: start with
   the heuristic, gate behind `tokens` visibility, refine pricing later.
4. **`provider` tier source** — plan tier (Max/Pro/Free) may need an account
   info API call or a config field. Recommend: read from config first, fall
   back to hiding if unavailable.
5. **`mcp` settle timeout** — how long to keep showing `🔌 N/M` after all
   servers connect before auto-hiding. Recommend: hide immediately on success,
   keep visible for 5s on partial failure, keep visible indefinitely on total
   failure.

## Phasing

1. **Phase 1** — Section model + config + Option A (two-line) as default,
   Option D as `classic` fallback. No vim. Context-aware hiding. Core sections:
   `project`, `git`, `model`, `mode`, `context`, `hints`, `agents`.
2. **Phase 2** — Rich sections with existing data sources: `context` bar,
   `worktree`, `agents`, `tokens`, `cost`, `clock`, `diff`, `dirty`, `pr` (real
   `gh` data), `gitAhead`, `gitBehind`, `tasks` (todo_write activity). Click
   targets for all interactive sections.
3. **Phase 3** — Integration sections: `mcp` (McpStartupCoordinator),
   `research` (auto-research state), `provider` (plan tier). Priority and
   overflow pipeline (stages 1–3). Extension section registration, per-directory
   overrides.
