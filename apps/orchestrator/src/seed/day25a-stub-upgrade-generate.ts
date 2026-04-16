// ============================================================================
// seed/day25a-stub-upgrade-generate.ts
// ----------------------------------------------------------------------------
// Wave E of the bio-audit follow-through: upgrade the ~75 dormant specialists
// whose personality.voiceExamples is empty and whose background is a
// template stub ("Name — archetype. Assigned to X, reports to Y.").
//
// Stage 1 of a two-stage process:
//   1. GENERATE (this script): call Claude Sonnet per agent with their
//      archetype + role + tier + Big5 + quirks + dept. Ask for 3 voice
//      examples and a 2-paragraph background. Write proposals to
//      workspace/audits/stub-upgrades-proposed.json.
//   2. APPLY (day25b): read the JSON, update DB. Human-editable step in
//      between — you can open the JSON, reject/rewrite any proposal, then
//      apply.
//
// Eligibility filter:
//   - is_human = false
//   - (voiceExamples.length < 3 OR length(background) < 200)
//   - status IN ('active', 'paused', 'terminated') — not limiting to active
//     because dormant specialists are often 'active' status but never fire
//
// Cost: ~$0.015 / agent × 75 ≈ $1.15 total. Sonnet 4.6.
//
// Run modes:
//   pnpm exec tsx src/seed/day25a-stub-upgrade-generate.ts --sample 5
//     Generates proposals for 5 random eligible agents (sanity check)
//   pnpm exec tsx src/seed/day25a-stub-upgrade-generate.ts
//     Generates proposals for ALL eligible agents
// ============================================================================

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";
import { anthropic } from "../claude.js";

const SAMPLE_ARG = process.argv.find((a) => a.startsWith("--sample"));
const SAMPLE_N = SAMPLE_ARG ? parseInt(SAMPLE_ARG.replace("--sample", "").replace("=", "").trim() || "0", 10) : 0;
const OUTPUT_PATH = path.join(
  process.cwd(),
  "..",
  "..",
  "workspace",
  "audits",
  "stub-upgrades-proposed.json"
);

interface AgentRow {
  id: string;
  name: string;
  role: string;
  tier: string;
  department: string | null;
  background: string | null;
  personality: {
    archetype?: string;
    quirks?: string[];
    voiceExamples?: string[];
    big5?: {
      openness: number;
      conscientiousness: number;
      extraversion: number;
      agreeableness: number;
      neuroticism: number;
    };
  } | null;
}

interface Proposal {
  agent_id: string;
  name: string;
  role: string;
  tier: string;
  needs_voice: boolean;
  needs_background: boolean;
  voice_examples?: string[];
  background?: string;
  cost_usd: number;
}

// ----------------------------------------------------------------------------
// Prompt builder
// ----------------------------------------------------------------------------

