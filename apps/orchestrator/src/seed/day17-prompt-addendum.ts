// ----------------------------------------------------------------------------
// seed/day17-prompt-addendum.ts - teach agents to use project channels
// ----------------------------------------------------------------------------
// Day 17 introduces project channels ("meeting rooms"). Agents need to know
// when to use project_post (shared channel) vs dm_send (private 1:1).
//
// The rule is simple:
//   - If it's project work that the team needs to see → project_post
//   - If it's private or only relevant to one person → dm_send
//
// Run with:
//   pnpm tsx src/seed/day17-prompt-addendum.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

const ADDENDUM_MARKER = "# Project channels (Day 17)";

const ADDENDUM_TEXT = `

${ADDENDUM_MARKER}

When you're working on a project, you now have access to a **shared project channel** — think of it as a meeting room where every team member can hear every message.

Use **project_post** when:
- Sharing a deliverable or artifact you've created ("Design direction is done, artifact at workspace/marketing/...")
- Posting a status update ("Architecture plan is approved, starting repo scaffold")
- Asking a question the team needs to discuss ("Should /work be evaluator-only or dual-audience?")
- Flagging a blocker or dependency ("I need Tessa's color tokens before I can build the component library")
- Responding to something another team member posted in the channel

Use **dm_send** when:
- Having a private 1:1 conversation (personnel issues, sensitive feedback)
- Sending something only one specific person needs to see
- Following up on a private thread that doesn't need the whole team

**Default to project_post for project work.** If you're unsure whether something belongs in the channel or a DM, put it in the channel. Visibility is better than privacy for project coordination — other team members might have context you don't know about.

When you create an artifact while working on a project, it will automatically be announced in the project channel. You don't need to manually post about it — but you should add context ("here's what I decided and why") rather than just letting the auto-announcement speak for itself.

The project channel history will be visible in your context when you're responding to channel messages. You can see what everyone else has been saying and what artifacts have been created. Use this to stay aligned — if someone posted something that affects your work, react to it without waiting to be asked.
`;

const NAMED_CAST = [
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
  "Michelle Pereira",
  "Faizal Harun",
  "Ong Kai Xiang",
  "Heng Kok Wei",
  "Choi Seung-hyun",
];

async function applyAddendum(
  agentName: string
): Promise<"applied" | "already" | "missing" | "error"> {
  const { data: agent, error } = await db
    .from("agents")
    .select("id, frozen_core")
    .eq("tenant_id", config.tenantId)
    .eq("name", agentName)
    .maybeSingle();

  if (error) {
    console.error(`  [ERROR] ${agentName}: ${error.message}`);
    return "error";
  }
  if (!agent) {
    console.warn(`  [MISSING] ${agentName}`);
    return "missing";
  }

  const currentCore = (agent.frozen_core as string | null) ?? "";
  if (currentCore.includes(ADDENDUM_MARKER)) {
    return "already";
  }

  const newCore = currentCore + ADDENDUM_TEXT;
  const { error: updateErr } = await db
    .from("agents")
    .update({ frozen_core: newCore, updated_at: new Date().toISOString() })
    .eq("id", agent.id);

  if (updateErr) {
    console.error(`  [ERROR] ${agentName}: ${updateErr.message}`);
    return "error";
  }

  console.log(`  [APPLIED] ${agentName}`);
  return "applied";
}

export async function runDay17PromptAddendum(): Promise<void> {
  console.log("");
  console.log(`[day17-prompt] applying "project channels" addendum`);
  console.log(`[day17-prompt] tenant: ${config.tenantId}`);
  console.log("");

  let applied = 0;
  let already = 0;
  let missing = 0;
  let errors = 0;

  for (const name of NAMED_CAST) {
    const r = await applyAddendum(name);
    if (r === "applied") applied++;
    else if (r === "already") already++;
    else if (r === "missing") missing++;
    else errors++;
  }

  console.log("");
  console.log(
    `[day17-prompt] summary: ${applied} applied, ${already} already, ${missing} missing, ${errors} errors`
  );
  console.log("");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDay17PromptAddendum()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[day17-prompt] unexpected error:`, err);
      process.exit(1);
    });
}
