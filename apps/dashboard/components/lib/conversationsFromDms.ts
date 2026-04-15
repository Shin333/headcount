// ============================================================================
// components/lib/conversationsFromDms.ts - Day 12a.1
// ----------------------------------------------------------------------------
// Folds a flat list of DMs into a list of conversations grouped by partner.
//
// Input: Dm[] (flat, ordered however)
// Output: Conversation[] sorted by lastMessage.created_at descending
//
// "Partner" = the OTHER party in a 1:1 conversation. From the CEO's
// perspective, the partner is whoever is NOT the CEO sentinel.
//
// Pure function. No side effects. Easy to test in isolation later.
// ============================================================================

import type { Dm, Agent } from "./types";

export interface Conversation {
  partnerId: string;
  partner: Agent | undefined;
  messages: Dm[];        // sorted oldest -> newest
  lastMessage: Dm;       // most recent (= last item in messages)
  unreadCount: number;   // messages TO the CEO that are still unread
}

export function conversationsFromDms(
  dms: Dm[],
  agents: Map<string, Agent>,
  ceoSentinelId: string
): Conversation[] {
  // Group by partner id (the non-CEO participant in each DM)
  const grouped = new Map<string, Dm[]>();
  for (const dm of dms) {
    const partnerId = dm.from_id === ceoSentinelId ? dm.to_id : dm.from_id;
    if (!grouped.has(partnerId)) grouped.set(partnerId, []);
    grouped.get(partnerId)!.push(dm);
  }

  const conversations: Conversation[] = [];
  for (const [partnerId, messages] of grouped) {
    // Sort oldest -> newest within the conversation
    const sorted = [...messages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const lastMessage = sorted[sorted.length - 1]!;

    // Count unread messages addressed TO the CEO (incoming, not yet read)
    const unreadCount = sorted.filter(
      (m) => m.to_id === ceoSentinelId && !m.read_at
    ).length;

    conversations.push({
      partnerId,
      partner: agents.get(partnerId),
      messages: sorted,
      lastMessage,
      unreadCount,
    });
  }

  // Sort conversations by most recent activity descending
  conversations.sort(
    (a, b) =>
      new Date(b.lastMessage.created_at).getTime() -
      new Date(a.lastMessage.created_at).getTime()
  );

  return conversations;
}

/**
 * Format a relative time string for the conversation list.
 * Examples: "just now", "12 min", "3 hours", "2 days", "5 weeks"
 * Compact format suitable for the left rail.
 */
export function formatRelativeShort(iso: string, nowMs: number = Date.now()): string {
  const ageMs = nowMs - new Date(iso).getTime();
  if (ageMs < 60_000) return "just now";
  const min = Math.floor(ageMs / 60_000);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"}`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"}`;
  const wk = Math.floor(day / 7);
  return `${wk} week${wk === 1 ? "" : "s"}`;
}

/**
 * Get a single-line preview of a DM body, stripping any artifact block
 * and trimming to a max length. Used in the conversation list rail.
 *
 * Day 14b: defensive guard against undefined/null body. Realtime payloads
 * occasionally arrive with missing body fields - the function should
 * return an empty string rather than crash the entire dashboard render.
 */
export function previewBody(body: string | null | undefined, maxLen: number = 60): string {
  if (typeof body !== "string" || body.length === 0) return "";
  // Strip artifact block if present
  const blockStart = body.lastIndexOf("<artifacts>");
  const stripped = blockStart === -1 ? body : body.slice(0, blockStart).trimEnd();
  // Collapse newlines to spaces
  const oneLine = stripped.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + "…";
}
