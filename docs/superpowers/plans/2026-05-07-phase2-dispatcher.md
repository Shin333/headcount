# Phase 2: Dispatcher

**Status:** Plan (pending review)
**Date:** 2026-05-07
**Author:** Shin (with Claude)
**Spec ref:** [docs/superpowers/specs/2026-05-04-onepark-digital-claude-code-rearchitecture-design.md](../specs/2026-05-04-onepark-digital-claude-code-rearchitecture-design.md)

---

**What this plan covers.** The dispatcher is the runtime that replaces the legacy tick-driven orchestrator. It exposes `POST /api/run`, launches Claude Code via `@anthropic-ai/claude-agent-sdk` with Eleanor as the entry agent, streams SSE back to the dashboard, persists every step to `agent_runs` and `project_messages`, and enforces rate hygiene against the `rate_budget` table. Phase 2 ends when a project initiated from the dashboard runs end-to-end through the dispatcher with full persistence.

**What it depends on.** Plan 1 complete: schema migrated to 13 tables (Phase 1 Task 1.x), all 119 `.claude/agents/*.md` files have manager / reports / brain / routing sections (Task 2.x), `agents/registry.md` generated (Task 4.1), `agents/brains/<slug>.md` files bootstrapped (Task 3.1), Eleanor smoke-tested in a fresh Claude Code session (Task 5.1). Auth policy defined per spec §6.9 (Auth policy).

**What's out of scope.** Plan 3 will rebuild the dashboard around the project-chat data model. Plan 4 will write the three cron rituals (07:00 morning brief, 09:00 CEO brief, 02:00 nightly learning). Plan 5 will delete legacy code (`apps/orchestrator/src/{rituals,seed,agents,comms,commitments,reports,world}/` and the root `chatter.ts` / `dm.ts` / `reflection.ts` / `runner.ts` / `claude.ts` files). This plan stops at: dispatcher boots, accepts a project request, runs Eleanor, streams events back to the dashboard, persists `agent_runs` + `project_messages` rows.

---

## Phase 1: SDK foundation

### Task 1.1: Install `@anthropic-ai/claude-agent-sdk`

**Status:** TO DO.

**Reason.** The dispatcher runtime depends on this SDK. Currently only `@anthropic-ai/sdk@0.32.1` (the API SDK — different package, different purpose) is installed. Per Phase 2 recon, the package is `@anthropic-ai/claude-agent-sdk`; minimum version `v0.2.111+` is required for Opus 4.7 support.

**Approach.**

- Add `@anthropic-ai/claude-agent-sdk` to `apps/orchestrator/package.json` dependencies, pinned to a specific version (the SDK is at v0.x and breaking changes between minor versions are possible).
- Run `pnpm install` to update the lockfile.
- Verify the bundled Claude Code binary lands in the package's optional dependencies — the TypeScript SDK ships it so no separate Claude Code install is needed.

**Acceptance.** Package present in `package.json`, lockfile updated, `import { query } from "@anthropic-ai/claude-agent-sdk"` resolves to a function from anywhere inside `apps/orchestrator/`.

### Task 1.2: Smoke test `query()` end-to-end

**Status:** TO DO.

**Reason.** Prove the SDK works in this environment with the OAuth-from-`~/.claude/credentials.json` auth path before scaffolding the dispatcher. This validates auth, `cwd` config, and subagent invocation via the SDK rather than via interactive Claude Code (Plan 1 Task 5.1 only validated the latter).

**Approach.**

- Write a one-shot script at `apps/orchestrator/src/migrations/foundation/sdk-smoke-test.ts`.
- The script invokes `query()` with `cwd: REPO_ROOT` and a prompt that targets Eleanor (e.g., "Eleanor, briefly introduce yourself").
- Before invoking, the script aborts with a clear error if `ANTHROPIC_API_KEY` is set in the env — we want OAuth, not API key, per spec §6.9.
- Confirm the returned `AsyncGenerator` yields messages and ends in an `SDKResultMessage` with `subtype: "success"`.

