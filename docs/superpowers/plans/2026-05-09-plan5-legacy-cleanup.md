# Plan 5 — Legacy orchestrator cleanup

**Status:** Phases 1–3 DONE; Phase 4 TODO
**Started:** 2026-05-09
**Predecessor:** Plan 2 (commit `b92aea0` on `feat/claude-code-rearchitecture`)

---

**What this plan covers.** Plan 2 swapped the orchestrator's entry point from the ritual tick loop to the dispatcher (Task 5.2, commit `5f4d228`). The legacy code was left in tree intentionally to keep the swap surgical. This plan removes the dormant code in phases, then drops the schema vestiges 0024 left intact for Plan 2.

**What's in scope.** Files reachable only via the deleted `startTickLoop` entry point, files reachable only via the legacy Anthropic-API-direct runner (`agents/runner.ts`) the dispatcher replaced, one-shot seed scripts that have already run productively, and column drops on `agent_runs` for the legacy ritual schema.

**What's out of scope.** The migrations themselves (historical record). Anything reachable from `src/index.ts`'s live import graph. Dashboard-side dead code (Plan 3 rebuild territory).

---

## Why

Plan 5 Phase 1 recon (2026-05-09) traced 19 files reachable from `src/index.ts` and surfaced ~108 dead candidates clustering naturally into three groups by deletion rationale plus a schema-migration tail. Each cluster has a distinct argument for deletion and is internally self-contained — Cluster A imports nothing in LIVE and is imported by nothing in LIVE; same for B; same for C. This makes per-cluster commits cleanly bisectable if a future Plan 3 rebuild needs to revive any specific surface.

---

## Phases

### Phase 1 — Ritual / world / tick cluster

**Status:** DONE (commit `2b768d8`, 21 files, −4375 lines).

**Reason.** Files imported only via the deleted `startTickLoop` entry point. All references to the dropped tables `world_clock`, `forum_posts`, `dms`, `commitments`, `ritual_state` live in this cluster.

**Files (~20).** `src/rituals/*` (11 files: `ceo-brief.ts`, `chatter.ts`, `daily-reset.ts`, `dm-responder.ts`, `morning-greeting.ts`, `project-heartbeat.ts`, `project-responder.ts`, `reflection.ts`, `report-runner.ts`, `stall-detector.ts`, `standup.ts`), `src/world/*` (2 files: `clock.ts`, `tick.ts`), `src/comms/*` (3 files: `channel.ts`, `dm.ts`, `forum.ts`), `src/commitments/store.ts`, plus top-level legacy roots (`chatter.ts`, `dm.ts`, `reflection.ts`, `tick.ts`).

**Acceptance.** `tsc --noEmit` reports the same baseline noise minus errors from `src/rituals/chatter.ts` (which had 9 pre-existing errors). Zero new errors in LIVE files. Dispatcher boot still works.

### Phase 2 — Legacy-runner cluster

**Status:** DONE (commit `90a0b8f`, 39 files, −8172 lines).

**Reason.** Files reachable only via `src/agents/runner.ts`, the legacy Anthropic-API-direct runner the dispatcher replaced. Includes the agent-context machinery (memory, personality, vision, etc.), the tool registry the runner exposed, and tool implementations that only the runner imported.

**Files (~39).** `src/agents/*` (7 files: `context-builder.ts`, `memory.ts`, `personality.ts`, `recent-work.ts`, `roster-context.ts`, `runner.ts`, `vision.ts`), `src/tools/*` non-LIVE (20 files — everything except `browser.ts` and `types.ts` which are LIVE), `src/util/untrusted.ts`, `src/util/supabase-storage.ts`, `src/auth/google-oauth.ts`, `src/projects/members.ts`, `src/reports/*` (6 files), plus top-level `runner.ts` and `claude.ts`.

**Acceptance.** `tsc --noEmit` baseline drops by the 2 errors that lived in `agents/runner.ts` (cache_control SDK API mismatch). Zero new errors in LIVE files.

### Phase 3 — Seed-script cluster

**Status:** DONE (commit `bdbe9cc`, 55 files, −8627 lines).

**Reason.** `src/seed/*` — one-shot migration scripts that have already run productively against the live DB. Audit trail preserved in git history. None are imported by LIVE; deleting doesn't affect anything in production.

**Files (55).** All of `src/seed/*.ts`.

**Acceptance.** `tsc --noEmit` reports the same baseline as after Phase 2; seed scripts had no errors but they're standalone so no change expected.

### Phase 4 — Schema cleanup migration

**Status:** TODO (separate session).

**Reason.** Migration 0028 drops the legacy columns on `agent_runs` that Plan 2 kept intact intentionally for backward-compat with the dormant ritual code: `action_type` (and its DEFAULT `'sdk_run'`), `trigger`, `response`, `tool_calls`, `metadata`. Phases 1–3 remove every consumer of those columns; the schema can shed them safely.

**Approach.**

```sql
-- 0028_drop_legacy_agent_runs_columns.sql
ALTER TABLE agent_runs DROP COLUMN IF EXISTS action_type;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS trigger;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS response;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS tool_calls;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS metadata;
```

Verify the dispatcher still inserts cleanly (`status`, `started_at`, `completed_at`, `runtime`, `agent_id`, `project_id`, `parent_run_id`, `duration_ms`, `id` — all schema columns the dispatcher actively uses; none of the dropped columns).

**Acceptance.** Post-0028 dispatcher run produces correct `agent_runs` rows. Schema view shows only the columns the dispatcher actively writes.
