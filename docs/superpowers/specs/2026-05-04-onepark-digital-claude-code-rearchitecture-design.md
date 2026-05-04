# Onepark Digital — Claude Code Re-architecture

**Status:** Design (pending review)
**Date:** 2026-05-04
**Author:** Shin (with Claude)
**Supersedes:** Days 1–28 of the headcount custom-orchestrator design

---

## 1. Why this exists

Headcount currently calls the Anthropic and Google APIs directly from a custom TypeScript orchestrator. API costs were rising fast enough that Days 26–27 added a circuit breaker and per-agent token budgets. The user holds a Claude Max subscription and a ChatGPT Pro subscription that are presently unused for this project.

A reread of the codebase showed the original ambition (parallel async multi-agent autonomy with 24/7 rituals) had not, in fact, been implemented: every agent runs serially today, and most projects are kicked off manually rather than by cron. Several open-source projects (BMAD-METHOD, Claude Code subagents, swarm patterns) already provide the routing-and-handoff pattern Headcount tried to build from scratch.

This spec replaces the custom orchestrator with **Claude Code itself as the runtime**, drives it from a rebuilt dashboard, and uses Codex CLI as a fallback. It eliminates per-token API spend while preserving the agent-personality, hierarchy, and learning-over-time ideas the project was always about.

## 2. Goals

1. **Zero per-token API spend.** All AI calls route through Claude Max (primary) or ChatGPT Pro (fallback) subscriptions.
2. **Smart depth-aware hierarchical routing.** A user-issued prompt enters via Eleanor (Chief of Staff). Each level — Eleanor, department head, manager, associate, intern — is intelligent enough to delegate to the *lowest competent level*, including skipping levels when appropriate. Interns do the most grunt work; senior agents do supervision and routing. Work is *spread*, not concentrated.
3. **Per-agent learning via brain docs.** Each agent owns a markdown brain that accumulates skills and corrections, updated by an overnight learning cron.
4. **Dashboard as the command surface with project-centric chat.** All agent invocations originate from the dashboard. **All communication for a project happens in that project's single shared chat** — no DMs, no personal channels. Every agent involved in a project (Eleanor down to intern) is added to the project chat. New agents joining mid-project are added dynamically.
5. **Marketing-site pivot to AI consulting.** `onepark-web` becomes a transparent AI-consulting site under the Onepark Digital umbrella.
6. **Runtime-switchable, latest-model-always.** Today's primary is Claude Code; switching to Codex CLI (or a future runtime) when a better model lands is a configuration change, not a rewrite. Subagents always use the highest-tier model available on the active subscription — no model gets pinned to a stale tier in a markdown frontmatter.
7. **Soft-ban resilient.** Explicit rate hygiene: jitter, burst avoidance, exponential backoff on errors, daily call budget. No detectable agent-farm patterns.

## 3. Non-goals

- Parallel/async multi-agent execution. Strictly serial.
- 24/7 autonomous operation. Cron jobs are limited to three named rituals.
- Inter-agent chatter, **inter-agent DMs**, fictional company time, or relationship sentiment tracking. All deleted. Communication is project-scoped only.
- API cost optimization (caching, batch API, Haiku routing). Not needed once subscription routing replaces metered calls.
- A new client-facing product. The consulting positioning is a marketing pivot, not a SaaS launch.

## 4. Current state (what already exists)

| Asset | Location | Status |
|---|---|---|
| 120 subagent definitions | `.claude/agents/*.md` | **Ready** — already in Claude Code's `name`/`description`/`tools`/`model` frontmatter format with personality body |
| Personality data | `apps/orchestrator/src/agents/personality.ts` | Source of truth has migrated to `.claude/agents/`; this file is now legacy |
| 18 featured personalities | `D:\Projects\onepark-web\data\agents.ts` | Used by marketing site team page |
| Dashboard shell | `apps/dashboard/` (Next.js 14, Supabase, 4-view nav) | Reusable foundation; needs heavy rebuild of views |
| Supabase schema | `supabase/migrations/0001_init.sql` + 22 day-numbered migrations | ~15 tables; most become irrelevant |
| Existing tools | `apps/orchestrator/src/tools/genviral.ts`, `view-image.ts`, MCP integrations from Day 24 | Reusable as MCP servers or local tools |
| Cron-driven rituals | `apps/orchestrator/src/rituals/*.ts` (11 files) | All deleted except morning-greeting and ceo-brief, which are rebuilt as Claude Code invocations |
| Claude Code skills, MCPs, plugins | User's existing global + project-level setup | **Reused as-is** |