**Acceptance.** Script runs to completion, Eleanor's response includes recognizable identity content (Chief of Staff, Onepark Digital, etc.), and the final result message lands. Script lives in `migrations/foundation/` for reproducibility — same shape as the Phase 1 migration scripts.

---

## Phase 2: HTTP server scaffold

### Task 2.1: Hono setup + dispatcher module structure

**Status:** TO DO.

**Reason.** Phase 2 recon confirmed zero existing HTTP surface in the orchestrator (the only `createServer` call is the transient OAuth callback in `auth/google-oauth.ts`). A net-new module is needed.

**Approach.**

- Add `hono` to `apps/orchestrator/package.json` dependencies.
- Create `apps/orchestrator/src/dispatcher/` with three files: `server.ts` (Hono app construction + bootstrap), `types.ts` (request / response / SSE event shapes), `index.ts` (public exports — `startDispatcherServer`, types).
- The bootstrap function takes a port and starts the server.

**Acceptance.** `import { startDispatcherServer } from "./dispatcher"` resolves from `index.ts`. Calling `startDispatcherServer({ port })` starts a bare server that responds to `GET /` (or `/health`) with a placeholder OK response.

### Task 2.2: `POST /api/run` skeleton with SSE response

**Status:** TO DO.

**Reason.** Defines the contract the dashboard will call. Nailing the request / response shape early gives Phase 4 (persistence) and Phase 5 (dashboard wiring) a stable target.

**Approach.**

- Route accepts JSON body `{ project_id, prompt, entry_agent_slug? }` (slug optional, defaults to Eleanor).
- Returns an SSE stream (`Content-Type: text/event-stream`).
- Emit typed events as a discriminated union: `run_started`, `assistant_message`, `tool_use`, `tool_result`, `subagent_handoff`, `run_completed`, `error`.
- The skeleton emits placeholder events without invoking the SDK yet — the SDK wires up in Phase 4 (persistence).
- Document the event vocabulary in `dispatcher/types.ts`.

**Acceptance.** `curl -N -X POST localhost:3001/api/run -d '{...}'` receives a stream of SSE events using the placeholder vocabulary. Event type definitions live in `dispatcher/types.ts` and are exported from `dispatcher/index.ts`.

---

## Phase 3: Queue + rate hygiene

### Task 3.1: Single-worker in-memory queue

**Status:** TO DO.

**Reason.** The spec invariant requires "strictly serial — one Claude Code session at a time" (§3, §6.8). This is also the soft-ban prevention strategy.

**Approach.**

- In-memory FIFO queue inside the dispatcher module.
- One worker loop drains the queue sequentially.
- `POST /api/run` enqueues and returns the SSE stream that's bound to the eventual run.
- If a run is already in-flight, the new request waits in the queue. SSE keepalive (e.g., periodic comment lines) keeps the connection from idling out while waiting.
- Add `GET /api/queue` introspection endpoint that returns current queue depth and the in-flight run's basic metadata.

**Acceptance.** Two concurrent `POST /api/run` calls process serially — the second one's first non-keepalive event timestamp is after the first one's `run_completed` event. Queue depth visible via `GET /api/queue`.

### Task 3.2: Daily-budget tracking via `rate_budget`

**Status:** TO DO.

**Reason.** Spec invariant of 500/day Claude budget (§6.8). Persisting to `rate_budget` means a PM2 restart mid-day doesn't reset the counter and accidentally let the dispatcher exceed the cap.

**Approach.**

- Before dequeuing a run, check `rate_budget` for today's usage on the relevant `provider` key (`claude` for Agent SDK runs).
- If at cap, hold the run in queue and emit a `budget_exhausted` SSE event with the current count and the reset timestamp.
- Increment the counter after each `run_completed` (and possibly per significant tool call — final design TBD during execution).
- Schema is the one created in 0024: `rate_budget` columns include `provider`, `usage_count`, `window_start`, `cap`, etc.

