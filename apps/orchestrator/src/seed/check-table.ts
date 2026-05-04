import "dotenv/config";

async function main() {
  // Query information_schema directly via PostgREST (bypasses the schema cache)
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/table_exists`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  // Direct PG connection is simpler — use pg via supabase-js raw SQL
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL!, key);

  // Force a PostgREST reload
  const reloadRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    method: "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  console.log("PostgREST ping:", reloadRes.status);

  // Try to query the table with retry
  for (let i = 0; i < 3; i++) {
    const { error } = await sb.from("social_drafts").select("id").limit(1);
    if (!error) {
      console.log(`attempt ${i + 1}: table found`);
      return;
    }
    console.log(`attempt ${i + 1}: ${error.code} ${error.message}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("\nTable not visible. Run in Supabase SQL editor:");
  console.log("  NOTIFY pgrst, 'reload schema';");
  console.log("If that doesn't work, the migration didn't apply. Check the dashboard's Table Editor for `social_drafts`.");
}
main().catch((e) => { console.error(e); process.exit(1); });
