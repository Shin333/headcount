import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: drafts, error } = await sb
    .from("social_drafts")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) {
    console.log("social_drafts table check:", error.code, "-", error.message);
  } else {
    console.log(`social_drafts (last 2h): ${drafts?.length ?? 0}`);
    for (const d of drafts ?? []) console.log(JSON.stringify(d, null, 2));
  }

  console.log("\n--- real_action_audit for genviral_create_draft (last 2h) ---");
  const { data: audit, error: aerr } = await sb
    .from("real_action_audit")
    .select("*")
    .eq("tool_name", "genviral_create_draft")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);
  if (aerr) { console.error("audit query error:", aerr); process.exit(1); }
  console.log(`audit rows: ${audit?.length ?? 0}`);
  for (const a of audit ?? []) {
    console.log(JSON.stringify(a, null, 2));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
