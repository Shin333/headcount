# Onepark Digital — Foundation Implementation Plan (Phase 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the database schema to the simplified design, rewrite all 120 subagent files with new sections (manager / reports / brain / routing guidance), bootstrap brain.md files, and generate the org-chart registry. Output: the data foundation that the dispatcher (Plan 2) will consume.

**Architecture:** Schema-first migration sets the data shape. A one-time TypeScript script reads the `agents` table to compute org hierarchy, then rewrites each subagent `.md` in `.claude/agents/` to inject new sections and strip the `model:` field. Two more small scripts bootstrap `agents/brains/<id>.md` files and generate `agents/registry.md`. All scripts are dry-run-first, idempotent, and committed to the repo for repeatability.

**Tech Stack:** PostgreSQL (Supabase migration SQL), TypeScript + tsx (one-time scripts), `@supabase/supabase-js` (already a dep), `gray-matter` (frontmatter parser, lightweight, ~70KB), Node `fs/promises`.

**Spec reference:** `docs/superpowers/specs/2026-05-04-onepark-digital-claude-code-rearchitecture-design.md` §7 (schema), §8 (migration steps 2–5), §6.1 (subagent file additions).

---

## Pre-flight

### Task 0.1: Verify clean state on the feature branch

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch + clean tree**

Run: `cd /d/Projects/headcount && git status`

Expected output:
```
On branch feat/claude-code-rearchitecture
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
        modified:   .claude/settings.local.json
```

The only acceptable working-tree dirt is `.claude/settings.local.json` (unrelated session state). If anything else appears, stop and resolve before continuing.

- [ ] **Step 2: Confirm `gray-matter` is available**

Run: `cd /d/Projects/headcount && pnpm list gray-matter --depth -1 2>&1 | head -5`

If "is not in dependencies" or empty, install it:
```bash
pnpm add -D gray-matter --filter @headcount/orchestrator
```

Expected after install: `gray-matter ^4.0.3` in `apps/orchestrator/package.json`.

---

## Phase 1: Schema Migration

### Task 1.1: Write the migration SQL

**Files:**
- Create: `apps/orchestrator/supabase/migrations/0024_phase2_simplification.sql`

- [ ] **Step 1: Create the file with full migration content**

Write this exact content to `apps/orchestrator/supabase/migrations/0024_phase2_simplification.sql`:

