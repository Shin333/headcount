import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// POST /api/project/[id]/pin (Day 19)
// ----------------------------------------------------------------------------
// Pin or unpin a project message. Pinned messages are always visible to
// agents regardless of channel history scrollback.
// Body: { messageId: string, pinned: boolean }
// ----------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const projectId = params.id;

  let body: { messageId?: string; pinned?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messageId = body.messageId?.trim();
  const pinned = body.pinned ?? true;

  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }

  const db = adminClient();

  // Verify the message belongs to this project
  const { data: msg, error: msgErr } = await db
    .from("project_messages")
    .select("id, project_id")
    .eq("id", messageId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (msgErr || !msg) {
    return NextResponse.json({ error: "Message not found in this project" }, { status: 404 });
  }

  const { error: updateErr } = await db
    .from("project_messages")
    .update({ is_pinned: pinned })
    .eq("id", messageId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    messageId,
    pinned,
    message: pinned
      ? "Message pinned. All agents will see this on every turn."
      : "Message unpinned.",
  });
}
