// ----------------------------------------------------------------------------
// seed/grant-day18-commitment-create.ts
// ----------------------------------------------------------------------------
// Adds 'commitment_create' to tool_access for all named cast agents.
//
// Run with:
//   pnpm tsx src/seed/grant-day18-commitment-create.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

const TOOL_NAME = "commitment_create";

const NAMED_CAST = [
  "Eleanor Vance",
  "Evangeline Tan",
  "Tsai Wei-Ming",
  "Park So-yeon",
  "Han Jae-won",
  "Bradley Koh",
  "Chen Yu-ting",
  "Tessa Goh",
  "Rina Halim",
  "Hoshino Ayaka",
  "Lim Geok Choo",
  "Nadia Rahman",
  "Devraj Pillai",
  "Faridah binte Yusof",
  "Siti Nurhaliza",
  "Michelle Pereira",
  "Faizal Harun",
  "Ong Kai Xiang",
  "Heng Kok Wei",
  "Choi Seung-hyun",
];

async function grantCommitmentCreate(): Promise<void> {
  console.log("");
  console.log(`[grant-day18] granting '${TOOL_NAME}' to ${NAMED_CAST.length} agents`);
  console.log(`[grant-day18] tenant: ${config.tenantId}`);
  console.log("");

  let granted = 0;
  let alreadyHas = 0;
  let missing = 0;
  let errors = 0;

  for (const name of NAMED_CAST) {
    const { data: agent, error } = await db
      .from("agents")
      .select("id, name, tool_access")
      .eq("tenant_id", config.tenantId)
      .eq("name", name)
      .maybeSingle();

    if (error) { console.error(`  [ERROR] ${name}: ${error.message}`); errors++; continue; }
    if (!agent) { console.warn(`  [MISSING] ${name}`); missing++; continue; }

    const currentTools: string[] = (agent.tool_access as string[] | null) ?? [];
    if (currentTools.includes(TOOL_NAME)) { alreadyHas++; continue; }

    const newTools = [...currentTools, TOOL_NAME];
    const { error: updateErr } = await db
      .from("agents")
      .update({ tool_access: newTools, updated_at: new Date().toISOString() })
      .eq("id", agent.id);

    if (updateErr) { console.error(`  [ERROR] ${name}: ${updateErr.message}`); errors++; continue; }
    console.log(`  [GRANTED] ${name} (now has ${newTools.length} tools)`);
    granted++;
  }

  console.log("");
  console.log(`[grant-day18] summary: ${granted} granted, ${alreadyHas} already, ${missing} missing, ${errors} errors`);
  console.log("");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  grantCommitmentCreate()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