```sql
-- ============================================================================
-- 0024_phase2_simplification.sql — Claude Code re-architecture (Phase 2)
-- See: docs/superpowers/specs/2026-05-04-onepark-digital-claude-code-rearchitecture-design.md §7
--
-- Drops 10 deprecated tables, alters 3 surviving tables, creates 5 new tables.
-- Final: 10 tables (down from ~15).
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- DROP deprecated tables (architecture no longer uses them)
-- ----------------------------------------------------------------------------
drop table if exists forum_posts cascade;
drop table if exists dms cascade;
drop table if exists memories cascade;
drop table if exists relationships cascade;
drop table if exists world_clock cascade;
drop table if exists standups cascade;
drop table if exists wall_token_spend cascade;
drop table if exists ritual_state cascade;
drop table if exists cost_alerts cascade;
drop table if exists prompt_evolution_log cascade;

-- ----------------------------------------------------------------------------
-- ALTER agents — drop deprecated columns, keep org-chart fields
-- ----------------------------------------------------------------------------
alter table agents drop column if exists daily_token_budget;
alter table agents drop column if exists tokens_used_today;
alter table agents drop column if exists chatter_posts_today;
alter table agents drop column if exists last_reset_company_date;
alter table agents drop column if exists last_reflection_at;
alter table agents drop column if exists addendum_loop_active;
alter table agents drop column if exists manager_overlay;
alter table agents drop column if exists learned_addendum;
alter table agents drop column if exists model_tier;
alter table agents drop column if exists frozen_core;
alter table agents drop column if exists personality;
alter table agents drop column if exists background;
alter table agents drop column if exists allowed_tools;
-- Keep: id, tenant_id, name, role, department, tier, manager_id, reports_to_ceo, status, created_at, updated_at

-- ----------------------------------------------------------------------------
-- RENAME tickets → projects (drop unused fields)
-- ----------------------------------------------------------------------------
alter table if exists tickets rename to projects;
alter table if exists projects drop column if exists assignee_id;
alter table if exists projects drop column if exists creator_id;
alter table if exists projects drop column if exists parent_ticket_id;
alter table if exists projects drop column if exists priority;
alter table if exists projects drop column if exists department;
-- Add fields the new architecture needs
alter table if exists projects add column if not exists entry_agent_id uuid references agents(id) on delete set null;
alter table if exists projects add column if not exists prompt text;

-- ----------------------------------------------------------------------------
-- RENAME agent_actions → agent_runs (drop API metering, add handoff fields)
-- ----------------------------------------------------------------------------
alter table if exists agent_actions rename to agent_runs;
alter table if exists agent_runs drop column if exists input_tokens;
alter table if exists agent_runs drop column if exists output_tokens;
alter table if exists agent_runs drop column if exists system_prompt;
alter table if exists agent_runs drop column if exists user_prompt;
alter table if exists agent_runs add column if not exists runtime text not null default 'claude_code' check (runtime in ('claude_code','codex','codex_fallback'));
alter table if exists agent_runs add column if not exists parent_run_id uuid references agent_runs(id) on delete set null;
alter table if exists agent_runs add column if not exists project_id uuid references projects(id) on delete cascade;

create index if not exists agent_runs_project_idx on agent_runs(project_id, created_at desc);
create index if not exists agent_runs_parent_idx on agent_runs(parent_run_id);

-- ----------------------------------------------------------------------------
-- NEW: briefs (cron-generated morning + ceo briefs)
-- ----------------------------------------------------------------------------
create table if not exists briefs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  kind text not null check (kind in ('morning','ceo')),
  body text not null,
  dismissed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists briefs_kind_created_idx on briefs(kind, created_at desc);

-- ----------------------------------------------------------------------------
-- NEW: cron_runs (cron-job observability)
-- ----------------------------------------------------------------------------
create table if not exists cron_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cron_kind text not null check (cron_kind in ('morning_brief','ceo_brief','nightly_learning')),
  status text not null check (status in ('ok','fail','partial','running')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  agents_processed int not null default 0,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists cron_runs_kind_started_idx on cron_runs(cron_kind, started_at desc);

-- ----------------------------------------------------------------------------
-- NEW: project_messages (the project chat — single thread per project)
-- ----------------------------------------------------------------------------
create table if not exists project_messages (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  project_id uuid not null references projects(id) on delete cascade,
  sender_type text not null check (sender_type in ('agent','user')),
  sender_id uuid references agents(id) on delete set null,
  kind text not null check (kind in ('prompt','handoff','output','comment','final')),
  body text not null,
  run_id uuid references agent_runs(id) on delete set null,
  parent_message_id uuid references project_messages(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists project_messages_project_idx on project_messages(project_id, created_at);
create index if not exists project_messages_run_idx on project_messages(run_id);

-- ----------------------------------------------------------------------------
-- NEW: project_participants (who's in the project chat)
-- ----------------------------------------------------------------------------
create table if not exists project_participants (
  project_id uuid not null references projects(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  joined_at timestamptz not null default now(),
  joined_via_run_id uuid references agent_runs(id) on delete set null,
  primary key (project_id, agent_id)
);
create index if not exists project_participants_agent_idx on project_participants(agent_id);

-- ----------------------------------------------------------------------------
-- NEW: rate_budget (soft-ban hygiene tracking)
-- ----------------------------------------------------------------------------
create table if not exists rate_budget (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  provider text not null check (provider in ('claude','codex')),
  window_start timestamptz not null,
  calls_used int not null default 0,
  calls_cap int not null default 500,
  unique (provider, window_start)
);
create index if not exists rate_budget_window_idx on rate_budget(provider, window_start desc);

-- ----------------------------------------------------------------------------
-- REALTIME publications (realtime channels for new tables)
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table briefs;
alter publication supabase_realtime add table cron_runs;
alter publication supabase_realtime add table project_messages;
alter publication supabase_realtime add table project_participants;
```

- [ ] **Step 2: Commit the migration file**

```bash
cd /d/Projects/headcount
git add apps/orchestrator/supabase/migrations/0024_phase2_simplification.sql
git commit -m "feat(schema): 0024 phase2 simplification — drop dead tables, add project chat + rate budget"
```

### Task 1.2: Apply the migration to the dev Supabase

**Files:** none (DB-side change)

- [ ] **Step 1: Open the Supabase dashboard for the headcount project**

Go to https://supabase.com/dashboard/project/_/sql (your project's SQL editor)

- [ ] **Step 2: Paste the contents of `0024_phase2_simplification.sql` and run it**

Expected: "Success. No rows returned" — the migration is `if not exists` / `if exists` everywhere, so no errors on re-run.

If you see an error referencing a column that doesn't exist, it likely means an earlier migration already removed it — safe to ignore *only* if the column name matches one in the alter-drop block.

- [ ] **Step 3: Verify the schema by listing tables**

Run in the SQL editor:
```sql
select tablename from pg_tables where schemaname = 'public' order by tablename;
```

Expected: exactly these 10 tables in the `public` schema (others may exist from extensions):
```
agent_runs
agents
artifacts
briefs
cron_runs
projects
project_messages
project_participants
rate_budget
social_drafts
```

If `forum_posts`, `dms`, `memories`, `relationships`, `world_clock`, `standups`, `wall_token_spend`, `ritual_state`, `cost_alerts`, or `prompt_evolution_log` still appear → the cascading drop in step 2 failed. Re-run that section.

### Task 1.3: Regenerate `packages/shared` types — DEFERRED to Phase 2

**Status:** DEFERRED. No work in this phase.

