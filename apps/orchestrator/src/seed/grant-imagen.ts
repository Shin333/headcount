// ----------------------------------------------------------------------------
// seed/grant-imagen.ts - grant imagen_generate to image-capable agents
// ----------------------------------------------------------------------------
// Adds 'imagen_generate' to any agent that already has 'image_generate'.
// This ensures Heng and anyone else with image generation access also gets
// the photorealistic Imagen 3 tool.
//
// Run with:
//   pnpm tsx src/seed/grant-imagen.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

async function grantImagen(): Promise<void> {
  console.log("");
  console.log(`[grant-imagen] granting 'imagen_generate' to agents with 'image_generate'`);
  console.log(`[grant-imagen] tenant: ${config.tenantId}`);
  console.log("");

  // Find all agents who have image_generate
  const { data: agents, error } = await db
    .from("agents")
    .select("id, name, tool_access")
    .eq("tenant_id", config.tenantId);

  if (error || !agents) {
    console.error(`[grant-imagen] failed to load agents: ${error?.message}`);
    return;
  }

  let granted = 0;
  let alreadyHas = 0;
  let skipped = 0;

  for (const agent of agents) {
    const tools: string[] = (agent.tool_access as string[] | null) ?? [];

    if (!tools.includes("image_generate")) {
      skipped++;
      continue;
    }

    if (tools.includes("imagen_generate")) {
      console.log(`  [ALREADY] ${agent.name}`);
      alreadyHas++;
      continue;
    }

    const newTools = [...tools, "imagen_generate"];
    const { error: updateErr } = await db
      .from("agents")
      .update({ tool_access: newTools, updated_at: new Date().toISOString() })
      .eq("id", agent.id);

    if (updateErr) {
      console.error(`  [ERROR] ${agent.name}: ${updateErr.message}`);
      continue;
    }

    console.log(`  [GRANTED] ${agent.name} (now has ${newTools.length} tools)`);
    granted++;
  }

  console.log("");
  console.log(`[grant-imagen] summary: ${granted} granted, ${alreadyHas} already, ${skipped} no image_generate`);
  console.log("");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  grantImagen()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
