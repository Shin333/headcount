// ----------------------------------------------------------------------------
// seed/day17-backfill-channel.ts - migrate existing project work into channel
// ----------------------------------------------------------------------------
// Day 17 introduces project channels, but the Onepark project has been
// running since Day 14 via 1:1 DMs. This script backfills the channel with:
//
//   1. Key DMs that referenced the project ID — converted to channel messages
//      with original timestamps preserved
//   2. Artifact creation summaries — so agents can see what's been produced
//
// After backfill, the channel looks like the project has been running in a
// meeting room from the start. Agents who get a project-responder turn will
// see the full history of coordination and deliverables.
//
// Idempotent: checks for existing messages by created_at + agent_id to avoid
// duplicates on re-run.
//
// Run with:
//   pnpm tsx src/seed/day17-backfill-channel.ts --dry-run
//   pnpm tsx src/seed/day17-backfill-channel.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

interface ProjectRow {
  id: string;
  title: string;
}

interface DmRow {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  agent_id: string;
  title: string;
  file_path: string;
  size_bytes: number;
  created_at: string;
}

interface AgentRow {
  id: string;
  name: string;
}

export async function runDay17Backfill(dryRun: boolean): Promise<void> {
  console.log("");
  console.log(
    `[day17-backfill] ${dryRun ? "DRY RUN" : "LIVE"} — backfilling project channels`
  );
  console.log(`[day17-backfill] tenant: ${config.tenantId}`);
  console.log("");

  // Load active projects
  const { data: projects, error: projectsErr } = await db
    .from("projects")
    .select("id, title")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  if (projectsErr || !projects || projects.length === 0) {
    console.log("[day17-backfill] no active projects. Nothing to backfill.");
    return;
  }

  for (const project of projects as ProjectRow[]) {
    console.log(`[day17-backfill] processing: ${project.title} (${project.id.slice(0, 8)})`);
    await backfillProject(project, dryRun);
    console.log("");
  }

  console.log(`[day17-backfill] ${dryRun ? "DRY RUN complete." : "Done."}`);
}

