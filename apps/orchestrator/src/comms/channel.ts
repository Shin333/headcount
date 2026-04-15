// ============================================================================
// comms/channel.ts - Day 17 - project channel ("meeting room") helpers
// ----------------------------------------------------------------------------
// Shared project channels where all members see all messages. This replaces
// the "Eleanor relays everything via 1:1 DMs" pattern with a broadcast room
// where agents post work, react to each other's artifacts, and coordinate
// directly.
//
// Three main functions:
//   1. postToChannel — insert a project_message row
//   2. getChannelHistory — load recent messages for context injection
//   3. formatChannelHistory — render history as a readable prompt block
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import type { ProjectMessageType } from "@headcount/shared";

// Max messages to inject into an agent's system prompt per project channel.
const CHANNEL_HISTORY_LIMIT = 40;

// Max characters per message body in the channel history. Long artifact
// summaries or verbose messages get truncated.
const CHANNEL_MSG_PREVIEW_CHARS = 600;

// Day 22: Pinned messages get more room — they're CEO decisions and
// critical project context. 600 chars was cutting off roster lists
// and multi-point decisions.
const PINNED_MSG_MAX_CHARS = 1500;

// CEO sentinel ID — messages from the dashboard are posted with this ID
export const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

// ----------------------------------------------------------------------------
// postToChannel
// ----------------------------------------------------------------------------

export async function postToChannel(args: {
  projectId: string;
  agentId: string;
  body: string;
  messageType?: ProjectMessageType;
}): Promise<{ id: string }> {
  const { data, error } = await db
    .from("project_messages")
    .insert({
      project_id: args.projectId,
      agent_id: args.agentId,
      body: args.body,
      message_type: args.messageType ?? "message",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to post to channel: ${error?.message}`);
  }
  return { id: data.id };
}

// ----------------------------------------------------------------------------
// getChannelHistory
// ----------------------------------------------------------------------------

interface ChannelMessage {
  id: string;
  agent_id: string;
  body: string;
  message_type: string;
  created_at: string;
}

/**
 * Load the most recent messages from a project channel, ordered
 * chronologically (oldest first). Used for context injection.
 *
 * excludeMessageId allows the caller to exclude a specific message
 * (e.g., the message that triggered this turn, which is already in
 * the trigger prompt).
 */
export async function getChannelHistory(
  projectId: string,
  limit: number = CHANNEL_HISTORY_LIMIT,
  excludeMessageId?: string
): Promise<ChannelMessage[]> {
  let query = db
    .from("project_messages")
    .select("id, agent_id, body, message_type, created_at")
    .eq("project_id", projectId)
    .eq("is_pinned", false) // Don't include pinned messages in rolling history — they're injected separately
    .order("created_at", { ascending: false })
    .limit(limit);

  if (excludeMessageId) {
    query = query.neq("id", excludeMessageId);
  }

  const { data, error } = await query;

  if (error) {
    console.warn(`[channel] getChannelHistory error: ${error.message}`);
    return [];
  }
  if (!data || data.length === 0) return [];

  // Reverse to chronological order (oldest first)
  return (data as ChannelMessage[]).reverse();
}

// ----------------------------------------------------------------------------
// getPinnedMessages - always-visible project context
// ----------------------------------------------------------------------------

/**
 * Load all pinned messages for a project, ordered chronologically.
 * Pinned messages are injected into EVERY agent turn regardless of
 * how old they are. Use for: roster, brief, key decisions, style guides.
 */
export async function getPinnedMessages(
  projectId: string
): Promise<ChannelMessage[]> {
  const { data, error } = await db
    .from("project_messages")
    .select("id, agent_id, body, message_type, created_at")
    .eq("project_id", projectId)
    .eq("is_pinned", true)
    .order("created_at", { ascending: true });

  if (error) {
    console.warn(`[channel] getPinnedMessages error: ${error.message}`);
    return [];
  }
  return (data ?? []) as ChannelMessage[];
}

// ----------------------------------------------------------------------------
// formatChannelHistory
// ----------------------------------------------------------------------------

/**
 * Render channel history as a readable conversation block for injection
 * into an agent's system prompt or trigger. Includes pinned messages
 * as a separate section above the rolling history.
 *
 * agentNames is a Map<agentId, displayName> so we can show "Tessa Goh"
 * instead of a UUID. The caller is responsible for loading the names.
 *
 * Returns null if both pinned and history are empty.
 */
export function formatChannelHistory(
  projectTitle: string,
  history: ChannelMessage[],
  agentNames: Map<string, string>,
  pinnedMessages?: ChannelMessage[]
): string | null {
  if (history.length === 0 && (!pinnedMessages || pinnedMessages.length === 0)) return null;

  const lines: string[] = [];

  // Pinned messages first — these are the "always visible" project context
  if (pinnedMessages && pinnedMessages.length > 0) {
    lines.push(`## 📌 Pinned — ${projectTitle}`);
    lines.push(`(${pinnedMessages.length} pinned message${pinnedMessages.length === 1 ? "" : "s"} — always visible)`);
    lines.push("");

    for (const msg of pinnedMessages) {
      const who = agentNames.get(msg.agent_id) ?? `Agent ${msg.agent_id.slice(0, 8)}`;
      let body = msg.body ?? "";
      const artifactIdx = body.lastIndexOf("<artifacts>");
      if (artifactIdx !== -1) body = body.slice(0, artifactIdx).trimEnd();
      // Day 22: pinned messages get 1500 chars (was 600) — CEO decisions need room
      if (body.length > PINNED_MSG_MAX_CHARS) {
        body = body.slice(0, PINNED_MSG_MAX_CHARS).trimEnd() + "… [truncated]";
      }
      lines.push(`**${who}:** ${body}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Rolling history
  if (history.length > 0) {
    lines.push(`## Project channel: ${projectTitle}`);
    lines.push(`(${history.length} recent messages)`);
    lines.push("");

    for (const msg of history) {
      const who = agentNames.get(msg.agent_id) ?? `Agent ${msg.agent_id.slice(0, 8)}`;
      let body = msg.body ?? "";

      // Strip <artifacts> XML blocks from channel history — they're noisy
      const artifactIdx = body.lastIndexOf("<artifacts>");
      if (artifactIdx !== -1) {
        body = body.slice(0, artifactIdx).trimEnd();
      }

      // Truncate long messages
      if (body.length > CHANNEL_MSG_PREVIEW_CHARS) {
        body = body.slice(0, CHANNEL_MSG_PREVIEW_CHARS).trimEnd() + "… [truncated]";
      }

      // Format differently based on message type
      if (msg.message_type === "artifact") {
        lines.push(`📄 **${who}:** ${body}`);
      } else if (msg.message_type === "system") {
        lines.push(`🔧 _${body}_`);
      } else {
        lines.push(`**${who}:** ${body}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ----------------------------------------------------------------------------
// loadAgentNames - utility for formatChannelHistory
// ----------------------------------------------------------------------------

/**
 * Load display names for a set of agent IDs. Returns a Map<id, name>.
 * Used by formatChannelHistory and the project-responder.
 */
export async function loadAgentNames(agentIds: string[]): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map();

  const uniqueIds = Array.from(new Set(agentIds));
  const { data, error } = await db
    .from("agents")
    .select("id, name")
    .in("id", uniqueIds);

  const names = new Map<string, string>();
  // Always include the CEO sentinel
  names.set(CEO_SENTINEL_ID, "Shin Park");

  if (error || !data) return names;
  for (const row of data as Array<{ id: string; name: string }>) {
    names.set(row.id, row.name);
  }
  return names;
}
