// ----------------------------------------------------------------------------
// seed/grant-day17-project-post.ts - grant project_post to named cast
// ----------------------------------------------------------------------------
// Adds 'project_post' to tool_access for all named cast agents so they can
// post to project channels. Also adds it to the standard specialist grant
// list so any specialist pulled into a project via roster_lookup can use it.
//
// Run with:
//   pnpm tsx src/seed/grant-day17-project-post.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

const TOOL_NAME = "project_post";

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
  // Specialists who have been pulled into projects
  "Michelle Pereira",
  "Faizal Harun",
  "Ong Kai Xiang",
  "Heng Kok Wei",
  "Choi Seung-hyun",
];

async function grantProjectPost(): Promise<void> {
  console.log("");
  console.log(`[grant-day17] granting '${TOOL_NAME}' to ${NAMED_CAST.length} agents`);
  console.log(`[grant-day17] tenant: ${config.tenantId}`);
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

    if (error) {
      console.error(`  [ERROR] ${name}: ${error.message}`);
      errors++;
      continue;
    }
    if (!agent) {
      console.warn(`  [MISSING] ${name}`);
      missing++;
      continue;
    }

    const currentTools: string[] = (agent.tool_access as string[] | null) ?? [];
    if (currentTools.includes(TOOL_NAME)) {
      console.log(`  [ALREADY] ${name}`);
      alreadyHas++;
      continue;
    }

    const newTools = [...currentTools, TOOL_NAME];
    const { error: updateErr } = await db
      .from("agents")
      .update({ tool_access: newTools, updated_at: new Date().toISOString() })
      .eq("id", agent.id);

    if (updateErr) {
      console.error(`  [ERROR] ${name}: ${updateErr.message}`);
      errors++;
      continue;
    }

    console.log(`  [GRANTED] ${name} (now has ${newTools.length} tools)`);
    granted++;
  }

  console.log("");
  console.log(
    `[grant-day17] summary: ${granted} granted, ${alreadyHas} already had it, ${missing} missing, ${errors} errors`
  );
  console.log("");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  grantProjectPost()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[grant-day17] unexpected error:`, err);
      process.exit(1);
    });
}
