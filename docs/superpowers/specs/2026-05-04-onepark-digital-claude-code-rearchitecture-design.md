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
2. **Hierarchical project routing.** A user-issued prompt enters via Eleanor (Chief of Staff), cascades down to department head → manager → associate, and bubbles results back up.
3. **Per-agent learning via brain docs.** Each agent owns a markdown brain that accumulates skills and corrections, updated by an overnight learning cron.
4. **Dashboard as the command surface.** All agent invocations originate from the dashboard, not from raw CLI usage.
5. **Marketing-site pivot to AI consulting.** `onepark-web` becomes a transparent AI-consulting site under the Onepark Digital umbrella.
6. **Runtime-switchable.** Today's primary is Claude Code; switching to Codex CLI (or a future runtime) when a better model lands should be a configuration change, not a rewrite.

## 3. Non-goals

- Parallel/async multi-agent execution. Strictly serial.
- 24/7 autonomous operation. Cron jobs are limited to three named rituals.
- Inter-agent chatter, DMs, fictional company time, or relationship sentiment tracking. All deleted.
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
│  ┌─────────────┐ ┌──────────────┐ ┌──────────┐ ┌────────────┐  │
│  │  COMMAND    │ │  PROJECTS    │ │  BRAINS  │ │  HEALTH    │  │
│  │  prompt in  │ │  task tree   │ │  per-    │ │  cron      │  │
│  │  agent pick │ │  per project │ │  agent   │ │  status    │  │
│  │  output     │ │  + handoffs  │ │  editor  │ │  + quota   │  │
│  └──────┬──────┘ └──────────────┘ └──────────┘ └────────────┘  │
│         │ POST /api/run                                        │
└─────────┼──────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│  Run dispatcher (apps/orchestrator, slimmed)                   │
│                                                                │
│  - Spawns Claude Code session via Claude Agent SDK             │
│  - Streams events back over WebSocket / SSE                    │
│  - Logs run start/finish/handoff to Supabase                   │
│  - Falls back to Codex CLI if Claude is unreachable            │
└─────────┬──────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│  Claude Code (subscription auth — Claude Max)                  │
│                                                                │
│  Initial prompt → Eleanor (Chief of Staff)                     │
│    └─ reads agents/registry.md (auto-generated org chart)      │
│    └─ Agent tool dispatches to Department Head                 │
│        └─ Agent tool dispatches to Manager                     │
│            └─ Agent tool dispatches to Associate               │
│    ← outputs propagate back up                                 │
│                                                                │
│  Each subagent reads brains/<id>.md before working             │
│  Tools: Read, Write, Edit, Bash, MCP                           │
│  Bash → codex exec when GPT-5 reasoning genuinely fits         │
└─────────┬──────────────────────────────────────────────────────┘
          │ logs to
          ▼
┌────────────────────────────────────────────────────────────────┐
│  Supabase (simplified — 7 tables, see §7)                      │
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

### 5.2 Hierarchical routing pattern

```
User prompts dashboard
        ↓
Dispatcher launches Claude Code with Eleanor as the entry subagent
        ↓
Eleanor reads `agents/registry.md` (compressed org chart)
Eleanor decides which department(s) the request touches
Eleanor invokes the Agent tool, dispatching to the relevant department head
        ↓
Department head reads their brain + the project context
Department head decides scope and which manager to involve
Department head invokes the Agent tool, dispatching to the manager
        ↓
Manager reads their brain
Manager decides scope and which associate to assign
Manager invokes the Agent tool, dispatching to the associate
        ↓
Associate does the actual work, returns the artifact
        ↓
Outputs propagate back up the chain. Each level may add framing, quality checks, or a summary
        ↓
Final response surfaces in the dashboard with the full handoff tree visible
```

The user can intervene at any point: the dashboard streams each handoff event live, and the user can pause, redirect, or skip a level.

### 5.3 Provider switchability

The `model:` field in each subagent's frontmatter today resolves to a Claude tier. To keep the design provider-flippable, we adopt a config layer:

```
config/runtime.ts
  PRIMARY_RUNTIME = 'claude-code'   // 'claude-code' | 'codex'
  FALLBACK_RUNTIME = 'codex'
  AGENT_OVERRIDES = {
    // optional per-agent overrides for cases where one model genuinely wins
    'devraj-pillai': 'codex',  // hypothetical: GPT-5 better at this role's work
  }
```

The dispatcher reads `PRIMARY_RUNTIME` and launches the corresponding CLI. When Anthropic ships a new top model and we stay on Claude, the change is one line. When OpenAI ships a model that decisively beats Claude across the board, swap `PRIMARY_RUNTIME = 'codex'`. The subagent definitions stay identical; Codex receives the personality as a system-prompt prefix.

This is the **direct-injection** pattern — the agent definition is provider-agnostic content that whichever runtime executes.

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

**Required additions to every agent file (one-time pass):**
1. A `# Your brain` section instructing the agent to read `brains/<id>.md` before any task and to append new learnings via the `Edit` tool.
2. A `# Your reports` section listing the agent's direct reports (the agents they can dispatch to via the Agent tool). Empty for associates.
3. A `# Your manager` section listing who they report to (for context, not dispatch).
4. The Agent tool added to `tools:` for any agent who can dispatch downward.

