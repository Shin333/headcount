// ============================================================================
// bootstrap-brains.ts — Phase 1 Task 3.1.
//
// Creates `agents/brains/<slug>.md` for each active agent that has a
// corresponding `.claude/agents/<slug>.md` subagent file (the 119-set;
// excludes Shin Park, who is the human user, not a subagent).
//
// Idempotent — skip-if-exists. Once a brain has content (cron-curated
// or hand-edited), bootstrap leaves it alone.
//
// Always writes/refreshes `agents/brains/README.md` (canonical doc).
//
// CLI:
//   pnpm exec tsx <path>/bootstrap-brains.ts                  # dry-run, all
//   pnpm exec tsx <path>/bootstrap-brains.ts --apply          # write
//   pnpm exec tsx <path>/bootstrap-brains.ts --file <slug>    # single agent
//   pnpm exec tsx <path>/bootstrap-brains.ts --verbose        # per-file
//
// Plan ref: docs/superpowers/plans/.../...foundation-data-and-agents.md Task 3.1
// ============================================================================

import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Repo discovery + env load
// ---------------------------------------------------------------------------
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `cwd does not look like the headcount repo (no pnpm-workspace.yaml found from ${process.cwd()})`,
  );
}

const REPO_ROOT = findRepoRoot();
loadEnv({ path: join(REPO_ROOT, "apps", "orchestrator", ".env") });

const AGENTS_DIR = join(REPO_ROOT, ".claude", "agents");
const BRAINS_DIR = join(REPO_ROOT, "agents", "brains");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in apps/orchestrator/.env",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const VERBOSE = argv.includes("--verbose");
const fileFlagIdx = argv.indexOf("--file");
const FILE_SCOPE = fileFlagIdx >= 0 ? argv[fileFlagIdx + 1] ?? null : null;

// ---------------------------------------------------------------------------
// Slugify — matches the convention used by `.claude/agents/<slug>.md`
// ---------------------------------------------------------------------------
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
function brainTemplate(agentName: string, todayIso: string): string {
  return `# ${agentName}'s working notes

<!-- Curated by the nightly learning ritual (runs at 02:00 daily, Phase 4).
     Manual edits are preserved but may be reorganized over time.
     This file is read at the start of every project Eleanor delegates to me. -->

## What I've learned

_Nothing yet. This brain was bootstrapped on ${todayIso}._

## Recent projects

_None yet — projects will appear here after the nightly ritual processes my completed work._

## Working preferences and patterns

_To be discovered through actual working._

## Open questions

_None yet._
`;
}

