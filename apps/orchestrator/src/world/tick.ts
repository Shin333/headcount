import { config } from "../config.js";
import { advanceClock, formatCompanyTime, type WorldClock } from "./clock.js";
import { runMorningGreeting } from "../rituals/morning-greeting.js";
import { maybeRunChatter } from "../rituals/chatter.js";
import { maybeRunReflections, forceReflection } from "../rituals/reflection.js";
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

// Day 1 morning greeting tracking (preserved exactly).
let lastGreetingDate: string | null = null;

async function onTick(clock: WorldClock): Promise<void> {
  console.log(`Tick ${clock.current_tick} - ${formatCompanyTime(clock.company_time)}`);

  // ---- Day 2b: process dashboard force-reflection triggers FIRST (snappy feedback) ----
  await processReflectionTriggers();

  const hour = clock.company_time.getUTCHours();
  const dateKey = clock.company_time.toISOString().substring(0, 10);

  // Day 1: Morning greeting at 09:xx company time, once per company day
  if (hour >= 9 && lastGreetingDate !== dateKey) {
    lastGreetingDate = dateKey;
    console.log(`Triggering morning greeting for ${dateKey}`);
    await runMorningGreeting();
  }

  // Day 2b: Watercooler chatter (own ritual gating, runs only during office hours)
  await maybeRunChatter(clock);

  // Day 2b: Wall-time reflection check (throttled to once per wall minute)
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
