import { db } from "../db.js";
import { config } from "../config.js";
import type { Dm } from "@headcount/shared";

// ----------------------------------------------------------------------------
// dm.ts - direct messages between agents
// ----------------------------------------------------------------------------

export async function sendDm(args: {
  fromId: string;
  toId: string;
  body: string;
}): Promise<{ id: string }> {
  const { data, error } = await db
    .from("dms")
    .insert({
      tenant_id: config.tenantId,
      from_id: args.fromId,
      to_id: args.toId,
      body: args.body,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Failed to send DM: " + error?.message);
  }
  return { id: data.id };
}

export async function unreadDmsFor(agentId: string): Promise<Dm[]> {
  const { data } = await db
    .from("dms")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("to_id", agentId)
    .is("read_at", null)
    .order("created_at", { ascending: true })
    .limit(20);
  return (data ?? []) as Dm[];
}

export async function markDmsRead(dmIds: string[]): Promise<void> {
  if (dmIds.length === 0) return;
  await db.from("dms").update({ read_at: new Date().toISOString() }).in("id", dmIds);
}

// ----------------------------------------------------------------------------
// Day 4: getUnreadDmContextFor - the helper rituals call before runAgentTurn
// ----------------------------------------------------------------------------
// Fetches the N most recent unread DMs to an agent, formats them as a string
// suitable for prepending to a contextBlock, and marks them as read.
//
// Returns an empty string if there are no unread DMs (callers can safely
// concatenate without checking).
//
// Marks DMs read with error checking AND a read-back verification per the
// Day 3.1 lesson - silent failures are unacceptable in state machines.
// ----------------------------------------------------------------------------

const MAX_UNREAD_DM_CONTEXT = 5;

export async function getUnreadDmContextFor(agentId: string): Promise<string> {
  // Fetch the most recent N unread DMs
  const { data: rawDms, error: fetchErr } = await db
    .from("dms")
    .select("id, from_id, body, created_at")
    .eq("tenant_id", config.tenantId)
    .eq("to_id", agentId)
    .is("read_at", null)
    .order("created_at", { ascending: false })
    .limit(MAX_UNREAD_DM_CONTEXT);

  if (fetchErr) {
    console.error(`[dm] failed to fetch unread DMs for ${agentId}: ${fetchErr.message}`);
    return "";
  }
  if (!rawDms || rawDms.length === 0) {
    return "";
  }

  // Resolve sender names (one query, not N)
  const senderIds = Array.from(new Set(rawDms.map((d) => d.from_id)));
  const { data: senders } = await db
    .from("agents")
    .select("id, name, role")
    .in("id", senderIds);

  const senderInfo = new Map<string, { name: string; role: string }>();
  for (const s of senders ?? []) {
    senderInfo.set(s.id, { name: s.name, role: s.role });
  }

  // Format oldest-first (so the agent reads them in order they arrived)
  const ordered = [...rawDms].reverse();
  const formatted = ordered
    .map((d) => {
      const sender = senderInfo.get(d.from_id);
      const senderLabel = sender ? `${sender.name} (${sender.role})` : "Unknown sender";
      return `From ${senderLabel}:\n${d.body}`;
    })
    .join("\n\n---\n\n");

  // Mark them read - WITH error check AND read-back verification
  const dmIds = rawDms.map((d) => d.id);
  const readAt = new Date().toISOString();
  const { error: markErr } = await db
    .from("dms")
    .update({ read_at: readAt })
    .in("id", dmIds);

  if (markErr) {
    console.error(`[dm] FAILED to mark ${dmIds.length} DMs read for ${agentId}: ${markErr.message}`);
    // Fall through and still return the context - the agent should still see them
    // even if we couldn't mark them read (better than dropping the message)
  } else {
    // Verify the writes actually landed by counting how many are now marked read
    const { data: verifyRows } = await db
      .from("dms")
      .select("id")
      .in("id", dmIds)
      .not("read_at", "is", null);

    if (!verifyRows || verifyRows.length !== dmIds.length) {
      console.error(
        `[dm] FAILED to verify mark-read: expected ${dmIds.length} DMs marked, found ${verifyRows?.length ?? 0}`
      );
    }
  }

  const header = `# Unread Direct Messages (${rawDms.length} message${rawDms.length === 1 ? "" : "s"})\n\nYou have unread messages. Read them carefully - if any are from the CEO, treat their substance as guidance you should integrate into your work today. Do not quote them publicly; they are private context.`;

  return `${header}\n\n${formatted}\n\n# End of unread messages\n`;
}

// ----------------------------------------------------------------------------
// Day 4: getCompanyDmsSnapshot - for Eleanor's CEO Brief synthesis
// ----------------------------------------------------------------------------
// Returns a tenant-wide summary of recent DM activity for Eleanor to factor
// into her brief. Does NOT mark anything read - this is read-only.
// ----------------------------------------------------------------------------

export async function getCompanyDmsSnapshot(sinceIso: string): Promise<{
  totalCount: number;
  toCeoCount: number;
  fromCeoCount: number;
}> {
  const { data, error } = await db
    .from("dms")
    .select("from_id, to_id")
    .eq("tenant_id", config.tenantId)
    .gte("created_at", sinceIso);

  if (error || !data) {
    return { totalCount: 0, toCeoCount: 0, fromCeoCount: 0 };
  }

  const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";
  const toCeoCount = data.filter((d) => d.to_id === CEO_SENTINEL_ID).length;
  const fromCeoCount = data.filter((d) => d.from_id === CEO_SENTINEL_ID).length;

  return {
    totalCount: data.length,
    toCeoCount,
    fromCeoCount,
  };
}

// ----------------------------------------------------------------------------
// Day 4.5: getOldestUnreadDmActionable - what the always-on responder picks up
// ----------------------------------------------------------------------------
// Returns the oldest unread DM whose recipient is NOT the CEO sentinel.
// (DMs to the CEO are read by the CEO via the dashboard, not by the runner.)
//
// Returns null if there's nothing to process.
//
// Read-only - does NOT mark anything read. The caller decides when to mark
// based on whether they successfully sent a response.
// ----------------------------------------------------------------------------

const CEO_SENTINEL_ID_CONST = "00000000-0000-0000-0000-00000000ce00";

export interface ActionableDm {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  created_at: string;
}

export async function getOldestUnreadDmActionable(): Promise<ActionableDm | null> {
  const { data, error } = await db
    .from("dms")
    .select("id, from_id, to_id, body, created_at")
    .eq("tenant_id", config.tenantId)
    .is("read_at", null)
    .neq("to_id", CEO_SENTINEL_ID_CONST)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as ActionableDm;
}

export async function markDmReadVerified(dmId: string): Promise<boolean> {
  const readAt = new Date().toISOString();
  const { error } = await db
    .from("dms")
    .update({ read_at: readAt })
    .eq("id", dmId);

  if (error) {
    console.error(`[dm] FAILED to mark DM ${dmId} read: ${error.message}`);
    return false;
  }

  // Read-back verify
  const { data: verify } = await db
    .from("dms")
    .select("id, read_at")
    .eq("id", dmId)
    .maybeSingle();

  if (!verify || !verify.read_at) {
    console.error(`[dm] FAILED to verify DM ${dmId} marked read`);
    return false;
  }

  return true;
}