## 5. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Dashboard  (apps/dashboard, Next.js 14)                       │
│                                                                │
│  ┌──────────┐ ┌──────────────────────────┐ ┌───────┐ ┌──────┐  │
│  │ COMMAND  │ │ PROJECTS                 │ │BRAINS │ │HEALTH│  │
│  │ start    │ │ list of all chats        │ │per-   │ │cron+ │  │
│  │ a new    │ │ + per-project chat:      │ │agent  │ │rate  │  │
│  │ project  │ │  • participant list      │ │editor │ │budget│  │
│  │          │ │  • full message log      │ │       │ │      │  │
│  │          │ │  • handoff tree view     │ │       │ │      │  │
│  └────┬─────┘ └──────────────────────────┘ └───────┘ └──────┘  │
│       │ POST /api/run                                          │
└───────┼────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────┐
│  Run dispatcher (apps/orchestrator, slimmed)                   │
│                                                                │
│  - Spawns Claude Code session via Claude Agent SDK             │
│  - Streams events back over WebSocket / SSE                    │
│  - Writes every agent run + handoff as a project_message       │
│  - Adds joining agents to project_participants                 │
│  - Enforces rate hygiene (jitter, daily budget, backoff)       │
│  - Falls back to Codex CLI if Claude is unreachable            │
└─────────┬──────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│  Claude Code (subscription auth — Claude Max)                  │
│                                                                │
│  Initial prompt → Eleanor (Chief of Staff)                     │
│    └─ reads agents/registry.md (full sub-tree visibility,      │
│       not just direct reports)                                 │
│    └─ decides DEPTH — dispatches to the lowest competent level │
│       (Dept Head, OR Manager, OR Associate, OR Intern)         │
│    └─ Agent tool dispatch cascades; each level makes the same  │
│       depth decision:                                          │
│                                                                │
│       Eleanor → Dept Head → Manager → Associate → Intern       │
│       (any level may skip levels below to spread work down)    │
│                                                                │
│    ← outputs propagate back up the chain                       │
│                                                                │
│  Each subagent reads brains/<id>.md before working             │
│  Model: highest-tier on the active subscription                │
│         (no `model:` pinned in frontmatters — see §6.1)        │
│  Tools: Read, Write, Edit, Bash, MCP, Agent                    │
│  Bash → codex exec when GPT reasoning genuinely fits           │
└─────────┬──────────────────────────────────────────────────────┘
          │ logs to
          ▼
┌────────────────────────────────────────────────────────────────┐
│  Supabase (simplified — 10 tables, see §7)                     │
└────────────────────────────────────────────────────────────────┘

Cron jobs (only three):
  07:00  morning-brief.ts     → Claude Code → Eleanor
  09:00  ceo-brief.ts         → Claude Code → Eleanor
  02:00  nightly-learning.ts  → Claude Code → brain-keeper subagent
```

### 5.1 Why Claude Code is the runtime, not a custom dispatcher

The original plan was to build a provider-agnostic adapter that read agent definitions, invoked a CLI, parsed output, and managed handoff. Claude Code already does this:

| Custom code we'd have written | What Claude Code provides natively |
|---|---|
| YAML/MD agent definition parser | Subagent frontmatter loader |
| Personality injection into prompt | Subagent system-prompt composition |
| Agent → agent handoff plumbing | Built-in `Agent` tool |
| Per-agent tool permissions | `tools:` field in frontmatter |
| Skill loading | `Skill` tool + existing skill plugins |
| MCP connection management | Built-in MCP client |
| Plugin extension system | Existing plugin marketplace |

The remaining custom code is small: a dispatcher that launches Claude Code sessions and a dashboard that drives it.

### 5.2 Hierarchical routing pattern (smart, depth-aware)

The hierarchy has **five tiers**: Eleanor (exec) → Department Head (director) → Manager → Associate → Intern. Each agent above an intern is intelligent enough to decide *which level* the work belongs at — not just blindly forward to the next level down.

The default *philosophy* is **delegate to the lowest competent level** so senior agents don't waste their time on grunt work and so work is spread across the org. Interns get most of the day-to-day execution; associates supervise interns and handle work above intern competence; managers coordinate associates; department heads handle scope & cross-team decisions; Eleanor handles routing & company-level questions.

```
User prompts dashboard
        ↓
