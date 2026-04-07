import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { postToForum } from "../comms/forum.js";
import { Channels, AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";

// ----------------------------------------------------------------------------
// rituals/standup.ts - the daily standup (Day 3)
// ----------------------------------------------------------------------------
// Runs at 09:30 company time, once per company day. Six designated agents
// post structured updates to #standup in a fixed order:
//
//   1. Eleanor Vance       (Chief of Staff)         - opens, sets the shape
//   2. Han Jae-won         (Director of Strategy)   - strategic priorities
//   3. Tessa Goh           (Director of Marketing)  - brand and content state
//   4. Bradley Koh         (Director of Sales)      - pipeline and deals
//   5. Tsai Wei-Ming       (Director of Engineering) - shipping and blockers
//   6. Hoshino Ayaka       (Reality Checker)        - risks she is tracking
//
// Each post is a Sonnet call. Total per company day: ~6 Sonnet calls.
// At 60x speed: ~$0.72 wall-day cost for standup alone.
//
// Why directors only (not managers): directors carry cross-functional context.
// Managers' tactical state surfaces through their director's post.
// ----------------------------------------------------------------------------

const STANDUP_ROLES_IN_ORDER = [
  "Chief of Staff",
  "Director of Strategy & Innovation",
  "Director of Marketing",
  "Director of Sales",
  "Director of Engineering",
  "Reality Checker (Quality & Risk)",
];

interface StandupContext {
  company_time: Date;
  company_date: string; // YYYY-MM-DD
}

export async function maybeRunStandup(ctx: StandupContext): Promise<void> {
  if (await isOverHourlyCap()) {
    console.log("[standup] skipped: hourly cost cap reached");
    return;
  }

  // Have we already run for this company day?
  const { data: ritualState } = await db
    .from("ritual_state")
    .select("last_standup_date")
    .eq("id", 1)
    .maybeSingle();

  if (ritualState?.last_standup_date === ctx.company_date) {
    return; // already ran today
  }

  console.log(`[standup] running for ${ctx.company_date}`);

  // Load the 6 standup participants in order
  const participants: Agent[] = [];
  for (const role of STANDUP_ROLES_IN_ORDER) {
    const { data: row } = await db
      .from("agents")
      .select("*")
      .eq("tenant_id", config.tenantId)
      .eq("role", role)
      .eq("status", "active")
      .maybeSingle();

    if (!row) {
      console.warn(`[standup] participant not found or inactive: ${role}`);
      continue;
    }
    const parsed = AgentSchema.safeParse(row);
    if (!parsed.success) {
      console.warn(`[standup] schema validation failed for ${role}`);
      continue;
    }
    participants.push(parsed.data);
  }

  if (participants.length === 0) {
    console.warn("[standup] no participants loaded, skipping");
    return;
  }

  // Pull recent forum context once - same context for all participants
  const { data: recentPostsRaw } = await db
    .from("forum_posts")
    .select("channel, author_id, body, created_at")
    .eq("tenant_id", config.tenantId)
    .order("created_at", { ascending: false })
    .limit(30);

  // Build a name lookup
  const { data: allAgents } = await db
    .from("agents")
    .select("id, name, role")
    .eq("tenant_id", config.tenantId);
  const nameById = new Map<string, string>();
  for (const a of allAgents ?? []) {
    nameById.set(a.id, `${a.name}`);
  }

  const recentForumSummary = (recentPostsRaw ?? [])
    .slice(0, 20)
    .reverse()
    .map((p) => `[#${p.channel}] ${nameById.get(p.author_id) ?? "?"}: ${p.body}`)
    .join("\n");

  // Run each participant in sequence
  for (const agent of participants) {
    if (await isOverHourlyCap()) {
      console.log(`[standup] cost cap reached, skipping remaining participants`);
      break;
    }

    const trigger = buildStandupTrigger(agent.role);

    const contextBlock = [
      `Channel you are posting to: #standup`,
      `Current company time: ${formatCompanyTime(ctx.company_time)}`,
      `Today is ${ctx.company_date}.`,
      ``,
      `This is the daily standup. Your team and the rest of the directors will read this. The CEO will read a synthesis of all standup posts from the Chief of Staff later this morning.`,
      ``,
      `Recent activity in the company forum (last 20 posts across all channels):`,
      recentForumSummary || "(forum is empty - this is the very first standup)",
    ].join("\n");

    const result = await runAgentTurn({
      agent,
      trigger,
      contextBlock,
      maxTokens: 500,
    });

    if (result.skipped) {
      console.log(`[standup] ${agent.name} skipped: ${result.skipped}`);
      continue;
    }

    const text = result.text.trim();
    if (!text) {
      console.log(`[standup] ${agent.name} returned empty - skipping post`);
      continue;
    }

    await postToForum({
      channel: Channels.STANDUP,
      authorId: agent.id,
      body: text,
      metadata: { ritual: "standup", company_date: ctx.company_date },
    });

    console.log(`[standup] ${agent.name} posted to #standup`);
  }

  // Mark complete - with loud failure if the write doesn't actually land
  const { error: markErr } = await db
    .from("ritual_state")
    .update({
      last_standup_date: ctx.company_date,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (markErr) {
    console.error(`[standup] FAILED to mark complete: ${markErr.message}`);
    console.error(`[standup] This usually means the 0004_day3.sql migration was not run.`);
    console.error(`[standup] Run this in Supabase SQL editor:`);
    console.error(`[standup]   alter table ritual_state add column if not exists last_standup_date date;`);
    console.error(`[standup]   alter table ritual_state add column if not exists last_ceo_brief_date date;`);
    return;
  }

  // Verify the write actually landed by reading it back
  const { data: verify } = await db
    .from("ritual_state")
    .select("last_standup_date")
    .eq("id", 1)
    .maybeSingle();

  if (verify?.last_standup_date !== ctx.company_date) {
    console.error(`[standup] FAILED to verify mark-complete write. Expected ${ctx.company_date}, got ${verify?.last_standup_date}`);
    console.error(`[standup] The 0004_day3.sql migration may not have been run, or last_standup_date column is missing.`);
    return;
  }

  console.log(`[standup] complete for ${ctx.company_date}`);
}

function buildStandupTrigger(role: string): string {
  // Each role gets a slightly tailored prompt that matches what their job
  // would actually report on. Keeps standups from sounding generic.
  const base = `Post your daily standup to #standup. Keep it under 80 words. Use this structure (no headers, just three short paragraphs):
1. What you are focused on today
2. Anything blocking you or anyone you depend on
3. One thing you want the CEO or the rest of leadership to know

Stay in your voice. Be specific. Do not write a generic status update - real standups have texture. If today is genuinely quiet, say so. Do not invent drama.`;

  if (role === "Chief of Staff") {
    return `${base}\n\nAs Chief of Staff, your standup sets the shape of the day. Read the room before you write. What is the company actually facing today?`;
  }
  if (role === "Reality Checker (Quality & Risk)") {
    return `${base}\n\nAs Reality Checker, your standup is where you flag risks early. What are you watching that nobody else is watching yet? Be specific.`;
  }
  return base;
}

function formatCompanyTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