A small one-time migration script reads the existing definitions, cross-references the `manager_id` graph from the Supabase `agents` table, and writes the additions back.

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

1. **COMMAND** — landing view. Single textarea for project prompt; a default "Send to Eleanor" button; an optional agent override; a runtime override. After submit, the live handoff tree streams in.
2. **PROJECTS** — list of past and active runs, each opening to its full handoff tree (which agents touched it, in what order, what each produced).
3. **BRAINS** — agent picker → renders the agent's brain markdown with edit-in-place. Shows the last N nightly-learning diffs.
4. **HEALTH** — three rows for the cron jobs (last run, status, output preview), plus a row for runtime quota status (Claude Max remaining %, Codex remaining %).

Drop entirely: TODAY (no chatter, no DMs to surface), MESSAGES (no inter-agent messaging), WORKBENCH (no longer the right shape).

The COMMAND view's streaming display follows the dispatcher's SSE feed: each handoff event becomes a node in a tree, with the active node highlighted and the user's "intervene" buttons live (pause / redirect / skip).

### 6.5 Cron jobs (three only)

**Morning brief — 07:00 daily.** Cron triggers `apps/orchestrator/src/cron/morning-brief.ts`. Script reads the previous 24 hours of `agent_runs` from Supabase, formats a context block, and invokes the dispatcher with prompt: *"Eleanor, generate the morning brief for Shin: what shipped yesterday, what's blocked, what needs his attention today."* Output writes to a `briefs` table and is rendered on the dashboard COMMAND landing.

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

Final table count: **7** (agents, agent_runs, projects, artifacts, social_drafts, briefs, cron_runs) — down from ~15.

## 8. Migration plan

A clean cutover, no strangler. The current orchestrator is no longer running anything we care about.

1. **Branch.** `feat/claude-code-rearchitecture`.
2. **Schema migration.** Write `0024_phase2_simplification.sql` that drops the dead tables, alters surviving tables, and creates `briefs` + `cron_runs`.
3. **Subagent file pass.** One-time script that walks `.claude/agents/*.md`, looks up each agent's `manager_id` in the existing `agents` table, and appends `# Your manager`, `# Your reports`, and `# Your brain` sections. Adds `Agent` to `tools:` for non-leaf agents.
4. **Brain bootstrap.** For each agent, create `agents/brains/<id>.md` with empty sections. Seed `# Standing patterns` from the existing `learned_addendum` field if non-empty.
5. **Generate `agents/registry.md`.** Auto-generated from the `agents` table: name, id, department, tier, one-line specialty per agent, organized by department. Eleanor reads this on every invocation.
6. **Dispatcher.** Build `src/dispatcher.ts` and `POST /api/run` endpoint. Launch a Claude Code session via Claude Agent SDK with Eleanor as the entry subagent. Stream events via SSE.
7. **Dashboard rebuild.** Replace TODAY/COMPANY/WORKBENCH/MESSAGES with COMMAND/PROJECTS/BRAINS/HEALTH. Wire to new dispatcher endpoint and the simplified schema.
8. **Cron scripts.** Write the three cron jobs. Configure OS-level scheduler (cron on Linux, Task Scheduler on Windows, or PM2 ecosystem.config).
9. **Delete.** Once dashboard works end-to-end with one project, delete the legacy orchestrator code in a single commit (no half-states).
10. **Onepark-web pivot.** Separate work; spec-stub in §10.

Estimated build size: **2 weeks of focused work**, not the 3+ months the original Day-28-and-counting roadmap implied.

## 9. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic detects automated subscription use → throttling or suspension | **High** | Codex fallback already in design. Keep an Anthropic API key in cold storage as last-resort manual recovery (not used in normal operation). Monitor for soft signals (latency increase, 429s) in HEALTH view. |
| OpenAI more aggressive → Codex fallback unreliable | Medium | Treat Codex as nice-to-have, not load-bearing. Most projects should run pure Claude. Don't schedule cron jobs through Codex. |
| Hierarchical routing accuracy: Eleanor picks the wrong department | Medium | Dashboard shows the routing decision; user can redirect. After enough redirects, the brain-keeper learns the correction. |
| Brain docs bloat without curation | Medium | Nightly learning cron does the curation. If skipped for >7 days, HEALTH shows a warning. |
| Each handoff = one Claude Code call → 4-deep chains burn quota fast | Medium | Track per-day call count in HEALTH. If >70% of weekly Max quota by Friday, throttle to project-only (skip cron). |
| Subscription auth tokens expire mid-cron at 02:00 | Low–Medium | Cron script catches auth errors, re-prompts to log in via push notification (existing pattern). |
| Claude Code subagent crashes lose context mid-handoff | Low | Dispatcher persists `agent_runs` row before each subagent call; on crash, can resume from the last completed handoff. |
| Cross-runtime handoff (Claude → Codex) loses context | Medium | Don't do mid-project runtime switches. If one runtime fails, retry the whole project on the other. |

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
