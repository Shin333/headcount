import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // How many genviral_create_draft fires in last 2h
  const { data: fires } = await sb.from("real_action_audit")
    .select("created_at,agent_id,success,result_summary")
    .eq("tool_name", "genviral_create_draft")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  console.log(`genviral_create_draft fires in last 2h: ${fires?.length ?? 0}`);
  for (const f of fires ?? []) console.log(`  ${f.created_at} agent=${f.agent_id} ok=${f.success}`);

  // Open commitments involving carousel/genviral
  const { data: commits } = await sb.from("commitments")
    .select("id,agent_id,description,status,deadline,created_at,resolved_at")
    .or("description.ilike.%genviral%,description.ilike.%carousel%,description.ilike.%draft%")
    .order("created_at", { ascending: false })
    .limit(20);
  console.log(`\ncarousel/genviral-related commitments (last 20):`);
  for (const c of commits ?? []) console.log(`  ${c.status} ${c.created_at} | ${(c.description ?? "").slice(0, 90)}`);

  // DM volume between Kavitha/Tessa/Chua in last hour
  const { data: names } = await sb.from("agents").select("id,full_name").in("full_name", ["Tessa Goh", "Kavitha Balasubramaniam", "Chua Li Ting"]);
  const idToName = new Map((names ?? []).map((n) => [n.id, n.full_name]));
  const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: dms } = await sb.from("dms")
    .select("id,from_agent_id,to_agent_id,body,created_at")
    .gte("created_at", since1h)
    .in("from_agent_id", Array.from(idToName.keys()))
    .order("created_at", { ascending: false })
    .limit(30);
  console.log(`\nDMs from Tessa/Kavitha/Chua in last 1h: ${dms?.length ?? 0}`);
  for (const d of dms ?? []) {
    const from = idToName.get(d.from_agent_id) ?? d.from_agent_id;
    const to = idToName.get(d.to_agent_id) ?? d.to_agent_id;
    console.log(`  ${d.created_at} ${from} -> ${to}: ${(d.body ?? "").slice(0, 80)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
