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
