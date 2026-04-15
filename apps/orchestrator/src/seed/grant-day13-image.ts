// ----------------------------------------------------------------------------
// seed/grant-day13-image.ts - grant image_generate tool (Day 13)
// ----------------------------------------------------------------------------
// Grants the image_generate (nanobanana) tool to:
//   - Tessa Goh (Director of Marketing) - for website hero images, brand visuals
//   - Tsai Wei-Ming (Director of Engineering) - for technical diagrams + testing
//   - Image Prompt Engineer specialist - dormant until Day 10 website project
//     activates them, but pre-granted so activation is one less step
//
// Idempotent: re-running has no effect on agents that already have the tool.
// Uses array union semantics (existing tools preserved, new tool added if
// not present).
//
// Run with:
//   pnpm tsx apps/orchestrator/src/seed/grant-day13-image.ts
//
// IMPORTANT - this script grants the TOOL CAPABILITY, not the API key. Make
// sure GEMINI_API_KEY is set in your orchestrator .env before agents try to
// use the tool. Without the key, the tool returns a friendly error and
// audit-logs the failure - it does NOT crash.
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

const NEW_TOOL = "image_generate";

interface GrantTarget {
  /** Selector type: "name" for named cast, "role" for specialists. */
  by: "name" | "role";
  /** The value to match. For named cast use the full name (e.g. "Tessa Goh"). */
  value: string;
  /** Human-readable label for log output. */
  label: string;
}

const TARGETS: GrantTarget[] = [
  // Named cast - granted by name (stable)
  {
    by: "name",
    value: "Tessa Goh",
    label: "Tessa Goh (Director of Marketing)",
  },
  {
    by: "name",
    value: "Tsai Wei-Ming",
    label: "Tsai Wei-Ming (Director of Engineering)",
  },
  // Specialist - granted by role since the assigned name is randomly generated
  {
    by: "role",
    value: "Image Prompt Engineer",
    label: "Image Prompt Engineer (dormant specialist)",
  },
];

interface AgentRow {
  id: string;
  name: string;
  role: string;
  tool_access: string[] | null;
}

async function findAgent(target: GrantTarget): Promise<AgentRow | null> {
  const query = db
    .from("agents")
    .select("id, name, role, tool_access")
    .eq("tenant_id", config.tenantId)
    .eq("is_human", false);

  const { data, error } =
    target.by === "name"
      ? await query.eq("name", target.value).maybeSingle()
      : await query.eq("role", target.value).maybeSingle();

  if (error) {
    console.error(`[grant-day13] error querying for ${target.label}: ${error.message}`);
    return null;
  }
  return (data as AgentRow | null) ?? null;
}

async function grantOne(target: GrantTarget): Promise<"granted" | "already" | "missing" | "error"> {
  const agent = await findAgent(target);
  if (!agent) {
    console.error(`[grant-day13] MISSING: ${target.label} - no matching agent found`);
    return "missing";
  }

  const existing: string[] = agent.tool_access ?? [];
  if (existing.includes(NEW_TOOL)) {
    console.log(`[grant-day13] ALREADY: ${target.label} (${agent.name}) already has ${NEW_TOOL}`);
    return "already";
  }

  const merged = [...existing, NEW_TOOL];
  const { error } = await db
    .from("agents")
    .update({ tool_access: merged, updated_at: new Date().toISOString() })
    .eq("id", agent.id);

  if (error) {
    console.error(`[grant-day13] FAILED: ${target.label}: ${error.message}`);
    return "error";
  }

  console.log(`[grant-day13] GRANTED: ${target.label} - now has [${merged.join(", ")}]`);
  return "granted";
}

export async function runGrantDay13Image(): Promise<void> {
  console.log(``);
  console.log(`[grant-day13] granting ${NEW_TOOL} tool to ${TARGETS.length} agents`);
  console.log(`[grant-day13] tenant: ${config.tenantId}`);
  console.log(``);

  let granted = 0;
  let already = 0;
  let missing = 0;
  let errors = 0;

  for (const target of TARGETS) {
    const result = await grantOne(target);
    if (result === "granted") granted++;
    else if (result === "already") already++;
    else if (result === "missing") missing++;
    else errors++;
  }

  console.log(``);
  console.log(`[grant-day13] summary: ${granted} granted, ${already} already had it, ${missing} missing, ${errors} errors`);
  console.log(``);

  if (granted > 0) {
    console.log(`[grant-day13] Next step: make sure GEMINI_API_KEY is set in your orchestrator .env file.`);
    console.log(`[grant-day13] Then DM Tessa or Wei-Ming and ask for an image.`);
    console.log(`[grant-day13] First-time test: pnpm tsx apps/orchestrator/src/tools/test-nanobanana.mjs`);
  }

  if (missing > 0) {
    console.log(``);
    console.log(`[grant-day13] WARNING: ${missing} target(s) were not found. Check that:`);
    console.log(`[grant-day13]   - The named cast seed scripts have been run (Tessa, Wei-Ming exist)`);
    console.log(`[grant-day13]   - The day7-bulk-specialists seed has run (Image Prompt Engineer exists)`);
  }

  if (errors > 0) {
    process.exit(1);
  }
}

// Allow running as a standalone script
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runGrantDay13Image()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[grant-day13] unexpected error:`, err);
      process.exit(1);
    });
}
