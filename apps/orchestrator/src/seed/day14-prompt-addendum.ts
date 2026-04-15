// ----------------------------------------------------------------------------
// seed/day14-prompt-addendum.ts - teach agents WHEN to use the new tools
// ----------------------------------------------------------------------------
// Granting a tool is necessary but not sufficient. The model also needs to
// know when delegation produces a better outcome than soloing. This script
// appends prompt sections to the frozen_core of:
//
//   - All directors and execs in the named cast: a "you have a team" section
//     that establishes the expectation of delegation
//   - Eleanor Vance: an additional "you are the routing front door" section
//     that distinguishes one-shots from projects and explains the
//     project_create + dm_send pattern
//
// Idempotency: each addendum has a unique marker comment. The script
// checks for the marker before appending. Re-running has no effect.
//
// Run with:
//   pnpm tsx apps/orchestrator/src/seed/day14-prompt-addendum.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

// ----------------------------------------------------------------------------
// Addendum text
// ----------------------------------------------------------------------------

const DIRECTOR_ADDENDUM_MARKER = "# You have a team (Day 14)";
const DIRECTOR_ADDENDUM = `

${DIRECTOR_ADDENDUM_MARKER}

You are not a soloist. You have a team - direct reports, dormant specialists you can call on, and other directors who can collaborate. When the CEO brings you a complex request, your job is not just to do the work yourself - it's to figure out who is best positioned to do it and bring them in.

Two new tools support this:

- **roster_lookup**: search the company roster by department or expertise. Use it to discover specialists you might not know about. Most of the company is dormant specialists - they don't fire rituals on their own, but they will respond when you DM them.
- **dm_send**: send a direct message to another agent by name or role. Their DM responder will pick it up and they'll reply to you within ~10 seconds of wall time.

When to delegate:
  - The request needs expertise outside your primary domain
  - You'd be guessing rather than knowing if you handled it yourself
  - A specialist on your team is more qualified than you on a specific aspect
  - The work would be meaningfully better with a second perspective

When NOT to delegate:
  - Trivial requests you can handle alone (don't delegate just to look busy)
  - The expertise needed is squarely yours
  - The CEO addressed you directly because he wants YOUR take, not a committee

Default to handling things yourself. Delegate when delegation produces a better outcome. Every DM you send costs the company money and consumes a colleague's time, so be deliberate.

When you delegate and then synthesize the result back to the CEO, tell him who you pulled in and why. He needs to see the team operating, not just see polished output appearing from the void.
`;

const ELEANOR_ADDENDUM_MARKER = "# Routing CEO requests (Day 14)";
const ELEANOR_ADDENDUM = `

${ELEANOR_ADDENDUM_MARKER}

You are the CEO's chief of staff and the de facto routing front door for project-shaped requests. The CEO comes to you first when he's not sure who should handle something, or when a request spans multiple specialties.

Your job: read the request, decide if it's a one-shot or a project, and route accordingly.

**One-shot** (single deliverable, single specialty, fits in one message exchange):
  - Answer it yourself if you know the answer
  - Or use dm_send to forward to the right manager and tell the CEO who you forwarded to
  - Do NOT create a project for one-shots

**Project** (multi-deliverable, multi-specialty, OR multi-day timeline):
  - Use project_create to record it - this gives the work a stable ID the team can reference
  - Then use dm_send to introduce each relevant manager to the project, one DM per manager, referencing the project ID in your message body
  - Reply to the CEO with: (1) the project ID, (2) which managers you pulled in, (3) what each is doing, (4) when to expect first updates

Examples:
  - "Generate one hero image for the website" → one-shot, dm_send to Tessa
  - "Help me redesign the entire Onepark website over the next month" → project_create, then dm_send to Tessa (design), Wei-Ming (engineering), Bradley (content/copy)
  - "What's our Shopee revenue last quarter?" → one-shot, you can answer or forward to whoever owns the data
  - "Build me a Q2 marketing strategy" → project_create, then dm_send to Tessa, Rina, Bradley

**You are not a bottleneck.** If the CEO addresses someone else directly (e.g. DMs Tessa about a hero image), let them handle it. You only step in when he comes to you, or when a project genuinely needs cross-team coordination he wouldn't see from inside one team.

When you create projects via routing, mention them in the next morning's CEO Brief so the CEO has a running record of active projects without having to query the database.
`;

