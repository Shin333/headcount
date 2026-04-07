import type Anthropic from "@anthropic-ai/sdk";
import type { Agent } from "@headcount/shared";
import { db } from "../db.js";
import { anthropic, MODEL_MAP } from "../claude.js";
import { config } from "../config.js";
import { composeSystemPrompt } from "./personality.js";
import { retrieveMemories } from "./memory.js";

export interface AgentTurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Run a single turn for an agent. This is THE core function of Headcount.
 * Day 1: trigger comes from a ritual, response is plain text.
 * Day 2+: response will be parsed for tool calls, posts, DMs, etc.
 */
export async function runAgentTurn(args: {
  agent: Agent;
  trigger: string;
  contextBlock: string;
}): Promise<AgentTurnResult> {
  const { agent, trigger, contextBlock } = args;
  const start = Date.now();

  // Token budget guard (Reality Checker's non-negotiable)
  if (agent.tokens_used_today >= agent.daily_token_budget) {
    throw new Error(`Agent ${agent.name} has hit daily token budget (${agent.daily_token_budget}).`);
  }

  // Memory retrieval (stubbed Day 1, real Day 2)
  await retrieveMemories(agent.id, trigger, { topK: 12 });

  const systemPrompt = composeSystemPrompt(agent, contextBlock);
  const model = MODEL_MAP[agent.model_tier];

  console.log(`[${agent.name}] calling ${model}...`);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: trigger }],
  });

  const durationMs = Date.now() - start;

  // Extract text from response
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  // Update token usage
  await db
    .from("agents")
    .update({
      tokens_used_today: agent.tokens_used_today + inputTokens + outputTokens,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id);

  // Audit log (Reza's non-negotiable)
  await db.from("agent_actions").insert({
    tenant_id: config.tenantId,
    agent_id: agent.id,
    action_type: "claude_call",
    trigger,
    system_prompt: systemPrompt,
    user_prompt: trigger,
    response: text,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: durationMs,
    metadata: { model },
  });

  console.log(`[${agent.name}] responded in ${durationMs}ms (${inputTokens}+${outputTokens} tokens)`);

  return { text, inputTokens, outputTokens, durationMs };
}
