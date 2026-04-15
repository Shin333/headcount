import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// POST /api/project/[id]/post (Day 17.5)
// ----------------------------------------------------------------------------
// CEO posts a message to a project's shared channel. Same as the SQL insert
// but from the dashboard UI.
// Body: { body: string }
// ----------------------------------------------------------------------------

const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";
const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const MAX_BODY_LENGTH = 5000;

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

  let body: { body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messageBody = body.body?.trim();
  if (!messageBody) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }
  if (messageBody.length > MAX_BODY_LENGTH) {
    return NextResponse.json(
      { error: `Message must be ${MAX_BODY_LENGTH} characters or fewer` },
      { status: 400 }
    );
  }

  const db = adminClient();

  // Verify the project exists
  const { data: project, error: projectErr } = await db
    .from("projects")
    .select("id, title, status")
    .eq("id", projectId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (projectErr || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (project.status !== "active") {
    return NextResponse.json({ error: "Project is not active" }, { status: 400 });
  }

  // Insert the channel message
  const { data: inserted, error: insertErr } = await db
    .from("project_messages")
    .insert({
      project_id: projectId,
      agent_id: CEO_SENTINEL_ID,
      body: messageBody,
      message_type: "message",
    })
    .select("id, created_at")
    .single();

  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: "Failed to post: " + (insertErr?.message ?? "unknown") },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    messageId: inserted.id,
    projectTitle: project.title,
    createdAt: inserted.created_at,
  });
}
