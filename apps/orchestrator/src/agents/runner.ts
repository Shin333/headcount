import type Anthropic from "@anthropic-ai/sdk";
import type { Agent, ModelTier } from "@headcount/shared";
import { COST_PER_M_TOKENS } from "@headcount/shared";
import { db } from "../db.js";
import { anthropic, MODEL_MAP } from "../claude.js";
import { config } from "../config.js";
import { composeSystemPrompt } from "./personality.js";
import { retrieveMemories } from "./memory.js";
import type { Tool, ToolResult, ToolExecutionContext } from "../tools/types.js";
import type { ImageBlock } from "./vision.js";
import { buildTriggerWithImages } from "./vision.js";
import {
  getToolByName,
  toolsToApiFormat,
  anyToolHasExtendedThinking,
  maxOutputTokensOverride,
} from "../tools/registry.js";

export interface AgentTurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  durationMs: number;
  skipped?: "budget_exceeded" | "agent_paused";
  toolCallCount?: number;
  /**
   * Day 9b: structured payloads from tool calls that produced one (artifact
   * tools, calendar_read). Order is the order tools were called. The
   * dm-responder uses this to append an <artifacts> block to the outgoing
   * DM body so the dashboard can render cards.
   */
  toolStructuredPayloads?: Array<{ toolName: string; payload: Record<string, unknown> }>;
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
// Token budget pre-charge (Day 22b: race-window fix)
// ============================================================================
// The Day 1 implementation checked `tokens_used_today >= daily_token_budget`
// before the API call but only WROTE the delta after the call returned. This
// meant a runaway turn could overshoot the daily budget by ~max_tokens before
// any subsequent invocation noticed. Pre-charging the worst-case output
// budget BEFORE the call closes that window. Post-call we reconcile to the
// true delta (actual - reserved), which can be negative.
//
// Mutates the in-memory `agent` so any later read inside the same function
// reflects the current charge.
// ============================================================================

