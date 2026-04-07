import type Anthropic from "@anthropic-ai/sdk";
import type { Agent, ModelTier } from "@headcount/shared";
import { COST_PER_M_TOKENS } from "@headcount/shared";
import { db } from "../db.js";
import { anthropic, MODEL_MAP } from "../claude.js";
import { config } from "../config.js";
import { composeSystemPrompt } from "./personality.js";
import { retrieveMemories } from "./memory.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { getToolByName, toolsToApiFormat } from "../tools/registry.js";

export interface AgentTurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  durationMs: number;
  skipped?: "budget_exceeded" | "agent_paused";
  toolCallCount?: number;
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
// runAgentTurn - Day 5 router
// ============================================================================
//
// BACKWARD COMPATIBILITY GUARANTEE:
//   When `tools` is undefined or empty, this function delegates to
//   runAgentTurnSingleCall, which is BIT-FOR-BIT IDENTICAL to the Day 2b.2/2b.4
//   runner. Eleanor's morning greeting, chatter, standup, brief, dm-responder
//   (without tools), and reflection all hit this path with zero behavior change.
//
//   When `tools` is non-empty, the new tool-use multi-round path runs.
//   This is currently used only by the dm-responder for agents with
//   non-empty tool_access (Day 5 = Ayaka only).
// ============================================================================

const MAX_TOOL_ITERATIONS_DEFAULT = 5;

export async function runAgentTurn(args: {
  agent: Agent;
  trigger: string;
  contextBlock: string;
  forceTier?: ModelTier;
  maxTokens?: number;
  tools?: Tool[];
  maxToolIterations?: number;
}): Promise<AgentTurnResult> {
  if (!args.tools || args.tools.length === 0) {
    return runAgentTurnSingleCall(args);
  }
  return runAgentTurnWithTools(args);
}

// ============================================================================
// SINGLE-CALL PATH (Day 2b.2/2b.4 behavior, preserved verbatim)
// ============================================================================
// This function is the ENTIRE original runAgentTurn body from before Day 5.
// Do not modify it. The Day 5 router delegates here when no tools are passed.
// ============================================================================

