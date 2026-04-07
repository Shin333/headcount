import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not set in dashboard env");
  }
  return createClient(url, serviceKey);
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action must be approve|reject" }, { status: 400 });
  }

  const db = adminClient();

  const { data: proposal, error: loadErr } = await db
    .from("prompt_evolution_log")
    .select("*")
    .eq("id", id)
    .single();

  if (loadErr || !proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  if (proposal.status !== "pending") {
    return NextResponse.json({ error: `Proposal already ${proposal.status}` }, { status: 409 });
  }

  if (body.action === "reject") {
    await db
      .from("prompt_evolution_log")
      .update({ status: "rejected", reviewed_by_ceo_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ ok: true, action: "rejected" });
  }

  // Approve: update agent's learned_addendum AND mark applied
  const { error: updateErr } = await db
    .from("agents")
    .update({ learned_addendum: proposal.new_value || "" })
    .eq("id", proposal.agent_id);

  if (updateErr) {
    return NextResponse.json({ error: "Failed to update agent: " + updateErr.message }, { status: 500 });
  }

  await db
    .from("prompt_evolution_log")
    .update({ status: "applied", reviewed_by_ceo_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true, action: "applied" });
}