async function chargeBudget(agent: Agent, deltaTokens: number): Promise<void> {
  if (deltaTokens === 0) return;
  agent.tokens_used_today = Math.max(0, agent.tokens_used_today + deltaTokens);
  await db
    .from("agents")
    .update({
      tokens_used_today: agent.tokens_used_today,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id);
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

// Day 9b.1: raised from 5 to 10 because Wei-Ming on Opus with adaptive
// thinking legitimately needs more research rounds for code tasks. A task
// that needs more than 10 rounds of tool use is probably malformed and
// should trigger the wrap-up path anyway.
const MAX_TOOL_ITERATIONS_DEFAULT = 10;

export async function runAgentTurn(args: {
  agent: Agent;
  trigger: string;
  contextBlock: string;
  forceTier?: ModelTier;
  maxTokens?: number;
  tools?: Tool[];
  maxToolIterations?: number;
  imageBlocks?: ImageBlock[];
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
  imageBlocks?: ImageBlock[];
}): Promise<AgentTurnResult> {
  const { agent, trigger, contextBlock, forceTier, maxTokens = 1024, imageBlocks } = args;
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

  // Day 22b: pre-charge the worst-case output budget before the API call.
  // Reconciled to the true delta after the call returns.
  const reserved = maxTokens;
  await chargeBudget(agent, reserved);

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
    messages: [{ role: "user", content: buildTriggerWithImages(trigger, imageBlocks ?? []) }],
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

  // Day 22b: reconcile pre-charge to actual usage. Delta can be negative if
  // actual was less than the reserved max_tokens.
  await chargeBudget(agent, totalInput + outputTokens - reserved);

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
  imageBlocks?: ImageBlock[];
}): Promise<AgentTurnResult> {
  const {
    agent,
    trigger,
    contextBlock,
    forceTier,
    maxTokens = 1024,
    tools = [],
    maxToolIterations = MAX_TOOL_ITERATIONS_DEFAULT,
    imageBlocks,
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

  // ----------------------------------------------------------------------
  // Day 9b: per-turn thinking + output token resolution
  // ----------------------------------------------------------------------
  // Per Anthropic docs, the entire assistant turn (including all iterations
  // of the tool loop and the wrap-up call) must operate in a single thinking
  // mode. We resolve the mode ONCE at the top of the loop based on tool
  // flags and use it for every API call inside this function.
  //
  // Adaptive thinking is used when ANY tool in the set has
  // extended_thinking=true (currently: code_artifact_create only).
  //
  // Day 9b.1: the `effort` parameter was removed. It's documented in
  // third-party wrappers (Promptfoo, GlobalGPT) but Anthropic's raw
  // Messages API rejects it with "Extra inputs are not permitted".
  // Adaptive thinking handles effort tuning internally; we don't need
  // to hint it.
  //
  // The output token cap is overridden when ANY tool in the set requests
  // a higher max_output_tokens (currently: code_artifact_create wants 16k).
  // ----------------------------------------------------------------------
  const useExtendedThinking = anyToolHasExtendedThinking(tools);
  const tokenOverride = maxOutputTokensOverride(tools);
  const effectiveMaxTokens = tokenOverride ?? maxTokens;

  // Build the thinking config object once.
  const thinkingConfig: { thinking?: { type: "adaptive" } } = useExtendedThinking
    ? { thinking: { type: "adaptive" } }
    : {};

  if (useExtendedThinking) {
    console.log(
      `[${agent.name}] thinking: adaptive (because tool set includes extended_thinking)`
    );
  }
  if (tokenOverride !== undefined) {
    console.log(
      `[${agent.name}] max_tokens override: ${tokenOverride} (default was ${maxTokens})`
    );
  }

  console.log(`[${agent.name}] calling ${model} with ${tools.length} tool(s)...`);

  // Conversation history for the multi-round loop
  const triggerContent = buildTriggerWithImages(trigger, imageBlocks ?? []);
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: triggerContent },
  ];

  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0;
  let accumulatedCachedInputTokens = 0;
  let accumulatedCostUsd = 0;
  let toolCallCount = 0;
  let finalText = "";
  let iteration = 0;
  // Day 22b: per-round pre-charge so concurrent budget reads see worst-case
  // in-flight usage. Reconciled to actual after each round returns.
  let totalReservedThisTurn = 0;
  // Day 9b: collect structured payloads from tool calls so the dm-responder
  // can attach them to the outgoing DM for dashboard rendering.
  const structuredPayloads: Array<{ toolName: string; payload: Record<string, unknown> }> = [];
  // Day 14b: truncation loop detection. Track the previous round's stop
  // reason and whether any tool actually executed live (not just attempted).
  // If two rounds in a row hit max_tokens AND no live tool execution
  // happened in between, the model is stuck generating the same truncated
  // tool call repeatedly. Break out and surface an honest error.
  let prevStopReason: string | null = null;
  let prevRoundHadLiveTool = false;
  let truncationLoopDetected = false;

  while (iteration < maxToolIterations) {
    iteration++;

    // Re-check cost cap before each round-trip - tool use can spiral
    if (await isOverHourlyCap()) {
      console.log(`[${agent.name}] hourly cap reached mid-tool-loop, breaking`);
      break;
    }

    // Day 14b: truncation loop detection. If the previous round hit
    // max_tokens AND no tool actually executed live, the model is
    // generating broken tool calls in a loop. Break before we burn another
    // round of cost on the same broken output.
    if (iteration > 1 && prevStopReason === "max_tokens" && !prevRoundHadLiveTool) {
      console.warn(
        `[${agent.name}] truncation loop detected (prev round stop=max_tokens, no live tool). Breaking out.`
      );
      truncationLoopDetected = true;
      break;
    }

    // Day 22b: pre-charge this round's worst-case output budget.
    await chargeBudget(agent, effectiveMaxTokens);
    totalReservedThisTurn += effectiveMaxTokens;

    const response = await anthropic.messages.create({
      model,
      max_tokens: effectiveMaxTokens,
      system: [
        {
          type: "text",
          text: systemPromptText,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: apiTools,
      messages: messages as Anthropic.MessageParam[],
      // Day 9b: spread the thinking config (empty object when disabled)
      ...(thinkingConfig as Record<string, unknown>),
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

    // Day 9b: build the execution context once per round so tool executors
    // know which agent is calling them. Used by artifact tools to attribute
    // ownership and by calendar/github tools to look up agent_credentials.
    const execContext: ToolExecutionContext = {
      agentId: agent.id,
      agentName: agent.name,
      agentDepartment: agent.department,
      triggeredByDmId: null, // TODO Day 9c+: wire through from dm-responder
      triggeredByPostId: null,
    };

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
          result = await tool.executor(toolUse.input, execContext);
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

      // Day 9b: capture structured payloads (artifact metadata, calendar
      // events, etc.) so they flow through to the dm-responder for rendering
      if (result.structuredPayload && !result.isError) {
        structuredPayloads.push({
          toolName: toolUse.name,
          payload: result.structuredPayload,
        });
      }

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
      // Day 14b: track whether any tool ran live for truncation loop detection
      prevRoundHadLiveTool = liveCount > 0;
    } else {
      prevRoundHadLiveTool = false;
    }
    // Day 14b: stash this round's stop reason for the next iteration check
    prevStopReason = response.stop_reason ?? null;

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
      // IMPORTANT: the wrap-up call MUST use the same thinking mode as the
      // rest of the loop. If the loop had thinking enabled, the messages
      // history contains thinking blocks, and Anthropic will reject a
      // wrap-up call that doesn't enable thinking with:
      //   "Expected thinking or redacted_thinking, but found tool_use"
      // The entire assistant turn must be a single thinking mode.
      const wrapResponse = await anthropic.messages.create({
        model,
        max_tokens: effectiveMaxTokens,
        system: [{ type: "text", text: systemPromptText, cache_control: { type: "ephemeral" } }],
        messages: messages as Anthropic.MessageParam[],
        ...(thinkingConfig as Record<string, unknown>),
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

  // Day 14b: when truncation loop is detected, the model may have left
  // behind a partial preamble like "Let me draft this..." in finalText
  // from before the loop broke. That preamble is misleading - it implies
  // the work continued. Override it with the honest truncation message
  // regardless of whether finalText is non-empty.
  if (truncationLoopDetected) {
    console.warn(
      `[${agent.name}] truncation loop detected, replacing partial preamble (${finalText.length} chars) with honest reply`
    );
    finalText =
      `I tried to create an artifact for this but my output kept getting truncated mid-tool-call - my output token budget for that tool is too low for what I wanted to write, so the artifact never landed on disk. ` +
      `I burned ${toolCallCount} tool call(s) trying before the runner caught the loop and stopped me. ` +
      `Tell Shin to bump max_output_tokens on the artifact tool I'm using, then DM me again and I'll retry. ` +
      `In the meantime I have nothing usable to send you - sorry.`;
  }

  // Day 9b.1: if we still have no text after the wrap-up attempt, emit a
  // canned degraded response so the user isn't silently ghosted. This
  // happens when the agent spirals in the tool loop and the wrap-up call
  // also returns empty (e.g. stop_reason:"tool_use" with no text blocks).
  // The cost has already been paid - at minimum the user deserves to know
  // what happened. Note: the truncation-loop case is handled above and
  // never reaches this branch.
  if (!finalText) {
    console.warn(
      `[${agent.name}] producing canned degraded reply after ${toolCallCount} tool calls with no final text`
    );
    finalText =
      `I got stuck in a research loop on this one and ran out of tool-use rounds before I could give you a proper answer. ` +
      `I made ${toolCallCount} tool call(s) but didn't land on something I was confident enough to ship. ` +
      `Can you DM me again? I'll try with a narrower scope this time.`;
  }

  const durationMs = Date.now() - start;

  // Day 22b: reconcile all per-round reservations to the true accumulated
  // usage. Delta is (actual total) - (sum of reservations). Almost always
  // negative because reservations are worst-case max_tokens per round.
  await chargeBudget(
    agent,
    accumulatedInputTokens + accumulatedOutputTokens - totalReservedThisTurn
  );

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
    toolStructuredPayloads: structuredPayloads.length > 0 ? structuredPayloads : undefined,
  };
}