**Reason.** This task assumed `packages/shared/src/schema.ts` is generated by `supabase gen types typescript` and could be regenerated in a single command. A working-tree audit (May 2026) found the file is **434 lines of hand-written Zod schemas** (`AgentSchema`, `PersonalitySchema`, `Big5Schema`, etc.) used as both runtime validators and inferred types. There is no `supabase gen` pipeline in this repo: no `supabase/config.toml`, no CLI dependency, no `gen` script. Running the original Step 1 command would destroy the Zod file and break every consumer that calls `.parse()`.

**Mitigation.** A stale-warning header was added at the top of `packages/shared/src/schema.ts` in commit `18f506c` (`docs(schema): mark file stale pending Phase 2 rewrite`). The header lists the columns the file still references that 0024 dropped, and instructs consumers not to import the stale schemas.

**Implication for the rest of Phase 1.** Tasks 2.x, 3.1, and 4.1 — the migration scripts (`migrate-agents.ts`, `bootstrap-brains.ts`, `generate-registry.ts`) — each read a small subset of columns from the `agents` table. Each script should define a **local Zod (or plain TypeScript interface) schema** covering only the columns it actually reads; the exact subset per script is determined when that script is written. **Do NOT import the stale schemas from `packages/shared/src/schema.ts`.** This keeps Phase 1 unblocked and avoids accidentally relying on dropped columns.

**Re-evaluation.** The clean rewrite of `schema.ts` happens during Phase 2 (dispatcher), where the new consumers — dispatcher, brief writer, project-chat UI, rate-budget tracker — determine the exact shape we need. The Phase 2 plan will own the replacement decision (hand-rewrite Zod vs. switch to `supabase gen types` vs. hybrid) and the migration of any remaining downstream consumers.

### Task 1.4: Delete `export-claude-agents.ts` before migrate-agents runs

**Status:** TO DO. Blocking — must complete before Task 2.5 runs.

**Reason.** Every `.claude/agents/*.md` file currently ends with a trailer comment of the form `<!-- Exported from Headcount on <date>. Do not edit by hand — this file is regenerated by apps/orchestrator/src/seed/export-claude-agents.ts. -->`. If that script reruns at any point — accidentally during Phase 5 cleanup, manually by anyone reading the trailer instruction, or by an old npm script — every migrate-agents transformation is silently clobbered. Phase 5 deletion of the seed scripts is too late: the window between migrate-agents running and Phase 5 starting is the danger zone.

**Action.**

- [ ] **Step 1: Delete the script.**

  ```bash
  cd /d/Projects/headcount
  git rm apps/orchestrator/src/seed/export-claude-agents.ts
  ```

- [ ] **Step 2: Confirm zero remaining references.**

  ```bash
  grep -r "export-claude-agents" --include="*.ts" --include="*.json" --include="*.md" apps packages 2>&1 | grep -v node_modules
  ```

  Expected: empty (no broken imports, no scripts that call it, no docs that reference it). Migration plan / spec mentions are excluded from this grep by the directory filter (only `apps/` and `packages/`).

- [ ] **Step 3: Verify the repo still builds.**

  ```bash
  pnpm typecheck
  ```

  Expected: same set of pre-existing errors as before (legacy orchestrator code Phase 5 will delete). No new errors specifically tied to the deleted file.

- [ ] **Step 4: Commit.**

  ```bash
  git commit -m "chore(seed): delete export-claude-agents.ts before migrate-agents runs"
  ```

**Expected outcome.** File deleted. Grep returns zero hits in source. Typecheck output unchanged from baseline. The trailer comments left behind in each `.md` file become stale text — Task 2.4's transform will strip them.

---

## Phase 2: Subagent file rewrite script

### Task 2.1: Create the script skeleton

**Files:**
- Create: `apps/orchestrator/src/migrations/foundation/migrate-agents.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p /d/Projects/headcount/apps/orchestrator/src/migrations/foundation
```

- [ ] **Step 2: Write the skeleton with imports and main**

Create `apps/orchestrator/src/migrations/foundation/migrate-agents.ts` with:

```typescript
// ============================================================================
// migrate-agents.ts — One-time pass over all .claude/agents/*.md to:
//   1. Strip `model:` from frontmatter (always-latest-model design)
//   2. Add `Agent` to `tools:` for any non-leaf agent
//   3. Append `# Your manager`, `# Your reports`, `# Your brain`,
//      `# Routing guidance` sections
//
// Usage:
//   pnpm exec tsx src/migrations/foundation/migrate-agents.ts --dry-run
//   pnpm exec tsx src/migrations/foundation/migrate-agents.ts            # writes
// ============================================================================

import "dotenv/config";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { createClient } from "@supabase/supabase-js";

const AGENTS_DIR = join(process.cwd(), "..", "..", ".claude", "agents");
const DRY = process.argv.includes("--dry-run");
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface AgentRow {
  id: string;
  name: string;
  role: string;
  tier: string;
  department: string | null;
  manager_id: string | null;
}