Dispatcher launches Claude Code with Eleanor as the entry subagent
The dashboard creates a new project_messages thread and adds Eleanor
as the first project_participant.
        ↓
Eleanor reads agents/registry.md (FULL sub-tree, not just direct reports)
Eleanor reads her brain
Eleanor judges the work:
  • Cross-functional or strategic? → dispatch to Department Head
  • Single-team but coordination-heavy? → dispatch to Manager directly
  • Bounded execution? → dispatch to Associate directly
  • Trivial grunt task? → dispatch to Intern directly
Eleanor invokes the Agent tool with chosen target.
The dispatcher adds that target to project_participants.
        ↓
Receiving agent reads their brain + project_messages thread for context
Receiving agent makes the same depth-decision:
  • Can I do this myself competently? → do it
  • Should this go further down? → dispatch via Agent tool
The dispatcher adds the new participant to the project chat each time.
        ↓
Cascade continues until someone at the right competence level does the work.
        ↓
Outputs propagate back up the chain. Each upward level may add review,
framing, or summary, all visible as new project_messages.
        ↓
Final response surfaces as a project_message from Eleanor (or whoever
finalizes), tagged as the project's final output.
```

**All inter-agent communication for the project happens in the project chat.** No DMs. No personal channels. Every agent who joins (via handoff) is added to `project_participants` and sees the full thread. New agents added later (mid-project pivot) see the full prior context.

The user can intervene at any point: the dashboard streams each handoff event live, and the user can pause, redirect, or skip a level. User comments are written into the same `project_messages` thread.

### 5.3 Provider switchability + always-latest-model

Two layers of switchability:

**Layer 1 — runtime selection (Claude vs Codex).** A small config:

```
config/runtime.ts
  PRIMARY_RUNTIME = 'claude-code'   // 'claude-code' | 'codex'
  FALLBACK_RUNTIME = 'codex'
  AGENT_OVERRIDES = {
    // optional per-agent overrides where one provider's model genuinely wins
    'devraj-pillai': 'codex',  // hypothetical: GPT model better for this role
  }
```

The dispatcher reads `PRIMARY_RUNTIME` and launches the corresponding CLI. When OpenAI ships a model that decisively beats Claude across the board, swap `PRIMARY_RUNTIME = 'codex'`. The subagent definitions stay identical; Codex receives the personality as a system-prompt prefix.

**Layer 2 — model tier (within a runtime).** Subagent frontmatters do NOT pin a `model:` field (this gets stripped in §6.1's migration script). Without a pinned tier, Claude Code uses the session's default model — which on Claude Max is Opus, the highest available. When Anthropic ships a successor (e.g. Opus 5), the session default updates and every subagent picks up the new model with zero edits. Same logic applies to Codex — the CLI's default uses the highest tier the ChatGPT Pro subscription allows.

This is the **direct-injection** pattern — the agent definition is provider-agnostic content that whichever runtime executes, always at the best model that subscription provides.

## 6. Components in detail

### 6.1 Subagent definitions (`.claude/agents/<id>.md`)

**Already exist for 120 agents.** Format (verified from `adrian-rozario.md`):

```markdown
---
name: adrian-rozario
description: "Use for security engineer work. Assumes everything is compromised until proven otherwise."
tools: Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch
model: sonnet
---

You are Adrian Rozario, Security Engineer at Onepark Digital. You report to Tsai Wei-Ming in the engineering department.

# Your expertise
...
# Your archetype
...
# Your seniority
...
```

**Required edits to every agent file (one-time pass):**
1. A `# Your brain` section instructing the agent to read `brains/<id>.md` before any task and to append new learnings via the `Edit` tool.
2. A `# Your reports` section listing the agent's **full sub-tree** (every agent at any level beneath them), not just direct reports. This enables smart depth-skipping. Empty for interns.
3. A `# Your manager` section listing who they report to (for context, not dispatch).
4. A `# Routing guidance` section instructing the agent: *"When you receive work, decide whether to do it yourself or delegate. Delegate to the lowest competent level — interns do most grunt work, associates supervise interns, managers coordinate associates, etc. Skip levels when appropriate."*
5. The `Agent` tool added to `tools:` for any agent who can dispatch downward (everyone except interns).
6. **Strip the `model:` field from frontmatters.** Currently all 120 files pin `model: sonnet`, which is stale. The whole point of subscription routing is to always run on the highest-tier model the active subscription provides (Opus 4 today on Claude Max). Removing the field lets Claude Code use the session's default — which on Max is Opus. When Anthropic ships a successor model, the subagents pick it up automatically. No per-file maintenance.

