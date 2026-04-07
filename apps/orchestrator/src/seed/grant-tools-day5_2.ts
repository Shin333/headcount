import { db } from "../db.js";
import { config } from "../config.js";

// ----------------------------------------------------------------------------
// seed/grant-tools-day5_2.ts - Day 5.2
// ----------------------------------------------------------------------------
// Extends the Day 5 tool grant pattern to two more agents:
//   - Tsai Wei-Ming (Director of Engineering)
//   - Han Jae-won  (Director of Strategy & Innovation)
//
// Each agent gets:
//   1. tool_access merged with ['web_search']
//   2. A character-specific search ethic appended to frozen_core
//      (different from Ayaka's so they actually USE search differently)
//
// Idempotent: same marker pattern as Day 5's grant-tools.ts. Safe to re-run.
// Read-back verified per Day 3.1 rule.
//
// Run with: pnpm tsx src/seed/grant-tools-day5_2.ts
// ----------------------------------------------------------------------------

interface AgentGrant {
  name: string;
  guideline: string;
}

// The marker MUST match Day 5's grant-tools.ts marker so both scripts coexist
// without overwriting each other's work on different agents.
const GUIDELINE_MARKER = "# Tool access: web_search";

const GRANTS: AgentGrant[] = [
  {
    name: "Tsai Wei-Ming",
    guideline: `

# Tool access: web_search
You have access to a web_search tool that queries the live web. Use it when you need to verify a technical claim, check current API documentation, look up library or framework changes, or confirm version-specific behavior. Prefer official documentation over blog posts. Be skeptical of anything that doesn't cite a version number or a release date. When you cite a source, include the URL and note the version or date you relied on. If the docs and a blog post disagree, the docs win. You are an engineer. Use search the way an engineer reads a changelog: methodically, with low tolerance for vibes-based answers.
`,
  },
  {
    name: "Han Jae-won",
    guideline: `

# Tool access: web_search
You have access to a web_search tool that queries the live web. Use it when you need market intelligence, competitive positioning data, recent funding or earnings information, or strategic context that requires current information. Triangulate across multiple sources before drawing a conclusion - one article is a data point, three articles is a pattern. Distinguish primary sources (company filings, press releases, official statements) from secondary analysis (blog posts, opinion pieces, aggregator coverage). When you cite, make it clear which is which. If sources conflict, say so explicitly and tell me which one you trust more and why. You are a strategist. Search the way a strategist reads the market: with patience and a willingness to say "the data is unclear" rather than force a story.
`,
  },
];

async function grantOne(grant: AgentGrant): Promise<{ ok: boolean; changed: boolean }> {
  console.log(`[grant-tools-day5.2] looking up ${grant.name}...`);

  const { data: agent, error: loadErr } = await db
    .from("agents")
    .select("id, name, frozen_core, tool_access")
    .eq("tenant_id", config.tenantId)
    .eq("name", grant.name)
    .maybeSingle();

  if (loadErr || !agent) {
    console.error(`[grant-tools-day5.2] FAILED to find ${grant.name}: ${loadErr?.message ?? "not found"}`);
    return { ok: false, changed: false };
  }

  // Build the new tool_access set (idempotent merge)
  const currentTools: string[] = agent.tool_access ?? [];
  const newTools = currentTools.includes("web_search")
    ? currentTools
    : [...currentTools, "web_search"];

  // Build the new frozen_core (only append if marker isn't already there)
  const currentFrozenCore: string = agent.frozen_core ?? "";
  const newFrozenCore = currentFrozenCore.includes(GUIDELINE_MARKER)
    ? currentFrozenCore
    : currentFrozenCore + grant.guideline;

  const toolsChanged = newTools.length !== currentTools.length;
  const promptChanged = newFrozenCore !== currentFrozenCore;

  if (!toolsChanged && !promptChanged) {
    console.log(`[grant-tools-day5.2] ${grant.name} already has web_search and the guideline. Nothing to do.`);
    return { ok: true, changed: false };
  }

  console.log(
    `[grant-tools-day5.2] updating ${grant.name}: tools_changed=${toolsChanged}, prompt_changed=${promptChanged}`
  );

  const { error: updateErr } = await db
    .from("agents")
    .update({
      tool_access: newTools,
      frozen_core: newFrozenCore,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agent.id);

  if (updateErr) {
    console.error(`[grant-tools-day5.2] FAILED to update ${grant.name}: ${updateErr.message}`);
    return { ok: false, changed: false };
  }

  // Read-back verification (Day 3.1 rule)
  const { data: verify } = await db
    .from("agents")
    .select("tool_access, frozen_core")
    .eq("id", agent.id)
    .maybeSingle();

  if (!verify) {
    console.error(`[grant-tools-day5.2] read-back verification failed - row not found for ${grant.name}`);
    return { ok: false, changed: false };
  }

  const verifyTools: string[] = verify.tool_access ?? [];
  if (!verifyTools.includes("web_search")) {
    console.error(`[grant-tools-day5.2] read-back FAILED for ${grant.name}: tool_access does not contain web_search`);
    return { ok: false, changed: false };
  }

  if (!(verify.frozen_core ?? "").includes(GUIDELINE_MARKER)) {
    console.error(`[grant-tools-day5.2] read-back FAILED for ${grant.name}: frozen_core does not contain guideline marker`);
    return { ok: false, changed: false };
  }

  console.log(`[grant-tools-day5.2] OK - ${grant.name} now has tools: [${verifyTools.join(", ")}]`);
  return { ok: true, changed: true };
}

async function main(): Promise<void> {
  console.log(`[grant-tools-day5.2] granting web_search to ${GRANTS.length} agents...`);

  let allOk = true;
  let totalChanged = 0;

  for (const grant of GRANTS) {
    const result = await grantOne(grant);
    if (!result.ok) allOk = false;
    if (result.changed) totalChanged++;
  }

  console.log("");
  if (!allOk) {
    console.error(`[grant-tools-day5.2] FAILED - one or more grants did not complete successfully`);
    process.exit(1);
  }

  console.log(`[grant-tools-day5.2] Done. ${totalChanged} of ${GRANTS.length} agents updated.`);
  console.log(`[grant-tools-day5.2] Safe to re-run; idempotent.`);
}

main().catch((err) => {
  console.error("[grant-tools-day5.2] crashed:", err);
  process.exit(1);
});
