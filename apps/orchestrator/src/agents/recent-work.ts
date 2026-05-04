// ============================================================================
// agents/recent-work.ts - Day 29 - per-agent memory substitute
// ----------------------------------------------------------------------------
// The retrieveMemories() stub in agents/memory.ts returns nothing, which
// means every agent turn starts fresh — no awareness of what they did last
// turn, what artifacts they already shipped, what commitments they logged.
// Result: agents produce v2, v3, v4 of the same format analysis because
// they don't remember producing v1.
//
// This module solves the practical version of memory: a compact "what you've
// done recently" block injected into the agent's context on every turn.
// Pulls from real tables (artifacts, project_messages, dms, commitments,
// agent_actions). 48-hour lookback. Each list capped so the block stays
// under ~800 tokens.
//
// Not fancy. Not vector-embedded. But it stops the duplicate-work failure
// mode in one pass, which retrieveMemories() has not done since Day 1.
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";

const LOOKBACK_HOURS = 48;
const MAX_ARTIFACTS = 8;
const MAX_CHANNEL_POSTS = 8;
const MAX_DMS_SENT = 6;
const MAX_COMMITMENTS = 5;

interface ArtifactRow {
  title: string;
  file_path: string;
  content_type: string;
  created_at: string;
  version: number;
}
interface ProjectPostRow {
  body: string;
  created_at: string;
  project_title?: string;
}
interface DmSentRow {
  body: string;
  to_name?: string;
  created_at: string;
}
interface CommitmentRow {
  description: string;
  status: string;
  deadline_at: string | null;
}

export async function buildRecentWorkContext(agentId: string): Promise<string> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  // Parallel queries
  const [artifactsRes, channelRes, dmsRes, commitsRes] = await Promise.all([
    db
      .from("artifacts")
      .select("title, file_path, content_type, created_at, version")
      .eq("tenant_id", config.tenantId)
      .eq("agent_id", agentId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_ARTIFACTS),
    db
      .from("project_messages")
      .select("body, created_at, project_id")
      .eq("agent_id", agentId)
      .gte("created_at", since)
      .eq("message_type", "message")
      .order("created_at", { ascending: false })
      .limit(MAX_CHANNEL_POSTS),
    db
      .from("dms")
      .select("body, to_id, created_at")
      .eq("tenant_id", config.tenantId)
      .eq("from_id", agentId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_DMS_SENT),
    db
      .from("commitments")
      .select("description, status, deadline_at, created_at")
      .eq("tenant_id", config.tenantId)
      .eq("agent_id", agentId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_COMMITMENTS),
  ]);

  const artifacts = (artifactsRes.data ?? []) as ArtifactRow[];
  const channelPosts = (channelRes.data ?? []) as ProjectPostRow[];
  const dmsSent = (dmsRes.data ?? []) as DmSentRow[];
  const commitments = (commitsRes.data ?? []) as CommitmentRow[];

  if (
    artifacts.length === 0 &&
    channelPosts.length === 0 &&
    dmsSent.length === 0 &&
    commitments.length === 0
  ) {
    return ""; // Nothing to say; agent is dormant or brand new to activity
  }

  // Resolve project titles + DM recipient names for readability
  const projectIds = Array.from(
    new Set(channelPosts.map((p) => (p as unknown as { project_id: string }).project_id).filter(Boolean))
  );
  const projectTitles = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects } = await db.from("projects").select("id, title").in("id", projectIds);
    for (const p of projects ?? []) projectTitles.set(p.id, p.title);
  }

  const toIds = Array.from(new Set(dmsSent.map((d) => (d as unknown as { to_id: string }).to_id)));
  const toNames = new Map<string, string>();
  if (toIds.length > 0) {
    const { data: ags } = await db.from("agents").select("id, name").in("id", toIds);
    for (const a of ags ?? []) toNames.set(a.id, a.name);
  }

  const lines: string[] = [];
  lines.push(`# Your recent work (last ${LOOKBACK_HOURS}h — read BEFORE deciding what to do)`);
  lines.push("");

  if (artifacts.length > 0) {
    lines.push(`## Artifacts you created (${artifacts.length})`);
    for (const a of artifacts) {
      lines.push(`  - "${a.title}" v${a.version} (${a.content_type}) — ${a.file_path} [${relTime(a.created_at)}]`);
    }
    lines.push("");
    lines.push("RULE: if an artifact above already covers what's being asked, update it (same file_path) instead of creating a new one. Do NOT produce v2, v3, v4 of the same analysis.");
    lines.push("");
  }

  if (channelPosts.length > 0) {
    lines.push(`## Project-channel posts you made (${channelPosts.length})`);
    for (const p of channelPosts) {
      const row = p as unknown as { project_id: string };
      const proj = projectTitles.get(row.project_id) ?? row.project_id.slice(0, 8);
      const preview = p.body.replace(/\n+/g, " ").slice(0, 120);
      lines.push(`  - [${relTime(p.created_at)}] in "${proj}": ${preview}${p.body.length > 120 ? "…" : ""}`);
    }
    lines.push("");
    lines.push("RULE: do NOT repost the same point you already posted. Only add NEW information or respond to a direct ask.");
    lines.push("");
  }

  if (dmsSent.length > 0) {
    lines.push(`## DMs you sent (${dmsSent.length})`);
    for (const d of dmsSent) {
      const row = d as unknown as { to_id: string };
      const to = toNames.get(row.to_id) ?? row.to_id.slice(0, 8);
      const preview = d.body.replace(/\n+/g, " ").slice(0, 120);
      lines.push(`  - [${relTime(d.created_at)}] to ${to}: ${preview}${d.body.length > 120 ? "…" : ""}`);
    }
    lines.push("");
  }

  if (commitments.length > 0) {
    lines.push(`## Commitments you logged (${commitments.length})`);
    for (const c of commitments) {
      const deadline = c.deadline_at ? `deadline ${relTime(c.deadline_at)}` : "no deadline";
      lines.push(`  - [${c.status}] ${c.description.slice(0, 160)}${c.description.length > 160 ? "…" : ""} (${deadline})`);
    }
    lines.push("");
    lines.push("RULE: do not log another commitment for work your recent artifacts/posts already cover. Close existing commitments by shipping, not by duplicating.");
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return "soon";
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