A small one-time migration script reads the existing definitions, cross-references the `manager_id` graph from the Supabase `agents` table to compute each agent's sub-tree, and writes the additions back. The same script strips the `model:` line.

### 6.2 Brain docs (`agents/brains/<id>.md`)

**Append-only with periodic curation.** Each brain has:

```markdown
---
agent: adrian-rozario
last_updated: 2026-05-04
---

# Standing patterns
- (durable rules of thumb the agent has learned)

# Recent learnings (newest first)
- 2026-05-04: When asked to review auth code, also check session token rotation — missed this on the OnePark project.
- 2026-05-02: ...

# Anti-patterns observed
- (mistakes to avoid)
```

The agent reads its brain on every invocation. The nightly learning cron rewrites the file: new entries go to "Recent learnings", entries older than 30 days that have proven durable are promoted to "Standing patterns", and stale entries are pruned. The brain-keeper subagent does this curation per agent.

Brain docs are checked into git for full history. We do not need a separate `brain_versions` table — `git log` is the audit trail.

### 6.3 Dispatcher (`apps/orchestrator`, slimmed)

The orchestrator app is heavily reduced. **Keep:**
- `src/db.ts` — Supabase client
- `src/config.ts` — env loading
- A new `src/dispatcher.ts` — launches Claude Code sessions via Claude Agent SDK

**Delete:**
- `src/claude.ts` (Anthropic SDK calls)
- `src/agents/runner.ts`, `personality.ts`, `vision.ts`, `recent-work.ts`, `roster-context.ts`, `context-builder.ts`, `memory.ts` (all replaced by Claude Code)
- `src/rituals/{chatter,project-heartbeat,reflection,stall-detector,standup,daily-reset,dm-responder,project-responder,report-runner}.ts`
- All `src/seed/*` scripts that grant tools or set per-agent model tiers (Claude Code handles tool granting per-subagent in frontmatter)

**Replace:**
- `src/rituals/morning-greeting.ts` → `src/cron/morning-brief.ts` (spawns Claude Code with a fixed prompt to Eleanor)
- `src/rituals/ceo-brief.ts` → `src/cron/ceo-brief.ts` (same pattern)
- New: `src/cron/nightly-learning.ts` (runs brain curation across all agents)

The dispatcher exposes one HTTP endpoint to the dashboard: `POST /api/run` accepting `{ prompt, entry_agent, runtime_override? }`. It returns a run ID and streams events via SSE.

### 6.4 Dashboard (`apps/dashboard`, rebuilt)

Replace the existing four-view nav (TODAY, COMPANY, WORKBENCH, MESSAGES) with:

1. **COMMAND** — landing view. Single textarea: *"What do you need done?"*. Submit creates a new project, opens the project chat, and dispatches the prompt to Eleanor as the first message. Optional advanced controls: agent override (skip Eleanor, send directly to a specific agent), runtime override (Codex instead of Claude).

2. **PROJECTS** — left rail lists every project (active + completed) with most-recent-message preview. Selecting one opens **the project chat**:
   - **Header**: project title (auto-generated from prompt), status, list of `project_participants` with their tier badge (exec/director/manager/associate/intern). Participants accumulate as agents are added via handoff.
   - **Message log**: every `project_message` rendered as a chat — sender avatar/name, body, timestamp, kind tag (`handoff`/`output`/`comment`). User comments interleave.
   - **Handoff tree** (collapsible side-panel): visualizes the dispatch chain so you can see *who handed off to whom*, useful when the chat grows long.
   - **Compose box**: lets the user inject a comment into the chat that the next-acting agent will see.
   - **Live**: streams new messages and handoffs in real time via SSE.

3. **BRAINS** — agent picker → renders the agent's brain markdown with edit-in-place. Shows the last N nightly-learning diffs.

