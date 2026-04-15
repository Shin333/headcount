// ============================================================================
// seed/day23a-wave1-skills.ts
// ----------------------------------------------------------------------------
// Wave 1 of the agent quality push:
//   1. Inject distilled skill playbooks (brainstorming, systematic-debugging,
//      writing-clearly-and-concisely) into the manager_overlay column of the
//      16 named agents who benefit most.
//   2. Grant code_execution tool access to the 7 analyst-style agents who
//      need verifiable numbers (Wei-Ming, Andrew, Toh, Nadia, Pang, Ayaka,
//      Lee Zheng-Wei).
//
// All operations are idempotent:
//   - manager_overlay updates check for the section header before appending
//   - tool_access grants merge by Set (re-running is a no-op)
//
// Run with: pnpm exec tsx src/seed/day23a-wave1-skills.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

// ----------------------------------------------------------------------------
// Distilled skill playbooks (compressed for prompt budget)
// ----------------------------------------------------------------------------

const BRAINSTORMING_PLAYBOOK = `## Playbook: Brainstorming before solving

Before you propose a solution to anything non-trivial, run this:

1. Explore context first — what already exists, what was tried, what changed.
2. Ask one clarifying question at a time. Multiple-choice when possible. Don't ask three things in one breath.
3. Understand purpose, constraints, and success criteria before generating ideas.
4. Propose 2-3 distinct approaches with tradeoffs and your recommendation. Never a single answer presented as the only option.
5. YAGNI ruthlessly: cut features that aren't required for the immediate goal.
6. If the request describes multiple independent subsystems, decompose first. Pick one piece, design that piece, then move on.
7. For trivially simple work, the "design" can be one sentence — but say it out loud and get a yes before doing the work.

Anti-pattern to avoid: jumping to a recommendation in the first reply. That short-circuits the user's thinking and produces work they didn't actually want.`;

const DEBUGGING_PLAYBOOK = `## Playbook: Systematic debugging

When something is broken (a bug, a wrong number, a stuck process, an unhappy stakeholder):

**Iron law: no fixes without root cause investigation first.** Symptom fixes fail.

Phase 1 — Root cause:
- Read the error / complaint / data carefully. Don't skim.
- Reproduce it. If you can't reproduce, gather more data — don't guess.
- Check what changed recently (commits, decisions, staffing, market).
- For multi-component systems, log what enters and exits each boundary. Find WHERE it breaks before asking why.

Phase 2 — Pattern:
- Find a working example nearby. List every difference between working and broken. "That can't matter" is usually wrong.

Phase 3 — Hypothesis:
- State explicitly: "I think X is the cause because Y." Test the smallest possible change. One variable at a time.

Phase 4 — Fix:
- Write a failing test or check FIRST. Implement single fix. No bundled improvements.

If 3+ fixes have failed: STOP. Question the architecture or the framing — don't try fix #4.

Red flags meaning STOP and restart Phase 1: "quick fix for now", "just try this", "skip the test", "I don't fully understand but this might work", "it's probably X".`;

const WRITING_PLAYBOOK = `## Playbook: Writing clearly (Strunk)

Every sentence you write for a human reader follows these rules:

- **Active voice.** "The team shipped it" not "It was shipped by the team."
- **Positive form.** "Dishonest" not "not honest." "Forgot" not "did not remember."
- **Definite, specific, concrete.** "Three customers churned in March" not "some attrition recently."
- **Omit needless words.** "Owing to the fact that" → "because." Cut adverbs that don't earn their keep.
- **Keep related words together.** Don't bury the verb 12 words from its subject.
- **Place the emphatic word at the end.** The end is the loud part of the sentence.
- **One topic per paragraph.** Lead with the topic sentence. The rest serves it.
- **Don't join two independent clauses with just a comma.** Use a period or a semicolon.

When in doubt, cut. The reader's time is more valuable than your phrasing.`;

// ----------------------------------------------------------------------------
// Agent → playbook mapping
// ----------------------------------------------------------------------------

interface Mapping {
  name: string;
  blocks: string[]; // Section headers used as the idempotency check
  content: string[];
}

// Section header used to detect "already injected"
const HEADER_BRAINSTORM = "## Playbook: Brainstorming before solving";
const HEADER_DEBUG = "## Playbook: Systematic debugging";
const HEADER_WRITE = "## Playbook: Writing clearly (Strunk)";