async function main() {
  console.log(`mode: ${DRY ? "DRY-RUN" : "WRITE"}`);
  console.log(`agents dir: ${AGENTS_DIR}`);
  // Subsequent tasks fill this in
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Verify the file runs (it will print just the mode banner)**

```bash
cd /d/Projects/headcount/apps/orchestrator
pnpm exec tsx src/migrations/foundation/migrate-agents.ts --dry-run
```

Expected output:
```
mode: DRY-RUN
agents dir: D:\Projects\headcount\.claude\agents
```

If it errors with "Missing SUPABASE_URL", check `apps/orchestrator/.env` exists and has those keys.

### Task 2.2: Add the org-chart loader

**Files:**
- Modify: `apps/orchestrator/src/migrations/foundation/migrate-agents.ts`

- [ ] **Step 1: Add `loadOrgChart()` function above `main()`**

Insert this function before `async function main()`:

```typescript
interface OrgNode {
  agent: AgentRow;
  /** Slugified id used as the .md filename — e.g. "adrian-rozario" */
  slug: string;
  /** Direct reports */
  directReports: OrgNode[];
  /** All descendants (full sub-tree, BFS) */
  subtree: OrgNode[];
  /** Manager node (null for Eleanor / human CEO) */
  manager: OrgNode | null;
}

/** Slugify "Adrian Rozario" → "adrian-rozario". Matches existing .md filenames. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Returns a Map<id, OrgNode> with subtree + manager populated. */
async function loadOrgChart(): Promise<Map<string, OrgNode>> {
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, role, tier, department, manager_id")
    .eq("status", "active");

  if (error) throw new Error(`agents query failed: ${error.message}`);
  if (!data) throw new Error("no agents returned");

  const nodes = new Map<string, OrgNode>();
  for (const row of data as AgentRow[]) {
    nodes.set(row.id, {
      agent: row,
      slug: slugify(row.name),
      directReports: [],
      subtree: [],
      manager: null,
    });
  }

  // Wire managers + direct reports
  for (const node of nodes.values()) {
    if (node.agent.manager_id) {
      const mgr = nodes.get(node.agent.manager_id);
      if (mgr) {
        node.manager = mgr;
        mgr.directReports.push(node);
      }
    }
  }

  // BFS subtree per node
  for (const node of nodes.values()) {
    const queue: OrgNode[] = [...node.directReports];
    const visited = new Set<string>();
    while (queue.length) {
      const next = queue.shift()!;
      if (visited.has(next.agent.id)) continue;
      visited.add(next.agent.id);
      node.subtree.push(next);
      queue.push(...next.directReports);
    }
  }

  return nodes;
}
```

- [ ] **Step 2: Wire it into `main()` and verify**

Replace the body of `main()` with:

```typescript
async function main() {
  console.log(`mode: ${DRY ? "DRY-RUN" : "WRITE"}`);
  const org = await loadOrgChart();
  console.log(`loaded ${org.size} agents from DB`);
  // Print a sanity sample
  for (const [, node] of org) {
    if (node.agent.tier === "exec") {
      console.log(
        `  ${node.agent.name} (${node.agent.tier}) — ${node.directReports.length} direct, ${node.subtree.length} total subtree`
      );
    }
  }
}
```

- [ ] **Step 3: Run and verify**

```bash
cd /d/Projects/headcount/apps/orchestrator
pnpm exec tsx src/migrations/foundation/migrate-agents.ts --dry-run
```

Expected (numbers depend on your data):
```
mode: DRY-RUN
loaded 120 agents from DB
  Eleanor Vance (exec) — 5 direct, 119 total subtree
```

If the subtree count is 0, the manager_id graph isn't populated. Run this query in Supabase SQL editor: `select count(*) from agents where manager_id is not null and status='active';` — should be ~119 (everyone except Eleanor).

### Task 2.3: Add the `.md` parser

**Files:**
- Modify: `apps/orchestrator/src/migrations/foundation/migrate-agents.ts`

- [ ] **Step 1: Add `readAgentFile()` and `writeAgentFile()` functions**

Add these functions before `main()`:

```typescript
interface AgentFile {
  path: string;
  /** Frontmatter as parsed object */
  frontmatter: Record<string, unknown>;
  /** Body markdown (everything after the `---` close fence) */
  body: string;
}

async function readAgentFile(path: string): Promise<AgentFile> {
  const raw = await readFile(path, "utf8");
  const parsed = matter(raw);
  return {
    path,
    frontmatter: parsed.data,
    body: parsed.content,
  };
}

async function writeAgentFile(file: AgentFile): Promise<void> {
  // gray-matter's stringify preserves YAML formatting reasonably well.
  // We rely on it for round-trip; manual edit if bugs surface.
  const out = matter.stringify(file.body, file.frontmatter);
  await writeFile(file.path, out, "utf8");
}
```

- [ ] **Step 2: Add a smoke-test in main()**

Replace `main()` body:

```typescript
async function main() {
  console.log(`mode: ${DRY ? "DRY-RUN" : "WRITE"}`);
  const org = await loadOrgChart();
  console.log(`loaded ${org.size} agents from DB`);

  // Smoke: read adrian-rozario.md and print frontmatter
  const sample = join(AGENTS_DIR, "adrian-rozario.md");
  const f = await readAgentFile(sample);
  console.log("frontmatter:", JSON.stringify(f.frontmatter, null, 2));
  console.log(`body length: ${f.body.length}`);
}
```

- [ ] **Step 3: Run and verify**

```bash
pnpm exec tsx src/migrations/foundation/migrate-agents.ts --dry-run
```

Expected:
```
mode: DRY-RUN
loaded 120 agents from DB
frontmatter: {
  "name": "adrian-rozario",
  "description": "Use for security engineer work. Assumes everything is compromised until proven otherwise.",
  "tools": "Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch",
  "model": "sonnet"
}
body length: <some number>
```

### Task 2.4: Add the transform function

**Files:**
- Modify: `apps/orchestrator/src/migrations/foundation/migrate-agents.ts`

- [ ] **Step 1: Add `transformAgent()` function**

Add before `main()`:

```typescript
const APPENDED_SECTIONS_MARKER = "<!-- migrate-agents:applied -->";

/**
 * Returns the transformed AgentFile. Idempotent: if the marker is present,
 * returns the input unchanged.
 */
function transformAgent(
  file: AgentFile,
  org: Map<string, OrgNode>
): AgentFile {
  // Idempotency: if we've already migrated this file, leave it alone.
  if (file.body.includes(APPENDED_SECTIONS_MARKER)) {
    return file;
  }

  // Find this agent's org node by matching frontmatter.name to slug
  const slug = String(file.frontmatter.name);
  const node = [...org.values()].find((n) => n.slug === slug);
  if (!node) {
    throw new Error(
      `no DB row matches agent slug "${slug}" — check agents table or .md filename`
    );
  }

  // Frontmatter changes: strip model, ensure Agent is in tools for non-leaf
  const fm = { ...file.frontmatter };
  delete fm.model;

  if (node.subtree.length > 0) {
    const tools = String(fm.tools ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tools.includes("Agent")) tools.push("Agent");
    fm.tools = tools.join(", ");
  }

  // Build the appended sections
  const sections: string[] = ["", APPENDED_SECTIONS_MARKER, ""];

  // # Your manager
  if (node.manager) {
    sections.push(
      "# Your manager",
      "",
      `${node.manager.agent.name} — ${node.manager.agent.role}. You report to them.`,
      ""
    );
  } else {
    sections.push(
      "# Your manager",
      "",
      `Shin Park (CEO, human). You report directly to him via Eleanor or the dashboard.`,
      ""
    );
  }

  // # Your reports (full subtree, grouped by tier)
  if (node.subtree.length > 0) {
    sections.push("# Your reports", "");
    sections.push(
      "Below is your full sub-tree, grouped by tier. You can dispatch via the `Agent` tool to any of them.",
      ""
    );

    const byTier: Record<string, OrgNode[]> = {
      director: [],
      manager: [],
      associate: [],
      intern: [],
      bot: [],
    };
    for (const r of node.subtree) {
      (byTier[r.agent.tier] ?? byTier.bot).push(r);
    }
    for (const tier of ["director", "manager", "associate", "intern"]) {
      const list = byTier[tier];
      if (!list?.length) continue;
      sections.push(`## ${tier[0].toUpperCase()}${tier.slice(1)}s`, "");
      for (const r of list) {
        sections.push(
          `- **${r.agent.name}** (\`${r.slug}\`) — ${r.agent.role}${r.agent.department ? ` · ${r.agent.department}` : ""}`
        );
      }
      sections.push("");
    }
  } else {
    sections.push(
      "# Your reports",
      "",
      "You have no reports. You execute the work yourself.",
      ""
    );
  }

  // # Your brain
  sections.push(
    "# Your brain",
    "",
    `Before starting any task, READ \`agents/brains/${node.slug}.md\` for your accumulated learnings.`,
    "",
    `When you discover a durable new pattern, correction, or anti-pattern during a task, APPEND it to your brain via the \`Edit\` tool under "# Recent learnings".`,
    ""
  );

  // # Routing guidance
  if (node.subtree.length > 0) {
    sections.push(
      "# Routing guidance",
      "",
      `When you receive a task, decide whether to **do it yourself** or **delegate**. Default to delegating to the *lowest competent level* — interns do most grunt work, associates supervise interns, managers coordinate associates. **Skip levels when appropriate** (e.g. you can dispatch directly to an intern for trivial work).`,
      "",
      `When you delegate, use the \`Agent\` tool with the target's slug. The dashboard will track the handoff and add them to the project chat automatically.`,
      ""
    );
  }

  return {
    path: file.path,
    frontmatter: fm,
    body: file.body.trimEnd() + "\n" + sections.join("\n"),
  };
}
```

- [ ] **Step 2: Hook the transform into a single-file dry-run**

Replace `main()`:

```typescript
async function main() {
  console.log(`mode: ${DRY ? "DRY-RUN" : "WRITE"}`);
  const org = await loadOrgChart();
  console.log(`loaded ${org.size} agents from DB`);

  // Single-file smoke test
  const sample = join(AGENTS_DIR, "adrian-rozario.md");
  const f = await readAgentFile(sample);
  const transformed = transformAgent(f, org);
  console.log("--- transformed frontmatter ---");
  console.log(JSON.stringify(transformed.frontmatter, null, 2));
  console.log("--- transformed body (last 800 chars) ---");
  console.log(transformed.body.slice(-800));
}
```

- [ ] **Step 3: Run and inspect**

```bash
pnpm exec tsx src/migrations/foundation/migrate-agents.ts --dry-run
```

Expected:
- Frontmatter no longer has `"model": "sonnet"`.
- Frontmatter has `"tools": "..., Agent"` (Agent appended) IF Adrian has reports. Adrian is an intern-tier security engineer based on the file body — verify the tier in the DB. If Adrian is associate or higher with reports, Agent should appear; otherwise tools is unchanged.
- Body ends with the four new sections under the `<!-- migrate-agents:applied -->` marker.
- Sub-tree section lists Adrian's reports grouped by Director/Manager/Associate/Intern.

If frontmatter still shows `model: sonnet`, check the `delete fm.model;` line.

### Task 2.5: Add full-batch processing

**Files:**
- Modify: `apps/orchestrator/src/migrations/foundation/migrate-agents.ts`

- [ ] **Step 1: Replace `main()` with the batch loop**

```typescript
async function main() {
  console.log(`mode: ${DRY ? "DRY-RUN" : "WRITE"}`);
  const org = await loadOrgChart();
  console.log(`loaded ${org.size} agents from DB`);

  const dirEntries = await readdir(AGENTS_DIR);
  const mdFiles = dirEntries.filter((f) => f.endsWith(".md"));
  console.log(`found ${mdFiles.length} subagent .md files`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const fname of mdFiles) {
    const path = join(AGENTS_DIR, fname);
    try {
      const f = await readAgentFile(path);
      const t = transformAgent(f, org);
      if (t.body === f.body && JSON.stringify(t.frontmatter) === JSON.stringify(f.frontmatter)) {
        skipped++;
        continue;
      }
      if (!DRY) {
        await writeAgentFile(t);
      }
      migrated++;
      if (migrated <= 3) {
        console.log(`  ${DRY ? "would-migrate" : "migrated"}: ${fname}`);
      }
    } catch (e) {
      errors++;
      console.error(`  ERROR ${fname}: ${(e as Error).message}`);
    }
  }

  console.log(
    `\nresult: ${migrated} ${DRY ? "would-migrate" : "migrated"}, ${skipped} unchanged (already migrated), ${errors} errors`
  );
}
```

- [ ] **Step 2: Run dry-run on all 120**

```bash
pnpm exec tsx src/migrations/foundation/migrate-agents.ts --dry-run
```

Expected:
```
mode: DRY-RUN
loaded 120 agents from DB
found 120 subagent .md files
  would-migrate: adrian-rozario.md
  would-migrate: amanda-setiawan.md
  would-migrate: amira-zulkifli.md

