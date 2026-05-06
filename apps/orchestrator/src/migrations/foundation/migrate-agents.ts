// ============================================================================
// migrate-agents.ts — One-time pass over .claude/agents/*.md to:
//   1. Strip `model:` from frontmatter (always-latest-model design).
//   2. Add `Agent` to `tools:` for any non-leaf agent (subtree.length > 0).
//   3. Strip the legacy `<!-- Exported from Headcount... -->` trailer.
//   4. Append the migration marker plus four new sections:
//      `# Your manager`, `# Your reports`, `# Your brain`, `# Routing guidance`.
//
// Idempotent. Reads `agents` table (status='active') as source of truth for
// the org chart. Computes all transforms in memory, then writes all-or-nothing.
//
// CLI:
//   pnpm exec tsx <path>/migrate-agents.ts                  # dry-run, all files
//   pnpm exec tsx <path>/migrate-agents.ts --apply          # write all files
//   pnpm exec tsx <path>/migrate-agents.ts --file <slug>    # single file (dry-run + diff)
//   pnpm exec tsx <path>/migrate-agents.ts --verbose        # per-file lines
//
// Spec ref: docs/superpowers/specs/.../...rearchitecture-design.md §5.2.1, §6.1
// Plan ref: docs/superpowers/plans/.../...foundation-data-and-agents.md Tasks 2.1–2.5
// ============================================================================

import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import matter from "gray-matter";
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
// Types
// ---------------------------------------------------------------------------
interface AgentRow {
  id: string;
  name: string;
  role: string;
  tier: string;
  department: string | null;
  manager_id: string | null;
}

interface OrgNode {
  agent: AgentRow;
  slug: string;
  directReports: OrgNode[];
  subtree: OrgNode[];
  manager: OrgNode | null;
}

interface TransformInput {
  filename: string;
  fullPath: string;
  rawContent: string;
}

interface TransformOutput {
  filename: string;
  fullPath: string;
  status: "would-migrate" | "already-applied";
  oldContent: string;
  newContent: string;
}

// ---------------------------------------------------------------------------
// Slugify — must match the convention used to name `.claude/agents/<slug>.md`
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
// Org chart loader
// ---------------------------------------------------------------------------
async function loadOrgChart(): Promise<{
  byId: Map<string, OrgNode>;
  bySlug: Map<string, OrgNode>;
  roots: OrgNode[];
}> {
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, role, tier, department, manager_id")
    .eq("status", "active");

  if (error) throw new Error(`agents query failed: ${error.message}`);
  if (!data) throw new Error("no agents returned");

  const byId = new Map<string, OrgNode>();
  const bySlug = new Map<string, OrgNode>();

  for (const row of data as AgentRow[]) {
    const slug = slugify(row.name);
    const node: OrgNode = {
      agent: row,
      slug,
      directReports: [],
      subtree: [],
      manager: null,
    };
    byId.set(row.id, node);
    if (bySlug.has(slug)) {
      throw new Error(
        `duplicate slug "${slug}" — collisions in active agents table (offenders: ${
          bySlug.get(slug)!.agent.name
        }, ${row.name})`,
      );
    }
    bySlug.set(slug, node);
  }

  const roots: OrgNode[] = [];
  for (const node of byId.values()) {
    if (node.agent.manager_id == null) {
      roots.push(node);
      continue;
    }
    const mgr = byId.get(node.agent.manager_id);
    if (!mgr) {
      throw new Error(
        `orphan FK: agent ${node.agent.name} (${node.agent.id}) has manager_id ${node.agent.manager_id} which does not resolve to an active agent`,
      );
    }
    node.manager = mgr;
    mgr.directReports.push(node);
  }
  if (roots.length === 0) {
    throw new Error(
      "no root agent found (every active agent has a non-null manager_id)",
    );
  }

  // BFS subtree per node + cycle detection
  for (const node of byId.values()) {
    const queue: OrgNode[] = [...node.directReports];
    const visited = new Set<string>([node.agent.id]);
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (visited.has(next.agent.id)) {
        throw new Error(
          `cycle detected: ${node.agent.name}'s subtree revisits ${next.agent.name}`,
        );
      }
      visited.add(next.agent.id);
      node.subtree.push(next);
      queue.push(...next.directReports);
    }
  }

  return { byId, bySlug, roots };
}

