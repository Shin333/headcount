// ----------------------------------------------------------------------------
// seed/grant-evie-calendar.ts - one-time Google Calendar OAuth grant for Evie
// ----------------------------------------------------------------------------
// Run once after Day 9b ships:
//   pnpm tsx apps/orchestrator/src/seed/grant-evie-calendar.ts
//
// This script:
//   1. Looks up Evie (Evangeline Tan) in the agents table
//   2. Runs the Google OAuth flow with calendar.readonly scope
//   3. Stores the resulting tokens in agent_credentials, attributed to Evie
//
// After this script completes successfully, Evie can use the calendar_read
// tool. You only need to run it once - tokens auto-refresh from then on.
//
// If you ever need to revoke or re-grant: visit
// https://myaccount.google.com/permissions and remove "Onepark Digital AI
// Agency", then re-run this script.
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { runGrantFlow } from "../auth/google-oauth.js";
import { pathToFileURL } from "node:url";

export async function runGrantEvieCalendar(): Promise<void> {
  console.log(`[grant-evie-calendar] looking up Evangeline Tan...`);

  const { data: evie, error } = await db
    .from("agents")
    .select("id, name")
    .eq("tenant_id", config.tenantId)
    .eq("name", "Evangeline Tan")
    .maybeSingle();

  if (error) {
    console.error(`[grant-evie-calendar] FAILED to query agents: ${error.message}`);
    process.exit(1);
  }

  if (!evie) {
    console.error(
      `[grant-evie-calendar] FAILED: no agent found with name 'Evangeline Tan'. ` +
        `Make sure the seed-day7 scripts have run.`
    );
    process.exit(1);
  }

  console.log(`[grant-evie-calendar] found Evie: ${evie.id}`);
  console.log(``);
  console.log(`[grant-evie-calendar] starting OAuth grant flow...`);
  console.log(`[grant-evie-calendar] you will see a browser window asking for permission.`);
  console.log(`[grant-evie-calendar] click 'Allow' on the consent screen.`);
  console.log(``);

  await runGrantFlow({
    agentId: evie.id,
    agentName: evie.name,
    provider: "google",
    scope: "calendar.readonly",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    grantedBy: "shin",
  });

  console.log(`[grant-evie-calendar] done. Evie can now read your Google Calendar.`);
  console.log(`[grant-evie-calendar] try DMing her: 'what's on my calendar today?'`);
}

// CLI invocation - cross-platform via pathToFileURL (Day 8 lesson)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGrantEvieCalendar()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[grant-evie-calendar] FATAL:", err);
      process.exit(1);
    });
}
