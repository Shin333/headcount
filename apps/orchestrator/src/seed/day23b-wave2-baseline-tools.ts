// ============================================================================
// seed/day23b-wave2-baseline-tools.ts
// ----------------------------------------------------------------------------
// Wave 2: ensure every agent has the baseline tools needed to do their job
// the moment they're activated, instead of being silently tool-less.
//
// The classifier picks a "role family" per agent based on department + role
// keywords + name overrides. Each family maps to a baseline tool set. Tools
// are added with set-union (idempotent, never strips).
//
// Defaults applied to ALL agents:
//   dm_send, roster_lookup, commitment_create, markdown_artifact_create,
//   read_artifact
//
// Family overlays:
//   engineer  → + code_artifact_create, web_search, code_execution, project_post
//   designer  → + image_generate, web_search, project_post
//   analyst   → + code_execution, web_search, project_post
//   marketing → + image_generate, web_search, project_post
//   sales     → + web_search, project_post
//   legal     → + web_search, project_post
//   executive → + project_create, project_post, web_search
//
// Special name overrides:
//   Evangeline Tan → + calendar_read (PA to CEO)
//
// Skipped: is_human=true (the CEO sentinel etc.)
//
// Run with: pnpm exec tsx src/seed/day23b-wave2-baseline-tools.ts
// Add --dry-run to preview without writing.
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

type Family =
  | "engineer"
  | "designer"
  | "analyst"
  | "marketing"
  | "sales"
  | "legal"
  | "executive"
  | "default";

const BASE_TOOLS = [
  "dm_send",
  "roster_lookup",
  "commitment_create",
  "markdown_artifact_create",
  "read_artifact",
];

const FAMILY_TOOLS: Record<Family, string[]> = {
  engineer: ["code_artifact_create", "web_search", "code_execution", "project_post"],
  designer: ["image_generate", "web_search", "project_post"],
  analyst: ["code_execution", "web_search", "project_post"],
  marketing: ["image_generate", "web_search", "project_post"],
  sales: ["web_search", "project_post"],
  legal: ["web_search", "project_post"],
  executive: ["project_create", "project_post", "web_search"],
  default: [],
};

const NAME_OVERRIDE_TOOLS: Record<string, string[]> = {
  "Evangeline Tan": ["calendar_read"],
};

// ----------------------------------------------------------------------------
// Classifier
// ----------------------------------------------------------------------------
//   1. Role-keyword overrides win (a "Designer" in operations dept is still a
//      designer; a "Backend Engineer" in marketing is still an engineer).
//   2. Department fallback for everything else.
//   3. Tier override: execs always get the executive overlay regardless of dept.
// ----------------------------------------------------------------------------

function classify(agent: { name: string; role: string; department: string | null; tier: string }): Family {
  const role = agent.role.toLowerCase();
  const dept = (agent.department ?? "").toLowerCase();

  // Tier override — execs get exec tools regardless of department
  if (agent.tier === "exec") return "executive";

  // Role keyword overrides (highest priority after exec tier)
  if (/(engineer|architect|developer|sre|devops|qa|database|backend|frontend|mobile|ml ops|firmware)/.test(role))
    return "engineer";
  if (/(designer|ux|ui designer|visual|brand|illustrator|art director)/.test(role))
    return "designer";
  if (/(analyst|data engineer|economist|financial controller|fp&a|treasury|tax|accountant|intern.*finance)/.test(role))
    return "analyst";
  if (/(content|writer|copywriter|marketer|seo|social|tiktok|instagram|reddit|email|growth|podcast|brand guard|trend)/.test(role))
    return "marketing";
  if (/(sales|account|sdr|deal|pipeline|business development|presales)/.test(role))
    return "sales";
  if (/(legal|paralegal|compliance|contract|ip counsel|tax specialist)/.test(role))
    return "legal";

  // Department fallback
  switch (dept) {
    case "engineering":
      return "engineer";
    case "design":
      return "designer";
    case "finance":
    case "operations":
    case "strategy":
    case "product":
      return "analyst";
    case "marketing":
    case "culture":
      return "marketing";
    case "sales":
      return "sales";
    case "legal":
    case "people":
      return "legal";
    case "executive":
      return "executive";
    default:
      return "default";
  }
}

function targetToolsFor(agent: { name: string; role: string; department: string | null; tier: string }): string[] {
  const family = classify(agent);
  const set = new Set<string>([...BASE_TOOLS, ...FAMILY_TOOLS[family]]);
  const override = NAME_OVERRIDE_TOOLS[agent.name] ?? [];
  for (const t of override) set.add(t);
  return Array.from(set);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("DRY RUN — no writes.\n");

  const { data: agents, error } = await db
    .from("agents")
    .select("id, name, role, department, tier, always_on, tool_access")
    .eq("tenant_id", config.tenantId)
    .eq("is_human", false)
    .order("name", { ascending: true });

  if (error) {
    console.error(`query failed: ${error.message}`);
    process.exit(1);
  }
  if (!agents) {
    console.error("no agents returned");
    process.exit(1);
  }

  const familyCounts: Record<Family, number> = {
    engineer: 0, designer: 0, analyst: 0, marketing: 0, sales: 0,
    legal: 0, executive: 0, default: 0,
  };

  let updated = 0;
  let unchanged = 0;
  let dormantUpdated = 0;
  let activeUpdated = 0;

  for (const a of agents) {
    const family = classify(a);
    familyCounts[family]++;

    const desired = targetToolsFor(a);
    const existing: string[] = a.tool_access ?? [];
    const merged = Array.from(new Set([...existing, ...desired]));
    const toAdd = desired.filter((t) => !existing.includes(t));

    if (toAdd.length === 0) {
      unchanged++;
      continue;
    }

    if (dryRun) {
      console.log(
        `  ${a.name.padEnd(28)} [${family.padEnd(9)}] +${toAdd.join(", ")}`
      );
    } else {
      const { error: updateErr } = await db
        .from("agents")
        .update({ tool_access: merged, updated_at: new Date().toISOString() })
        .eq("id", a.id);
      if (updateErr) {
        console.warn(`  ! ${a.name}: update failed — ${updateErr.message}`);
        continue;
      }
      console.log(`  + ${a.name.padEnd(28)} [${family.padEnd(9)}] +${toAdd.join(", ")}`);
    }

    updated++;
    if (a.always_on) activeUpdated++;
    else dormantUpdated++;
  }

  console.log("\n=== Summary ===");
  console.log(`Total agents:       ${agents.length}`);
  console.log(`Updated:            ${updated} (${dormantUpdated} dormant, ${activeUpdated} active)`);
  console.log(`Already correct:    ${unchanged}`);
  console.log("\n=== Family distribution ===");
  for (const [family, count] of Object.entries(familyCounts)) {
    console.log(`  ${family.padEnd(10)} ${count}`);
  }

  if (dryRun) console.log("\nDRY RUN — re-run without --dry-run to apply.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
