import { config } from "../config.js";
import { advanceClock, formatCompanyTime, type WorldClock } from "./clock.js";
import { runMorningGreeting } from "../rituals/morning-greeting.js";
import { maybeRunChatter } from "../rituals/chatter.js";
import { maybeRunReflections, forceReflection } from "../rituals/reflection.js";
import { maybeRunStandup } from "../rituals/standup.js";
import { maybeRunCeoBrief } from "../rituals/ceo-brief.js";
import { maybeRunDmResponder } from "../rituals/dm-responder.js";
import { handleProjectMessage } from "../rituals/project-responder.js";
import { maybeRunDailyReset } from "../rituals/daily-reset.js";
import { maybeRunReportScheduler } from "../rituals/report-runner.js";
import { maybeRunStallDetector } from "../rituals/stall-detector.js";
import { maybeRunProjectHeartbeat } from "../rituals/project-heartbeat.js";
import { db } from "../db.js";

let running = false;
let lastWallReflectionCheck = 0;

// Day 16 (Phase B): event-driven DM processing.
// Instead of only polling for unread DMs every 5-second tick, we also
// subscribe to Supabase realtime INSERT events on the dms table. When a
// new DM is inserted, the handler fires maybeRunDmResponder immediately,
// cutting response latency from 0-5000ms to ~50ms.
//
// Mutex: dmResponderRunning prevents double-processing if a realtime event
// fires while a tick-triggered DM responder is already mid-flight (or vice
// versa). The DM responder itself is safe to call concurrently (it only
// processes one DM per call, and marks it read before returning), but the
// mutex avoids wasted API calls where both paths grab the same DM.
let dmResponderRunning = false;
let lastClock: WorldClock | null = null;

async function runDmResponderGuarded(): Promise<void> {
  if (dmResponderRunning) return;
  if (!lastClock) return; // haven't had first tick yet
  dmResponderRunning = true;
  try {
    await maybeRunDmResponder(lastClock);
  } catch (err) {
    console.error("[dm-realtime] error in event-driven DM responder:", err);
  } finally {
    dmResponderRunning = false;
  }
}

function startDmRealtimeSubscription(): void {
  const channel = db.channel("dm-inserts");

  channel
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "dms",
      },
      (_payload) => {
        // Fire-and-forget: process the new DM immediately.
        // We don't use payload.new directly because maybeRunDmResponder
        // already queries for the oldest unread actionable DM. The realtime
        // event just tells us "something arrived, go check now."
        void runDmResponderGuarded();
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[dm-realtime] subscribed to dms INSERT events — DM processing is now event-driven");
      } else if (status === "CHANNEL_ERROR") {
        console.warn("[dm-realtime] channel error — falling back to tick-based polling");
      } else if (status === "TIMED_OUT") {
        console.warn("[dm-realtime] subscription timed out — falling back to tick-based polling");
      }
    });
}

// Day 17: project channel realtime subscription. When a new message is
// posted to a project channel, immediately trigger the project-responder
// to check which members should react.
function startProjectChannelSubscription(): void {
  const channel = db.channel("project-message-inserts");

  channel
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "project_messages",
      },
      (payload) => {
        // Extract the project_id, agent_id (sender), and message id from
        // the realtime payload so the project-responder knows which room
        // and who sent it without an extra query.
        const row = payload.new as {
          id?: string;
          project_id?: string;
          agent_id?: string;
        } | undefined;

        if (!row?.id || !row?.project_id || !row?.agent_id) {
          console.warn("[project-realtime] incomplete payload, skipping");
          return;
        }

        if (!lastClock) return; // haven't had first tick yet

        void handleProjectMessage(row.id, row.project_id, row.agent_id, lastClock);
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[project-realtime] subscribed to project_messages INSERT events — meeting rooms are live");
      } else if (status === "CHANNEL_ERROR") {
        console.warn("[project-realtime] channel error — project channels will use tick fallback only");
      } else if (status === "TIMED_OUT") {
        console.warn("[project-realtime] subscription timed out — project channels will use tick fallback only");
      }
    });
}

export function startTickLoop(): void {
  if (running) return;
  running = true;

  console.log(`Tick loop starting (interval: ${config.tickIntervalMs}ms, speed: ${config.speedMultiplier}x)`);

  // Day 16: start the realtime DM subscription so DMs are processed
  // immediately on insert, not just at the next tick boundary.
  startDmRealtimeSubscription();

  // Day 17: start the project channel subscription so agents react
  // to each other's work immediately in the meeting room.
  startProjectChannelSubscription();

  const loop = async () => {
    if (!running) return;
    try {
      const clock = await advanceClock();
      lastClock = clock; // stash for the realtime handler
      await onTick(clock);
    } catch (err) {
      console.error("Tick error:", err);
    } finally {
      setTimeout(loop, config.tickIntervalMs);
    }
  };

  loop();
}

export function stopTickLoop(): void {
  running = false;
}

// Day 9d: lastGreetingDate is in-memory for fast-path skipping after the
// first check of the day. On orchestrator restart it resets to null, which
// would cause a duplicate morning greeting. We back it up with a forum_posts
// query the first time we see hour>=9 each process lifetime.
let lastGreetingDate: string | null = null;
let lastGreetingChecked: string | null = null;

