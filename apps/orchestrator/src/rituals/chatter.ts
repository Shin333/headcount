import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { postToForum } from "../comms/forum.js";
import { Channels, AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";

// ----------------------------------------------------------------------------
// rituals/chatter.ts - the #watercooler ritual (Day 2b.2)
// ----------------------------------------------------------------------------
// Runs once per company hour during office hours. Picks one agent who has
// something to say, gives them recent context, and lets them post a casual
// message. Caps + smart skipping prevent spam and runaway costs.
// ----------------------------------------------------------------------------

interface ChatterContext {
  current_tick: number;
  company_time: Date;
  speed_multiplier: number;
  paused: boolean;
}

export async function maybeRunChatter(clock: ChatterContext): Promise<void> {
  if (!config.chatterEnabled) return;
  if (await isOverHourlyCap()) {
    console.log("[chatter] skipped: hourly cost cap reached");
    return;
  }

  const companyHour = clock.company_time.getUTCHours();
  const companyDate = clock.company_time.toISOString().substring(0, 10);

  // Have we already run for this company hour?
  const { data: ritualState } = await db
    .from("ritual_state")
    .select("last_chatter_company_hour, last_chatter_company_date")
    .eq("id", 1)
    .maybeSingle();

  if (
    ritualState?.last_chatter_company_date === companyDate &&
    ritualState?.last_chatter_company_hour === companyHour
  ) {
    return;
  }

  // Office hours only (09:00 - 18:00 company time)
  if (companyHour < 9 || companyHour >= 18) {
    await markChatterHour(companyHour, companyDate);
    return;
  }

  await resetCountersIfNewDay(companyDate);

  const { data: agentRows } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active")
    .lt("chatter_posts_today", config.chatterPostsPerAgentPerDay);

  if (!agentRows || agentRows.length === 0) {
    await markChatterHour(companyHour, companyDate);
    return;
  }

  const agents: Agent[] = [];
  for (const row of agentRows) {
    const parsed = AgentSchema.safeParse(row);
    if (parsed.success) agents.push(parsed.data);
  }
  if (agents.length === 0) {
    console.log("[chatter] no agents passed schema validation");
    await markChatterHour(companyHour, companyDate);
    return;
  }

  const { data: recentPosts } = await db
    .from("forum_posts")
    .select("id, channel, author_id, body, created_at")
    .eq("tenant_id", config.tenantId)
    .eq("channel", Channels.WATERCOOLER)
    .order("created_at", { ascending: false })
    .limit(8);

  // Smart skip: channel was very active recently
  if (recentPosts && recentPosts.length >= 5) {
    const newest = new Date(recentPosts[0].created_at).getTime();
    const fifth = new Date(recentPosts[4].created_at).getTime();
    const spanMinutes = (newest - fifth) / 1000 / 60;
    if (spanMinutes < 30) {
      console.log("[chatter] skipped: channel already chatty");
      await markChatterHour(companyHour, companyDate);
      return;
    }
  }

  const lastAuthorId = recentPosts?.[0]?.author_id;
  const candidates = agents.filter((a) => a.id !== lastAuthorId);
  if (candidates.length === 0) {
    await markChatterHour(companyHour, companyDate);
    return;
  }

  // Weight by extraversion
  const weights = candidates.map((a) => Math.max(10, a.personality.big5.extraversion));
  const total = weights.reduce((s, w) => s + w, 0);
  let pick = Math.random() * total;
  let chosen = candidates[0];
  for (let i = 0; i < candidates.length; i++) {
    pick -= weights[i];
    if (pick <= 0) {
      chosen = candidates[i];
      break;
    }
  }

  const recentSummary =
    recentPosts && recentPosts.length > 0
      ? recentPosts
          .slice(0, 5)
          .reverse()
          .map((p) => {
            const author = agents.find((a) => a.id === p.author_id);
            return `[${author?.name ?? "?"}]: ${p.body}`;
          })
          .join("\n")
      : "(channel is empty)";

  const trigger = `Post ONE message in the #watercooler channel. Keep it short - 1 to 3 sentences. Stay in character. Be specific to the moment - reference the time of day, something happening, an observation. Do NOT post a generic greeting. Do NOT introduce yourself. Do NOT explain that you are taking a break - just speak.\n\nIf you have nothing to say right now that would feel authentic, respond with exactly the single word: SKIP`;

  const contextBlock = [
    `Channel you're posting to: #watercooler`,
    `Current company time: ${formatCompanyTime(clock.company_time)}`,
    `This is the casual hangout space. People drop in to comment on the day, share small things, react to office life. NOT for work decisions, NOT for clients, NOT for serious announcements.`,
    ``,
    `Recent posts in #watercooler:`,
    recentSummary,
  ].join("\n");

  const result = await runAgentTurn({
    agent: chosen,
    trigger,
    contextBlock,
    forceTier: "haiku",
    maxTokens: 280,
  });

  if (result.skipped) {
    console.log(`[chatter] ${chosen.name} skipped: ${result.skipped}`);
    await markChatterHour(companyHour, companyDate);
    return;
  }

  const text = result.text.trim();
  if (!text || text.toUpperCase() === "SKIP") {
    console.log(`[chatter] ${chosen.name} declined to post`);
    await markChatterHour(companyHour, companyDate);
    return;
  }

  await postToForum({
    channel: Channels.WATERCOOLER,
    authorId: chosen.id,
    body: text,
    metadata: { ritual: "watercooler_chatter", company_hour: companyHour },
  });

  await db
    .from("agents")
    .update({ chatter_posts_today: chosen.chatter_posts_today + 1 })
    .eq("id", chosen.id);

  console.log(`[chatter] ${chosen.name} posted to #watercooler`);
  await markChatterHour(companyHour, companyDate);
}

async function markChatterHour(companyHour: number, companyDate: string): Promise<void> {
  await db
    .from("ritual_state")
    .update({
      last_chatter_company_hour: companyHour,
      last_chatter_company_date: companyDate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

async function resetCountersIfNewDay(companyDate: string): Promise<void> {
  await db
    .from("agents")
    .update({ chatter_posts_today: 0, last_reset_company_date: companyDate })
    .eq("tenant_id", config.tenantId)
    .neq("last_reset_company_date", companyDate);
}

function formatCompanyTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