// ---------------------------------------------------------------------------
// Transform — pure, idempotent.
// ---------------------------------------------------------------------------
const APPENDED_MARKER = "<!-- migrate-agents:applied -->";
// Trailer left behind by the deleted apps/orchestrator/src/seed/export-claude-agents.ts:
//   ...
//   ---
//   <!-- Exported from Headcount on <date>. ... -->
const TRAILER_RE = /\n---\s*\n<!--\s*Exported from Headcount[\s\S]*?-->\s*$/;

const TIER_RENDER_ORDER = ["exec", "director", "manager", "associate", "intern"] as const;
const TIER_HEADING: Record<string, string> = {
  exec: "Exec",
  director: "Director",
  manager: "Manager",
  associate: "Associate",
  intern: "Intern",
};

function transformAgent(
  input: TransformInput,
  bySlug: Map<string, OrgNode>,
): TransformOutput {
  const parsed = matter(input.rawContent);
  const fmName = String((parsed.data as { name?: unknown }).name ?? "");
  if (!fmName) {
    throw new Error(`${input.filename}: missing frontmatter "name" field`);
  }

  // Idempotency
  if (parsed.content.includes(APPENDED_MARKER)) {
    return {
      filename: input.filename,
      fullPath: input.fullPath,
      status: "already-applied",
      oldContent: input.rawContent,
      newContent: input.rawContent,
    };
  }

  const node = bySlug.get(fmName);
  if (!node) {
    throw new Error(
      `${input.filename}: frontmatter slug "${fmName}" does not match any active DB agent`,
    );
  }

  if (!node.manager) {
    throw new Error(
      `${input.filename}: agent "${node.agent.name}" has no manager_id (root agent should not have a .md file)`,
    );
  }

  // Frontmatter mutation — strip model, append Agent for non-leaf
  const fm: Record<string, unknown> = { ...parsed.data };
  delete fm.model;

  if (node.subtree.length > 0) {
    const tools = String(fm.tools ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tools.includes("Agent")) tools.push("Agent");
    fm.tools = tools.join(", ");
  }

  // Build appended sections
  const lines: string[] = ["", APPENDED_MARKER, ""];

  // # Your manager
  lines.push("# Your manager", "");
  lines.push(`You report to ${node.manager.agent.name}, ${node.manager.agent.role}.`);
  lines.push("");

  // # Your reports
  lines.push("# Your reports", "");
  if (node.subtree.length === 0) {
    lines.push("You have no direct reports. You execute work yourself.");
    lines.push("");
  } else {
    lines.push(
      "The following agents report to you (full subtree, grouped by seniority tier):",
    );
    lines.push("");

    // Tier buckets: render exec → director → manager → associate → intern.
    // `bot` is intentionally NOT rendered — Uncle Tan is not a delegation target.
    const byTier: Record<string, OrgNode[]> = {
      exec: [],
      director: [],
      manager: [],
      associate: [],
      intern: [],
      bot: [],
    };
    for (const r of node.subtree) {
      (byTier[r.agent.tier] ?? byTier.bot).push(r);
    }
    for (const tier of TIER_RENDER_ORDER) {
      const list = byTier[tier];
      if (!list || list.length === 0) continue;
      lines.push(`## ${TIER_HEADING[tier]}`, "");
      for (const r of list) {
        lines.push(`- ${r.agent.name} — ${r.agent.role}`);
      }
      lines.push("");
    }
  }

  // # Your brain
  lines.push("# Your brain", "");
  lines.push(
    `Your persistent memory lives at \`agents/brains/${node.slug}.md\`. Read it at the start of every project and update it during nightly reflection (created in Plan 1 Task 3.1; wired up in Phase 2).`,
  );
  lines.push("");

  // # Routing guidance — only for non-leaf
  if (node.subtree.length > 0) {
    lines.push("# Routing guidance", "");
    lines.push(
      "You can dispatch work to your reports using the `Agent` tool. To delegate to an agent outside your subtree, route through your manager. Always delegate to the lowest competent level.",
    );
    lines.push("");
  }

  // Strip the legacy export-claude-agents.ts trailer from the body
  const cleanBody = parsed.content.replace(TRAILER_RE, "");

  const newBody = cleanBody.trimEnd() + "\n" + lines.join("\n");
  const newContent = matter.stringify(newBody, fm);

  return {
    filename: input.filename,
    fullPath: input.fullPath,
    status: "would-migrate",
    oldContent: input.rawContent,
    newContent,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("> migrate-agents v1");
  console.log(
    `> Mode: ${APPLY ? "APPLY" : "DRY-RUN"}${APPLY ? "" : "  (use --apply to write changes)"}`,
  );
  console.log(`> Scope: ${FILE_SCOPE ? FILE_SCOPE : "all files"}`);
  console.log(">");

  // Load org chart
  console.log("> Loading org chart from Supabase...");
  const { byId, bySlug, roots } = await loadOrgChart();
  console.log(`  ${byId.size} active agents loaded`);
  console.log(
    `  Roots: ${roots.length} (${roots.map((r) => r.agent.name).join(", ")})`,
  );

  const tierCounts: Record<string, number> = {};
  for (const n of byId.values()) {
    tierCounts[n.agent.tier] = (tierCounts[n.agent.tier] ?? 0) + 1;
  }
  const TIER_PRINT_ORDER = ["exec", "director", "manager", "associate", "intern", "bot"];
  const tierStr = TIER_PRINT_ORDER.filter((t) => (tierCounts[t] ?? 0) > 0)
    .map((t) => `${t}=${tierCounts[t]}`)
    .join(" ");
  console.log(`  Tier distribution: ${tierStr}`);

  // Scan files
  console.log("");
  console.log("> Scanning .claude/agents/...");
  const allEntries = await readdir(AGENTS_DIR);
  let mdFiles = allEntries.filter((f) => f.endsWith(".md"));
  if (FILE_SCOPE) {
    const target = `${FILE_SCOPE}.md`;
    if (!mdFiles.includes(target)) {
      throw new Error(
        `--file ${FILE_SCOPE}: ${target} not found in ${AGENTS_DIR}`,
      );
    }
    mdFiles = [target];
  }
  console.log(`  ${mdFiles.length} .md file${mdFiles.length === 1 ? "" : "s"}`);

  // Read inputs
  const inputs: TransformInput[] = [];
  for (const filename of mdFiles) {
    const fullPath = join(AGENTS_DIR, filename);
    const rawContent = await readFile(fullPath, "utf8");
    inputs.push({ filename, fullPath, rawContent });
  }

  // Pre-flight: parse + slug match
  console.log("");
  console.log("> Pre-flight:");
  const parseErrors: string[] = [];
  const slugErrors: string[] = [];
  for (const input of inputs) {
    let fmName: string;
    try {
      const parsed = matter(input.rawContent);
      fmName = String((parsed.data as { name?: unknown }).name ?? "");
      if (!fmName) {
        parseErrors.push(`${input.filename}: missing frontmatter "name"`);
        continue;
      }
    } catch (e) {
      parseErrors.push(`${input.filename}: parse error: ${(e as Error).message}`);
      continue;
    }
    if (!bySlug.has(fmName)) {
      slugErrors.push(
        `${input.filename}: slug "${fmName}" has no active DB agent`,
      );
    }
  }
  if (parseErrors.length > 0) {
    console.error(`  ✗ ${parseErrors.length} parse error(s):`);
    for (const e of parseErrors) console.error(`    ${e}`);
    process.exit(1);
  }
  console.log(
    `  ✓ All ${inputs.length} file${inputs.length === 1 ? "" : "s"} parse cleanly`,
  );
  if (slugErrors.length > 0) {
    console.error(`  ✗ ${slugErrors.length} slug-match error(s):`);
    for (const e of slugErrors) console.error(`    ${e}`);
    process.exit(1);
  }
  console.log(
    `  ✓ All ${inputs.length} file slug${inputs.length === 1 ? "" : "s"} match an active DB agent`,
  );
  console.log(
    `  ✓ Org chart: no cycles, no orphan FKs, ${roots.length} root${roots.length === 1 ? "" : "s"}`,
  );

  // Sanity-print exec tier (only when scope is all files)
  if (!FILE_SCOPE) {
    console.log("");
    console.log("> Sanity-print: exec tier subtree sizes");
    const execNodes = [...byId.values()]
      .filter((n) => n.agent.tier === "exec")
      .sort((a, b) => a.agent.name.localeCompare(b.agent.name));
    for (const n of execNodes) {
      const note =
        n.slug === "eleanor-vance" && n.subtree.length === 0
          ? "   [empty by design — see spec §5.2.1]"
          : "";
      console.log(
        `  ${n.agent.name} (exec) — ${n.directReports.length} direct, ${n.subtree.length} subtree${note}`,
      );
    }
  }

  // Compute transforms
  console.log("");
  console.log("> Computing transforms...");
  const transforms: TransformOutput[] = [];
  for (const input of inputs) {
    try {
      const out = transformAgent(input, bySlug);
      transforms.push(out);
      if (VERBOSE) console.log(`  ${out.status}: ${input.filename}`);
    } catch (e) {
      console.error(`  ✗ ABORT on ${input.filename}: ${(e as Error).message}`);
      console.error(`  Computation aborted; no writes attempted.`);
      process.exit(1);
    }
  }
  const wouldMigrate = transforms.filter((t) => t.status === "would-migrate").length;
  const alreadyApplied = transforms.filter((t) => t.status === "already-applied").length;
  console.log(
    `  ${wouldMigrate} would-migrate, ${alreadyApplied} already-applied, 0 errors`,
  );

  // Single-file diff (dry-run)
  if (FILE_SCOPE && !APPLY) {
    const t = transforms[0]!;
    console.log("");
    if (t.status === "already-applied") {
      console.log(`  ${t.filename} is already migrated; no diff to show.`);
    } else {
      console.log(`> Diff for ${t.filename}:`);
      const tmp = await mkdtemp(join(tmpdir(), "migrate-agents-"));
      const tmpFile = join(tmp, t.filename);
      await writeFile(tmpFile, t.newContent, "utf8");
      try {
        const diff = execSync(
          `git diff --no-index --no-color -- "${t.fullPath}" "${tmpFile}"`,
          { encoding: "utf8" },
        );
        console.log(diff || "(no diff)");
      } catch (e) {
        // git diff --no-index exits 1 when files differ — normal.
        const err = e as { status?: number; stdout?: string };
        if (err.status === 1 && err.stdout) {
          console.log(err.stdout);
        } else {
          throw e;
        }
      }
    }
  }

  // Write pass — only with --apply
  if (APPLY) {
    console.log("");
    console.log("> Writing changes...");
    let written = 0;
    for (const t of transforms) {
      if (t.status !== "would-migrate") continue;
      try {
        await writeFile(t.fullPath, t.newContent, "utf8");
        written++;
      } catch (e) {
        console.error(`  ✗ WRITE FAILURE on ${t.filename}: ${(e as Error).message}`);
        console.error(
          `  Partial state: ${written} file${written === 1 ? "" : "s"} written before this. Use 'git status' / 'git restore' to recover.`,
        );
        process.exit(2);
      }
    }
    console.log(`  ${written} written`);
  }

  console.log("");
  console.log("> Done.");
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
