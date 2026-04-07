import type Anthropic from "@anthropic-ai/sdk";
import type { Agent, ModelTier } from "@headcount/shared";
import { COST_PER_M_TOKENS } from "@headcount/shared";
import { db } from "../db.js";
import { anthropic, MODEL_MAP } from "../claude.js";
import { config } from "../config.js";
import { composeSystemPrompt } from "./personality.js";
import { retrieveMemories } from "./memory.js";

export interface AgentTurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  durationMs: number;
  skipped?: "budget_exceeded" | "agent_paused";
}

// ============================================================================
// Wall-hour cost cap (Day 2b.2)
// ============================================================================

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

// ============================================================================
// Cost calculation
// ============================================================================

function calcCost(
  tier: ModelTier,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number {
  const rates = COST_PER_M_TOKENS[tier];
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (freshInput / 1_000_000) * rates.input_fresh +
    (cachedInputTokens / 1_000_000) * rates.input_cached +
    (outputTokens / 1_000_000) * rates.output
  );
}

// ============================================================================
// runAgentTurn - the core function (Day 1 contract preserved)
// ============================================================================
//
// Day 1 signature: { agent, trigger, contextBlock } -> { text, inputTokens, outputTokens, durationMs }
// Day 2b.2 additions: optional forceTier, optional maxTokens, returns
//   cachedInputTokens, costUsd, and skipped reason. All Day 1 callers still
//   work because the new fields are additive.
// ============================================================================

export async function runAgentTurn(args: {
  agent: Agent;
  trigger: string;
  contextBlock: string;
  forceTier?: ModelTier;
  maxTokens?: number;
}): Promise<AgentTurnResult> {
  const { agent, trigger, contextBlock, forceTier, maxTokens = 1024 } = args;
  const start = Date.now();

  // Token budget guard (Day 1)
  if (agent.tokens_used_today >= agent.daily_token_budget) {
    console.log(`[${agent.name}] skipped: daily token budget exceeded`);
    return {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      skipped: "budget_exceeded",
    };
  }

  // Agent status guard (Day 2b.2)
  if (agent.status !== "active") {
    return {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      skipped: "agent_paused",
    };
  }

  // Wall-hour cost cap (Day 2b.2)
  if (await isOverHourlyCap()) {
    console.log(`[${agent.name}] skipped: hourly cost cap reached`);
    return {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      skipped: "budget_exceeded",
    };
  }

  // Memory retrieval (Day 1 stub)
  await retrieveMemories(agent.id, trigger, { topK: 12 });

  const systemPromptText = composeSystemPrompt(agent, contextBlock);
  const tier = forceTier ?? agent.model_tier;
  const model = MODEL_MAP[tier];

  console.log(`[${agent.name}] calling ${model}...`);

  // Day 2b.2: send system as a cache-enabled block. Anthropic will cache the
  // bulk of the prompt automatically; subsequent calls within the cache TTL
  // (~5 min) get massive cost savings on the input side.
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: systemPromptText,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: trigger }],
  });

  const durationMs = Date.now() - start;

  // Extract text
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;
  const cachedInputTokens =
    (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
  const cacheCreationTokens =
    (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;

  const totalInput = inputTokens + cacheCreationTokens;
  const costUsd = calcCost(tier, totalInput, cachedInputTokens, outputTokens);

  // Update token usage (Day 1 contract)
  await db
    .from("agents")
    .update({
      tokens_used_today: agent.tokens_used_today + totalInput + outputTokens,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id);

  // Day 2b.2: also record wall-hour spend
  await recordSpend(totalInput, outputTokens, cachedInputTokens, costUsd);

  // Audit log (Day 1 contract preserved)
  await db.from("agent_actions").insert({
    tenant_id: config.tenantId,
    agent_id: agent.id,
    action_type: "claude_call",
    trigger,
    system_prompt: systemPromptText,
    user_prompt: trigger,
    response: text,
    input_tokens: totalInput,
    output_tokens: outputTokens,
    duration_ms: durationMs,
    metadata: { model, tier, cached_input_tokens: cachedInputTokens, cost_usd: costUsd },
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
  };
}
