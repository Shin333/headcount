// ----------------------------------------------------------------------------
// seed/day18-prompt-addendum.ts - teach agents to use commitment_create
// ----------------------------------------------------------------------------
// Run with:
//   pnpm tsx src/seed/day18-prompt-addendum.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

const ADDENDUM_MARKER = "# Commitments (Day 18)";

const ADDENDUM_TEXT = `

${ADDENDUM_MARKER}

**MANDATORY RULE:** Every time you say you will deliver something — "I'll generate the portraits," "posting the spec now," "writing the bios," "will have this done shortly" — you MUST call **commitment_create** BEFORE you start the work. This is not optional. If you promise a deliverable without logging a commitment, you are breaking protocol.

**You are an AI agent. Your work takes MINUTES, not hours.**
- 5 minutes: simple tasks (status update, single artifact, one image)
- 10 minutes: medium tasks (writing a spec, generating a batch of 3-5 images)
- 15 minutes: complex tasks (writing 18 bios, generating 18 portraits, full architecture plan)
- NEVER set a deadline longer than 30 minutes. If you think a task takes longer than 30 minutes, break it into sub-tasks.

**What happens when you log a commitment:**
- The commitment appears in your context on future turns as a reminder
- If the deadline passes without you producing the deliverable, the system will nudge you automatically
- When you create an artifact, your oldest pending commitment auto-resolves
- After 3 nudges without delivery, the commitment is escalated to the CEO

**Rules:**
1. Every promise gets a commitment_create call BEFORE you start work. No exceptions.
2. When nudged on an overdue commitment, PRODUCE THE DELIVERABLE IMMEDIATELY. Do not write a status update.
3. If you're genuinely blocked, say the specific blocker in one sentence and respond with SKIP.
4. Do not discuss work. Do the work. Status updates without deliverables are worthless.

**Examples:**
- "Generating 18 portraits" → commitment_create(description="Generate all 18 agent portraits using imagen_generate", deadline_minutes=15)
- "Writing the card spec" → commitment_create(description="Post card component spec artifact", deadline_minutes=10)
- "Posting a status update" → Don't log this — status updates aren't deliverables.
`;

const NAMED_CAST = [
  "Eleanor Vance", "Evangeline Tan", "Tsai Wei-Ming", "Park So-yeon",
  "Han Jae-won", "Bradley Koh", "Chen Yu-ting", "Tessa Goh",
  "Rina Halim", "Hoshino Ayaka", "Lim Geok Choo", "Nadia Rahman",
  "Devraj Pillai", "Faridah binte Yusof", "Siti Nurhaliza",
  "Michelle Pereira", "Faizal Harun", "Ong Kai Xiang",
  "Heng Kok Wei", "Choi Seung-hyun",
];

async function applyAddendum(name: string): Promise<string> {
  const { data: agent, error } = await db
    .from("agents")
    .select("id, frozen_core")
    .eq("tenant_id", config.tenantId)
    .eq("name", name)
    .maybeSingle();

  if (error) return "error";
  if (!agent) return "missing";

  const core = (agent.frozen_core as string | null) ?? "";
  if (core.includes(ADDENDUM_MARKER)) return "already";

  const { error: updateErr } = await db
    .from("agents")
    .update({ frozen_core: core + ADDENDUM_TEXT, updated_at: new Date().toISOString() })
    .eq("id", agent.id);

  if (updateErr) return "error";
  console.log(`  [APPLIED] ${name}`);
  return "applied";
}

async function main(): Promise<void> {
  console.log("");
  console.log(`[day18-prompt] applying "commitments" addendum`);
  console.log(`[day18-prompt] tenant: ${config.tenantId}`);
  console.log("");

  const counts = { applied: 0, already: 0, missing: 0, error: 0 };
  for (const name of NAMED_CAST) {
    const r = await applyAddendum(name);
    counts[r as keyof typeof counts]++;
  }

  console.log("");
  console.log(`[day18-prompt] summary: ${counts.applied} applied, ${counts.already} already, ${counts.missing} missing, ${counts.error} errors`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
