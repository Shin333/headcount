// ============================================================================
// agents/roster-context.ts - Day 29 - cached roster snippet for every prompt
// ----------------------------------------------------------------------------
// Injects a compressed list of all non-human colleagues into every agent's
// system prompt. Fixes the "Tessa didn't know Carlos Reyes exists" bug — no
// agent should ever claim a colleague doesn't exist when the DB has them.
//
// Format: grouped by department, then by tier (exec first). Name + role.
// Example:
//
//   # Company roster (120 agents)
//   ## executive
//     Eleanor Vance — Chief of Staff (exec)
//     Evangeline Tan — Executive Assistant to the CEO (manager)
//   ## marketing
//     Tessa Goh — Director of Marketing (director)
//     Rina Halim — Senior Copywriter (manager)
//     ...
//
// Cache: 5-minute TTL. Agents change infrequently; 5 min keeps the roster
// fresh without hammering the DB every turn.
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";

interface RosterRow {
  name: string;
  role: string;
  department: string | null;
  tier: string;
}

const TIER_ORDER: Record<string, number> = {
  exec: 0,
  director: 1,
  manager: 2,
  associate: 3,
  intern: 4,
  bot: 5,
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cached: { text: string; at: number } | null = null;

async function fetchRoster(): Promise<RosterRow[]> {
  const { data, error } = await db
    .from("agents")
    .select("name, role, department, tier")
    .eq("tenant_id", config.tenantId)
    .eq("is_human", false)
    .eq("status", "active")
    .order("department", { ascending: true })
    .order("tier", { ascending: true });
  if (error) {
    console.warn(`[roster-context] query failed: ${error.message}`);
    return [];
  }
  return (data ?? []) as RosterRow[];
}

function render(rows: RosterRow[]): string {
  if (rows.length === 0) return "";
  const byDept = new Map<string, RosterRow[]>();
  for (const r of rows) {
    const d = r.department ?? "(unassigned)";
    if (!byDept.has(d)) byDept.set(d, []);
    byDept.get(d)!.push(r);
  }
  for (const list of byDept.values()) {
    list.sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99) || a.name.localeCompare(b.name));
  }
  const depts = Array.from(byDept.keys()).sort();
  const lines: string[] = [`# Company roster (${rows.length} agents)`, ""];
  for (const d of depts) {
    lines.push(`## ${d}`);
    for (const r of byDept.get(d)!) {
      lines.push(`  - ${r.name} — ${r.role} (${r.tier})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Get the cached roster text. Refreshes from DB if the cache is stale.
 * Returns "" on error so callers can safely concatenate.
 */
export async function getRosterContext(): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.text;
  }
  const rows = await fetchRoster();
  const text = render(rows);
  cached = { text, at: Date.now() };
  return text;
}

/** Force a refresh — used when seed scripts mutate the agents table. */
export function invalidateRosterCache(): void {
  cached = null;
}