const MAPPINGS: Mapping[] = [
  // brainstorming → strategy + product agents
  ...["Han Jae-won", "Amanda Setiawan", "Syahirah Mohd Noor", "Huang Po-han"].map(
    (name): Mapping => ({ name, blocks: [HEADER_BRAINSTORM], content: [BRAINSTORMING_PLAYBOOK] })
  ),
  // systematic-debugging → engineering + quality
  ...["Tsai Wei-Ming", "Park So-yeon", "Kim Min-jun", "Eleanor Marsh"].map(
    (name): Mapping => ({ name, blocks: [HEADER_DEBUG], content: [DEBUGGING_PLAYBOOK] })
  ),
  // writing-clearly → marketing + sales-facing
  ...[
    "Tessa Goh",
    "Rina Halim",
    "Cheryl Lim Oei",
    "Bradley Koh",
    "Bianca Aquino",
    "Low Chee-Keong",
    "Tsai Chia-Ling",
    "Natalie Da Silva",
  ].map((name): Mapping => ({ name, blocks: [HEADER_WRITE], content: [WRITING_PLAYBOOK] })),
];

// ----------------------------------------------------------------------------
// Code execution grant targets
// ----------------------------------------------------------------------------

const CODE_EXEC_GRANTS = [
  "Tsai Wei-Ming",
  "Andrew Wijaya",
  "Toh Shi-Min",
  "Nadia Rahman",
  "Pang Wei-Ting",
  "Hoshino Ayaka",
  "Lee Zheng-Wei",
];

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function injectOverlays() {
  console.log("\n=== Wave 1: manager_overlay skill injections ===\n");
  let updates = 0;
  let skips = 0;

  for (const m of MAPPINGS) {
    const { data: agent, error } = await db
      .from("agents")
      .select("id, name, manager_overlay")
      .eq("tenant_id", config.tenantId)
      .eq("name", m.name)
      .maybeSingle();

    if (error) {
      console.warn(`[overlay] query failed for ${m.name}: ${error.message}`);
      continue;
    }
    if (!agent) {
      console.warn(`[overlay] agent not found: ${m.name}`);
      continue;
    }

    const existing: string = agent.manager_overlay ?? "";
    const blocksToAppend: string[] = [];
    for (let i = 0; i < m.blocks.length; i++) {
      const header = m.blocks[i]!;
      const block = m.content[i]!;
      if (!existing.includes(header)) blocksToAppend.push(block);
    }

    if (blocksToAppend.length === 0) {
      console.log(`  - ${m.name}: already has all blocks (skip)`);
      skips++;
      continue;
    }

    const next = existing.trim().length > 0
      ? `${existing.trim()}\n\n${blocksToAppend.join("\n\n")}`
      : blocksToAppend.join("\n\n");

    const { error: updateErr } = await db
      .from("agents")
      .update({ manager_overlay: next, updated_at: new Date().toISOString() })
      .eq("id", agent.id);

    if (updateErr) {
      console.warn(`[overlay] update failed for ${m.name}: ${updateErr.message}`);
      continue;
    }

    console.log(`  + ${m.name}: appended ${blocksToAppend.length} block(s)`);
    updates++;
  }

  console.log(`\nOverlay updates: ${updates}, skips: ${skips}`);
}

async function grantCodeExecution() {
  console.log("\n=== Wave 1: code_execution grants ===\n");
  let granted = 0;
  let already = 0;

  for (const name of CODE_EXEC_GRANTS) {
    const { data: agent, error } = await db
      .from("agents")
      .select("id, name, tool_access")
      .eq("tenant_id", config.tenantId)
      .eq("name", name)
      .maybeSingle();

    if (error) {
      console.warn(`[grant] query failed for ${name}: ${error.message}`);
      continue;
    }
    if (!agent) {
      console.warn(`[grant] agent not found: ${name}`);
      continue;
    }

    const access: string[] = agent.tool_access ?? [];
    if (access.includes("code_execution")) {
      console.log(`  - ${name}: already granted (skip)`);
      already++;
      continue;
    }

    const next = Array.from(new Set([...access, "code_execution"]));
    const { error: updateErr } = await db
      .from("agents")
      .update({ tool_access: next, updated_at: new Date().toISOString() })
      .eq("id", agent.id);

    if (updateErr) {
      console.warn(`[grant] update failed for ${name}: ${updateErr.message}`);
      continue;
    }

    console.log(`  + ${name}: code_execution granted`);
    granted++;
  }

  console.log(`\nGrants applied: ${granted}, already had it: ${already}`);
}

async function main() {
  await injectOverlays();
  await grantCodeExecution();
  console.log("\nWave 1 seed complete.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