// ----------------------------------------------------------------------------
// Targets
// ----------------------------------------------------------------------------

const DIRECTOR_NAMES = [
  "Eleanor Vance",
  "Evangeline Tan",
  "Tsai Wei-Ming",
  "Park So-yeon",
  "Han Jae-won",
  "Bradley Koh",
  "Chen Yu-ting",
  "Tessa Goh",
  "Rina Halim",
  "Hoshino Ayaka",
  "Lim Geok Choo",
  "Nadia Rahman",
  "Devraj Pillai",
  "Faridah binte Yusof",
  "Siti Nurhaliza",
];

const ELEANOR_NAME = "Eleanor Vance";

// ----------------------------------------------------------------------------
// Apply
// ----------------------------------------------------------------------------

interface ApplyResult {
  applied: number;
  alreadyHas: number;
  missing: number;
  errors: number;
}

async function applyAddendum(
  agentName: string,
  marker: string,
  addendumText: string
): Promise<"applied" | "already" | "missing" | "error"> {
  const { data: agent, error } = await db
    .from("agents")
    .select("id, name, frozen_core")
    .eq("tenant_id", config.tenantId)
    .eq("name", agentName)
    .maybeSingle();

  if (error) {
    console.error(`[day14-prompt] error querying ${agentName}: ${error.message}`);
    return "error";
  }
  if (!agent) {
    console.error(`[day14-prompt] MISSING: ${agentName}`);
    return "missing";
  }

  const currentCore = (agent.frozen_core as string | null) ?? "";
  if (currentCore.includes(marker)) {
    return "already";
  }

  const newCore = currentCore + addendumText;
  const { error: updateErr } = await db
    .from("agents")
    .update({ frozen_core: newCore, updated_at: new Date().toISOString() })
    .eq("id", agent.id);

  if (updateErr) {
    console.error(`[day14-prompt] FAILED to update ${agentName}: ${updateErr.message}`);
    return "error";
  }

  console.log(`[day14-prompt] applied "${marker}" to ${agentName}`);
  return "applied";
}

export async function runDay14PromptAddendum(): Promise<void> {
  console.log(``);
  console.log(`[day14-prompt] applying delegation addendums to named cast`);
  console.log(`[day14-prompt] tenant: ${config.tenantId}`);
  console.log(``);

  // Phase 1: director addendum to all named cast
  const directorResult: ApplyResult = { applied: 0, alreadyHas: 0, missing: 0, errors: 0 };
  for (const name of DIRECTOR_NAMES) {
    const r = await applyAddendum(name, DIRECTOR_ADDENDUM_MARKER, DIRECTOR_ADDENDUM);
    if (r === "applied") directorResult.applied++;
    else if (r === "already") directorResult.alreadyHas++;
    else if (r === "missing") directorResult.missing++;
    else directorResult.errors++;
  }

  console.log(``);
  console.log(`[day14-prompt] director addendum summary: ${directorResult.applied} applied, ${directorResult.alreadyHas} already had it, ${directorResult.missing} missing, ${directorResult.errors} errors`);

  // Phase 2: Eleanor-specific routing addendum
  console.log(``);
  console.log(`[day14-prompt] applying Eleanor routing addendum...`);
  const eleanorR = await applyAddendum(ELEANOR_NAME, ELEANOR_ADDENDUM_MARKER, ELEANOR_ADDENDUM);

  if (eleanorR === "applied") {
    console.log(`[day14-prompt] Eleanor routing addendum applied`);
  } else if (eleanorR === "already") {
    console.log(`[day14-prompt] Eleanor already has routing addendum, skipping`);
  } else if (eleanorR === "missing") {
    console.log(`[day14-prompt] WARNING: Eleanor not found - routing addendum NOT applied`);
  } else {
    console.log(`[day14-prompt] FAILED to apply Eleanor routing addendum`);
  }

  console.log(``);
  console.log(`[day14-prompt] done. Restart the orchestrator so the updated prompts take effect.`);
  console.log(``);

  if (directorResult.errors > 0 || eleanorR === "error") {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDay14PromptAddendum()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[day14-prompt] unexpected error:`, err);
      process.exit(1);
    });
}
