import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { postToForum } from "../comms/forum.js";
import { getUnreadDmContextFor } from "../comms/dm.js";
import { Channels, AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";

// ----------------------------------------------------------------------------
// rituals/standup.ts - the daily standup (Day 3, expanded Day 7)
// ----------------------------------------------------------------------------
// Runs at 09:30 company time, once per company day. All agents with
// in_standup=true post structured updates to #standup in a fixed order
// determined by department display_order, then tier (exec → manager).
//
// Day 7: filter is now data-driven — every agent with `in_standup=true AND
// is_human=false AND status='active'` participates. The Shin Park CEO row
// (is_human=true) is excluded. Dormant specialists (always_on=false) are
// excluded by definition.
//
// Cost: each post is a Sonnet call. With ~10 standup seats post-Day 7,
// roughly $0.05 per standup, ~$1.20 per wall day at 60x speed.
//
// Why some managers are in standup but not all: PA-tier roles like Evie
// have unique cross-functional intel that doesn't surface through their
// "manager" otherwise. Most ICs do not — their state surfaces through
// their director's post.
// ----------------------------------------------------------------------------

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

  // Day 7: pull all standup participants via filter, not hardcoded list.
  // Filter: active, non-human, in_standup=true. Order: Eleanor first
  // (she runs the meeting), then by department display_order, then tier.
  const { data: participantRows, error: participantErr } = await db
    .from("agents")
    .select("*, departments!inner(display_order)")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active")
    .eq("is_human", false)
    .eq("in_standup", true);

  if (participantErr) {
    // Fallback path: the join may fail if departments table is missing or
    // a participant's department doesn't have a row. Fall back to a plain
    // query without ordering and let the constant Eleanor-first logic handle
    // the rest.
    console.warn(`[standup] department join failed (${participantErr.message}), falling back to plain query`);
  }

  let rawParticipants: Array<Record<string, unknown>> = participantRows ?? [];

  if (!participantRows || participantRows.length === 0) {
    const { data: fallbackRows } = await db
      .from("agents")
      .select("*")
      .eq("tenant_id", config.tenantId)
      .eq("status", "active")
      .eq("is_human", false)
      .eq("in_standup", true);
    rawParticipants = fallbackRows ?? [];
  }

  if (rawParticipants.length === 0) {
    console.warn("[standup] no participants found via filter, skipping");
    return;
  }

  // Parse and sort: Eleanor first, then by department display_order, then by
  // tier (exec before manager). Stable secondary sort by name for determinism.
  const tierOrder: Record<string, number> = { exec: 0, director: 1, manager: 2, associate: 3, intern: 4, bot: 5 };

  const parsed: Agent[] = [];
  for (const raw of rawParticipants) {
    const result = AgentSchema.safeParse(raw);
    if (!result.success) {
      console.warn(`[standup] schema validation failed for ${(raw as { name?: string }).name ?? "unknown"}`);
      continue;
    }
    parsed.push(result.data);
  }

  // We need department display_order. The join may have given it to us; if
  // not, query it once and build a lookup.
  const deptOrder = new Map<string, number>();
  for (const raw of rawParticipants) {
    const dept = (raw as { departments?: { display_order?: number } }).departments;
    const slug = (raw as { department?: string }).department;
    if (dept?.display_order !== undefined && slug) {
      deptOrder.set(slug, dept.display_order);
    }
  }
  if (deptOrder.size === 0) {
    const { data: deptRows } = await db
      .from("departments")
      .select("slug, display_order")
      .eq("tenant_id", config.tenantId);
    for (const d of deptRows ?? []) {
      deptOrder.set(d.slug as string, d.display_order as number);
    }
  }

  parsed.sort((a, b) => {
    // Chief of Staff (Eleanor) always opens
    if (a.role === "Chief of Staff") return -1;
    if (b.role === "Chief of Staff") return 1;
    const ao = deptOrder.get(a.department ?? "") ?? 999;
    const bo = deptOrder.get(b.department ?? "") ?? 999;
    if (ao !== bo) return ao - bo;
    const at = tierOrder[a.tier] ?? 999;
    const bt = tierOrder[b.tier] ?? 999;
    if (at !== bt) return at - bt;
    return a.name.localeCompare(b.name);
  });

  const participants: Agent[] = parsed;
  console.log(`[standup] ${participants.length} participants in order: ${participants.map((p) => p.name).join(" → ")}`);

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

    // Day 4: fetch unread DMs for this agent (also marks them read)
    const unreadDmContext = await getUnreadDmContextFor(agent.id);

    const contextBlock = [
      unreadDmContext, // empty string if no unread DMs - safe to concat
      `Channel you are posting to: #standup`,
      `Current company time: ${formatCompanyTime(ctx.company_time)}`,
      buildTimeGrounding(ctx.company_time),
      ``,
      `This is the daily standup. Your team and the rest of the directors will read this. The CEO will read a synthesis of all standup posts from the Chief of Staff later this morning.`,
      ``,
      `Recent activity in the company forum (last 20 posts across all channels):`,
      recentForumSummary || "(forum is empty - this is the very first standup)",
    ].filter(Boolean).join("\n");

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

// Day 8: time grounding. Inject grounded calendar facts so agents stop
// confabulating phrases like "Day 3 of Q1" on actual Day 27. The forum
// context window is enough to give agents social memory, but it's not
// enough to give them an accurate calendar — they need explicit facts.
//
// Returns a multi-line string ready to be inserted into a prompt context block.
export function buildTimeGrounding(d: Date): string {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  const day = d.getUTCDate();

  // Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec
  const quarter = Math.floor((month - 1) / 3) + 1;
  const quarterStartMonth = (quarter - 1) * 3 + 1; // 1, 4, 7, 10
  const quarterStart = new Date(Date.UTC(year, quarterStartMonth - 1, 1));
  const msPerDay = 24 * 60 * 60 * 1000;
  const dayOfQuarter = Math.floor((d.getTime() - quarterStart.getTime()) / msPerDay) + 1;

  // Days since Jan 1 of this year (1-indexed)
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((d.getTime() - yearStart.getTime()) / msPerDay) + 1;

  // ISO week number
  const tempDate = new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));
  tempDate.setUTCDate(tempDate.getUTCDate() + 4 - (tempDate.getUTCDay() || 7));
  const yearStartIso = new Date(Date.UTC(tempDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((tempDate.getTime() - yearStartIso.getTime()) / msPerDay + 1) / 7);

  // Day of week
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayOfWeek = dayNames[d.getUTCDay()] ?? "Unknown";

  return [
    `Calendar facts (do not contradict these):`,
    `- Today is ${dayOfWeek}, ${formatCompanyTime(d).slice(0, 10)}.`,
    `- This is Day ${dayOfQuarter} of Q${quarter} ${year}.`,
    `- Week ${weekNumber} of ${year}. Day ${dayOfYear} of the year.`,
  ].join("\n");
}
