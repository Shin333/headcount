import { db } from "./db.js";
import { config } from "./config.js";
import { run, isOverHourlyCap } from "./runner.js";
import { Channels } from "@headcount/shared";
import type { Agent, ForumPost } from "@headcount/shared";

// ----------------------------------------------------------------------------
// chatter.ts - the #watercooler ritual
// ----------------------------------------------------------------------------
// Runs once per company hour. Picks one or two agents who have something to
// say, gives them recent context, and lets them post a casual message.
//
// Smart skipping rules:
//   - Skip agents who already hit their per-company-day cap
//   - Skip if last 5 watercooler posts were within 30 company minutes (the
//     channel is already chatty)
//   - Skip if any agent's last post was within 60 company minutes
//   - Skip Uncle Tan if he was the last poster (don't let him spam)
// ----------------------------------------------------------------------------

interface ChatterContext {
  companyTime: Date;
  companyHour: number;
  companyDate: string; // YYYY-MM-DD
}

export async function maybeRunChatter(ctx: ChatterContext): Promise<void> {
  if (!config.chatterEnabled) return;
  if (await isOverHourlyCap()) {
    console.log("[chatter] skipped: hourly cost cap reached");
    return;
  }

  // Have we already run for this company hour?
  const { data: ritualState } = await db
    .from("ritual_state")
    .select("last_chatter_company_hour, last_chatter_company_date")
    .eq("id", 1)
    .single();

  if (
    ritualState?.last_chatter_company_date === ctx.companyDate &&
    ritualState?.last_chatter_company_hour === ctx.companyHour
  ) {
    return; // already ran this company hour
  }

  // Only run during "office hours" company-time (9-18)
  if (ctx.companyHour < 9 || ctx.companyHour >= 18) {
    await markChatterHour(ctx);
    return;
  }

  // Reset chatter counters at company midnight
  await resetCountersIfNewDay(ctx.companyDate);

  // Load eligible agents
  const { data: agents } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active")
    .lt("chatter_posts_today", config.chatterPostsPerAgentPerDay);

  if (!agents || agents.length === 0) {
    await markChatterHour(ctx);
    return;
  }

  // Recent watercooler context
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
      await markChatterHour(ctx);
      return;
    }
  }

  // Pick an agent: weighted by extraversion + recency penalty
  const lastAuthorId = recentPosts?.[0]?.author_id;
  const candidates = (agents as Agent[]).filter((a) => a.id !== lastAuthorId);
  if (candidates.length === 0) {
    await markChatterHour(ctx);
    return;
  }

  // Weight by extraversion - higher = more likely to chime in
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

  // Build the chatter prompt
  const recentSummary =
    recentPosts && recentPosts.length > 0
      ? recentPosts
          .slice(0, 5)
          .reverse()
          .map((p) => {
            const author = (agents as Agent[]).find((a) => a.id === p.author_id);
            return `[${author?.name ?? "?"}]: ${p.body}`;
          })
          .join("\n")
      : "(channel is empty)";

  const userPrompt = `It is ${formatCompanyTime(ctx.companyTime)} company time.

You are in the #watercooler channel. This is the casual hangout space. People drop in to comment on the day, share small things, react to office life. It is NOT for work decisions, NOT for clients, NOT for serious announcements.

Recent posts in #watercooler:
${recentSummary}

Post ONE message. Keep it short - 1 to 3 sentences. Stay in character. Be specific to the moment - reference the time of day, something happening, an observation. Do NOT post a generic greeting. Do NOT introduce yourself. Do NOT explain that you are taking a break - just speak.

If you have nothing to say right now that would feel authentic, respond with exactly the single word: SKIP

Your post:`;

  const result = await run({
    agent: chosen,
    userPrompt,
    forceTier: "haiku", // chatter is always Haiku regardless of agent's normal tier
    maxTokens: 280,
    context: "watercooler_chatter",
  });

  if (result.skipped) {
    console.log(`[chatter] ${chosen.name} skipped: ${result.skipped}`);
    await markChatterHour(ctx);
    return;
  }

  const text = result.text.trim();
  if (!text || text === "SKIP" || text.toUpperCase() === "SKIP") {
    console.log(`[chatter] ${chosen.name} declined to post`);
    await markChatterHour(ctx);
    return;
  }

  // Post it
  await db.from("forum_posts").insert({
    tenant_id: config.tenantId,
    channel: Channels.WATERCOOLER,
    author_id: chosen.id,
    body: text,
    metadata: { ritual: "watercooler_chatter", company_hour: ctx.companyHour },
  });

  // Increment counter
  await db
    .from("agents")
    .update({ chatter_posts_today: chosen.chatter_posts_today + 1 })
    .eq("id", chosen.id);

  console.log(`[chatter] ${chosen.name} posted to #watercooler`);
  await markChatterHour(ctx);
}

async function markChatterHour(ctx: ChatterContext): Promise<void> {
  await db
    .from("ritual_state")
    .update({
      last_chatter_company_hour: ctx.companyHour,
      last_chatter_company_date: ctx.companyDate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

async function resetCountersIfNewDay(companyDate: string): Promise<void> {
  // Reset chatter_posts_today for any agent whose last_reset_company_date != today
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
