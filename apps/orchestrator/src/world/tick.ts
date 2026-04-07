import { config } from "../config.js";
import { advanceClock, formatCompanyTime, type WorldClock } from "./clock.js";
import { runMorningGreeting } from "../rituals/morning-greeting.js";
import { maybeRunChatter } from "../rituals/chatter.js";
import { maybeRunReflections, forceReflection } from "../rituals/reflection.js";
import { maybeRunStandup } from "../rituals/standup.js";
import { maybeRunCeoBrief } from "../rituals/ceo-brief.js";
import { maybeRunDmResponder } from "../rituals/dm-responder.js";
import { maybeRunDailyReset } from "../rituals/daily-reset.js";
import { db } from "../db.js";

let running = false;
let lastWallReflectionCheck = 0;

export function startTickLoop(): void {
  if (running) return;
  running = true;

  console.log(`Tick loop starting (interval: ${config.tickIntervalMs}ms, speed: ${config.speedMultiplier}x)`);

  const loop = async () => {
    if (!running) return;
    try {
      const clock = await advanceClock();
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

// Day 1 morning greeting tracking (in-memory, preserved exactly).
let lastGreetingDate: string | null = null;

async function onTick(clock: WorldClock): Promise<void> {
  console.log(`Tick ${clock.current_tick} - ${formatCompanyTime(clock.company_time)}`);

  // ---- Day 2b: process dashboard force-reflection triggers FIRST (snappy feedback) ----
  await processReflectionTriggers();

  // ---- Day 5.1: daily reset of per-agent token counters (idempotent, once per company day) ----
  await maybeRunDailyReset(clock);

  // ---- Day 4.5: always-on DM responder (runs every tick regardless of company time) ----
  await maybeRunDmResponder(clock);

  const hour = clock.company_time.getUTCHours();
  const minute = clock.company_time.getUTCMinutes();
  const dateKey = clock.company_time.toISOString().substring(0, 10);

  // ---- Day 1: Morning greeting at 09:00, once per company day ----
  if (hour >= 9 && lastGreetingDate !== dateKey) {
    lastGreetingDate = dateKey;
    console.log(`Triggering morning greeting for ${dateKey}`);
    await runMorningGreeting();
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