4. **HEALTH** — three rows for the cron jobs (last run, status, output preview); runtime quota row (Claude Max consumed %, Codex consumed %, and rate-budget headroom — see §6.8); soft-signal row (latency trend, recent CAPTCHA events, model downgrades).

**Dropped entirely:** TODAY (no chatter to surface), MESSAGES (no DMs, no personal channels — communication is project-scoped only), WORKBENCH (no longer the right shape).

### 6.5 Cron jobs (three only)

**Morning brief — 07:00 daily.** Cron triggers `apps/orchestrator/src/cron/morning-brief.ts`. Script reads the previous 24 hours of `agent_runs` from Supabase, formats a context block, and invokes the dispatcher with prompt: *"Eleanor, generate the morning brief for Shin: what shipped yesterday, what's blocked, what needs his attention today."* Output writes to a `briefs` table and surfaces as a dismissible banner at the top of every dashboard view (most-recent-first, latest brief on top). Older briefs accessible from the HEALTH view's "recent briefs" panel.

**CEO brief — 09:00 daily.** Same pattern. Different prompt, different audience tilt: *"Eleanor, prepare Shin's CEO brief: company-level decisions only, omit operational detail, surface anything that needs his judgment."*

**Nightly learning — 02:00 daily.** Cron triggers `apps/orchestrator/src/cron/nightly-learning.ts`. Script enumerates all 120 agents and, for each, invokes the dispatcher with a prompt to a `brain-keeper` subagent: *"Read the last 24 hours of `agent_runs` for `<agent_id>`. Read their current brain at `agents/brains/<id>.md`. Identify any durable new pattern, correction, or anti-pattern. Update the brain file accordingly. Commit changes."*

Cron runs serially (one agent at a time) to respect single-runtime concurrency. With 120 agents and ~30s per brain update, the nightly window completes in ~1 hour. Failures log to `cron_runs` and surface in the HEALTH view.

### 6.6 Codex CLI fallback

Two scenarios:

- **Per-agent strategic use.** A subagent's prompt body invokes Codex via Bash when the agent's role specifically benefits from GPT-5 reasoning. Example: a financial-modeling agent calls `codex exec "..."` and uses the result inside its own response. This is opt-in per agent definition.
- **Runtime fallback on Claude outage.** Dispatcher detects Claude Code session failure (timeout, auth error, Anthropic 5xx) and retries the same prompt with `codex exec`, prefixed with the same agent personality. Logged as `runtime: codex_fallback` in `agent_runs` so we know which projects ran on which provider.

Codex use is rate-budgeted: dispatcher tracks weekly Codex calls, surfaces the count in HEALTH, and refuses to fallback if we're near the ChatGPT Pro weekly cap.

### 6.7 Tools (Day 28 work, repurposed)

The Day 28 work-in-progress (`genviral.ts`, `view-image.ts`) is repurposed:

- **`view-image`** becomes a local tool exposed to subagents that need image input. The tool reads a file path and surfaces the image to the runtime. Whichever subagents need it list it in their frontmatter `tools:`.
- **`genviral`** becomes an MCP server (`mcp-genviral`) running locally. Subagents that own social-media drafting list `mcp__genviral__*` in their tools.
- The Supabase `social_drafts` table from migration 0023 stays, since it tracks pending-approval drafts independently of which runtime created them.

### 6.8 Rate hygiene & soft-ban prevention

Subscription auth is sold for human-paced, interactive use. Running 120 agents through it — even strictly serially — is far higher volume than a typical Claude Max user. Without explicit pacing, anomaly-detection systems at Anthropic and OpenAI will flag the account, leading to throttling, increased CAPTCHA challenges, model downgrades, or in the worst case suspension. The dispatcher owns this concern.

**Concrete mitigations enforced by the dispatcher:**