const README_CONTENT = `# Agent brains

This directory holds persistent memory for each AI agent in the company. One file per agent, named by slug (matching \`.claude/agents/<slug>.md\`).

## Curation

The nightly learning ritual (Phase 4, runs at 02:00 daily) reads each agent's recent project work from the database and updates the corresponding brain file. Updates are append-and-reorganize, not replace.

## Reading

Each agent reads its own brain at the start of every project Eleanor delegates to it. The brain provides context the agent has learned over time — preferences, patterns, lessons, open questions.

## Manual edits

Hand edits are allowed and preserved. The nightly ritual reorganizes content but does not delete user-authored material. If you want to seed an agent with specific knowledge, edit its brain file directly.

## Bootstrap

Brain files are bootstrapped by \`apps/orchestrator/src/migrations/foundation/bootstrap-brains.ts\` (Phase 1 Task 3.1). The script is idempotent: re-running skips any brain that already exists.
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AgentRow {
  id: string;
  name: string;
}

interface BrainPlan {
  slug: string;
  agentName: string;
  targetPath: string;
  status: "to-create" | "skipped";
  newContent: string | null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("> bootstrap-brains v1");
  console.log(
    `> Mode: ${APPLY ? "APPLY" : "DRY-RUN"}${APPLY ? "" : "  (use --apply to write changes)"}`,
  );
  console.log(
    `> Scope: ${FILE_SCOPE ? FILE_SCOPE : "all agents with a .claude/agents/<slug>.md file"}`,
  );
  console.log(">");

  // Load agents
  console.log("> Loading active agents from Supabase...");
  const { data, error } = await supabase
    .from("agents")
    .select("id, name")
    .eq("status", "active");
  if (error) throw new Error(`agents query failed: ${error.message}`);
  if (!data) throw new Error("no agents returned");

  const agents = data as AgentRow[];

  // Build the in-scope set: active agents that have a corresponding .md file
  const mdFiles = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith(".md"));
  const mdSlugs = new Set(mdFiles.map((f) => f.replace(/\.md$/, "")));

  const inScope: { slug: string; agentName: string }[] = [];
  const dbActiveWithoutFile: string[] = [];
  for (const a of agents) {
    const slug = slugify(a.name);
    if (mdSlugs.has(slug)) {
      inScope.push({ slug, agentName: a.name });
    } else {
      dbActiveWithoutFile.push(a.name);
    }
  }
  inScope.sort((a, b) => a.slug.localeCompare(b.slug));

  if (FILE_SCOPE) {
    const target = inScope.find((s) => s.slug === FILE_SCOPE);
    if (!target) {
      throw new Error(
        `--file ${FILE_SCOPE}: no active agent has slug "${FILE_SCOPE}" with a matching .md file`,
      );
    }
    inScope.length = 0;
    inScope.push(target);
  }

  console.log(
    `  ${inScope.length} agent${inScope.length === 1 ? "" : "s"} in scope${
      dbActiveWithoutFile.length > 0
        ? ` (excluded ${dbActiveWithoutFile.length} active agent${
            dbActiveWithoutFile.length === 1 ? "" : "s"
          } with no .md file: ${dbActiveWithoutFile.join(", ")})`
        : ""
    }`,
  );

  // Pre-flight
  console.log("");
  console.log("> Pre-flight:");
  console.log(`  ✓ Repo root confirmed`);

  if (APPLY) {
    await mkdir(BRAINS_DIR, { recursive: true });
  } else {
    // Dry-run: just check that the parent dir exists (we'd be able to create it)
    await mkdir(join(REPO_ROOT, "agents"), { recursive: true });
  }
  console.log(`  ✓ agents/brains/ ${APPLY ? "created" : "creatable"}`);

  // Compute pass
  console.log("");
  console.log("> Computing brain files...");
  const plans: BrainPlan[] = [];
  for (const { slug, agentName } of inScope) {
    const targetPath = join(BRAINS_DIR, `${slug}.md`);
    const exists = await fileExists(targetPath);
    if (exists) {
      plans.push({ slug, agentName, targetPath, status: "skipped", newContent: null });
      if (VERBOSE) console.log(`  skipped (exists): ${slug}.md`);
      continue;
    }
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const content = brainTemplate(agentName, todayIso);
      plans.push({ slug, agentName, targetPath, status: "to-create", newContent: content });
      if (VERBOSE) console.log(`  to-create: ${slug}.md`);
    } catch (e) {
      console.error(`  ✗ ABORT on ${slug}: ${(e as Error).message}`);
      console.error(`  Computation aborted; no writes attempted.`);
      process.exit(1);
    }
  }
  const toCreate = plans.filter((p) => p.status === "to-create").length;
  const skipped = plans.filter((p) => p.status === "skipped").length;
  console.log(`  ${toCreate} to-create, ${skipped} skipped (already exists), 0 errors`);

  // Write pass — only with --apply
  if (APPLY) {
    console.log("");
    console.log("> Writing changes...");
    let written = 0;
    for (const p of plans) {
      if (p.status !== "to-create" || p.newContent == null) continue;
      try {
        await writeFile(p.targetPath, p.newContent, "utf8");
        written++;
      } catch (e) {
        console.error(`  ✗ WRITE FAILURE on ${p.slug}.md: ${(e as Error).message}`);
        console.error(
          `  Partial state: ${written} brain file${
            written === 1 ? "" : "s"
          } written before this. Recovery: rm -rf agents/brains/`,
        );
        process.exit(2);
      }
    }
    console.log(`  ${written} brain file${written === 1 ? "" : "s"} written`);

    // Always (re)write README — canonical doc, not curated content.
    // Only do this when scope is all files; --file mode shouldn't touch README.
    if (!FILE_SCOPE) {
      const readmePath = join(BRAINS_DIR, "README.md");
      await writeFile(readmePath, README_CONTENT, "utf8");
      console.log(`  1 README written`);
    }
  }

  console.log("");
  console.log("> Done.");
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
