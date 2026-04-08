import { db } from "../db.js";
import { config } from "../config.js";
import { SPECIALIST_CATALOG, buildSpecialistFrozenCore, type SpecialistDefinition } from "./agency-agents-catalog.js";
import { assignUniqueNamesForRoles, type SeaName } from "./singaporean-names.js";

// ============================================================================
// Day 7: Bulk specialist insertion
// ----------------------------------------------------------------------------
// For each specialist in the catalog:
//   1. Assign a deterministic name from the SG/SEA name pool
//   2. Resolve the manager_id (either dept head exec or null)
//   3. Build the frozen_core from the generic template
//   4. Upsert into agents table (idempotent by name)
//
// CRITICAL: All specialists are dormant by default.
//   always_on = false
//   in_standup = false
//   status = active (but never fires unless pulled into a project)
//
// Cost implication: 104 new rows in agents table, but ZERO additional
// Claude calls per standup/chatter/reflection tick, because the ritual
// filters exclude is_human=false AND always_on=true.
// ============================================================================

const TENANT_ID = config.tenantId;

// Department slug → exec name mapping. Used to resolve manager_id when
// a specialist has reports_to_department_head=true.
const DEPT_HEAD_BY_SLUG: Record<string, string> = {
  engineering: "Tsai Wei-Ming",
  marketing: "Tessa Goh",
  sales: "Bradley Koh",
  operations: "Lim Geok Choo",
  finance: "Nadia Rahman",
  legal: "Devraj Pillai",
  people: "Faridah binte Yusof",
  strategy: "Han Jae-won",
  design: "Tessa Goh",  // dotted line to Wei-Ming but Tessa is primary
  product: "Shin Park",  // product reports to CEO directly per org chart
};

// Default personality shell for specialists. Archetype and quirks get
// filled from the catalog; big5 uses role-appropriate baselines.
function buildSpecialistPersonality(def: SpecialistDefinition): {
  big5: { openness: number; conscientiousness: number; extraversion: number; agreeableness: number; neuroticism: number };
  archetype: string;
  quirks: string[];
  voiceExamples: string[];
} {
  // Generic big5 baseline — adjusted per tier so seniors feel senior
  // and interns feel a little more uncertain.
  const base = {
    director: { openness: 75, conscientiousness: 85, extraversion: 55, agreeableness: 55, neuroticism: 35 },
    manager:  { openness: 70, conscientiousness: 80, extraversion: 55, agreeableness: 60, neuroticism: 40 },
    associate:{ openness: 68, conscientiousness: 75, extraversion: 55, agreeableness: 65, neuroticism: 45 },
    intern:   { openness: 78, conscientiousness: 70, extraversion: 55, agreeableness: 70, neuroticism: 50 },
  }[def.tier];

  return {
    big5: base,
    archetype: def.archetype,
    quirks: [
      "Dormant by default — only speaks when pulled into a project or assigned a ticket.",
      "Expertise-first: leaves the flavor to the named execs, focuses on quality output.",
    ],
    voiceExamples: [],  // Empty — specialists get voice examples when pulled into a project
  };
}