| Mitigation | Detail |
|---|---|
| **Single-runtime concurrency** | Only one Claude Code session active at any time. The dispatcher serializes everything — projects, cron jobs, brain updates — through a queue. No parallel sessions, no overlapping calls. |
| **Inter-call jitter** | 5–30 seconds randomized delay between sequential subagent invocations. Prevents the "machine-gun" pattern that anomaly detectors fire on. |
| **Burst smoothing on the nightly cron** | Instead of running 120 brain updates back-to-back at 02:00, spread them across the 02:00–04:00 window with random gaps. Roughly one brain update per minute. |
| **Daily call budget** | Dispatcher tracks total subscription calls per rolling 24h window. Default cap: 500/day on Claude (conservative — Max 20x is believed to handle several thousand but we don't push it). When the budget hits 70%, HEALTH warns; at 85%, dispatcher refuses new project starts (cron jobs still run); at 100%, cron jobs pause too. Resets at midnight local. |
| **Exponential backoff on errors** | On 429, 5xx, or auth errors: wait `2^n` seconds where `n` is consecutive-failure count. Cap at 5 minutes. **Never retry tighter than 1 second.** Three consecutive failures pause the dispatcher for 30 minutes. |
| **No retry-storm on auth failure** | If Claude Code session token expired, the dispatcher does NOT auto-retry. It surfaces a "session needs re-auth" notification (push + dashboard banner) and waits for the user. Hammering the auth endpoint is itself a soft-ban accelerant. |
| **Soft-signal monitoring** | Dispatcher tracks (a) median response latency, (b) frequency of 429s, (c) any model downgrade signals (Claude Code response metadata). When any trends adversely over 24h, HEALTH shows a yellow warning; over 72h, red. User can choose to switch to Codex fallback proactively. |
| **Human-natural cron timing** | Morning brief at 07:00, CEO brief at 09:00 — these match a real workday. Nightly learning at 02:00–04:00 is unavoidable but we keep it spread, not bursty. |
| **Single account, no proxying** | One Claude Max account, one ChatGPT Pro account. We do NOT rotate accounts to dodge limits — that's bot-farm behavior and is detection-trigger #1. If we hit caps, we accept the cap. |

**Failure mode: dispatcher gets soft-banned.** Symptoms: latency spike to 30s+ per call, 429s on every request, or persistent CAPTCHA. Response sequence: (1) HEALTH flips red, (2) dispatcher pauses Claude routing for 4 hours, (3) optionally falls through to Codex if user opts in, (4) sends push notification with the symptoms. Manual recovery only — do not auto-resume.

## 7. Data model (simplified Supabase schema)

**Tables to keep (with edits):**

| Table | Edits | Purpose |
|---|---|---|
| `agents` | Drop `daily_token_budget`, `tokens_used_today`, `chatter_posts_today`, `last_reset_company_date`, `last_reflection_at`, `addendum_loop_active`, `manager_overlay`, `learned_addendum`. Personality content lives in `.claude/agents/<id>.md` from now on. Keep `id`, `name`, `role`, `department`, `tier`, `manager_id`, `reports_to_ceo`, `status`. | Org chart, dashboard rendering |
| `agent_runs` (renamed from `agent_actions`) | Drop `input_tokens`, `output_tokens`, `system_prompt`, `user_prompt`. Add `runtime` (`claude_code` / `codex`), `parent_run_id` (handoff parent), `project_id`. | Runs + handoff tree |
| `tickets` | Renamed `projects`. Drop fields no longer used. | User-issued projects |
| `artifacts` | Keep | Final outputs of runs |
| `social_drafts` | Keep | Genviral integration (Day 28) |

**Tables to drop:**

| Table | Reason |
|---|---|
| `forum_posts` | No more inter-agent chatter |
| `dms` | No more inter-agent DMs |
| `memories` | Replaced by brain markdown files |
| `relationships` | No social/sentiment tracking |
| `world_clock` | No fictional company time |
| `standups` | Replaced by morning/ceo briefs |
| `wall_token_spend` | No per-token metering |
| `ritual_state` | Cron jobs use OS scheduler, no DB state |
| `cost_alerts` | No API spend |
| `prompt_evolution_log` | Brain docs in git replace this |

**New tables:**

| Table | Fields | Purpose |
|---|---|---|
| `briefs` | `id`, `kind` (`morning`/`ceo`), `body`, `created_at` | Cron-generated briefs |
| `cron_runs` | `id`, `cron_kind`, `status` (`ok`/`fail`/`partial`), `started_at`, `finished_at`, `error`, `agents_processed` | Cron observability |
| `project_messages` | `id`, `project_id`, `sender_type` (`agent`/`user`), `sender_id` (agent_id, nullable for user), `kind` (`prompt`/`handoff`/`output`/`comment`/`final`), `body`, `run_id` (FK to `agent_runs`, nullable for user comments), `parent_message_id` (nullable, for explicit reply-threading), `created_at` | The project chat — central, single thread per project; renders as the chat UI |
| `project_participants` | `project_id`, `agent_id`, `joined_at`, `joined_via_run_id` (the handoff that pulled them in, nullable for entry agent), unique `(project_id, agent_id)` | Who's in the project chat — accumulates as agents are added via handoff |
| `rate_budget` | `id`, `provider` (`claude`/`codex`), `window_start` (24h rolling), `calls_used`, `calls_cap` | Soft-ban hygiene; tracks subscription call budget per provider |

Final table count: **10** (agents, agent_runs, projects, artifacts, social_drafts, briefs, cron_runs, project_messages, project_participants, rate_budget) — down from ~15. Note: `dms` is firmly dropped — communication is project-chat-only.

## 8. Migration plan

A clean cutover, no strangler. The current orchestrator is no longer running anything we care about.

1. **Branch.** `feat/claude-code-rearchitecture`.
2. **Schema migration.** Write `0024_phase2_simplification.sql` that drops the dead tables, alters surviving tables, and creates `briefs`, `cron_runs`, `project_messages`, `project_participants`, `rate_budget`.
3. **Subagent file pass.** One-time script that walks `.claude/agents/*.md` and rewrites each:
   - Look up the agent's `manager_id` in the existing `agents` table
   - Compute the **full sub-tree** under each agent (BFS down through manager_id graph)
   - Append `# Your manager`, `# Your reports` (full sub-tree, grouped by tier — Director, Manager, Associate, Intern), `# Your brain`, and `# Routing guidance` sections
   - Add `Agent` to `tools:` for any agent with a non-empty sub-tree (every tier above intern)
   - **Strip the `model:` field** so subagents inherit the session's default (Opus 4 on Max)
4. **Brain bootstrap.** For each agent, create `agents/brains/<id>.md` with empty sections. Seed `# Standing patterns` from the existing `learned_addendum` field if non-empty.
5. **Generate `agents/registry.md`.** Auto-generated from the `agents` table: name, id, department, tier, one-line specialty per agent, organized by department and clearly tagged with tier (so smart-routing decisions can match work to level). Eleanor reads this on every invocation.
6. **Dispatcher.** Build `src/dispatcher.ts` and `POST /api/run` endpoint. Launch a Claude Code session via Claude Agent SDK with Eleanor as the entry subagent. Implement rate hygiene from §6.8 (queue + jitter + backoff + budget tracking). Stream events via SSE. Persist every run as `agent_runs` AND project_message; add new participants to `project_participants` on each handoff.
7. **Dashboard rebuild.** Replace TODAY/COMPANY/WORKBENCH/MESSAGES with COMMAND/PROJECTS/BRAINS/HEALTH. Wire PROJECTS to the project_chat data model (messages + participants + handoff tree). Wire HEALTH to cron_runs + rate_budget tables.
8. **Cron scripts.** Write the three cron jobs. Nightly-learning spreads its 120 brain updates across the 02:00–04:00 window (random gaps). Configure OS-level scheduler.
9. **Delete.** Once dashboard works end-to-end with one project, delete the legacy orchestrator code in a single commit (no half-states).
10. **Onepark-web pivot.** Separate work; spec-stub in §10.

Estimated build size: **2–3 weeks of focused work** (the rate-hygiene + project-chat additions push it slightly past the original 2-week estimate).

## 9. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic detects automated subscription use → soft-ban (throttling, CAPTCHA, model downgrade) or hard suspension | **High** | Full rate hygiene per §6.8: jitter, daily budget, exponential backoff, no auth retry-storms, soft-signal monitoring, single-runtime concurrency. Codex fallback when Claude degrades. Keep an Anthropic API key in cold storage as last-resort manual recovery (NOT used in normal operation). |
| OpenAI more aggressive → Codex fallback unreliable | Medium | Treat Codex as nice-to-have, not load-bearing. Most projects should run pure Claude. Don't schedule cron jobs through Codex. Same rate hygiene applied to Codex calls. |
| Hierarchical routing depth-judgment errors: agent over-delegates trivial work to interns who botch it, OR keeps work too high (senior burns time on grunt) | Medium | Dashboard shows every routing decision with the agent's reasoning. User can redirect at any handoff. Each redirect feeds into the redirected agent's nightly brain update so they learn the correction. Routing guidance prompt explicitly emphasizes *competent* not *cheap*. |
| 5-deep chains (Eleanor→Head→Manager→Associate→Intern) burn 5+ Claude calls per project + bubble-up | High | Encourage skip-levels in routing guidance — *most* projects shouldn't go 5 deep. Track avg-depth per project in HEALTH. Daily budget enforced per §6.8 covers worst case. |
| Project chat blows up — long projects with many participants and 50+ messages get unwieldy in the UI | Medium | UI has collapsible handoff-tree side-panel for navigation. Older messages collapse with "show N more". Search within project. If a project genuinely needs splitting, manual user action: spawn a child project that links to parent. |
| Brain docs bloat without curation | Medium | Nightly learning cron does the curation. If skipped for >7 days, HEALTH shows a warning. |
| Subscription auth tokens expire mid-cron at 02:00 | Low–Medium | Cron script catches auth errors, surfaces via push notification, does NOT retry. User re-auths next morning. |
| Claude Code subagent crashes lose context mid-handoff | Low | Dispatcher persists `agent_runs` row + `project_message` before each subagent call; on crash, can resume from the last completed handoff. |
| Cross-runtime handoff (Claude → Codex) loses context | Medium | Don't do mid-project runtime switches. If one runtime fails, retry the whole project on the other from scratch. |
| Stripping `model:` from frontmatters means Claude Code's default is unclear — what if it's still sonnet? | Low | Verify on first session that the dispatcher reports Opus as the active model. If CC defaults to Sonnet on Max, set `model: opus` explicitly in frontmatters as a fallback. Tested in step 6 of migration. |

## 10. Marketing site pivot (`onepark-web`) — sketch only

Out of scope for implementation in this spec, but worth committing the direction so the spec spans both repos:

- Hero: *"AI-augmented consulting. Real outputs, named team, transparent process."*
- New `/services` page: 3–5 consulting offerings (e.g. "AI strategy review", "MVP build sprint", "Process automation audit"), each with what's included, timeline, and starting price.
- `/team` page reframes the 18 featured agents as the consulting team. Each bio explicitly says *"AI agent — see Build Log for how this works."* Honest, transparent.
- `/work` page hosts case studies of completed consulting engagements.
- `/build-log` continues as the public weeknotes feed.
- `/manifesto` reframes from "AI-native company" to "Why AI consulting works".
- Contact form routes to a real inbox, not a placeholder.

A separate spec will detail this pivot; this spec just commits the direction.

## 11. Out of scope

- Building a SaaS product on top of this. Onepark Digital is a consultancy, not a platform.
- Multi-tenant. The `tenant_id` columns can stay for future-proofing but only one tenant exists.
- Real-time collaboration with the user during a project (e.g. user types feedback while Eleanor is mid-routing). Not in V1; intervene = pause + restart.
- Billing or usage attribution. No customer-facing metering.
- Automatic brain merging across agents. Each agent owns their own brain; no cross-pollination.
- Replacing Claude Code's subagent feature with our own. We use it as-is.
- **Inter-agent direct messaging or personal channels.** All communication is project-scoped. No DMs, no agent-to-agent private chat, no broadcast channels.
- **Parallel project execution.** One Claude Code session at a time. If five projects are queued, they run in order. This is also a soft-ban-prevention requirement (§6.8).

## 12. Open TBDs

1. **Streaming protocol from dispatcher to dashboard.** SSE vs WebSocket. Default SSE; fall back to WS only if needed.
2. **Whether to commit `agents/brains/` to the headcount repo or a separate repo.** Recommend headcount repo, alongside `.claude/agents/`. Single source of truth.
3. **How Eleanor learns the routing patterns.** Initially: no special mechanism, just her brain. Later, possibly: a routing-feedback table that captures user redirects and feeds them into Eleanor's nightly learning.
4. **Onepark-web case study content.** Need actual completed consulting work to write up. Out of scope but the gating constraint for the marketing pivot.
5. **Whether `apps/orchestrator/` deserves to be renamed once stripped down.** It's no longer an orchestrator. Suggested: `apps/dispatcher/`. Defer to implementation.
6. **Authentication on the dashboard.** Currently has `app/auth/` and `app/login/`. Keep as-is; this is a single-user tool but we don't unwire auth.

---

## Approval

This spec replaces the existing Days 1–28 design. Approval here means we cut the new branch and start the migration in §8.

Reviewer: Shin
