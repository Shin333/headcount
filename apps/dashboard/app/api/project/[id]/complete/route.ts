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

  // Resolve pending commitments
  const { data: pending } = await db
    .from("commitments")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "pending");

  let resolvedCount = 0;
  if (pending && pending.length > 0) {
    await db
      .from("commitments")
      .update({
        status: "resolved",
        resolution_type: "manual",
        resolved_at: new Date().toISOString(),
      })
      .eq("project_id", projectId)
      .eq("status", "pending");
    resolvedCount = pending.length;
  }

  // Post celebration
  const CEO_ID = "00000000-0000-0000-0000-00000000ce00";
  await db.from("project_messages").insert({
    project_id: projectId,
    agent_id: CEO_ID,
    body: `🎉 **Project "${project.title}" is complete!** All work is shipped. ${resolvedCount > 0 ? `${resolvedCount} remaining commitment(s) auto-resolved.` : ""} Great work, team.`,
    message_type: "system",
  });

  return NextResponse.json({
    message: `Project "${project.title}" completed`,
    resolvedCommitments: resolvedCount,
  });
}
