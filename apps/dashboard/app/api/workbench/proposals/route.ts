import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// GET /api/workbench/proposals — Day 22
// Returns addendum proposals (self-improvement requests from agents)

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function GET() {
  const db = adminClient();

  const { data: proposals, error } = await db
    .from("prompt_evolution_log")
    .select("id, agent_id, old_value, new_value, reason, proposed_by, status, created_at")
    .eq("tenant_id", TENANT_ID)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ proposals: proposals ?? [] });
}
