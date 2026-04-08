import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// GET /api/reports (Day 6)
// ----------------------------------------------------------------------------
// Returns the most recent N reports, optionally filtered by ritual_name.
// Query params:
//   ?ritual=bradley_pipeline_review   - filter to one ritual
//   ?limit=20                         - max results (default 20, max 50)
// ----------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not set in dashboard env");
  }
  return createClient(url, serviceKey);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ritual = searchParams.get("ritual");
  const limitParam = searchParams.get("limit");
  const limit = Math.min(50, Math.max(1, parseInt(limitParam ?? "20", 10) || 20));

  const db = adminClient();

  let query = db
    .from("reports")
    .select("id, ritual_name, agent_id, title, body, company_date, metadata, created_at")
    .eq("tenant_id", TENANT_ID)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (ritual) {
    query = query.eq("ritual_name", ritual);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    reports: data ?? [],
  });
}
