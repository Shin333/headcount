import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db.js";
import { config } from "./config.js";
import { COST_PER_M_TOKENS } from "@headcount/shared";
import type { Agent, ModelTier } from "@headcount/shared";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MODEL_NAMES: Record<ModelTier, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
};

export interface RunOptions {
  agent: Agent;
  userPrompt: string;
  // If set, override the agent's normal model tier (e.g. chatter always uses haiku)
  forceTier?: ModelTier;
  maxTokens?: number;
  // Logical context for the audit trail
  context: string;
}

export interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  durationMs: number;
  tier: ModelTier;
  skipped?: "budget_exceeded" | "agent_paused";
}

// ----------------------------------------------------------------------------
// Wall-hour cost cap
// ----------------------------------------------------------------------------

function currentWallHour(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

async function getWallHourSpend(): Promise<number> {
  const hour = currentWallHour();
  const { data } = await db
    .from("wall_token_spend")
    .select("estimated_cost_usd")
    .eq("tenant_id", config.tenantId)
    .eq("wall_hour", hour)
    .maybeSingle();
  return Number(data?.estimated_cost_usd ?? 0);
}

async function recordSpend(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  costUsd: number
): Promise<void> {
  const hour = currentWallHour();
  const { data: existing } = await db
    .from("wall_token_spend")
    .select("id, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, call_count")
    .eq("tenant_id", config.tenantId)
    .eq("wall_hour", hour)
    .maybeSingle();

  if (existing) {
    await db
      .from("wall_token_spend")
      .update({
        input_tokens: Number(existing.input_tokens) + inputTokens,
        output_tokens: Number(existing.output_tokens) + outputTokens,
        cached_input_tokens: Number(existing.cached_input_tokens) + cachedInputTokens,
        estimated_cost_usd: Number(existing.estimated_cost_usd) + costUsd,
        call_count: existing.call_count + 1,
      })
      .eq("id", existing.id);
  } else {
    await db.from("wall_token_spend").insert({
      tenant_id: config.tenantId,
      wall_hour: hour,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_input_tokens: cachedInputTokens,
      estimated_cost_usd: costUsd,
      call_count: 1,
    });
  }
}

export async function isOverHourlyCap(): Promise<boolean> {
  const spend = await getWallHourSpend();
  return spend >= config.hourlyCostCapUsd;
}

// ----------------------------------------------------------------------------
// Cost calculation (assumes Anthropic returns cached vs uncached tokens)
// ----------------------------------------------------------------------------

function calcCost(
  tier: ModelTier,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number {
  const rates = COST_PER_M_TOKENS[tier];
  const freshInput = inputTokens - cachedInputTokens;
  return (
    (freshInput / 1_000_000) * rates.input_fresh +
    (cachedInputTokens / 1_000_000) * rates.input_cached +
    (outputTokens / 1_000_000) * rates.output
  );
}

// ----------------------------------------------------------------------------
// Three-slot prompt assembly with cache markers
// ----------------------------------------------------------------------------
// The frozen_core + background + manager_overlay are STABLE across calls for
// a given agent, so we mark them as cache-able. The learned_addendum and the
// per-call userPrompt are fresh.
// ----------------------------------------------------------------------------

function assembleSystemBlocks(agent: Agent): Anthropic.TextBlockParam[] {
  // Block 1: frozen core + background (stable, expensive, cache it)
  const stableBlock = [
    agent.frozen_core,
    agent.background ? `\n\n# Background\n${agent.background}` : "",
    `\n\n# Personality\n- Archetype: ${agent.personality.archetype}`,
    `\n- Quirks:`,
    ...agent.personality.quirks.map((q: string) => `\n  - ${q}`),
    `\n\n# Voice examples`,
    ...agent.personality.voiceExamples.map((v: string) => `\n  - "${v}"`),
  ].join("");

  // Block 2: manager overlay (per-agent, semi-stable, also cache it)
  const overlayBlock = agent.manager_overlay || "";

  // Block 3: learned addendum (changes when CEO approves; fresh)
  const addendumBlock = agent.learned_addendum
    ? `\n\n# Learned addendum (approved)\n${agent.learned_addendum}`
    : "";

  const blocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: stableBlock,
      cache_control: { type: "ephemeral" },
    },
  ];

  if (overlayBlock) {
    blocks.push({
      type: "text",
      text: `\n\n# Standing orders from your manager\n${overlayBlock}`,
      cache_control: { type: "ephemeral" },
    });
  }

  if (addendumBlock) {
    blocks.push({ type: "text", text: addendumBlock });
  }

  return blocks;
}

// ----------------------------------------------------------------------------
// Main run() function
// ----------------------------------------------------------------------------

export async function run(options: RunOptions): Promise<RunResult> {
  const { agent, userPrompt, forceTier, maxTokens = 1024, context } = options;
  const startedAt = Date.now();

  if (agent.status !== "active") {
    return {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      tier: forceTier ?? agent.model_tier,
      skipped: "agent_paused",
    };
  }

  // Wall-hour cost cap check (cheap, runs before every call)
  if (await isOverHourlyCap()) {
    return {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      tier: forceTier ?? agent.model_tier,
      skipped: "budget_exceeded",
    };
  }

  const tier = forceTier ?? agent.model_tier;
  const model = MODEL_NAMES[tier];

  console.log(`[${agent.name}] calling ${model} (${context})...`);

  const systemBlocks = assembleSystemBlocks(agent);

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: [{ role: "user", content: userPrompt }],
  });

  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;
  // Anthropic SDK returns cache_read_input_tokens and cache_creation_input_tokens
  const cachedInputTokens =
    (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const cacheCreationTokens =
    (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;

  // True input cost: fresh input + cache creation (1.25x normal) + cached reads (0.1x normal)
  // Simplified: treat cache_creation as fresh, cache_read as cached. Close enough for cap math.
  const totalInput = inputTokens + cacheCreationTokens;
  const costUsd = calcCost(tier, totalInput, cachedInputTokens, outputTokens);

  // Extract text
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const durationMs = Date.now() - startedAt;

  // Record spend
  await recordSpend(totalInput, outputTokens, cachedInputTokens, costUsd);

  // Audit trail
  await db.from("agent_actions").insert({
    tenant_id: config.tenantId,
    agent_id: agent.id,
    action_type: "claude_call",
    payload: {
      context,
      model,
      tier,
      input_tokens: totalInput,
      cached_input_tokens: cachedInputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      duration_ms: durationMs,
    },
  });

  console.log(
    `[${agent.name}] ${tier} ${durationMs}ms in=${totalInput} cached=${cachedInputTokens} out=${outputTokens} $${costUsd.toFixed(5)}`
  );

  return {
    text,
    inputTokens: totalInput,
    outputTokens,
    cachedInputTokens,
    costUsd,
    durationMs,
    tier,
  };
}
