import { config } from "../config.js";
import { advanceClock, formatCompanyTime, type WorldClock } from "./clock.js";
import { runMorningGreeting } from "../rituals/morning-greeting.js";

let running = false;

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

// Day 1: the only ritual is the morning greeting at 09:00 company time.
// We track the last company-date we ran it, so it fires once per company day.
let lastGreetingDate: string | null = null;

async function onTick(clock: WorldClock): Promise<void> {
  console.log(`Tick ${clock.current_tick} - ${formatCompanyTime(clock.company_time)}`);

  const hour = clock.company_time.getUTCHours();
  const dateKey = clock.company_time.toISOString().substring(0, 10);

  // Morning greeting at 09:xx company time, once per company day
  if (hour >= 9 && lastGreetingDate !== dateKey) {
    lastGreetingDate = dateKey;
    console.log(`Triggering morning greeting for ${dateKey}`);
    await runMorningGreeting();
  }
}
