import { config } from "../config.js";
import { db } from "../db.js";
import { runAgentTurn } from "../agents/runner.js";
import { postToForum } from "../comms/forum.js";
import { Channels, AgentSchema, type Agent } from "@headcount/shared";
import { getWorldClock, formatCompanyTime } from "../world/clock.js";

/**
 * Day 1 ritual: Chief of Staff wakes up and posts a "good morning, here's the
 * shape of today" message to #general. That's it. That's the whole sim today.
 *
 * On Day 3 this gets replaced by the full standup ritual.
 */
export async function runMorningGreeting(): Promise<void> {
  const clock = await getWorldClock();

  const cos = await getChiefOfStaff();
  if (!cos) {
    console.warn("No Chief of Staff seeded yet. Run 'pnpm seed' first.");
    return;
  }
  if (cos.status !== "active") {
    console.warn(`Chief of Staff is ${cos.status}, skipping greeting.`);
    return;
  }

  const trigger = "It's the start of a new day at Onepark Digital. Post a short good-morning message to #general for the team. Mention what kind of day it feels like and one thing you're paying attention to. Keep it under 60 words. Stay in your voice.";

  const contextBlock = [
    `Channel you're posting to: #general`,
    `Current company time: ${formatCompanyTime(clock.company_time)}`,
    `It's the very first morning of the new operating system at Onepark Digital. The forum has zero posts so far. You're the first person logged in. The office is empty. Nobody else has started yet.`,
  ].join("\n");

  try {
    const result = await runAgentTurn({
      agent: cos,
      trigger,
      contextBlock,
    });

    await postToForum({
      channel: Channels.GENERAL,
      authorId: cos.id,
      body: result.text,
      metadata: { ritual: "morning_greeting", company_time: clock.company_time.toISOString() },
    });

    console.log(`[${cos.name}] posted morning greeting to #general`);
  } catch (err) {
    console.error("Morning greeting failed:", err);
  }
}

async function getChiefOfStaff(): Promise<Agent | null> {
  const { data, error } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("role", "Chief of Staff")
    .maybeSingle();

  if (error) {
    console.error("DB error loading Chief of Staff:", error);
    return null;
  }
  if (!data) return null;

  const parsed = AgentSchema.safeParse(data);
  if (!parsed.success) {
    console.error("Chief of Staff row failed schema validation:", parsed.error);
    return null;
  }
  return parsed.data;
}
