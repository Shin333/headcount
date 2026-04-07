import { db } from "../db.js";
import { config } from "../config.js";

// ----------------------------------------------------------------------------
// tools/cache.ts - tool result cache (Day 5.3)
// ----------------------------------------------------------------------------
// Standalone cache layer for tool results. Used by web-search.ts (and any
// future tools that benefit from result deduplication within a session).
//
// Design rules:
//   - PER-TENANT scope: cache entries are isolated per tenant for the
//     eventual multi-tenant SaaS conversion.
//   - FAIL-OPEN: any cache failure (table missing, network error, etc.)
//     falls through to a live tool call. Never crash the runner.
//   - LAST-WRITE-WINS: cache.set uses upsert. Concurrent writes to the same
//     key just overwrite each other; no contention handling needed.
//   - OPPORTUNISTIC CLEANUP: cache.set deletes expired entries for the same
//     tenant_id+tool_name. Cheap, no cron job needed.
//   - NORMALIZE keys: trim, lowercase, collapse whitespace. Same query
//     phrased two ways (extra space, casing) hits the same cache entry.
// ----------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Normalize a cache key. Same query in slightly different shapes maps to
 * the same cache entry.
 */
export function normalizeCacheKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Read a cached tool result. Returns null on miss, error, or expiry.
 * Never throws.
 */
export async function cacheGet(args: {
  toolName: string;
  cacheKey: string;
}): Promise<string | null> {
  const { toolName } = args;
  const cacheKey = normalizeCacheKey(args.cacheKey);

  try {
    const { data, error } = await db
      .from("tool_result_cache")
      .select("result_content, expires_at")
      .eq("tenant_id", config.tenantId)
      .eq("tool_name", toolName)
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (error || !data) return null;

    const expiresAt = new Date(data.expires_at).getTime();
    if (expiresAt <= Date.now()) {
      // Expired - treat as miss. Cleanup happens on the next set call.
      return null;
    }

    return data.result_content;
  } catch (err) {
    console.warn(`[cache] cacheGet failed (treating as miss): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Write a tool result to the cache. Also opportunistically cleans up expired
 * entries for the same (tenant, toolName) pair. Never throws.
 */
export async function cacheSet(args: {
  toolName: string;
  cacheKey: string;
  resultContent: string;
  ttlSeconds?: number;
}): Promise<void> {
  const { toolName, resultContent, ttlSeconds = DEFAULT_TTL_SECONDS } = args;
  const cacheKey = normalizeCacheKey(args.cacheKey);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  try {
    // Upsert by the unique (tenant_id, tool_name, cache_key) constraint.
    const { error } = await db
      .from("tool_result_cache")
      .upsert(
        {
          tenant_id: config.tenantId,
          tool_name: toolName,
          cache_key: cacheKey,
          result_content: resultContent,
          expires_at: expiresAt,
        },
        { onConflict: "tenant_id,tool_name,cache_key" }
      );

    if (error) {
      console.warn(`[cache] cacheSet failed (continuing without cache): ${error.message}`);
      return;
    }

    // Opportunistic cleanup of expired entries for this tool. Best-effort,
    // don't error out if it fails.
    try {
      await db
        .from("tool_result_cache")
        .delete()
        .eq("tenant_id", config.tenantId)
        .eq("tool_name", toolName)
        .lt("expires_at", new Date().toISOString());
    } catch {
      // Cleanup failures are silent - the table just grows a bit.
    }
  } catch (err) {
    console.warn(`[cache] cacheSet exception: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ----------------------------------------------------------------------------
// Quota tracking - Day 5.3 dashboard counter
// ----------------------------------------------------------------------------
// Returns the count of LIVE (non-cached) tool calls today for a given tool.
// Used by the dashboard to show "X/33 Tavily searches used today."
// ----------------------------------------------------------------------------

export async function getLiveToolCallCountToday(toolName: string): Promise<number> {
  const startOfWallDayIso = new Date();
  startOfWallDayIso.setUTCHours(0, 0, 0, 0);

  try {
    const { count, error } = await db
      .from("agent_actions")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", config.tenantId)
      .gte("created_at", startOfWallDayIso.toISOString())
      .contains("metadata", { tool_name: toolName, cache_hit: false });

    if (error || count === null) return 0;
    return count;
  } catch {
    return 0;
  }
}
