// ============================================================================
// seed/day27-encrypt-credentials.ts
// ----------------------------------------------------------------------------
// One-shot backfill: read every row in agent_credentials, encrypt any
// access_token / refresh_token that's still plaintext, write back.
//
// Idempotent — encryptCredential() detects the v1: prefix and skips already-
// encrypted values. Safe to re-run (no-op the second time).
//
// Requires CRED_ENCRYPTION_KEY in apps/orchestrator/.env. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Run with: pnpm exec tsx src/seed/day27-encrypt-credentials.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";
import { encryptCredential, isEncrypted, isEncryptionKeyConfigured } from "../auth/crypto.js";

async function main() {
  if (!isEncryptionKeyConfigured()) {
    console.error("CRED_ENCRYPTION_KEY is not set. Generate one and add to apps/orchestrator/.env:");
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    process.exit(1);
  }

  const { data: rows, error } = await db
    .from("agent_credentials")
    .select("id, agent_id, provider, scope, access_token, refresh_token")
    .eq("tenant_id", config.tenantId);

  if (error) {
    console.error(`query failed: ${error.message}`);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log("No agent_credentials rows. Nothing to encrypt.");
    return;
  }

  console.log(`=== Day 27 — encrypt ${rows.length} credential row(s) ===\n`);

  let updated = 0;
  let already = 0;
  for (const r of rows) {
    const accessNeeds = !isEncrypted(r.access_token);
    const refreshNeeds = r.refresh_token != null && !isEncrypted(r.refresh_token);
    if (!accessNeeds && !refreshNeeds) {
      console.log(`  - ${r.provider}/${r.scope} for agent ${r.agent_id.slice(0, 8)}: already encrypted`);
      already++;
      continue;
    }

    const patch: Record<string, unknown> = {};
    if (accessNeeds) patch.access_token = encryptCredential(r.access_token);
    if (refreshNeeds && r.refresh_token) patch.refresh_token = encryptCredential(r.refresh_token);

    const { error: uErr } = await db.from("agent_credentials").update(patch).eq("id", r.id);
    if (uErr) {
      console.log(`  ! ${r.provider}/${r.scope}: update failed — ${uErr.message}`);
      continue;
    }
    console.log(`  + ${r.provider}/${r.scope} for agent ${r.agent_id.slice(0, 8)}: encrypted ${accessNeeds ? "access" : ""}${accessNeeds && refreshNeeds ? " + " : ""}${refreshNeeds ? "refresh" : ""}`);
    updated++;
  }

  console.log(`\nSummary: ${updated} encrypted, ${already} already encrypted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
