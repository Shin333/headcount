import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// GET /api/tools/quota (Day 5.3)
// ----------------------------------------------------------------------------
// Returns the count of live (non-cached) tool calls today, broken down by tool.
// Used by the dashboard quota counter to show "X / 33 Tavily searches today".
// ----------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const TAVILY_FREE_TIER_DAILY = 33; // 1000/month / ~30 days

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not set in dashboard env");
  }
  return createClient(url, serviceKey);
}

export async function GET() {
  const db = adminClient();

  const startOfWallDay = new Date();
  startOfWallDay.setUTCHours(0, 0, 0, 0);

  // Count live web_search calls today (cache_hit = false)
  const { count: liveCount } = await db
    .from("agent_actions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .eq("action_type", "tool_call")
    .gte("created_at", startOfWallDay.toISOString())
    .contains("metadata", { tool_name: "web_search", cache_hit: false });

  // Count cache hits today
  const { count: cacheHitCount } = await db
    .from("agent_actions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .eq("action_type", "tool_call")
    .gte("created_at", startOfWallDay.toISOString())
    .contains("metadata", { tool_name: "web_search", cache_hit: true });

  return NextResponse.json({
    web_search: {
      live_today: liveCount ?? 0,
      cache_hits_today: cacheHitCount ?? 0,
      free_tier_daily: TAVILY_FREE_TIER_DAILY,
      remaining: Math.max(0, TAVILY_FREE_TIER_DAILY - (liveCount ?? 0)),
    },
  });
}
