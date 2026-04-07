import type { Agent, Personality } from "@headcount/shared";

const NL = "\n";

/**
 * Composes the runtime system prompt from the three slots.
 * Reza's rule: frozen_core is the bulk; learned_addendum is small and capped.
 */
export function composeSystemPrompt(agent: Agent, contextBlock: string): string {
  const personalityBlock = renderPersonality(agent.personality);

  return [
    `# Your Identity`,
    agent.frozen_core,
    "",
    `# Your Personality`,
    personalityBlock,
    "",
    agent.background ? `# Your Background${NL}${agent.background}${NL}` : "",
    agent.manager_overlay
      ? `# Standing Orders From Your Manager${NL}${agent.manager_overlay}${NL}`
      : "",
    agent.learned_addendum
      ? `# Things You've Learned (reviewed by CEO)${NL}${agent.learned_addendum}${NL}`
      : "",
    `# Current Context`,
    contextBlock,
    "",
    `# Output Rules`,
    `- Stay in character. Use your voice. Use your quirks naturally, never as a checklist.`,
    `- Be concise. Real employees do not write essays in chat.`,
    `- If asked to post to the forum, respond with ONLY the post body. No preamble. No "Sure, here's my post:".`,
    `- Never break character to explain that you are an AI.`,
  ]
    .filter(Boolean)
    .join(NL);
}

function renderPersonality(p: Personality): string {
  const traits = traitDescriptors(p);
  const quirks = p.quirks.map((q) => `- ${q}`).join(NL);
  const voice = p.voiceExamples.map((v, i) => `Example ${i + 1}: "${v}"`).join(NL);

  return [
    `Archetype: ${p.archetype}`,
    `Traits: ${traits.join(", ")}`,
    "",
    `Quirks (use these naturally - they are who you are):`,
    quirks,
    "",
    `Voice examples - match this register:`,
    voice,
  ].join(NL);
}

function traitDescriptors(p: Personality): string[] {
  const out: string[] = [];
  const { big5 } = p;

  if (big5.openness >= 70) out.push("highly open to new ideas, curious");
  else if (big5.openness <= 30) out.push("traditional, prefers proven approaches");

  if (big5.conscientiousness >= 70) out.push("methodical, detail-oriented");
  else if (big5.conscientiousness <= 30) out.push("loose, improvisational");

  if (big5.extraversion >= 70) out.push("warm, talkative, jumps in");
  else if (big5.extraversion <= 30) out.push("reserved, speaks when it matters");

  if (big5.agreeableness >= 70) out.push("warm and accommodating");
  else if (big5.agreeableness <= 30) out.push("blunt, debates by default");

  if (big5.neuroticism >= 70) out.push("worrier, anticipates risks");
  else if (big5.neuroticism <= 30) out.push("steady, hard to ruffle");

  return out;
}
