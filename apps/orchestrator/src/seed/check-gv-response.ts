import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await sb.from("real_action_audit").select("*").eq("tool_name", "genviral_create_draft").eq("success", true).order("created_at", { ascending: false }).limit(1);
  console.log(JSON.stringify(data?.[0] ?? null, null, 2));

  console.log("\n--- social_drafts exists check ---");
  const { data: d2, error } = await sb.from("social_drafts").select("id").limit(1);
  if (error) console.log("still missing:", error.code, error.message);
  else console.log("table ok, rows:", d2?.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
