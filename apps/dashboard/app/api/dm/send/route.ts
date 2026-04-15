import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// POST /api/dm/send (Day 4)
// ----------------------------------------------------------------------------
// The CEO replies to an agent. Body: { toId: string, body: string }
// Inserts a row into dms with from_id = CEO_SENTINEL_ID, read_at = null.
// The recipient agent will see this DM the next time their ritual runs.
// ----------------------------------------------------------------------------

const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";
const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const MAX_BODY_LENGTH = 20000;

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not set in dashboard env");
  }
  return createClient(url, serviceKey);
}

export async function POST(req: NextRequest) {
  let body: { toId?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const toId = body.toId?.trim();
  const messageBody = body.body?.trim();

  if (!toId || !messageBody) {
    return NextResponse.json({ error: "toId and body are required" }, { status: 400 });
  }

  if (messageBody.length > MAX_BODY_LENGTH) {
    return NextResponse.json(
      { error: `Message body must be ${MAX_BODY_LENGTH} characters or fewer` },
      { status: 400 }
    );
  }

  // Don't let the CEO DM themselves
  if (toId === CEO_SENTINEL_ID) {
    return NextResponse.json({ error: "Cannot send DM to CEO sentinel" }, { status: 400 });
  }

  const db = adminClient();

  // Verify the recipient exists and is in the tenant
  const { data: recipient, error: recipErr } = await db
    .from("agents")
    .select("id, name, status")
    .eq("id", toId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (recipErr || !recipient) {
    return NextResponse.json({ error: "Recipient agent not found" }, { status: 404 });
  }

  // Insert the DM with error checking
  const { data: inserted, error: insertErr } = await db
    .from("dms")
    .insert({
      tenant_id: TENANT_ID,
      from_id: CEO_SENTINEL_ID,
      to_id: toId,
      body: messageBody,
    })
    .select("id, created_at")
    .single();

  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: "Failed to send DM: " + (insertErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  // Read-back verification per Day 3.1 rule
  const { data: verify } = await db
    .from("dms")
    .select("id")
    .eq("id", inserted.id)
    .maybeSingle();

  if (!verify) {
    return NextResponse.json(
      { error: "DM insert verification failed - row not found after insert" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    dmId: inserted.id,
    recipient: recipient.name,
    createdAt: inserted.created_at,
    message: `DM sent to ${recipient.name}. They will see it on their next ritual cycle (~1 wall minute).`,
  });
}
