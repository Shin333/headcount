import { db } from "./db.js";
import { config } from "./config.js";
import { runMorningGreeting } from "./rituals/morning-greeting.js";
import { maybeRunChatter } from "./chatter.js";
import { maybeRunReflections } from "./reflection.js";

// ----------------------------------------------------------------------------
// tick.ts - the master scheduler
// ----------------------------------------------------------------------------
// Every TICK_INTERVAL_MS wall ms, advance the company clock by
// TICK_INTERVAL_MS * speed_multiplier and check whether any rituals need to
// fire based on the new company time. Reflections are checked separately on
// a wall-time schedule.
// ----------------------------------------------------------------------------

interface WorldClock {
  id: number;
  tenant_id: string;
  current_tick: number;
  company_time: string;
  speed_multiplier: number;
}

let lastWallReflectionCheck = 0;
let tickCount = 0;

async function loadClock(): Promise<WorldClock | null> {
  const { data } = await db
    .from("world_clock")
    .select("*")
    .eq("id", 1)
    .single();
  return data as WorldClock | null;
}

async function advanceClock(clock: WorldClock): Promise<Date> {
  const advanceMs = config.tickIntervalMs * clock.speed_multiplier;
  const newTime = new Date(new Date(clock.company_time).getTime() + advanceMs);
  await db
    .from("world_clock")
    .update({
      current_tick: clock.current_tick + 1,
      company_time: newTime.toISOString(),
    })
    .eq("id", 1);
  return newTime;
}

export async function tick(): Promise<void> {
  tickCount++;
  const clock = await loadClock();
  if (!clock) {
    console.error("Tick: world_clock missing");
    return;
  }

  const newCompanyTime = await advanceClock(clock);
  const companyHour = newCompanyTime.getUTCHours();
  const companyDate = newCompanyTime.toISOString().substring(0, 10);

  console.log(
    `Tick ${clock.current_tick + 1} - ${formatTime(newCompanyTime)} (company)`
  );

  // ---- Company-time rituals ----

  // Morning greeting at 09:00 (Day 1 ritual)
  if (companyHour === 9) {
    await runMorningGreeting(newCompanyTime, companyDate);
  }

  // Watercooler chatter (Day 2b)
  await maybeRunChatter({
    companyTime: newCompanyTime,
    companyHour,
    companyDate,
  });

  // ---- Wall-time rituals ----

  // Reflection check (only once per wall minute to avoid hammering DB)
  const nowMs = Date.now();
  if (nowMs - lastWallReflectionCheck > 60_000) {
    lastWallReflectionCheck = nowMs;
    await maybeRunReflections(new Date());
  }
}

function formatTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}
