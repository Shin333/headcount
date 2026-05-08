// ============================================================================
// dispatcher/agent-resolver.ts — Shared slug→id resolver (Phase 4 Task 4.1c).
//
// Resolves an agent slug (e.g., "eleanor-vance") to its `agents.id` UUID
// from the live DB. Used by:
//   - server.ts POST /api/run, to fail-fast with HTTP 400 on bad slugs.
//   - queue.ts worker (Commit B), when a `subagent_handoff` event needs to
//     INSERT a nested `agent_runs` row keyed on the dispatched slug.
//
// Module-level Map cache; lifetime = dispatcher process. The agents table
// changes rarely (full-restart-on-rebuild deployment model).
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 4.1c "Pre-resolve agent_id
// at enqueue".
// ============================================================================

import { db } from "../db.js";

const cache = new Map<string, string>();
let cachePopulated = false;

/**
 * Slug derivation must match the migrate-agents.ts convention used during
 * Phase 1 Task 2: lowercase, NFD-normalized, non-alphanumeric → hyphen.
 * Stable client-side slugifier so DB names (e.g., "Eleanor Vance") map
 * to the same slug used in `.claude/agents/*.md` filenames.
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function populateCacheOnce(): Promise<void> {
  if (cachePopulated) return;
  const { data, error } = await db
    .from("agents")
    .select("id, name")
    .eq("status", "active");
  if (error || !data) {
    // Leave `cachePopulated` false so the next call retries the fetch.
    throw new Error(
      `agent-resolver: failed to load agents: ${error?.message ?? "no data"}`,
    );
  }
  for (const row of data as Array<{ id: string; name: string }>) {
    cache.set(slugifyName(row.name), row.id);
  }
  cachePopulated = true;
}

/**
 * Returns the agent UUID for a slug, or `null` if no active agent has that
 * slug. The cache is loaded lazily on first call and reused thereafter.
 */
export async function resolveAgentIdBySlug(
  slug: string,
): Promise<string | null> {
  await populateCacheOnce();
  return cache.get(slug) ?? null;
}

/**
 * Test-only: clears the cache so the next call refetches. Not exported via
 * the public dispatcher entry point.
 */
export function _resetAgentResolverCacheForTests(): void {
  cache.clear();
  cachePopulated = false;
}
