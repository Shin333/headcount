import { NextResponse } from "next/server";

// ----------------------------------------------------------------------------
// POST /api/project/[id]/pin — REMOVED in migration 0024
// ----------------------------------------------------------------------------
// The is_pinned column on project_messages was dropped in 0024. The pinning
// feature has no DB-level surface anymore. Plan 3 will rebuild the dashboard
// around the new project-chat data model and decide whether pinning makes a
// comeback in some other shape; until then this endpoint returns 410 Gone.
// ----------------------------------------------------------------------------

export async function POST() {
  return NextResponse.json(
    {
      error: "feature_removed",
      message:
        "Pinning was removed in migration 0024. Plan 3 rebuild.",
    },
    { status: 410 },
  );
}