async function runAgentTurnSingleCall(args: {
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

// ============================================================================
// TOOL-USE MULTI-ROUND PATH (Day 5)
// ============================================================================
// Used when the caller passes a non-empty `tools` array. The model can request
// tool calls; we execute them and feed results back; the loop continues until
// the model returns a final text response or we hit MAX_TOOL_ITERATIONS.
//
// All cost, audit, and budget checks happen per round-trip.
// ============================================================================

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

async function runAgentTurnWithTools(args: {
  agent: Agent;
  trigger: string;
  contextBlock: string;
  forceTier?: ModelTier;
  maxTokens?: number;
  tools?: Tool[];
  maxToolIterations?: number;
}): Promise<AgentTurnResult> {
  const {
    agent,
    trigger,
    contextBlock,
    forceTier,
    maxTokens = 1024,
    tools = [],
    maxToolIterations = MAX_TOOL_ITERATIONS_DEFAULT,
  } = args;
  const start = Date.now();

  // ---- Same gates as the single-call path ----
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

  await retrieveMemories(agent.id, trigger, { topK: 12 });

  const systemPromptText = composeSystemPrompt(agent, contextBlock);
  const tier = forceTier ?? agent.model_tier;
  const model = MODEL_MAP[tier];
  const apiTools = toolsToApiFormat(tools);

  console.log(`[${agent.name}] calling ${model} with ${tools.length} tool(s)...`);

  // Conversation history for the multi-round loop
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: trigger },
  ];

  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0;
  let accumulatedCachedInputTokens = 0;
  let accumulatedCostUsd = 0;
  let toolCallCount = 0;
  let finalText = "";
  let iteration = 0;

  while (iteration < maxToolIterations) {
    iteration++;

    // Re-check cost cap before each round-trip - tool use can spiral
    if (await isOverHourlyCap()) {
      console.log(`[${agent.name}] hourly cap reached mid-tool-loop, breaking`);
      break;
    }

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
      tools: apiTools,
      messages: messages as Anthropic.MessageParam[],
    });

    // Accumulate token + cost for this round
    const inputTokens = response.usage.input_tokens ?? 0;
    const outputTokens = response.usage.output_tokens ?? 0;
    const cachedInputTokens =
      (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
    const cacheCreationTokens =
      (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
    const totalInput = inputTokens + cacheCreationTokens;
    const roundCost = calcCost(tier, totalInput, cachedInputTokens, outputTokens);

    accumulatedInputTokens += totalInput;
    accumulatedOutputTokens += outputTokens;
    accumulatedCachedInputTokens += cachedInputTokens;
    accumulatedCostUsd += roundCost;

    // Record spend per round so the cost cap reflects reality immediately
    await recordSpend(totalInput, outputTokens, cachedInputTokens, roundCost);

    // Audit log per round
    const roundText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const toolUseBlocks: ToolUseBlock[] = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: (block.input as Record<string, unknown>) ?? {},
      }));

    await db.from("agent_actions").insert({
      tenant_id: config.tenantId,
      agent_id: agent.id,
      action_type: "claude_call",
      trigger,
      system_prompt: systemPromptText,
      user_prompt: iteration === 1 ? trigger : `[tool-loop iteration ${iteration}]`,
      response: roundText,
      tool_calls: toolUseBlocks.length > 0
        ? toolUseBlocks.map((b) => ({ name: b.name, input: b.input }))
        : null,
      input_tokens: totalInput,
      output_tokens: outputTokens,
      duration_ms: 0, // per-round duration not tracked, total tracked at end
      metadata: {
        model,
        tier,
        cached_input_tokens: cachedInputTokens,
        cost_usd: roundCost,
        iteration_index: iteration,
        tool_use: toolUseBlocks.length > 0,
        stop_reason: response.stop_reason,
      },
    });

    console.log(
      `[${agent.name}] ${tier} round ${iteration} in=${totalInput} cached=${cachedInputTokens} out=${outputTokens} $${roundCost.toFixed(5)} stop=${response.stop_reason}`
    );

    // If no tool calls, we have our final text
    if (toolUseBlocks.length === 0) {
      finalText = roundText;
      break;
    }

    // Model wants to use tools - append assistant message and execute each
    messages.push({
      role: "assistant",
      content: response.content,
    });

    const toolResultBlocks: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }> = [];

    // Day 5.3: track cache hits per tool execution in this round
    const toolExecutionTrace: Array<{
      name: string;
      cache_hit: boolean;
      is_error: boolean;
    }> = [];

    for (const toolUse of toolUseBlocks) {
      toolCallCount++;
      console.log(`[${agent.name}] executing tool: ${toolUse.name}`);

      const tool = getToolByName(toolUse.name);
      let result: ToolResult;

      if (!tool) {
        result = {
          toolName: toolUse.name,
          content: `Error: tool '${toolUse.name}' is not registered.`,
          isError: true,
        };
      } else {
        try {
          result = await tool.executor(toolUse.input);
        } catch (err) {
          // Executor contract says they shouldn't throw, but defend anyway
          result = {
            toolName: toolUse.name,
            content: `Error: tool executor crashed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      toolExecutionTrace.push({
        name: toolUse.name,
        cache_hit: result.cacheHit === true,
        is_error: result.isError,
      });

      // Day 5.3: also write a dedicated audit row per tool execution.
      // This is what the dashboard quota counter queries via metadata.
      await db.from("agent_actions").insert({
        tenant_id: config.tenantId,
        agent_id: agent.id,
        action_type: "tool_call",
        trigger,
        system_prompt: null,
        user_prompt: JSON.stringify(toolUse.input).slice(0, 500),
        response: result.content.slice(0, 2000),
        tool_calls: null,
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 0,
        metadata: {
          tool_name: toolUse.name,
          cache_hit: result.cacheHit === true,
          is_error: result.isError,
          iteration_index: iteration,
        },
      });

      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    if (toolExecutionTrace.length > 0) {
      const liveCount = toolExecutionTrace.filter((t) => !t.cache_hit && !t.is_error).length;
      const hitCount = toolExecutionTrace.filter((t) => t.cache_hit).length;
      console.log(
        `[${agent.name}] tool round: ${toolExecutionTrace.length} call(s), ${liveCount} live, ${hitCount} cached`
      );
    }

    // Append tool results as the next user message
    messages.push({
      role: "user",
      content: toolResultBlocks,
    });

    // If we got a final text along with tool calls in the same response,
    // we still continue the loop because the model has more to say after seeing results.
    finalText = roundText;
  }

  if (iteration >= maxToolIterations && !finalText) {
    console.warn(
      `[${agent.name}] hit max tool iterations (${maxToolIterations}) without final text - forcing one more call`
    );
    // Last-ditch: ask the model to wrap up without tools
    try {
      const wrapResponse = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: systemPromptText, cache_control: { type: "ephemeral" } }],
        messages: messages as Anthropic.MessageParam[],
      });
      finalText = wrapResponse.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      const wInputTokens = wrapResponse.usage.input_tokens ?? 0;
      const wOutputTokens = wrapResponse.usage.output_tokens ?? 0;
      const wCacheCreation =
        (wrapResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
      const wCached =
        (wrapResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
      const wTotal = wInputTokens + wCacheCreation;
      const wCost = calcCost(tier, wTotal, wCached, wOutputTokens);
      accumulatedInputTokens += wTotal;
      accumulatedOutputTokens += wOutputTokens;
      accumulatedCachedInputTokens += wCached;
      accumulatedCostUsd += wCost;
      await recordSpend(wTotal, wOutputTokens, wCached, wCost);
    } catch (err) {
      console.error(`[${agent.name}] wrap-up call failed:`, err);
    }
  }

  const durationMs = Date.now() - start;

  // Update agent token usage with the accumulated total
  await db
    .from("agents")
    .update({
      tokens_used_today: agent.tokens_used_today + accumulatedInputTokens + accumulatedOutputTokens,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id);

  console.log(
    `[${agent.name}] ${tier} TOTAL ${durationMs}ms in=${accumulatedInputTokens} cached=${accumulatedCachedInputTokens} out=${accumulatedOutputTokens} tools=${toolCallCount} $${accumulatedCostUsd.toFixed(5)}`
  );

  return {
    text: finalText,
    inputTokens: accumulatedInputTokens,
    outputTokens: accumulatedOutputTokens,
    cachedInputTokens: accumulatedCachedInputTokens,
    costUsd: accumulatedCostUsd,
    durationMs,
    toolCallCount,
  };
}
