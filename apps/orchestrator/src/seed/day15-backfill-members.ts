// ----------------------------------------------------------------------------
// seed/day15-backfill-members.ts - recover existing project memberships
// ----------------------------------------------------------------------------
// Day 15 introduces project_members but there's already one real project in
// the database from Day 14: the Onepark Digital website (id 1806c510-...).
// Without a backfill, Eleanor and the team would have zero membership on
// their existing work when they re-engage tomorrow, and the project context
// injection would do nothing until someone re-introduces the project ID
// into a new DM.
//
// This script fixes that by scanning existing dms for UUID references to
// active projects and auto-adding every distinct sender/recipient of those
// DMs as project members.
//
// Idempotent via the addMember helper (unique constraint swallowed). Safe
// to re-run. Logs every add loudly.
//
// Dry-run support: pass --dry-run as a CLI arg to see what would be added
// without writing anything.
//
// Run with:
//   pnpm tsx apps/orchestrator/src/seed/day15-backfill-members.ts
//   pnpm tsx apps/orchestrator/src/seed/day15-backfill-members.ts --dry-run
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { addMember } from "../projects/members.js";
import { pathToFileURL } from "node:url";

const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

interface ActiveProjectRow {
  id: string;
  title: string;
  created_by: string | null;
}

interface DmRow {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
}

interface AgentRow {
  id: string;
  name: string;
}

export async function runDay15Backfill(dryRun: boolean): Promise<void> {
  console.log(``);
  console.log(
    `[day15-backfill] ${dryRun ? "DRY RUN — no changes will be written" : "LIVE — writing memberships"}`
  );
  console.log(`[day15-backfill] tenant: ${config.tenantId}`);
  console.log(``);

  // Step 1: load all active projects
  const { data: projects, error: projectsErr } = await db
    .from("projects")
    .select("id, title, created_by")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  if (projectsErr) {
    console.error(`[day15-backfill] failed to load projects: ${projectsErr.message}`);
    process.exit(1);
  }
  if (!projects || projects.length === 0) {
    console.log(`[day15-backfill] no active projects found. Nothing to backfill.`);
    return;
  }

  console.log(`[day15-backfill] found ${projects.length} active project(s):`);
  for (const p of projects as ActiveProjectRow[]) {
    console.log(`  - ${p.title} (${p.id.slice(0, 8)})`);
  }
  console.log(``);

  // Build a lookup set of project IDs (lowercased) for fast membership check
  const activeProjectIds = new Set(
    (projects as ActiveProjectRow[]).map((p) => p.id.toLowerCase())
  );
  const projectById = new Map<string, ActiveProjectRow>();
  for (const p of projects as ActiveProjectRow[]) {
    projectById.set(p.id.toLowerCase(), p);
  }

  // Step 2: load all DMs for the tenant, scan bodies for project UUIDs.
  // We don't filter by date — we want the full history.
  const { data: dms, error: dmsErr } = await db
    .from("dms")
    .select("id, from_id, to_id, body");

  if (dmsErr) {
    console.error(`[day15-backfill] failed to load dms: ${dmsErr.message}`);
    process.exit(1);
  }
  if (!dms) {
    console.log(`[day15-backfill] no dms found. Nothing to backfill.`);
    return;
  }

  console.log(`[day15-backfill] scanning ${dms.length} dms for project references...`);

  // For each project, collect the distinct set of agent IDs that appear as
  // sender or recipient in any DM whose body mentions that project ID.
  const membersByProject = new Map<string, Set<string>>();
  for (const pid of activeProjectIds) {
    membersByProject.set(pid, new Set());
  }

  let dmsWithProjectRefs = 0;
  for (const dm of dms as DmRow[]) {
    if (!dm.body) continue;
    const matches = dm.body.match(UUID_REGEX);
    if (!matches) continue;

    let thisDmHadRef = false;
    const distinctMatches = new Set(matches.map((m) => m.toLowerCase()));
    for (const match of distinctMatches) {
      if (!activeProjectIds.has(match)) continue;
      thisDmHadRef = true;
      const set = membersByProject.get(match);
      if (!set) continue;
      if (dm.from_id) set.add(dm.from_id);
      if (dm.to_id) set.add(dm.to_id);
    }
    if (thisDmHadRef) dmsWithProjectRefs++;
  }

  console.log(
    `[day15-backfill] ${dmsWithProjectRefs} dm(s) referenced at least one active project`
  );
  console.log(``);

  // Also always include each project's creator, even if they didn't appear
  // in any DM body (they still created it).
  for (const p of projects as ActiveProjectRow[]) {
    if (!p.created_by) continue;
    const set = membersByProject.get(p.id.toLowerCase());
    if (set) set.add(p.created_by);
  }

  // Step 3: load agent names for pretty logging
  const allAgentIds = new Set<string>();
  for (const set of membersByProject.values()) {
    for (const id of set) allAgentIds.add(id);
  }
  const agentNames = new Map<string, string>();
  if (allAgentIds.size > 0) {
    const { data: agents } = await db
      .from("agents")
      .select("id, name")
      .in("id", Array.from(allAgentIds));
    if (agents) {
      for (const a of agents as AgentRow[]) {
        agentNames.set(a.id, a.name);
      }
    }
  }

  // Step 4: apply (or report if dry-run)
  let totalAdded = 0;
  let totalAlready = 0;
  let totalErrors = 0;

  for (const project of projects as ActiveProjectRow[]) {
    const pid = project.id.toLowerCase();
    const members = membersByProject.get(pid);
    if (!members || members.size === 0) {
      console.log(
        `[day15-backfill] ${project.title} (${project.id.slice(0, 8)}): no members found in dm history`
      );
      continue;
    }

    console.log(
      `[day15-backfill] ${project.title} (${project.id.slice(0, 8)}): ${members.size} member(s) to consider`
    );

    for (const agentId of members) {
      const name = agentNames.get(agentId) ?? `(unknown ${agentId.slice(0, 8)})`;
      if (dryRun) {
        console.log(`  [would add] ${name}`);
        continue;
      }
      const result = await addMember(project.id, agentId, null);
      if (result.error) {
        console.error(`  [ERROR] ${name}: ${result.error}`);
        totalErrors++;
        continue;
      }
      if (result.inserted) {
        console.log(`  [added] ${name}`);
        totalAdded++;
      } else {
        console.log(`  [already] ${name}`);
        totalAlready++;
      }
    }
    console.log(``);
  }

  if (dryRun) {
    console.log(
      `[day15-backfill] DRY RUN complete. Re-run without --dry-run to apply.`
    );
  } else {
    console.log(
      `[day15-backfill] summary: ${totalAdded} added, ${totalAlready} already members, ${totalErrors} errors`
    );
  }
  console.log(``);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dryRun = process.argv.includes("--dry-run");
  runDay15Backfill(dryRun)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[day15-backfill] unexpected error:`, err);
      process.exit(1);
    });
}
