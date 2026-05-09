import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// POST /api/project/[id]/complete — Day 22
// Marks a project as completed, resolves pending commitments, posts celebration.

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const db = adminClient();

  // Verify project exists
  const { data: project, error } = await db
    .from("projects")
    .select("id, title, status")
    .eq("id", projectId)
    .maybeSingle();

  if (error || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (project.status === "completed") {
    return NextResponse.json({ message: "Already completed" });
  }

  // Mark complete
  await db
    .from("projects")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", projectId);

  // 0024 dropped commitments; Plan 3 rebuild. Resolved count is always 0
  // here so the celebration body uses the no-commitments wording below.
  const resolvedCount = 0;

  // Post celebration.
  // 0024 renamed agent_id→sender_id, message_type→kind (with backfill
  // mapping 'system' → 'comment'); sender_type is now NOT NULL.
  const CEO_ID = "00000000-0000-0000-0000-00000000ce00";
  await db.from("project_messages").insert({
    project_id: projectId,
    sender_id: CEO_ID,
    sender_type: "agent",
    body: `🎉 **Project "${project.title}" is complete!** All work is shipped. ${resolvedCount > 0 ? `${resolvedCount} remaining commitment(s) auto-resolved.` : ""} Great work, team.`,
    kind: "comment",
  });

  return NextResponse.json({
    message: `Project "${project.title}" completed`,
    resolvedCommitments: resolvedCount,
  });
}