**Acceptance.** A 501st run in a single day waits in the queue and emits `budget_exhausted`. Counter visible in DB. Counter resets at the next day's window start.

### Task 3.3: Jitter + exponential backoff on transient failures

**Status:** TO DO.

**Reason.** Spec invariant — "jitter (5–30s), exponential backoff, no auth-retry storms, soft-signal monitoring" (§6.8).

**Approach.**

- Between successive runs, insert randomized jitter in the 5–30s range.
- On transient SDK errors (network failures, 5xx responses), retry with capped exponential backoff: 3 retries at 10s → 30s → 90s.
- On auth errors (401, 403), do NOT retry — fail fast and emit a clear `error` SSE event with a message instructing the operator to run `claude auth login`.
- Soft-signal monitoring: when transient errors cluster within a short window, write a structured log line via `ops/logger.ts` so we can spot rate-limit canaries early.

**Acceptance.** Synthetic test where the SDK is mocked to throw a transient error confirms the backoff sequence. Auth error fails immediately without retry. Soft-signal log line lands when expected.

---

## Phase 4: Persistence layer

### Task 4.1: `agent_runs` writes from streamed events

**Status:** TO DO.

**Reason.** Every dispatched run gets a row for traceability — project, agent, status, timing, and parent for handoffs. This table is the source of truth for "what did the dispatcher do, when, and why."

**Approach.**

- Insert an `agent_runs` row on `run_started` with `status: 'running'`.
- Update on `run_completed` with end timestamp and final status.
- Capture `runtime` field — `claude-code` for Agent SDK runs, leaving room for `codex` fallback later.
- Column set is the one from the 0024 amendment: `id`, `agent_id`, `project_id`, `runtime`, `parent_run_id`, `started_at`, `completed_at`, `status` (and any others present in the live schema).

**Acceptance.** A single dispatched run produces exactly one row in `agent_runs` with start/end timestamps and a final status. Failed runs land with `status: 'failed'` and a captured error message.

### Task 4.2: `project_messages` writes from streamed events

**Status:** TO DO.

**Reason.** Project chat is the only channel for inter-agent communication (spec invariant). Every assistant message, handoff, and final output must land as a `project_messages` row so the dashboard chat view can render them.

**Approach.**

- Map SDK event types to `kind` values per the 0024 schema: `prompt`, `handoff`, `output`, `comment`, `final`.
- `sender_type` is `agent` for SDK output, `user` for the inbound prompt that initiated the run.
- Populate `run_id` (FK to `agent_runs`) and `parent_message_id` from event metadata.
- Preserve message ordering via `created_at` — write rows in stream-arrival order.

**Acceptance.** Replaying a run's `project_messages` rows in `created_at` order reconstructs the conversation faithfully — every assistant message and handoff is captured, in order.

### Task 4.3: Subagent attribution via `parent_tool_use_id`

**Status:** TO DO.

**Reason.** When Eleanor dispatches to Tsai (or further down the chain), the resulting `agent_runs` and `project_messages` rows must attribute correctly. The Agent SDK provides a `parent_tool_use_id` field on subagent messages — Phase 2 recon confirmed.

**Approach.**

- Maintain an in-memory map `tool_use_id → run_id` for the duration of a session.
- On a subagent message that carries `parent_tool_use_id`, look up the parent run and set the subagent's `agent_runs.parent_run_id` accordingly.
- The same lookup populates `project_messages.parent_message_id` and `kind: 'handoff'` for the dispatch event.

**Acceptance.** A run where Eleanor dispatches to Tsai produces two `agent_runs` rows — Eleanor's and Tsai's — with Tsai's `parent_run_id` pointing to Eleanor's `id`. The chat view shows the handoff with Tsai's response rendered as a child of Eleanor's dispatch message.

---

## Phase 5: End-to-end integration