function buildUserPrompt(agent: AgentRow, needsVoice: boolean, needsBackground: boolean): string {
  const p = agent.personality ?? {};
  const big5 = p.big5 ?? { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 };
  const quirks = (p.quirks ?? []).join(" • ");

  const lines = [
    `You are writing character detail for an AI agent in a simulated Singaporean / Southeast-Asian digital agency called Onepark Digital. The CEO reads these bios; they must feel like a specific person, not a generic role card.`,
    ``,
    `Agent:`,
    `  Name: ${agent.name}`,
    `  Role: ${agent.role}`,
    `  Tier: ${agent.tier}`,
    `  Department: ${agent.department ?? "(none)"}`,
    `  Archetype: ${p.archetype ?? "(none)"}`,
    `  Quirks: ${quirks || "(none)"}`,
    `  Big-5: O=${big5.openness} C=${big5.conscientiousness} E=${big5.extraversion} A=${big5.agreeableness} N=${big5.neuroticism}`,
    `  Existing background (if any): ${agent.background?.trim() || "(empty)"}`,
    ``,
    `Exemplars — THIS is the quality bar:`,
    ``,
    `Bradley Koh (CRO) voice examples:`,
    `  - "closing motion on the Halim account got weird today. they went quiet after i sent the MSA red-lines. yu-ting, can you do a temperature check with procurement? you have a better read on them than i do"`,
    `  - "i overpromised on delivery timelines in my last email to Linear. yu-ting flagged it. she's right. i'm going back to soften the timeline before they hold us to it"`,
    ``,
    `Uncle Tan (Watercooler, all 100% tic and texture) background:`,
    `  "Used to drive a taxi in the '90s before pivoting to 'consulting' which is how he describes owning two minibuses and a karaoke lounge in Geylang. Claims to have met Lee Kuan Yew once in a coffee shop in 1987, story changes each telling. Now semi-retired, hangs around the office 'to give the young people wisdom.' His actual job description was never written; HR gave up."`,
    ``,
    `Your task: produce`,
    needsVoice ? `  - voice_examples: 3 distinct voice samples (one-liners or 2-3 sentences each) showing different situations` : null,
    needsBackground ? `  - background: 1-2 paragraphs adding history + stakes + texture (where they grew up / studied, what they did before Onepark, one personal detail that's specific not generic)` : null,
    ``,
    `Rules:`,
    `  - Voice must reflect archetype + quirks + Big-5 concretely. High-extraversion = they jump in. High-conscientiousness = they notice the thing everyone else missed. High-neuroticism = they anticipate the break.`,
    `  - Voice samples are DM-shaped or chat-shaped. Not dialogue scripts, not self-descriptions.`,
    `  - Use lowercase-first informal register ONLY for agents whose archetype explicitly implies that register (rina-halim type, some engineers). Default is sentence case.`,
    `  - Background may reference Singaporean / SEA cultural detail when the agent's name fits (schools, neighborhoods, ex-employers). For non-SEA names, use appropriate cultural context.`,
    `  - DO NOT describe the agent in third person in voice examples. DO write "yu-ting flagged it" style inter-agent references where natural.`,
    `  - DO NOT write essays. Voice examples should be 40-200 chars each. Background 300-600 chars total.`,
    ``,
    `Return ONLY this JSON, nothing else (no markdown fences, no preamble):`,
    `{`,
    needsVoice ? `  "voice_examples": ["...", "...", "..."],` : null,
    needsBackground ? `  "background": "..."` : null,
    `}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  return lines;
}

// ----------------------------------------------------------------------------
// Claude call
// ----------------------------------------------------------------------------

const COST_INPUT_PER_M = 3.0; // sonnet-4-6 fresh input
const COST_OUTPUT_PER_M = 15.0;

async function generateForAgent(agent: AgentRow): Promise<Proposal> {
  const existingVoice = agent.personality?.voiceExamples ?? [];
  const existingBackground = agent.background?.trim() ?? "";
  const needsVoice = existingVoice.length < 3;
  const needsBackground = existingBackground.length < 200;

  const base: Proposal = {
    agent_id: agent.id,
    name: agent.name,
    role: agent.role,
    tier: agent.tier,
    needs_voice: needsVoice,
    needs_background: needsBackground,
    cost_usd: 0,
  };

  if (!needsVoice && !needsBackground) {
    return base;
  }

  const prompt = buildUserPrompt(agent, needsVoice, needsBackground);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;
  const cost = (inputTokens / 1_000_000) * COST_INPUT_PER_M + (outputTokens / 1_000_000) * COST_OUTPUT_PER_M;

  // Strip any accidental ``` fences or preamble
  let cleaned = text;
  const fenceMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1]!;
  const braceStart = cleaned.indexOf("{");
  const braceEnd = cleaned.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    cleaned = cleaned.slice(braceStart, braceEnd + 1);
  }

  let parsed: { voice_examples?: string[]; background?: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.warn(`  ! ${agent.name}: failed to parse JSON response. Raw text saved to proposal for manual edit.`);
    return { ...base, voice_examples: needsVoice ? [`PARSE_FAIL — raw:`, text.slice(0, 500)] : undefined, background: needsBackground ? `PARSE_FAIL — raw: ${text.slice(0, 800)}` : undefined, cost_usd: cost };
  }

  return {
    ...base,
    voice_examples: needsVoice ? parsed.voice_examples : undefined,
    background: needsBackground ? parsed.background : undefined,
    cost_usd: cost,
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  console.log("=== Day 25a — generating voice + background proposals ===\n");

  const { data: agents, error } = await db
    .from("agents")
    .select("id, name, role, tier, department, background, personality")
    .eq("tenant_id", config.tenantId)
    .eq("is_human", false)
    .order("name", { ascending: true });

  if (error) {
    console.error(`query failed: ${error.message}`);
    process.exit(1);
  }
  if (!agents) {
    console.error("no agents returned");
    process.exit(1);
  }

  const eligible: AgentRow[] = [];
  for (const a of agents as AgentRow[]) {
    const voice = a.personality?.voiceExamples ?? [];
    const bg = a.background?.trim() ?? "";
    if (voice.length < 3 || bg.length < 200) {
      eligible.push(a);
    }
  }

  let targets = eligible;
  if (SAMPLE_N > 0 && SAMPLE_N < eligible.length) {
    const shuffled = [...eligible].sort(() => Math.random() - 0.5);
    targets = shuffled.slice(0, SAMPLE_N);
    console.log(`--sample ${SAMPLE_N}: running on random subset of ${eligible.length} eligible agents.\n`);
  } else {
    console.log(`${eligible.length} eligible agents of ${agents.length} total.\n`);
  }

  const proposals: Proposal[] = [];
  let totalCost = 0;
  let i = 0;
  for (const a of targets) {
    i++;
    process.stdout.write(`  [${i}/${targets.length}] ${a.name} (${a.role}, ${a.tier})... `);
    try {
      const p = await generateForAgent(a);
      proposals.push(p);
      totalCost += p.cost_usd;
      const bits: string[] = [];
      if (p.voice_examples) bits.push(`${p.voice_examples.length} voice`);
      if (p.background) bits.push("bg");
      if (bits.length === 0) bits.push("SKIP (has both)");
      console.log(`${bits.join(" + ")} ($${p.cost_usd.toFixed(4)})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAIL — ${msg}`);
    }
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify({ generated_at: new Date().toISOString(), proposals }, null, 2));

  console.log(`\nWrote ${proposals.length} proposals to ${OUTPUT_PATH}`);
  console.log(`Total cost: $${totalCost.toFixed(3)}`);
  console.log(`\nNext: review workspace/audits/stub-upgrades-proposed.json, edit any proposals,`);
  console.log(`then run: pnpm exec tsx src/seed/day25b-stub-upgrade-apply.ts`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