result: 120 would-migrate, 0 unchanged (already migrated), 0 errors
```

If errors > 0:
- "no DB row matches agent slug X" → either the .md file is for an agent not in the DB (orphan; investigate), or the slug isn't matching (filename ≠ frontmatter name). Add a one-line fix in `slugify()` or rename the file.
- Don't proceed to the write run until errors == 0.

- [ ] **Step 3: Run for real**

```bash
pnpm exec tsx src/migrations/foundation/migrate-agents.ts
```

Expected: same as dry-run but with `migrated: ...` instead of `would-migrate: ...`.

- [ ] **Step 4: Verify with grep that all files have the marker**

```bash
cd /d/Projects/headcount
grep -L "migrate-agents:applied" .claude/agents/*.md
```

Expected: empty (all files contain the marker).

If any files are listed, they failed to migrate — re-investigate those specifically.

- [ ] **Step 5: Verify model: stripped from all frontmatters**

```bash
grep -E "^model:" .claude/agents/*.md | head -5
```

Expected: empty.

- [ ] **Step 6: Verify Agent tool added to non-leaf agents**

```bash
# Eleanor should have Agent
grep "^tools:" .claude/agents/eleanor-vance.md
# Adrian (likely intern, no reports) probably should not (depends on tier)
grep "^tools:" .claude/agents/adrian-rozario.md
```

Expected: Eleanor's tools include `Agent`. Whether Adrian's does depends on whether his tier has reports under him.

- [ ] **Step 7: Spot-check eleanor-vance.md**

```bash
tail -80 .claude/agents/eleanor-vance.md
```

Expected: the four new sections (`# Your manager`, `# Your reports`, `# Your brain`, `# Routing guidance`) appear, with Eleanor's full sub-tree (~119 reports) listed grouped by tier.

- [ ] **Step 8: Commit**

```bash
git add apps/orchestrator/src/migrations/foundation/migrate-agents.ts apps/orchestrator/package.json apps/orchestrator/pnpm-lock.yaml .claude/agents/
git commit -m "feat(agents): rewrite all 120 subagent files — strip model, add Agent tool, append manager/reports/brain/routing sections"
```

---

## Phase 3: Brain bootstrap

### Task 3.1: Write the brain bootstrap script

**Files:**
- Create: `apps/orchestrator/src/migrations/foundation/bootstrap-brains.ts`

- [ ] **Step 1: Create the file**

Write this content:

```typescript
// ============================================================================
// bootstrap-brains.ts — Create agents/brains/<slug>.md for every active agent.
// Idempotent: skips if the file already exists.
//
// Usage:
//   pnpm exec tsx src/migrations/foundation/bootstrap-brains.ts --dry-run
//   pnpm exec tsx src/migrations/foundation/bootstrap-brains.ts
// ============================================================================

import "dotenv/config";
import { writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BRAINS_DIR = join(process.cwd(), "..", "..", "agents", "brains");
const DRY = process.argv.includes("--dry-run");
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function brainTemplate(slug: string, today: string): string {
  return `---
agent: ${slug}
last_updated: ${today}
---

# Standing patterns

(Durable rules of thumb you've learned. Promoted from "Recent learnings" by the nightly brain-keeper after a learning has proven durable.)

# Recent learnings (newest first)

(Append new entries here as you finish tasks and discover patterns. The nightly brain-keeper curates these into "Standing patterns" or prunes stale ones.)

# Anti-patterns observed

(Mistakes to avoid. Same curation flow as above.)
`;
}

async function main() {
  console.log(`mode: ${DRY ? "DRY-RUN" : "WRITE"}`);
  await mkdir(BRAINS_DIR, { recursive: true });
  console.log(`brains dir: ${BRAINS_DIR}`);

  const { data, error } = await supabase
    .from("agents")
    .select("id, name")
    .eq("status", "active");

  if (error || !data) throw new Error(`agents query failed: ${error?.message}`);

  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  let skipped = 0;

  for (const row of data) {
    const slug = slugify(row.name);
    const path = join(BRAINS_DIR, `${slug}.md`);
    if (await exists(path)) {
      skipped++;
      continue;
    }
    if (!DRY) {
      await writeFile(path, brainTemplate(slug, today), "utf8");
    }
    created++;
  }

  console.log(`\nresult: ${created} ${DRY ? "would-create" : "created"}, ${skipped} already-exist`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run dry-run**

```bash
cd /d/Projects/headcount/apps/orchestrator
pnpm exec tsx src/migrations/foundation/bootstrap-brains.ts --dry-run
```

Expected:
```
mode: DRY-RUN
brains dir: D:\Projects\headcount\agents\brains
result: 120 would-create, 0 already-exist
```

- [ ] **Step 3: Run for real**

```bash
pnpm exec tsx src/migrations/foundation/bootstrap-brains.ts
```

Expected: `120 created, 0 already-exist`.

- [ ] **Step 4: Verify**

```bash
cd /d/Projects/headcount
ls agents/brains/ | wc -l
cat agents/brains/eleanor-vance.md
```

Expected: `120`. The Eleanor file should match the template with her slug + today's date.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/migrations/foundation/bootstrap-brains.ts agents/brains/
git commit -m "feat(brains): bootstrap 120 brain.md files (one per active agent)"
```

---

## Phase 4: Registry generation

### Task 4.1: Write the registry generator

**Files:**
- Create: `apps/orchestrator/src/migrations/foundation/generate-registry.ts`

- [ ] **Step 1: Create the file**

```typescript
// ============================================================================
// generate-registry.ts — Build agents/registry.md from the agents table.
// This file is read by Eleanor (and any router) to make routing decisions.
// Re-run this whenever the agents table changes (new hire, status change, role rename).
//
// Usage:
//   pnpm exec tsx src/migrations/foundation/generate-registry.ts
// ============================================================================

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const REGISTRY_PATH = join(process.cwd(), "..", "..", "agents", "registry.md");
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  tier: string;
  department: string | null;
}

const TIER_ORDER = ["exec", "director", "manager", "associate", "intern", "bot"];
const TIER_LABEL: Record<string, string> = {
  exec: "Exec",
  director: "Director",
  manager: "Manager",
  associate: "Associate",
  intern: "Intern",
  bot: "Bot",
};

async function main() {
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, role, tier, department")
    .eq("status", "active");

  if (error || !data) throw new Error(`agents query failed: ${error?.message}`);

  const rows = data as AgentRow[];
  console.log(`generating registry for ${rows.length} active agents`);

  // Group by department, then by tier within department
  const byDept = new Map<string, AgentRow[]>();
  for (const r of rows) {
    const d = r.department || "Unassigned";
    if (!byDept.has(d)) byDept.set(d, []);
    byDept.get(d)!.push(r);
  }

  const out: string[] = [];
  out.push("# Onepark Digital — Agent Registry");
  out.push("");
  out.push(
    "Generated by `apps/orchestrator/src/migrations/foundation/generate-registry.ts`. Re-run when the agents table changes. Read by router agents (Eleanor, department heads, managers) to decide handoff targets."
  );
  out.push("");
  out.push(`**Total active: ${rows.length} agents.**`);
  out.push("");

  const deptNames = [...byDept.keys()].sort();
  for (const dept of deptNames) {
    out.push(`## ${dept}`);
    out.push("");
    const list = byDept.get(dept)!;
    list.sort((a, b) => {
      const ta = TIER_ORDER.indexOf(a.tier);
      const tb = TIER_ORDER.indexOf(b.tier);
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });

    for (const r of list) {
      const tierLabel = TIER_LABEL[r.tier] ?? r.tier;
      out.push(`- **${r.name}** (\`${slugify(r.name)}\`) · *${tierLabel}* — ${r.role}`);
    }
    out.push("");
  }

  await mkdir(join(REGISTRY_PATH, ".."), { recursive: true });
  await writeFile(REGISTRY_PATH, out.join("\n"), "utf8");
  console.log(`wrote ${REGISTRY_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
cd /d/Projects/headcount/apps/orchestrator
pnpm exec tsx src/migrations/foundation/generate-registry.ts
```

Expected:
```
generating registry for 120 active agents
wrote D:\Projects\headcount\agents\registry.md
```

- [ ] **Step 3: Inspect the output**

```bash
cd /d/Projects/headcount
head -40 agents/registry.md
wc -l agents/registry.md
```

Expected: a header, total count, then department-grouped agent lists. ~150–200 lines for 120 agents.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/src/migrations/foundation/generate-registry.ts agents/registry.md
git commit -m "feat(registry): generate agents/registry.md from agents table"
```

---

## Phase 5: Wrap-up

### Task 5.1: Smoke-test that Claude Code sees the changes

**Files:** none (manual verification)

- [ ] **Step 1: In a fresh Claude Code session, list available subagents**

In Claude Code, type: `/agents`

Expected: 120 agents listed (depending on Claude Code version, you may see a list or a selection menu). The frontmatter changes (no `model:`, `Agent` in tools where applicable) are picked up automatically by Claude Code on session start.

- [ ] **Step 2: Dispatch to Eleanor with a test prompt**

In Claude Code, type:
```
Use the eleanor-vance subagent and ask her: "Walk me through how you'd route this project: 'Build a 3-page marketing site for a meal planner SaaS by Friday'. Don't actually do the work yet — just narrate the routing decision."
```

Expected: Eleanor's response references her brain (`agents/brains/eleanor-vance.md`), her registry (she should mention reading `agents/registry.md`), and proposes a delegation to one or more department heads (likely Marketing + Engineering). The fact that she's reasoning at "highest model available" tier (Opus on Claude Max) should be visible from quality of the output.

If Eleanor doesn't reference her brain or the registry, the migration script's `# Your brain` and `# Routing guidance` sections weren't added correctly — re-check Task 2.5 step 7.

- [ ] **Step 3: Confirm we exit the foundation phase cleanly**

Run: `cd /d/Projects/headcount && git log --oneline feat/claude-code-rearchitecture ^main`

Expected: commits from Phase 1–4 listed in chronological order:
```
feat(registry): generate agents/registry.md ...
feat(brains): bootstrap 120 brain.md files ...
feat(agents): rewrite all 120 subagent files ...
feat(shared): regenerate types from 0024 schema
feat(schema): 0024 phase2 simplification ...
```

If commits are missing or out of order, that's fine — order in plan is logical, git history is chronological.

### Task 5.2: Push the foundation work

- [ ] **Step 1: Push the feature branch**

```bash
cd /d/Projects/headcount
git push -u origin feat/claude-code-rearchitecture
```

Expected: `* [new branch] feat/claude-code-rearchitecture -> feat/claude-code-rearchitecture`.

- [ ] **Step 2: Stop here. Phase 1 complete.**

The foundation is in place:
- Schema is simplified (10 tables)
- All 120 subagent files have manager / reports / brain / routing sections, no `model:` pinned
- Brain markdown files exist for all agents
- The org-chart registry is generated

The dispatcher (Plan 2 — write next) is what makes this come alive. Pause here, review the state, then start the dispatcher plan.

---

## Self-review checklist

Before moving to the dispatcher plan, walk this:

- [ ] All 10 tables exist in the dev DB; the 10 deprecated tables are gone
- [ ] `packages/shared/src/schema.ts` references the new tables
- [ ] `grep -L "migrate-agents:applied" .claude/agents/*.md` returns empty
- [ ] `grep "^model:" .claude/agents/*.md` returns empty
- [ ] `agents/brains/` contains 120 files
- [ ] `agents/registry.md` exists and lists all active agents grouped by department
- [ ] All foundation work is committed on `feat/claude-code-rearchitecture` and pushed
- [ ] Eleanor smoke-tested in Claude Code; references her brain and the registry

Once all checked, move to **Plan 2: Dispatcher + rate hygiene**.