export async function runBulkSpecialistSeed(): Promise<void> {
  console.log(`[day7-bulk] starting bulk specialist seed (${SPECIALIST_CATALOG.length} specialists)...`);

  // Step 1: resolve all manager ids up front (dept heads)
  const { data: allAgents, error: lookupErr } = await db
    .from("agents")
    .select("id, name, department")
    .eq("tenant_id", TENANT_ID);

  if (lookupErr || !allAgents) {
    console.error(`[day7-bulk] FAILED to load agents: ${lookupErr?.message}`);
    return;
  }

  const nameToId = new Map(allAgents.map((a) => [a.name, a.id]));

  // Verify all dept heads exist before we start
  const missingHeads: string[] = [];
  for (const [dept, headName] of Object.entries(DEPT_HEAD_BY_SLUG)) {
    if (!nameToId.has(headName)) {
      missingHeads.push(`${dept} → ${headName}`);
    }
  }
  if (missingHeads.length > 0) {
    console.error(`[day7-bulk] FAILED: missing department heads: ${missingHeads.join(", ")}`);
    console.error(`[day7-bulk] Run Day 7 org restructure first (runDay7OrgRestructure)`);
    return;
  }

  // Step 2: assign unique names for all specialist slugs
  const nameAssignments = assignUniqueNamesForRoles(SPECIALIST_CATALOG.map((s) => s.slug));
  console.log(`[day7-bulk] assigned ${nameAssignments.size} unique names from pool`);

  // Step 3: resolve existing specialist rows (for idempotent updates)
  const existingByName = new Map<string, string>();
  for (const agent of allAgents) {
    existingByName.set(agent.name, agent.id);
  }

  // Step 4: insert/update each specialist
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const def of SPECIALIST_CATALOG) {
    const seaName = nameAssignments.get(def.slug);
    if (!seaName) {
      console.error(`[day7-bulk] FAILED: no name assigned for '${def.slug}'`);
      failed++;
      continue;
    }

    // Resolve manager
    let managerId: string | null = null;
    let managerName: string = "";

    if (def.reports_to_department_head) {
      const headName = DEPT_HEAD_BY_SLUG[def.department];
      if (!headName) {
        console.error(`[day7-bulk] FAILED: no dept head for '${def.department}'`);
        failed++;
        continue;
      }
      managerId = nameToId.get(headName) ?? null;
      managerName = headName;
    } else {
      // Non-dept-head specialists report to another specialist in the same
      // department at tier=manager or tier=director. For simplicity in Day 7,
      // we still point them at the dept head, and Day 8 can refine reporting
      // chains within departments.
      const headName = DEPT_HEAD_BY_SLUG[def.department];
      if (!headName) {
        console.error(`[day7-bulk] FAILED: no dept head for '${def.department}'`);
        failed++;
        continue;
      }
      managerId = nameToId.get(headName) ?? null;
      managerName = headName;
    }

    if (!managerId) {
      console.error(`[day7-bulk] FAILED: couldn't resolve manager for '${def.slug}'`);
      failed++;
      continue;
    }

    const fullName = seaName.full_name;
    const frozenCore = buildSpecialistFrozenCore({
      name: fullName,
      role: def.role,
      department: def.department,
      manager_name: managerName,
      archetype: def.archetype,
      expertise: def.expertise,
      tier: def.tier,
    });

    const personality = buildSpecialistPersonality(def);

    const existingId = existingByName.get(fullName);

    const row = {
      tenant_id: TENANT_ID,
      name: fullName,
      role: def.role,
      department: def.department,
      tier: def.tier,
      manager_id: managerId,
      reports_to_ceo: false,
      personality,
      background: `${fullName} — ${def.archetype} Assigned to ${def.department} department, reports to ${managerName}.`,
      frozen_core: frozenCore,
      manager_overlay: "",
      learned_addendum: "",
      allowed_tools: [],
      model_tier: def.model_tier,
      status: "active" as const,
      daily_token_budget: 10000,
      tokens_used_today: 0,
      addendum_loop_active: false,
      chatter_posts_today: 0,
      tool_access: [],
      always_on: false,
      in_standup: false,
      is_human: false,
      tic: null,
    };

    if (existingId) {
      const { error } = await db.from("agents").update(row).eq("id", existingId);
      if (error) {
        console.error(`[day7-bulk] FAILED to update '${fullName}': ${error.message}`);
        failed++;
        continue;
      }
      updated++;
    } else {
      const { error } = await db.from("agents").insert(row);
      if (error) {
        console.error(`[day7-bulk] FAILED to insert '${fullName}' (${def.slug}): ${error.message}`);
        failed++;
        continue;
      }
      inserted++;
    }
  }

  console.log(`[day7-bulk] complete: ${inserted} inserted, ${updated} updated, ${failed} failed`);
}

// CLI invocation
// Cross-platform check: pathToFileURL gives the same shape as import.meta.url
// on both Windows and POSIX. The previous `file://${process.argv[1]}` template
// silently failed on Windows because Windows paths use backslashes and drive
// letters that don't match the URL format.
import { pathToFileURL as __pathToFileURL_bulk } from "node:url";
if (process.argv[1] && import.meta.url === __pathToFileURL_bulk(process.argv[1]).href) {
  runBulkSpecialistSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[day7-bulk] FATAL", err);
      process.exit(1);
    });
}
