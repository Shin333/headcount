// ============================================================================
// tools/roster-lookup.ts - Day 14 - find colleagues across the company
// ----------------------------------------------------------------------------
// Read-only search across the agents table. Lets an agent answer "who's on
// my team?" or "who else specializes in X?" - the prerequisite for
// delegation via dm_send.
//
// Search strategy:
//   - Filter by department slug if provided
//   - Free-text search across name + role + background fields if
//     expertise_query provided (background contains the expertise bullets
//     baked in by day7-bulk-specialists)
//   - Default include_specialists=true (so the dormant 104-specialist
//     bench is discoverable)
//   - Cap results at 20 per call to bound model context cost
//   - Sort: same-dept-as-caller first, then by tier (exec/director/manager
//     before associate/intern), then by relevance score
//
// NOT a real_action - this is a read-only lookup. No audit row, no daily
// cap. Listed in the registry as a regular tool.
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

const MAX_RESULTS = 20;

// Tier ordering: lower number = higher priority in sort
const TIER_ORDER: Record<string, number> = {
  exec: 0,
  director: 1,
  manager: 2,
  associate: 3,
  intern: 4,
  bot: 5,
};

interface RosterRow {
  id: string;
  name: string;
  role: string;
  department: string | null;
  tier: string;
  background: string | null;
  status: string;
  always_on: boolean;
}

interface FormattedRosterEntry {
  name: string;
  role: string;
  department: string | null;
  tier: string;
  active_member: boolean; // true if always_on (named cast), false if dormant specialist
  expertise_summary: string;
}

/**
 * Extract a short expertise summary from the background field. The day7
 * specialist seed format is:
 *   "<Name> — <archetype>. Specialized in: <expertise joined>. Reports to..."
 * For named cast, background is freer text. We try to grab anything after
 * "Specialized in:" if present, otherwise truncate the first sentence.
 */
function extractExpertiseSummary(background: string | null): string {
  if (!background) return "";
  const specMatch = background.match(/Specialized in:\s*([^.]+)/i);
  if (specMatch && specMatch[1]) {
    return specMatch[1].trim().slice(0, 200);
  }
  // Fall back to first sentence
  const firstSentence = background.split(/[.\n]/)[0] ?? "";
  return firstSentence.trim().slice(0, 200);
}

/**
 * Score a row against an expertise query. Naive but useful: count matches
 * of query terms in name + role + background. Returns 0 if no query.
 */
function relevanceScore(row: RosterRow, query: string): number {
  if (!query) return 0;
  const haystack = `${row.name} ${row.role} ${row.background ?? ""}`.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2); // skip stopwords-ish
  let score = 0;
  for (const term of terms) {
    // Count occurrences (max 3 per term to avoid runaway weighting)
    let count = 0;
    let idx = haystack.indexOf(term);
    while (idx !== -1 && count < 3) {
      count++;
      idx = haystack.indexOf(term, idx + 1);
    }
    score += count;
    // Bonus if the term appears in the role specifically
    if (row.role.toLowerCase().includes(term)) score += 2;
  }
  return score;
}

export const rosterLookupTool: Tool = {
  // No real_action flag - this is a read-only DB query, no audit row
  definition: {
    name: "roster_lookup",
    description:
      "Search the company roster to find colleagues by department or expertise. Use this BEFORE dm_send when you need to figure out who to delegate to.\n\nThe roster includes all active agents, including the dormant specialist bench (104 specialists who don't fire rituals on their own but will respond if you DM them via dm_send).\n\nAlways provide a department or expertise_query unless you genuinely want a sample of the whole roster. Generic searches return up to 20 results sorted by relevance.\n\nResults include each agent's name (use this with dm_send to_name), role, department, tier, and a short expertise summary.",
    input_schema: {
      type: "object",
      properties: {
        department: {
          type: "string",
          description:
            "Filter by department slug. Valid values: engineering, marketing, sales, strategy, operations, finance, legal, people, executive, design, product, culture. Leave empty to search across all departments.",
        },
        expertise_query: {
          type: "string",
          description:
            "Free-text search across role and background. Examples: 'reddit community', 'image prompting', 'database design', 'customer interviews'. The more specific, the better the results.",
        },
        include_specialists: {
          type: "boolean",
          description:
            "Whether to include dormant specialists (associates and interns who don't fire rituals on their own). Default true. Set false to see only the active named cast.",
        },
      },
      required: [],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const toolName = "roster_lookup";

    if (!context) {
      return {
        toolName,
        content: "Error: roster_lookup requires execution context.",
        isError: true,
      };
    }

    const department = typeof input.department === "string" ? input.department.trim().toLowerCase() : "";
    const query = typeof input.expertise_query === "string" ? input.expertise_query.trim() : "";
    const includeSpecialists =
      typeof input.include_specialists === "boolean" ? input.include_specialists : true;

    // ----- Build query -----
    let dbQuery = db
      .from("agents")
      .select("id, name, role, department, tier, background, status, always_on")
      .eq("tenant_id", config.tenantId)
      .eq("is_human", false)
      .eq("status", "active");

    if (department) {
      dbQuery = dbQuery.eq("department", department);
    }
    if (!includeSpecialists) {
      dbQuery = dbQuery.eq("always_on", true);
    }

    // Pull a wider set than MAX_RESULTS so we can rank then truncate
    const { data, error } = await dbQuery.limit(120);

    if (error) {
      return {
        toolName,
        content: `Error querying roster: ${error.message}`,
        isError: true,
      };
    }

    if (!data || data.length === 0) {
      return {
        toolName,
        content: `No agents matched. Try a broader department or expertise_query, or set include_specialists=true.`,
        isError: false,
      };
    }

    // ----- Rank -----
    const rows = data as RosterRow[];

    // Find caller's department for same-dept boost
    const { data: callerRow } = await db
      .from("agents")
      .select("department")
      .eq("id", context.agentId)
      .maybeSingle();
    const callerDept = (callerRow?.department as string | null) ?? null;

    interface ScoredRow {
      row: RosterRow;
      score: number;
    }

    const scored: ScoredRow[] = rows
      .filter((r) => r.id !== context.agentId) // don't return the caller themself
      .map((row) => {
        let score = relevanceScore(row, query);
        // Same-department bonus
        if (callerDept && row.department === callerDept) score += 5;
        // Tier bonus (lower tier number = higher priority)
        const tierBonus = 5 - (TIER_ORDER[row.tier] ?? 5);
        score += tierBonus;
        // Always-on bonus (active named cast preferred over dormant specialists)
        if (row.always_on) score += 2;
        return { row, score };
      });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_RESULTS);

    // ----- Format -----
    const formatted: FormattedRosterEntry[] = top.map(({ row }) => ({
      name: row.name,
      role: row.role,
      department: row.department,
      tier: row.tier,
      active_member: row.always_on,
      expertise_summary: extractExpertiseSummary(row.background),
    }));

    const summary = `${formatted.length} of ${rows.length - 1} matched`;

    return {
      toolName,
      content: JSON.stringify(
        {
          query: { department: department || null, expertise_query: query || null, include_specialists: includeSpecialists },
          summary,
          results: formatted,
        },
        null,
        2
      ),
      isError: false,
      structuredPayload: {
        result_count: formatted.length,
        total_matched: rows.length - 1,
      },
    };
  },
};
