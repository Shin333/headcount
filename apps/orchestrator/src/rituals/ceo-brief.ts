import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { postToForum } from "../comms/forum.js";
import { sendDm, getUnreadDmContextFor, getCompanyDmsSnapshot } from "../comms/dm.js";
import { Channels, AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";

// ----------------------------------------------------------------------------
// rituals/ceo-brief.ts - the daily CEO Brief (Day 3)
// ----------------------------------------------------------------------------
// Runs at 10:00 company time, once per company day, AFTER standup has run.
// Eleanor (Chief of Staff):
//   1. Loads all #standup posts from today
//   2. Synthesizes them into a structured brief
//   3. Posts the brief to #ceo-brief publicly
//   4. Sends the brief as a DM to the CEO sentinel agent
//
// The brief is a single Sonnet call. Larger input than usual (~3000 tokens
// of standup content) so this is the most expensive call per company day.
// ----------------------------------------------------------------------------

// Sentinel UUID for the human CEO. Inserted by seed-ceo.ts.
export const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

interface BriefContext {
  company_time: Date;
  company_date: string;
}

export async function maybeRunCeoBrief(ctx: BriefContext): Promise<void> {
  if (await isOverHourlyCap()) {
    console.log("[brief] skipped: hourly cost cap reached");
    return;
  }

  // Have we already run for this company day?
  const { data: ritualState } = await db
    .from("ritual_state")
    .select("last_ceo_brief_date, last_standup_date")
    .eq("id", 1)
    .maybeSingle();

  if (ritualState?.last_ceo_brief_date === ctx.company_date) {
    return; // already ran today
  }

  // Don't run the brief unless standup has run for the same day
  if (ritualState?.last_standup_date !== ctx.company_date) {
    console.log(`[brief] waiting for standup to complete first (last_standup_date=${ritualState?.last_standup_date})`);
    return;
  }

  // Load Eleanor
  const { data: eleanorRow } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("role", "Chief of Staff")
    .eq("status", "active")
    .maybeSingle();

  if (!eleanorRow) {
    console.warn("[brief] Chief of Staff not found, skipping");
    return;
  }
  const parsedEleanor = AgentSchema.safeParse(eleanorRow);
  if (!parsedEleanor.success) {
    console.warn("[brief] Chief of Staff schema validation failed");
    return;
  }
  const eleanor: Agent = parsedEleanor.data;

  // Load today's standup posts
  const startOfCompanyDay = new Date(ctx.company_date + "T00:00:00Z").toISOString();
  const { data: standupPosts } = await db
    .from("forum_posts")
    .select("author_id, body, created_at")
    .eq("tenant_id", config.tenantId)
    .eq("channel", Channels.STANDUP)
    .gte("created_at", startOfCompanyDay)
    .order("created_at", { ascending: true })
    .limit(20);

  if (!standupPosts || standupPosts.length === 0) {
    console.warn("[brief] no standup posts found for today, skipping");
    return;
  }

  // Build a name lookup for the standup authors
  const authorIds = Array.from(new Set(standupPosts.map((p) => p.author_id)));
  const { data: authors } = await db
    .from("agents")
    .select("id, name, role")
    .in("id", authorIds);
  const agentInfo = new Map<string, { name: string; role: string }>();
  for (const a of authors ?? []) {
    agentInfo.set(a.id, { name: a.name, role: a.role });
  }

  const standupContent = standupPosts
    .map((p) => {
      const info = agentInfo.get(p.author_id);
      return `**${info?.name ?? "Unknown"}** (${info?.role ?? "Unknown"}):\n${p.body}`;
    })
    .join("\n\n---\n\n");

  const trigger = `Read the standup posts from your direct reports below. Synthesize them into a CEO Brief - a one-pager the CEO can read in 60 seconds and know the state of the company.

Structure your brief in exactly this format (use these headers, fill in the content):

# CEO Brief - ${ctx.company_date}

## The shape of the day
(2-3 sentences. The overall feel. Quiet day, busy day, tense day, what is the energy.)

## Key items
(3-5 bullets. The things that actually matter today. Not status dumps - decisions, deals, blockers, real things.)

## Escalations
(Anything you think needs Shin's direct attention. Be specific about who and what. If nothing, say "Nothing needs you today.")

## Risks I am watching
(2-3 bullets max. Things that aren't urgent yet but could become so.)

Stay in your voice - dry, observant, edited. Cut anything that does not earn its place. If today is genuinely quiet, the brief should be short. Quiet briefs are correct briefs on quiet days. Do not invent drama.`;

  // Day 4: fetch Eleanor's own unread DMs (including any from CEO)
  const eleanorUnreadDms = await getUnreadDmContextFor(eleanor.id);

  // Day 4: get a tenant-wide DM activity snapshot since start of company day
  const startOfCompanyDayIso = new Date(ctx.company_date + "T00:00:00Z").toISOString();
  const dmSnapshot = await getCompanyDmsSnapshot(startOfCompanyDayIso);

  const dmActivityLine =
    dmSnapshot.totalCount > 0
      ? `DM activity today: ${dmSnapshot.totalCount} messages (${dmSnapshot.fromCeoCount} from CEO, ${dmSnapshot.toCeoCount} to CEO)`
      : `DM activity today: none`;

  const contextBlock = [
    eleanorUnreadDms, // empty string if no unread DMs - safe to concat
    `You are writing the CEO Brief for ${ctx.company_date}.`,
    `Current company time: ${formatCompanyTime(ctx.company_time)}`,
    dmActivityLine,
    ``,
    `Here are today's standup posts from your team:`,
    ``,
    standupContent,
  ].filter(Boolean).join("\n");

  const result = await runAgentTurn({
    agent: eleanor,
    trigger,
    contextBlock,
    maxTokens: 1200,
  });

  if (result.skipped) {
    console.log(`[brief] Eleanor skipped: ${result.skipped}`);
    return;
  }

  const briefText = result.text.trim();
  if (!briefText) {
    console.log("[brief] Eleanor returned empty - skipping");
    return;
  }

  // Post to #ceo-brief publicly
  await postToForum({
    channel: Channels.CEO_BRIEF,
    authorId: eleanor.id,
    body: briefText,
    metadata: {
      ritual: "ceo_brief",
      company_date: ctx.company_date,
      standup_post_count: standupPosts.length,
    },
  });

  console.log(`[brief] Eleanor posted CEO Brief to #ceo-brief`);

  // ALSO send as a DM to the CEO sentinel
  try {
    await sendDm({
      fromId: eleanor.id,
      toId: CEO_SENTINEL_ID,
      body: briefText,
    });
    console.log(`[brief] Eleanor DM'd CEO Brief to CEO`);
  } catch (err) {
    console.error(`[brief] failed to DM brief to CEO:`, err);
    // Non-fatal - the public post succeeded
  }

  // Mark complete - with loud failure if the write doesn't actually land
  const { error: markErr } = await db
    .from("ritual_state")
    .update({
      last_ceo_brief_date: ctx.company_date,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (markErr) {
    console.error(`[brief] FAILED to mark complete: ${markErr.message}`);
    console.error(`[brief] This usually means the 0004_day3.sql migration was not run.`);
    return;
  }

  const { data: verify } = await db
    .from("ritual_state")
    .select("last_ceo_brief_date")
    .eq("id", 1)
    .maybeSingle();

  if (verify?.last_ceo_brief_date !== ctx.company_date) {
    console.error(`[brief] FAILED to verify mark-complete write. Expected ${ctx.company_date}, got ${verify?.last_ceo_brief_date}`);
    return;
  }

  console.log(`[brief] complete for ${ctx.company_date}`);
}

function formatCompanyTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
