import { db } from "../db.js";
import { config } from "../config.js";

export interface WorldClock {
  current_tick: number;
  company_time: Date;
  speed_multiplier: number;
  paused: boolean;
}

export async function getWorldClock(): Promise<WorldClock> {
  const { data, error } = await db
    .from("world_clock")
    .select("*")
    .eq("id", 1)
    .single();

  if (error || !data) {
    throw new Error("Failed to load world clock: " + error?.message);
  }

  return {
    current_tick: Number(data.current_tick),
    company_time: new Date(data.company_time),
    speed_multiplier: Number(data.speed_multiplier),
    paused: data.paused,
  };
}

export async function advanceClock(): Promise<WorldClock> {
  const current = await getWorldClock();
  if (current.paused) return current;

  const advanceMs = config.tickIntervalMs * current.speed_multiplier;
  const newCompanyTime = new Date(current.company_time.getTime() + advanceMs);
  const newTick = current.current_tick + 1;

  const { error } = await db
    .from("world_clock")
    .update({
      current_tick: newTick,
      company_time: newCompanyTime.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (error) throw new Error("Failed to advance clock: " + error.message);

  return {
    ...current,
    current_tick: newTick,
    company_time: newCompanyTime,
  };
}

export function formatCompanyTime(d: Date): string {
  return d.toISOString().replace("T", " ").substring(0, 19) + " (company)";
}
