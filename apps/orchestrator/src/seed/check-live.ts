import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  console.log(`Checking activity since ${since} (last 10 min)`);
  console.log(`Now: ${new Date().toISOString()}\n`);

  // Recent DMs
  const { data: dms } = await sb.from("dms").select("id,from_agent_id,to_agent_id,body,created_at").gte("created_at", since).order("created_at", { ascending: false }).limit(10);
  console.log(`--- DMs (last 10min): ${dms?.length ?? 0} ---`);
  for (const d of dms ?? []) console.log(`${d.created_at} ${(d.body ?? "").slice(0, 100)}`);

  // Recent genviral audit
  const { data: audit } = await sb.from("real_action_audit").select("created_at,agent_id,success,result_summary,error_message").eq("tool_name", "genviral_create_draft").gte("created_at", since).order("created_at", { ascending: false });
  console.log(`\n--- genviral_create_draft attempts (last 10min): ${audit?.length ?? 0} ---`);
  for (const a of audit ?? []) console.log(`${a.created_at} success=${a.success} ${a.result_summary} ${(a.error_message ?? "").slice(0, 200)}`);

  // social_drafts
  const { data: drafts, error: derr } = await sb.from("social_drafts").select("*").gte("created_at", since).order("created_at", { ascending: false });
  console.log(`\n--- social_drafts (last 10min): ${drafts?.length ?? 0} ---`);
  if (derr) console.log(`  table error: ${derr.code} ${derr.message}`);
  for (const d of drafts ?? []) console.log(JSON.stringify({ id: d.id, platform: d.platform, status: d.status, genviral_post_id: d.genviral_post_id, error: d.error_message }, null, 2));

  // All tool usage in last 10min
  const { data: tools } = await sb.from("real_action_audit").select("created_at,tool_name,success").gte("created_at", since).order("created_at", { ascending: false }).limit(30);
  console.log(`\n--- all tool calls (last 10min): ${tools?.length ?? 0} ---`);
  for (const t of tools ?? []) console.log(`${t.created_at} ${t.tool_name} success=${t.success}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
