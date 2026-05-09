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

## Amendments

### Amendment 2026-05-09 — Main-router pivot (post-Task 5.3 attempt 1)

**Why.**

Task 5.3 attempt 1 (2026-05-09) failed Gate 3 even after Eleanor's persona received an explicit dispatch directive (Plan 1 amendment, commit `6feb081`). Empirical finding: the Claude Agent SDK does not expose the Agent tool to a subagent at runtime, regardless of what the subagent's `.claude/agents/<slug>.md` frontmatter `tools:` line declares. Nested dispatch (subagent → subagent) is not the SDK's intended pattern.

The "entry agent" concept Plan 2 originally adopted (dispatcher resolves an `entry_agent_slug`, wraps the SDK call to dispatch into that agent) put every persona-bearing agent into a subagent context where they cannot dispatch further. The empirically successful path in Phase 4 verification was always the SDK main agent improvising sibling dispatches around the entry — non-deterministic and architecturally backwards.

**What changes.**

The SDK's main agent becomes the dispatcher's router. Personas (Eleanor, Tsai, Tessa, …) are subagents the main agent dispatches to based on prompt content. There is no "entry agent" — there is a user prompt, the main agent, and a flat namespace of dispatchable subagents.

Concretely:

1. **New sentinel agent `main-router`** with id `00000000-0000-0000-0000-000000a1a1a1` (the originally drafted `…ma1n` rendering is not valid UUID hex; substituted to a valid all-zeros + alternating-`a1` pattern that's visually distinct as a sentinel and parseable by Postgres). Persona: "You are the dispatcher router. Read the user's request, choose the most appropriate department head or specialist subagent via the Agent tool, and synthesize their response. Never answer from your own context — always dispatch."

2. **Migration 0027** inserts the `main-router` row into `agents`. `department=NULL`, `role='router'`, `tier='bot'` (the `agents_tier_check` constraint allows `exec | director | manager | associate | intern | bot`; `bot` matches the `uncle-tan` automation-sentinel precedent), `status='active'`. The main-router persona text lives in `apps/orchestrator/src/dispatcher/main-router-prompt.ts` and is passed to the SDK `query()` call via the `systemPrompt` option (concretely: `{ type: 'preset', preset: 'claude_code', append: MAIN_ROUTER_SYSTEM_PROMPT }`, so the Claude Code preset's Agent-tool wiring is preserved and the routing directive appends to it). It is NOT placed in `.claude/agents/`, because that directory is read by the SDK as subagent definitions — putting main-router there would register it as a dispatchable subagent (the nested-dispatch trap this amendment exists to escape). The `.claude/agents/` directory continues to hold only persona-bearing subagents (eleanor-vance.md, tsai-wei-ming.md, etc.).

3. **`/api/run` accepts `entry_agent_slug` as an optional HINT** for the main agent's prompt prefix ("the user is addressing `<display_name>`") but no longer wraps the SDK call with a "Use the Agent tool to dispatch to X" instruction. Default behaviour is pass-through: user prompt goes to the SDK main agent verbatim.

4. **Run handler:** root `agent_runs` row uses `main-router`'s id as `agent_id`. Nested dispatches the main agent fires land as children with `parent_run_id = root run id`. Phase 4's `tool_use_id` map machinery is unchanged.

5. **Phase 4 transparent-routing logic:** the "skip entry-dispatch tool_result" branch becomes dead code (no entry dispatch to elide). It can be removed in the same commit, or left as a defensive no-op until Plan 5.

**Task 5.3 acceptance — amended.**

Replace gate 3 from "agent_runs has Eleanor (parent) + ≥1 subagent (child)" with:

> [ ] `agent_runs` has `main-router` (root, `parent_run_id NULL`) + ≥1 dept-head child (`parent_run_id = root run id`), all completed.

Other gates unchanged.

**Plan 5.1 expansion — dashboard 0024-schema-drift sweep.**

Task 5.1 was scoped tightly to `project_members → project_participants` in `apps/dashboard/`. The full 0024 migration also renamed columns on `project_messages` (`agent_id → sender_id`, `message_type → kind`) and dropped `is_pinned`. The dashboard's `apps/dashboard/app/api/project/[id]/messages/route.ts` and likely other routes still reference the old names. Hotfix scope expansion handled in this same amendment cycle (separate commit); not blocking the main-router pivot but blocking Task 5.3 Gate 4 verification.

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
- Subscribe to `rate_limit_event` SDK messages directly as the soft-signal source (Task 1.2 confirmed the SDK emits these as discrete stream events, not just as 429 errors). Don't infer rate-limit pressure from latency spikes alone.

**Acceptance.** Synthetic test where the SDK is mocked to throw a transient error confirms the backoff sequence. Auth error fails immediately without retry. Soft-signal log line lands when expected.

---

## Phase 4: Persistence layer

### Task 4.1: `agent_runs` writes from streamed events

**Status:** TO DO.

**Reason.** Every dispatched run gets a row for traceability — project, agent, status, timing, and parent for handoffs. This table is the source of truth for "what did the dispatcher do, when, and why."

**Prerequisite migration: 0026 — `agent_runs` schema additions.**

The `agent_runs` table inherited stale columns from its `agent_actions` predecessor (renamed in 0024). Plan 2's original column assumptions (`started_at`, `completed_at`, `status`) don't yet exist in the live schema. Migration 0026 adds them:

```sql
ALTER TABLE agent_runs ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_runs ADD COLUMN completed_at timestamptz;
ALTER TABLE agent_runs ADD COLUMN status text NOT NULL DEFAULT 'running'
  CHECK (status IN ('running','completed','failed','cancelled'));
ALTER TABLE agent_runs ALTER COLUMN action_type SET DEFAULT 'sdk_run';
```

Legacy columns (`action_type`, `trigger`, `response`, `tool_calls`, `metadata`) are left intact. Phase 5 (entry-point swap) deletes the dormant ritual code that references them; a follow-up cleanup migration after Phase 5 removes the columns.

Apply 0026 as a separate commit before the persistence wire-up commit. Verify with a column inspect on `agent_runs` post-apply.

**Approach.**

- Insert an `agent_runs` row on `run_started` with `status: 'running'`.
- Update on `run_completed` with end timestamp and final status.
- Capture `runtime` field — `claude_code` for Agent SDK runs, leaving room for `codex` fallback later. Runtime value matches the CHECK constraint added in 0024 (one of `'claude_code'`, `'codex'`, `'codex_fallback'`).
- Column set is the one from the 0024 amendment plus 0026: `id`, `agent_id`, `project_id`, `runtime`, `parent_run_id`, `started_at`, `completed_at`, `status` (and any others present in the live schema).

**Retry vs. inline error inspection.** The Phase 3 `withRetry` wrapper around the runHandler iteration is preserved but its scope narrows for Phase 4: it catches only stream-drop / network errors that propagate as thrown exceptions before or during AsyncGenerator iteration (e.g., the underlying HTTP/SSE connection dropping). The SDK does not throw for message-level errors — it streams them as `SDKAssistantMessage.error` fields, `SDKResultError` subtypes, and `SDKRateLimitEvent` messages. These are inspected per-message during iteration and translated into terminal dispatcher events without retry:

| SDK message pattern | Dispatcher action |
|---|---|
| `SDKAssistantMessage.error === 'authentication_failed' \| 'oauth_org_not_allowed'` | Emit `error` event with `recoverable: false` and operator-friendly "run `claude auth login`" message. End run. Mark `agent_runs.status = 'failed'`. |
| `SDKAssistantMessage.error === 'rate_limit'` | Emit `error` event with `recoverable: true`. End run. Mark `agent_runs.status = 'failed'`. |
| `SDKAssistantMessage.error === 'billing_error'` | Emit `error` event with `recoverable: false`. End run. Mark `agent_runs.status = 'failed'`. |
| `SDKAssistantMessage.error === 'server_error' \| 'unknown' \| 'invalid_request'` | Emit `error` event with `recoverable: true`. End run. Mark `agent_runs.status = 'failed'`. |
| `SDKResultError` (any subtype) | Emit `error` event with details from `errors[]` and `terminal_reason`. End run. Mark `agent_runs.status = 'failed'`. |
| `SDKRateLimitEvent` | Forward to client SSE stream as `rate_limit_event` (Task 3.3 scaffolding); log warn line; do NOT terminate run — informational. |
| `AbortError` thrown | End run. Mark `agent_runs.status = 'cancelled'`. |

The retry's `defaultIsAuthError` and `defaultIsTransient` predicates need broadening to match SDK error shapes per the table above. Update is part of Task 4.1's persistence wire-up commit.

**Acceptance.** A single dispatched run produces exactly one row in `agent_runs` with start/end timestamps and a final status. Failed runs land with `status: 'failed'` and a captured error message.

#### Task 4.1c — subagent handoff event mapping (post-4.1b)

**Reason.** Task 4.1b's bounded scope shipped single-turn happy path only. Real Onepark workflows always involve subagent dispatch (Eleanor → Tsai, etc., per Spec §5.2.2). Task 4.1c implements the dispatcher-side mapping for subagent paths.

**Approach.**

- **Entry-dispatch detection.** Identify the entry dispatch as the FIRST Agent tool_use that satisfies all three conditions: (a) `message.parent_tool_use_id == null` (dispatch from SDK main agent's context, not from inside a subagent), (b) `block.input.subagent_type == request.entry_agent_slug`, (c) it is the first Agent tool_use of the run. The `parent_tool_use_id == null` qualifier prevents false-matching an inner dispatch that coincidentally shares the entry slug. The Agent tool_use input field name is `subagent_type` (verified via empirical SDK capture). This dispatch is treated as transparent routing per Spec §5.2.2: emit `tool_use` for SSE telemetry, no `subagent_handoff`, no nested `agent_runs` row.
- **Subsequent Agent dispatches.** Any Agent tool_use after the entry dispatch represents a true subagent dispatch within the org-chart hierarchy. Emit `tool_use` + `subagent_handoff`. INSERT a nested `agent_runs` row with `agent_id` resolved from the dispatched slug, `parent_run_id = <entry_run_id>`, `project_id` inherited, `status = 'running'`. The nested row is updated to `status='completed'` when the subagent's terminal `tool_result` returns to the parent context (the message-#17 pattern from Task 4.1b's Step 0.5 capture: `user` with no `parent_tool_use_id`, contains `tool_result` block whose `tool_use_id` matches the dispatch).
- **In-memory `tool_use_id → run_id` map.** Maintain for the duration of a single dispatcher run. Populated when a subagent dispatch is detected (key = the Agent tool_use's `tool_use_id`, value = the nested `run_id`). Used to resolve subsequent subagent-context messages back to the correct nested run.
- **`user` with `parent_tool_use_id` set.** This message carries the invocation prompt being passed INTO the subagent's context (verbatim copy of the Agent tool_use's `input.prompt`), NOT subagent output. From the SSE consumer's perspective it's redundant with the prior `tool_use` event. Skip from the SSE stream. Task 4.2's `project_messages` writer will persist these as `kind='handoff'` per the A4 mapping table, with attribution flowing through the `tool_use_id → run_id` map. The Task 4.1b `dispatcher.deferred.subagent_user_message` warn is removed — this is expected behavior, not deferred work.
- **`assistant` with `parent_tool_use_id` set.** Empirically not observed in the SDK stream — subagent text content is delivered exclusively via `tool_result` blocks on top-level `user` messages, not as separately-streamed assistant messages. No special handling needed. If this pattern ever surfaces (a future SDK version or a longer-running subagent path we haven't observed), default to `skip` with a one-time warn line `dispatcher.unexpected.subagent_assistant_message`, and revisit handling.
- **Pre-resolve `agent_id` at enqueue.** Move the `agents.slug → agents.id` lookup from the worker into the route handler. If slug doesn't resolve, return HTTP 400 immediately (better UX than waiting for SSE error event). Worker is leaner; the `queue_status` keepalive triple-fire observed in Task 4.1b's Test A is reduced to zero or one keepalive event.

**Acceptance.** Verification with a real Eleanor → Tsai dispatch produces: top-level `agent_runs` row attributed to Eleanor, one nested `agent_runs` row attributed to Tsai with `parent_run_id` set to Eleanor's run_id, both rows transitioning to `'completed'`. Dispatcher SSE stream includes `subagent_handoff` event for Eleanor → Tsai dispatch and `assistant_message` events with `parent_tool_use_id` preserved for Tsai's responses. No `dispatcher.deferred.subagent_user_message` warn lines.

Sibling-dispatch handling: if the entry agent is a leaf (no Agent tool in its `.md`) and the SDK main agent improvises by dispatching to a different named agent at the same level (i.e., a non-entry Agent tool_use with `parent_tool_use_id == null`), the impl records the sibling as a nested row of the entry run. This is a simplification — the sibling agent is structurally a peer of the entry agent (both dispatched by main agent), not a child — but it keeps the data model coherent without introducing a special "main agent sibling" node. This case should be rare in practice; production orchestration uses non-leaf entry agents (managers, directors) that can dispatch onward themselves. Revisit if leaf-entry routing becomes operationally common.

Acceptance verification uses a non-leaf entry slug (e.g., `bradley-koh`, who has Agent in his tools per Phase 1 migration and 10 direct reports) so the test exercises a true nested chain (entry → direct-report) rather than the leaf-anomaly sibling case.

#### Task 4.1d — cancellation wiring (post-4.1c)

**Reason.** Task 4.1b deferred cancellation wiring; AbortSignal from the route handler isn't currently propagating to `query.interrupt()`.

**Approach.**

- In the run-handler, hold a reference to the `Query` instance returned by `query()`.
- Wire an event listener on the route's AbortSignal: when it fires, call `query.interrupt()`. The SDK then throws `AbortError` from the AsyncGenerator.
- Worker catches AbortError and marks `agent_runs.status='cancelled'`, `completed_at=now()`, `duration_ms=<elapsed>`. Any in-progress nested rows (subagent runs that were active when cancellation hit) get the same cancelled treatment.

**Acceptance.** A `curl --max-time N` mid-run produces `agent_runs.status='cancelled'` for the entry run and any nested rows. Dispatcher event stream closes cleanly. `GET /api/queue` shows `in_flight: null` post-cancellation.

### Task 4.2: `project_messages` writes from streamed events

**Status:** TO DO.

**Reason.** Project chat is the only channel for inter-agent communication (spec invariant). Every assistant message, handoff, and final output must land as a `project_messages` row so the dashboard chat view can render them.

**Approach.**

- Map SDK event types to `kind` values per the 0024 schema: `prompt`, `handoff`, `output`, `comment`, `final`.
- `sender_type` is `agent` for SDK output, `user` for the inbound prompt that initiated the run.
- Populate `run_id` (FK to `agent_runs`) and `parent_message_id` from event metadata.
- Preserve message ordering via `created_at` — write rows in stream-arrival order.

**Message-type persistence rules** (derived from the Task 1.2 smoke-test taxonomy). Each SDK message variant gets one explicit disposition:

| SDK message type / subtype | Persisted? | `project_messages.kind` |
|---|---|---|
| `system/init` | skip | — |
| `system/hook_started`, `system/hook_progress`, `system/hook_response` | skip | — |
| `system/task_started`, `system/task_notification`, `system/task_updated`, `system/task_progress` | skip | — |
| `system/notification`, `system/auth_status` | skip | — |
| `system/compact_boundary`, `system/mirror_error` | skip | — |
| `assistant` (text content, no error) | persist | `output` |
| `assistant` (with `tool_use` block, name=`Agent`) | persist | `handoff` (the dispatch event; `tool_use_id` keyed for Task 4.3) |
| `assistant` (with `error` field set) | skip from project_messages; surface as `error` SSE event per Task 4.1's retry-vs-inline-inspection table | — |
| `user` (with `parent_tool_use_id` set) | persist | `handoff` (subagent's user-side message in its own context) |
| `user` (no `parent_tool_use_id`, contains `tool_result` blocks) | persist (one row per tool_result block) | `comment` — subagent's reply content; `sender_id` resolved via the unified tool_use_id map to the dispatched subagent's agent_id; `parent_message_id` chains to the handoff row via the same map |
| `result/success` | persist | `final` (body = `result.result` field) |
| `result/error_*` | skip from project_messages; surface as `error` SSE event per Task 4.1's table | — |
| `rate_limit_event` | skip from project_messages; forward + log per Task 3.3 | — |

**Acceptance.** Replaying a run's `project_messages` rows in `created_at` order reconstructs the conversation faithfully — every assistant message and handoff is captured, in order.

### Task 4.3: Subagent attribution via `parent_tool_use_id`

**Status:** TO DO.

**Dependencies.** Task 4.1c (run-level parent map) and Task 4.2 (project_messages persistence) must land first.

**Reason.** When Eleanor dispatches to Tsai (or further down the chain), the resulting `project_messages` rows must attribute correctly so the dashboard chat view can render the conversation as a tree. The Agent SDK provides a `parent_tool_use_id` field on subagent messages — Phase 2 recon confirmed. Task 4.1c establishes the `agent_runs.parent_run_id` chain natively as part of nested-row INSERT; this task narrows to the project_messages chain only.

**Approach.**

- **Unified per-run map.** Replace the two narrower maps from Task 4.1c (`tool_use_id → run_id`) and Task 4.2 (implicit `tool_use_id → message_id` via row capture) with a single record-shaped map: `tool_use_id → { nested_run_id, handoff_message_id, agent_id }`. Task 4.1c populates `nested_run_id` and `agent_id` on subagent_handoff. Task 4.2 populates `handoff_message_id` after the handoff project_messages row is INSERTed. Task 4.3 reads all three fields when persisting comment rows.
- **Comment row INSERT.** When a `user` message with no `parent_tool_use_id` arrives carrying one or more tool_result blocks: for each block, look up the block's `tool_use_id` in the map. If found (tracked subagent dispatch): INSERT a `project_messages` row with `kind='comment'`, `body=<tool_result text content>` (extract text blocks and concatenate; JSON.stringify if non-text content surfaces), `sender_type='agent'`, `sender_id=<map entry's agent_id>`, `run_id=<map entry's nested_run_id>`, `parent_message_id=<map entry's handoff_message_id>`. If not found (entry dispatch's tool_result return — entry has no map entry per 4.1c's transparent-routing policy): skip the row.
- **is_error flag handling.** If a tool_result block has `is_error: true`, persist the row anyway. The body conveys the failure signal; dashboard can render error-styled. Don't drop error returns.
- **Map cleanup.** The map is per-run and discarded when the run terminates. No persistence beyond the run lifecycle.

**Acceptance.** A run where Eleanor dispatches to Tsai produces two `agent_runs` rows — Eleanor's and Tsai's — with Tsai's `parent_run_id` pointing to Eleanor's `id`. The chat view shows the handoff with Tsai's response rendered as a child of Eleanor's dispatch message via the `parent_message_id` chain on the comment row.

### Phase 4 open questions

Items the recon couldn't answer, to be resolved during execution:

- **`SDKAssistantMessage.error` termination behavior** — when this field is populated, does the AsyncGenerator continue yielding messages, or does it terminate? Affects whether we end the run on observation or wait for the next `result`. Resolve empirically by triggering an auth failure during Task 4.1 verification.
- **`session_id` field persistence** — every SDK message carries `session_id`. Useful for correlating retries across restarts. Plan 2 doesn't currently persist it; consider adding to `agent_runs.metadata` if Phase 4 verification surfaces a use case.

---

## Phase 5: End-to-end integration

### Task 5.1: Dashboard hotfix — `project_members` → `project_participants`

**Status:** DONE (commit 393dd37).

**Reason.** Phase 2 recon found `apps/dashboard/app/api/projects/route.ts:37` queries the table as `project_members` — but 0024 renamed it to `project_participants`. The dashboard's projects view is broken today. Cheap fix; big sanity-check win when verifying Task 5.3.

**Approach.**

- Rename in `apps/dashboard/app/api/projects/route.ts`.
- Grep across `apps/dashboard/` for any other stale references to `project_members` and fix them too.

**Acceptance.** Dashboard `/projects` view loads without error against the live DB. No remaining `project_members` references in `apps/dashboard/`.

### Task 5.2: Replace `index.ts:main()` to boot the dispatcher

**Status:** DONE (Plan 2 Task 5.2 commit on feat/claude-code-rearchitecture).

**Reason.** Current `index.ts:main()` calls `startTickLoop()` which imports rituals that query dropped tables — the orchestrator crashes on startup today. Phase 2 replaces this with `startDispatcherServer()`. Legacy code stays in tree until Plan 5 nukes it; only the entry point flips.

**Approach.**

- Gut `main()`'s startup checks that reference dropped state — `world_clock`, `agent.tool_access`, `agent.mcp_access`.
- Delete the existing `if (!process.env.ANTHROPIC_API_KEY) exit(1)` check in `apps/orchestrator/src/index.ts:main()`. Per spec §6.9, the dispatcher uses Claude Max OAuth credentials and `ANTHROPIC_API_KEY` must NOT be set in the dispatcher environment. Replace with:

  ```ts
  if (process.env.ANTHROPIC_API_KEY) {
    logger.warn(
      { event: 'dispatcher.startup.api_key_set' },
      "ANTHROPIC_API_KEY is set in dispatcher env; spec §6.9 requires OAuth-only. Unset before production."
    );
  }
  ```

  The check inverts: warn if set, allow startup. Production runbook covers the unset step.
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
