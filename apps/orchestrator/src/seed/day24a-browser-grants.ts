// ============================================================================
// seed/day24a-browser-grants.ts
// ----------------------------------------------------------------------------
// Grant read-only browser tools to the 5 agents who most need to look at
// real web pages:
//
//   - Tessa Goh         — CMO; competitor landing pages, positioning audits
//   - Bradley Koh       — Sales; prospect research, careers pages, press
//   - Carlos Reyes      — Market intel; earnings calls, competitor filings
//   - Hsu Yi-Ting       — SEO; SERP checks, structure audits of ranking pages
//   - Pang Wei-Ting     — Marketing analytics; measurement page audits
//
// Tools granted: browser_fetch_text, browser_extract_links, browser_screenshot
// All three on a per-agent daily cap of 50 combined (enforced in browser.ts).
//
// Idempotent — re-running is a no-op.
// Dry-run with --dry-run.
// Run with: pnpm exec tsx src/seed/day24a-browser-grants.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

const DRY = process.argv.includes("--dry-run");
const BROWSER_TOOLS = ["browser_fetch_text", "browser_extract_links", "browser_screenshot"];
const TARGETS = [
  "Tessa Goh",
  "Bradley Koh",
  "Carlos Reyes",
  "Hsu Yi-Ting",
  "Pang Wei Ting",
];

async function main() {
  if (DRY) console.log("DRY RUN — no writes.\n");
  console.log(`=== Day 24a — browser tool grants to ${TARGETS.length} agents ===\n`);

  let granted = 0;
  let already = 0;

  for (const name of TARGETS) {
    const { data: agent, error } = await db
      .from("agents")
      .select("id, name, tool_access")
      .eq("tenant_id", config.tenantId)
      .eq("name", name)
      .maybeSingle();

    if (error) {
      console.log(`  ! ${name}: query failed — ${error.message}`);
      continue;
    }
    if (!agent) {
      console.log(`  ! ${name}: not found`);
      continue;
    }

    const existing: string[] = agent.tool_access ?? [];
    const missing = BROWSER_TOOLS.filter((t) => !existing.includes(t));
    if (missing.length === 0) {
      console.log(`  - ${name}: all browser tools already granted`);
      already++;
      continue;
    }

    const next = Array.from(new Set([...existing, ...BROWSER_TOOLS]));
    if (DRY) {
      console.log(`  [DRY] ${name}: +${missing.join(", ")}`);
      granted++;
      continue;
    }
    const { error: uErr } = await db
      .from("agents")
      .update({ tool_access: next, updated_at: new Date().toISOString() })
      .eq("id", agent.id);
    if (uErr) {
      console.log(`  ! ${name}: update failed — ${uErr.message}`);
      continue;
    }
    console.log(`  + ${name}: +${missing.join(", ")}`);
    granted++;
  }

  console.log(`\nGrants: ${granted}, already had it: ${already}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