### Task 5.1: Dashboard hotfix — `project_members` → `project_participants`

**Status:** TO DO.

**Reason.** Phase 2 recon found `apps/dashboard/app/api/projects/route.ts:37` queries the table as `project_members` — but 0024 renamed it to `project_participants`. The dashboard's projects view is broken today. Cheap fix; big sanity-check win when verifying Task 5.3.

**Approach.**

- Rename in `apps/dashboard/app/api/projects/route.ts`.
- Grep across `apps/dashboard/` for any other stale references to `project_members` and fix them too.

**Acceptance.** Dashboard `/projects` view loads without error against the live DB. No remaining `project_members` references in `apps/dashboard/`.

### Task 5.2: Replace `index.ts:main()` to boot the dispatcher

**Status:** TO DO.

**Reason.** Current `index.ts:main()` calls `startTickLoop()` which imports rituals that query dropped tables — the orchestrator crashes on startup today. Phase 2 replaces this with `startDispatcherServer()`. Legacy code stays in tree until Plan 5 nukes it; only the entry point flips.

**Approach.**

- Gut `main()`'s startup checks that reference dropped state — `world_clock`, `agent.tool_access`, `agent.mcp_access`.
- Keep the encryption-key warning (still relevant for `agent_credentials`) and the shutdown registration.
- Swap the call to `startTickLoop()` for `startDispatcherServer()` from the new dispatcher module.

**Acceptance.** `pnpm dev` from `apps/orchestrator/` boots cleanly. PM2 keeps the process alive past `min_uptime: 60000`. The HTTP server responds on the configured dispatcher port.

### Task 5.3: End-to-end smoke test from dashboard

**Status:** TO DO.

**Reason.** Prove the full chain works — dashboard initiates a project, dispatcher picks it up, Eleanor runs, persistence writes, SSE streams back, dashboard renders the conversation. This is the "Phase 2 done" gate.

**Approach.**

- Use the existing dashboard project-creation flow if intact post-hotfix; otherwise add a temporary `/api/projects/create` shim.
- Kick off a project with a simple prompt — for example, "Eleanor, please give me a status report on the Engineering team."
- Verify Eleanor invokes Tsai (or another engineering agent) via dispatch.
- Confirm `project_messages` rows populate and the dashboard chat view renders them in stream order.

**Acceptance.** End-to-end flow completes in under 2 minutes. The project ends with a `final` message from Eleanor. `agent_runs` shows at least one parent (Eleanor) and one child (whoever she dispatched to). The dashboard chat view shows the conversation cleanly with handoff threading visible.

---

## Phase 6: Closure

### Task 6.1: Push `feat/claude-code-rearchitecture` (Plan 2 work)

**Status:** TO DO.

**Reason.** Phase 2 work is significant — push when the integration smoke test passes, before starting Plan 3. The branch upstream was set in Phase 1 Task 5.2.

**Approach.**

- `git push` to the existing upstream.
- Confirm the remote branch matches local commit-by-commit.

**Acceptance.** GitHub shows the Plan 2 commits on the branch. CI (if any) is green.

---

## Estimated scope

14 tasks across 6 phases. Comparable to Plan 1's scope; expect 2–3 weeks of focused work given Phase 1's pace.

## Risk register

- **SDK auth policy interpretation.** Documented in spec §6.9 (Auth policy). If Anthropic clarifies otherwise, Phase 2 may need to switch to API-key auth with daily $ caps — significant rework of Task 3.2 and a re-think of the spec invariant.
- **SDK API stability.** `@anthropic-ai/claude-agent-sdk` is at v0.x. Breaking changes between minor versions are possible. Pin the version in `package.json` (Task 1.1).
- **Persistence schema drift.** Phase 4 assumes the 0024 schema (e.g., `agent_runs.runtime`, `agent_runs.parent_run_id`) holds. Any further schema migrations during Phase 2 work require revisiting Tasks 4.1–4.3.
