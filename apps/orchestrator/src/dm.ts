import { db } from "./db.js";
import { config } from "./config.js";
import type { Dm } from "@headcount/shared";

// ----------------------------------------------------------------------------
// dm.ts - direct messages between agents
// ----------------------------------------------------------------------------
// Lightweight: an agent can send a DM to another agent. The recipient sees it
// on their next ritual. The dashboard surfaces unread DMs in a side panel.
// ----------------------------------------------------------------------------

export async function sendDm(fromId: string, toId: string, body: string): Promise<void> {
  await db.from("dms").insert({
    tenant_id: config.tenantId,
    from_id: fromId,
    to_id: toId,
    body,
  });
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
