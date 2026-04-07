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

export async function POST(_req: NextRequest, { params }: { params: { agentId: string } }) {
  const agentId = params.agentId;
  const db = adminClient();

  const { data: agent, error: loadErr } = await db
    .from("agents")
    .select("id, name, addendum_loop_active, status")
    .eq("id", agentId)
    .maybeSingle();

  if (loadErr || !agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (!agent.addendum_loop_active) {
    return NextResponse.json({ error: "Agent does not have addendum_loop_active=true" }, { status: 400 });
  }

  if (agent.status !== "active") {
    return NextResponse.json({ error: "Agent is not active" }, { status: 400 });
  }

  const { data: trigger, error: insertErr } = await db
    .from("reflection_triggers")
    .insert({
      agent_id: agentId,
      requested_by: "ceo_dashboard",
      status: "pending",
    })
    .select("id")
    .single();

  if (insertErr || !trigger) {
    return NextResponse.json(
      { error: "Failed to queue trigger: " + (insertErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    triggerId: trigger.id,
    agentName: agent.name,
    message: "Reflection queued. The orchestrator will process within ~10 seconds.",
  });
}
