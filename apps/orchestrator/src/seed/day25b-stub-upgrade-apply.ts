// ============================================================================
// seed/day25b-stub-upgrade-apply.ts
// ----------------------------------------------------------------------------
// Stage 2 of the stub-upgrade: read proposals from workspace JSON and apply
// to DB. Idempotent — skips agents whose current state already exceeds the
// proposal threshold (e.g. voice already populated by a manual edit).
//
// Workflow:
//   1. Run day25a to generate proposals
//   2. Open workspace/audits/stub-upgrades-proposed.json, edit anything
//      that reads poorly, delete proposals you don't want applied
//   3. Run this script (with --dry-run first to preview) to apply
//
// Run with:
//   pnpm exec tsx src/seed/day25b-stub-upgrade-apply.ts --dry-run
//   pnpm exec tsx src/seed/day25b-stub-upgrade-apply.ts
// ============================================================================

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";

const DRY = process.argv.includes("--dry-run");
const INPUT_PATH = path.join(
  process.cwd(),
  "..",
  "..",
  "workspace",
  "audits",
  "stub-upgrades-proposed.json"
);

interface Proposal {
  agent_id: string;
  name: string;
  role: string;
  tier: string;
  voice_examples?: string[];
  background?: string;
}

async function main() {
  if (DRY) console.log("DRY RUN — no writes.\n");
  console.log("=== Day 25b — applying stub upgrades from proposals JSON ===\n");

  let raw: string;
  try {
    raw = await readFile(INPUT_PATH, "utf8");
  } catch (err) {
    console.error(`Could not read ${INPUT_PATH}. Run day25a first.`);
    console.error(err);
    process.exit(1);
  }
  const doc = JSON.parse(raw) as { proposals: Proposal[] };
  const proposals = doc.proposals ?? [];

  console.log(`${proposals.length} proposals to consider.\n`);

  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const p of proposals) {
    const { data: agent, error } = await db
      .from("agents")
      .select("id, name, background, personality")
      .eq("id", p.agent_id)
      .eq("tenant_id", config.tenantId)
      .maybeSingle();

    if (error) {
      console.log(`  ! ${p.name}: query failed — ${error.message}`);
      continue;
    }
    if (!agent) {
      console.log(`  ! ${p.name}: not found`);
      missing++;
      continue;
    }

    const existingVoice = (agent.personality as { voiceExamples?: string[] } | null)?.voiceExamples ?? [];
    const existingBackground = (agent.background ?? "").trim();

    const updates: Record<string, unknown> = {};
    const notes: string[] = [];

    if (p.voice_examples && p.voice_examples.length > 0 && existingVoice.length < 3) {
      const personality = (agent.personality ?? {}) as Record<string, unknown>;
      const nextPersonality = { ...personality, voiceExamples: p.voice_examples };
      updates.personality = nextPersonality;
      notes.push(`voice(${p.voice_examples.length})`);
    }
    if (p.background && p.background.length >= 100 && existingBackground.length < 200) {
      updates.background = p.background;
      notes.push(`bg(${p.background.length})`);
    }

    if (Object.keys(updates).length === 0) {
      console.log(`  - ${p.name}: already has content, skipping`);
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`  [DRY] ${p.name}: would apply ${notes.join(" + ")}`);
      updated++;
      continue;
    }

    updates.updated_at = new Date().toISOString();
    const { error: uErr } = await db.from("agents").update(updates).eq("id", agent.id);
    if (uErr) {
      console.log(`  ! ${p.name}: update failed — ${uErr.message}`);
      continue;
    }
    console.log(`  + ${p.name}: applied ${notes.join(" + ")}`);
    updated++;
  }

  console.log(`\nSummary: ${updated} updated, ${skipped} skipped, ${missing} not found.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
