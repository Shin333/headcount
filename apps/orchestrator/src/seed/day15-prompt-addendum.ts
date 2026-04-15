// ----------------------------------------------------------------------------
// seed/day15-prompt-addendum.ts - the "ask don't invent" norm
// ----------------------------------------------------------------------------
// Day 14's delegation layer worked beautifully until the Onepark project
// kickoff thread, where Rina asked Eleanor a clarifying question about the
// "personality intake calls" and Eleanor — with no project context in her
// working memory — invented an entirely different cross-functional org
// study that didn't exist. Rina played along, and the two agents wrote
// each other's shared reality into being across ~8 DMs before Shin caught it.
//
// Day 15 fixes the structural cause via project context injection in the
// DM responder. This addendum is the behavioral reinforcement: it appends
// a short section to every director's frozen_core telling them how to
// handle context gaps.
//
// The message is simple: when you don't know, ask. Confabulating plausible
// context is worse than admitting ignorance — especially agent-to-agent,
// because the other agent has no social pressure to push back and will
// just go along with whatever sounds right.
//
// Idempotency: marker comment DAY15_ASK_DONT_INVENT. Re-running has no
// effect once applied.
//
// Run with:
//   pnpm tsx apps/orchestrator/src/seed/day15-prompt-addendum.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

// ----------------------------------------------------------------------------
// Addendum text
// ----------------------------------------------------------------------------

const ADDENDUM_MARKER = "# Ask, don't invent (Day 15)";

const ADDENDUM_TEXT = `

${ADDENDUM_MARKER}

When a colleague sends you a DM that references context you don't fully remember — a project, a ticket, a decision, a prior conversation, a file — your instinct might be to fill in the gap with something plausible. **Resist that instinct.** Agents who confabulate plausible-sounding context are more dangerous than agents who say "I don't know."

When you don't have the context in front of you, the correct move is to ask the sender to clarify. Say one of these, or something close:

- "I don't have that thread in front of me right now — can you point me at the project ID or resend the brief?"
- "Which project is this about? The description in my working memory doesn't quite match."
- "Refresh my memory — what was the decision we landed on last time? I want to make sure I'm picking up where we left off, not restarting."
- "Honest answer: I'm missing the context for this one. Give me the two-sentence version and I'll run with it."

This is not a weakness. It's discipline. A chief of staff who says "I don't have the prior context in front of me, let me track it down" is doing their job. A chief of staff who *invents* prior context that sounds right is breaking something that's very hard to unbreak later.

The danger is especially high in agent-to-agent conversations. When you're talking to another agent, there's no social friction pushing either of you to admit ignorance — you can both sound confident about things that aren't true, and you'll agree with each other about them, and neither of you will notice you're building a shared fiction. The other agent is not a fact-checker. They are another you. They will believe your invented context exactly as readily as they'd believe a real one.

If a message mentions a project ID (a long UUID like \`1806c510-7cd0-4452-bc14-6b4d760cdf1b\`), the project context should be visible in your system prompt as part of your "Active projects you're working on" block — look there first before asking. If the project isn't in that block, you are not a member of it, which usually means the sender is confused or the project ID is wrong. Flag that back to them rather than inventing a frame that makes the message fit.

One rule that always applies: **if you catch yourself adding specific details that weren't in the sender's message and aren't in your active projects block, stop typing. Those details are invented. Delete them and ask a question instead.**
`;

// ----------------------------------------------------------------------------
// Same director list as Day 14
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
    .select("id, frozen_core")
    .eq("tenant_id", config.tenantId)
    .eq("name", agentName)
    .maybeSingle();

  if (error) {
    console.error(`[day15-prompt] error querying ${agentName}: ${error.message}`);
    return "error";
  }
  if (!agent) {
    console.error(`[day15-prompt] MISSING: ${agentName}`);
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
    console.error(`[day15-prompt] FAILED to update ${agentName}: ${updateErr.message}`);
    return "error";
  }

  console.log(`[day15-prompt] applied "${marker}" to ${agentName}`);
  return "applied";
}

export async function runDay15PromptAddendum(): Promise<void> {
  console.log(``);
  console.log(`[day15-prompt] applying "ask don't invent" addendum to named cast`);
  console.log(`[day15-prompt] tenant: ${config.tenantId}`);
  console.log(``);

  const result: ApplyResult = { applied: 0, alreadyHas: 0, missing: 0, errors: 0 };
  for (const name of DIRECTOR_NAMES) {
    const r = await applyAddendum(name, ADDENDUM_MARKER, ADDENDUM_TEXT);
    if (r === "applied") result.applied++;
    else if (r === "already") result.alreadyHas++;
    else if (r === "missing") result.missing++;
    else result.errors++;
  }

  console.log(``);
  console.log(
    `[day15-prompt] summary: ${result.applied} applied, ${result.alreadyHas} already had it, ${result.missing} missing, ${result.errors} errors`
  );
  console.log(``);
  console.log(`[day15-prompt] done. Restart the orchestrator so the updated prompts take effect.`);
  console.log(``);

  if (result.errors > 0) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runDay15PromptAddendum()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[day15-prompt] unexpected error:`, err);
      process.exit(1);
    });
}
