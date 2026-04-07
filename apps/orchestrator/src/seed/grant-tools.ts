import { db } from "../db.js";
import { config } from "../config.js";

// ----------------------------------------------------------------------------
// seed/grant-tools.ts - Day 5
// ----------------------------------------------------------------------------
// Idempotent script that:
//   1. Grants Hoshino Ayaka tool_access = ['web_search']
//   2. Prepends a short web_search usage guideline to her frozen_core
//      (only if not already present, to keep this safe to re-run)
//
// Run with: pnpm tsx src/seed/grant-tools.ts
// Or invoked from a one-off pnpm script.
// ----------------------------------------------------------------------------

const AYAKA_NAME = "Hoshino Ayaka";

const WEB_SEARCH_GUIDELINE = `

# Tool access: web_search
You have access to a web_search tool that queries the live web. Use it when you need to verify a specific factual claim, check recent news, or look up something that happened after your training cutoff. Do NOT use it for opinions, internal company knowledge, or things you can reasonably know without searching. When you do use it, cite the URL of the source you relied on. If the search returns nothing useful or contradicts itself, say so plainly. You are the Reality Checker. Search is one of your tools, not a crutch.
`;

const GUIDELINE_MARKER = "# Tool access: web_search";

async function main(): Promise<void> {
  console.log("[grant-tools] looking up Hoshino Ayaka...");

  const { data: ayaka, error: loadErr } = await db
    .from("agents")
    .select("id, name, frozen_core, tool_access")
    .eq("tenant_id", config.tenantId)
    .eq("name", AYAKA_NAME)
    .maybeSingle();

  if (loadErr || !ayaka) {
    console.error(`[grant-tools] FAILED to find ${AYAKA_NAME}: ${loadErr?.message ?? "not found"}`);
    process.exit(1);
  }

  // Build the new tool_access set (idempotent merge)
  const currentTools: string[] = ayaka.tool_access ?? [];
  const newTools = currentTools.includes("web_search")
    ? currentTools
    : [...currentTools, "web_search"];

  // Build the new frozen_core (only append if marker isn't already there)
  const currentFrozenCore: string = ayaka.frozen_core ?? "";
  const newFrozenCore = currentFrozenCore.includes(GUIDELINE_MARKER)
    ? currentFrozenCore
    : currentFrozenCore + WEB_SEARCH_GUIDELINE;

  const toolsChanged = newTools.length !== currentTools.length;
  const promptChanged = newFrozenCore !== currentFrozenCore;

  if (!toolsChanged && !promptChanged) {
    console.log(`[grant-tools] ${AYAKA_NAME} already has web_search and the guideline. Nothing to do.`);
    return;
  }

  console.log(`[grant-tools] updating ${AYAKA_NAME}: tools_changed=${toolsChanged}, prompt_changed=${promptChanged}`);

  const { error: updateErr } = await db
    .from("agents")
    .update({
      tool_access: newTools,
      frozen_core: newFrozenCore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ayaka.id);

  if (updateErr) {
    console.error(`[grant-tools] FAILED to update ${AYAKA_NAME}: ${updateErr.message}`);
    process.exit(1);
  }

  // Read-back verification (Day 3.1 rule)
  const { data: verify } = await db
    .from("agents")
    .select("tool_access, frozen_core")
    .eq("id", ayaka.id)
    .maybeSingle();

  if (!verify) {
    console.error(`[grant-tools] read-back verification failed - row not found`);
    process.exit(1);
  }

  const verifyTools: string[] = verify.tool_access ?? [];
  if (!verifyTools.includes("web_search")) {
    console.error(`[grant-tools] read-back verification failed - tool_access does not contain web_search`);
    process.exit(1);
  }

  if (!(verify.frozen_core ?? "").includes(GUIDELINE_MARKER)) {
    console.error(`[grant-tools] read-back verification failed - frozen_core does not contain guideline marker`);
    process.exit(1);
  }

  console.log(`[grant-tools] OK - ${AYAKA_NAME} now has tools: [${verifyTools.join(", ")}]`);
  console.log(`[grant-tools] Done. You can re-run this script safely; it is idempotent.`);
}

main().catch((err) => {
  console.error("[grant-tools] crashed:", err);
  process.exit(1);
});
