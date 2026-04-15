// ----------------------------------------------------------------------------
// seed/eleanor-confab-guard.ts - Day 22: hard confabulation enforcement
// ----------------------------------------------------------------------------
// Appends a hard rule to Eleanor's frozen_core that REQUIRES roster_lookup
// for any personnel claims. The soft "ask don't invent" addendum wasn't
// enough — she still confabulated 8 fake agent names when compiling a cast
// list from memory.
//
// Run with:
//   pnpm tsx src/seed/eleanor-confab-guard.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { pathToFileURL } from "node:url";

const GUARD_MARKER = "# Personnel Data Integrity Rule";

const GUARD_TEXT = `

${GUARD_MARKER}

HARD RULE — NEVER VIOLATE:

When listing, naming, counting, or describing employees, agents, team members, or any personnel:
1. You MUST call roster_lookup FIRST to get the real data
2. You MUST NOT list any names from memory — your memory is unreliable and you WILL invent people who don't exist
3. If roster_lookup is unavailable or returns incomplete data, say "I need to verify this against the roster" and STOP
4. NEVER fill gaps with plausible-sounding names — a shorter accurate list is better than a longer fictional one
5. If the CEO or anyone asks "who's on the team" or "list the named cast" or any variant — call roster_lookup. No exceptions.

You have previously invented 8 fake agent names (Marcus Webb, Anya Sharma, etc.) when compiling a cast list from memory. This caused significant project disruption. The rule above exists because of that failure.
`;

async function addConfabGuard(): Promise<void> {
  console.log("\n[eleanor-confab-guard] adding hard confabulation rule to Eleanor's frozen_core");

  const { data: agent } = await db
    .from("agents")
    .select("id, name, frozen_core")
    .eq("name", "Eleanor Vance")
    .maybeSingle();

  if (!agent) {
    console.error("[eleanor-confab-guard] Eleanor Vance not found");
    return;
  }

  if (agent.frozen_core.includes(GUARD_MARKER)) {
    console.log("[eleanor-confab-guard] guard already present, skipping");
    return;
  }

  const updatedCore = agent.frozen_core + GUARD_TEXT;

  const { error } = await db
    .from("agents")
    .update({ frozen_core: updatedCore })
    .eq("id", agent.id);

  if (error) {
    console.error("[eleanor-confab-guard] update failed:", error.message);
    return;
  }

  console.log(`[eleanor-confab-guard] done — appended ${GUARD_TEXT.length} chars to frozen_core`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  addConfabGuard()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