async function alreadyGreetedToday(dateKey: string): Promise<boolean> {
  const { data } = await db
    .from("forum_posts")
    .select("id")
    .eq("tenant_id", config.tenantId)
    .gte("created_at", dateKey + "T00:00:00Z")
    .filter("metadata->>ritual", "eq", "morning_greeting")
    .limit(1);
  return !!(data && data.length > 0);
}

async function onTick(clock: WorldClock): Promise<void> {
  console.log(`Tick ${clock.current_tick} - ${formatCompanyTime(clock.company_time)}`);

  // ---- Day 2b: process dashboard force-reflection triggers FIRST (snappy feedback) ----
  await processReflectionTriggers();

  // ---- Day 5.1: daily reset of per-agent token counters (idempotent, once per company day) ----
  await maybeRunDailyReset(clock);

  // ---- Day 4.5: always-on DM responder (runs every tick regardless of company time) ----
  // Day 16: this now uses the guarded runner so it doesn't conflict with
  // the event-driven realtime handler. The tick-based call acts as a
  // fallback in case the realtime subscription drops — it'll catch any
  // unread DMs that the realtime handler missed.
  await runDmResponderGuarded();

  // ---- Day 6: always-on report scheduler (fires due report rituals, 1 per tick max) ----
  await maybeRunReportScheduler(clock);

  // ---- Day 18: stall detector (throttled internally to every 5 wall minutes) ----
  await maybeRunStallDetector(clock);

  // ---- Day 21+25: project heartbeat (throttled internally to every 5 wall minutes) ----
  // Proactively gives agents with overdue commitments a turn to produce work,
  // even when the channel is quiet. One agent per project per cycle.
  await maybeRunProjectHeartbeat(clock);

  const hour = clock.company_time.getUTCHours();
  const minute = clock.company_time.getUTCMinutes();
  const dateKey = clock.company_time.toISOString().substring(0, 10);

  // ---- Day 1: Morning greeting at 09:00, once per company day ----
  // Day 9d: on first encounter of a new date this process lifetime,
  // check forum_posts to see if a previous orchestrator instance already
  // posted today. Avoids duplicate greetings on restart.
  if (hour >= 9 && lastGreetingDate !== dateKey) {
    if (lastGreetingChecked !== dateKey) {
      lastGreetingChecked = dateKey;
      if (await alreadyGreetedToday(dateKey)) {
        lastGreetingDate = dateKey;
      }
    }
    if (lastGreetingDate !== dateKey) {
      lastGreetingDate = dateKey;
      console.log(`Triggering morning greeting for ${dateKey}`);
      await runMorningGreeting();
    }
  }

  // ---- Day 3: Standup ritual at 09:30 company time, once per company day ----
  // Triggers any time at-or-after 09:30 (the maybeRunStandup function gates
  // on its own once-per-company-day flag in ritual_state)
  if (hour > 9 || (hour === 9 && minute >= 30)) {
    await maybeRunStandup({
      company_time: clock.company_time,
      company_date: dateKey,
    });
  }

  // ---- Day 3: CEO Brief at 10:00 company time, once per company day ----
  // Triggers any time at-or-after 10:00 (gates on its own ritual_state flag,
  // and also waits for standup to have completed for the same day)
  if (hour >= 10) {
    await maybeRunCeoBrief({
      company_time: clock.company_time,
      company_date: dateKey,
    });
  }

  // ---- Day 2b: Watercooler chatter (runs only during office hours, own gating) ----
  await maybeRunChatter(clock);

  // ---- Day 2b: Wall-time reflection check (throttled to once per wall minute) ----
  const nowMs = Date.now();
  if (nowMs - lastWallReflectionCheck > 60_000) {
    lastWallReflectionCheck = nowMs;
    await maybeRunReflections(new Date());
  }
}

// ----------------------------------------------------------------------------
// processReflectionTriggers - drains the dashboard force-reflection queue
// ----------------------------------------------------------------------------

async function processReflectionTriggers(): Promise<void> {
  const { data: triggers } = await db
    .from("reflection_triggers")
    .select("id, agent_id")
    .eq("tenant_id", config.tenantId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(3);

  if (!triggers || triggers.length === 0) return;

  for (const trigger of triggers) {
    console.log(`[trigger] processing forced reflection ${trigger.id}`);
    try {
      const result = await forceReflection(trigger.agent_id);
      await db
        .from("reflection_triggers")
        .update({
          status: result === "ok" ? "processed" : "error",
          result,
          error_message: result === "ok" ? null : `Reflection result: ${result}`,
          processed_at: new Date().toISOString(),
        })
        .eq("id", trigger.id);
      console.log(`[trigger] ${trigger.id} -> ${result}`);
    } catch (err) {
      console.error(`[trigger] ${trigger.id} failed:`, err);
      await db
        .from("reflection_triggers")
        .update({
          status: "error",
          error_message: String(err),
          processed_at: new Date().toISOString(),
        })
        .eq("id", trigger.id);
    }
  }
}