async function backfillProject(project: ProjectRow, dryRun: boolean): Promise<void> {
  const projectIdLower = project.id.toLowerCase();

  // Load project members for filtering
  const { data: members } = await db
    .from("project_members")
    .select("agent_id")
    .eq("project_id", project.id);

  const memberIds = new Set(
    (members as Array<{ agent_id: string }> | null)?.map((m) => m.agent_id) ?? []
  );

  if (memberIds.size === 0) {
    console.log("  no members — skipping");
    return;
  }

  // Load agent names
  const { data: agentRows } = await db
    .from("agents")
    .select("id, name")
    .in("id", Array.from(memberIds));

  const agentNames = new Map<string, string>();
  for (const a of (agentRows ?? []) as AgentRow[]) {
    agentNames.set(a.id, a.name);
  }

  // Check existing channel messages to avoid duplicates
  const { data: existingMsgs } = await db
    .from("project_messages")
    .select("created_at, agent_id")
    .eq("project_id", project.id);

  const existingKeys = new Set(
    (existingMsgs ?? []).map(
      (m: { created_at: string; agent_id: string }) => `${m.agent_id}|${m.created_at}`
    )
  );

  // ---- Phase 1: DMs referencing this project ----
  console.log("  scanning DMs for project references...");

  const { data: allDms } = await db
    .from("dms")
    .select("id, from_id, to_id, body, created_at")
    .order("created_at", { ascending: true });

  let dmCount = 0;
  let dmSkipped = 0;
  const channelRows: Array<{
    project_id: string;
    agent_id: string;
    body: string;
    message_type: string;
    created_at: string;
  }> = [];

  for (const dm of (allDms ?? []) as DmRow[]) {
    if (!dm.body) continue;

    // Check if this DM references the project
    const matches = dm.body.match(UUID_REGEX);
    if (!matches) continue;
    const hasProjectRef = matches.some((m) => m.toLowerCase() === projectIdLower);
    if (!hasProjectRef) continue;

    // Only include DMs from project members
    if (!memberIds.has(dm.from_id)) continue;

    // Dedup check
    const key = `${dm.from_id}|${dm.created_at}`;
    if (existingKeys.has(key)) {
      dmSkipped++;
      continue;
    }

    // Strip artifact blocks from the body for cleaner channel history
    let body = dm.body;
    const artifactIdx = body.lastIndexOf("<artifacts>");
    if (artifactIdx !== -1) {
      body = body.slice(0, artifactIdx).trimEnd();
    }

    // Truncate very long DMs
    if (body.length > 2000) {
      body = body.slice(0, 2000) + "\n\n[message truncated for channel history]";
    }

    if (body.length === 0) continue;

    const senderName = agentNames.get(dm.from_id) ?? "Unknown";
    const recipientName = agentNames.get(dm.to_id) ?? "Unknown";

    // Prefix with context about who this was originally sent to
    const channelBody = `[originally DM to ${recipientName}] ${body}`;

    channelRows.push({
      project_id: project.id,
      agent_id: dm.from_id,
      body: channelBody,
      message_type: "message",
      created_at: dm.created_at,
    });

    dmCount++;
    if (!dryRun) {
      existingKeys.add(key); // prevent dupes within this run
    }
  }

  console.log(`  found ${dmCount} DMs to backfill (${dmSkipped} already exist)`);

  // ---- Phase 2: Artifacts from project members ----
  console.log("  scanning artifacts from project members...");

  const { data: artifacts } = await db
    .from("artifacts")
    .select("id, agent_id, title, file_path, size_bytes, created_at")
    .in("agent_id", Array.from(memberIds))
    .order("created_at", { ascending: true });

  let artCount = 0;
  let artSkipped = 0;

  for (const art of (artifacts ?? []) as ArtifactRow[]) {
    // Dedup check
    const key = `${art.agent_id}|${art.created_at}`;
    if (existingKeys.has(key)) {
      artSkipped++;
      continue;
    }

    const authorName = agentNames.get(art.agent_id) ?? "Unknown";
    const sizeStr =
      art.size_bytes < 1024
        ? `${art.size_bytes} B`
        : art.size_bytes < 1024 * 1024
          ? `${(art.size_bytes / 1024).toFixed(1)} KB`
          : `${(art.size_bytes / (1024 * 1024)).toFixed(1)} MB`;

    channelRows.push({
      project_id: project.id,
      agent_id: art.agent_id,
      body: `Created artifact: **${art.title}** at \`${art.file_path}\` (${sizeStr})`,
      message_type: "artifact",
      created_at: art.created_at,
    });

    artCount++;
    if (!dryRun) {
      existingKeys.add(key);
    }
  }

  console.log(`  found ${artCount} artifacts to backfill (${artSkipped} already exist)`);

  // ---- Write ----
  const totalRows = channelRows.length;

  if (totalRows === 0) {
    console.log("  nothing to write");
    return;
  }

  if (dryRun) {
    console.log(`  [DRY RUN] would insert ${totalRows} channel messages`);
    // Show a sample
    for (const row of channelRows.slice(0, 5)) {
      const name = agentNames.get(row.agent_id) ?? row.agent_id.slice(0, 8);
      const preview = row.body.slice(0, 80);
      console.log(`    ${row.message_type.padEnd(8)} ${name}: ${preview}...`);
    }
    if (totalRows > 5) {
      console.log(`    ... and ${totalRows - 5} more`);
    }
    return;
  }

  // Sort by created_at to maintain chronological order
  channelRows.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  // Insert in batches of 50
  const BATCH_SIZE = 50;
  let inserted = 0;
  for (let i = 0; i < channelRows.length; i += BATCH_SIZE) {
    const batch = channelRows.slice(i, i + BATCH_SIZE);
    const { error } = await db.from("project_messages").insert(batch);
    if (error) {
      console.error(`  [ERROR] batch insert failed: ${error.message}`);
      break;
    }
    inserted += batch.length;
  }

  console.log(`  inserted ${inserted} channel messages`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dryRun = process.argv.includes("--dry-run");
  runDay17Backfill(dryRun)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[day17-backfill] unexpected error:`, err);
      process.exit(1);
    });
}
