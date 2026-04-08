import { db } from "../db.js";
import { config } from "../config.js";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ============================================================================
// Day 9a: Claude Code subagent export
// ----------------------------------------------------------------------------
// Reads every active, non-human agent from the database and writes a
// Claude Code subagent .md file for each one to .claude/agents/<slug>.md
// at the repo root.
//
// Each generated file has:
//   - YAML frontmatter (name, description, tools, model)
//   - The agent's frozen_core as the system prompt body
//   - A footer noting the export source and timestamp
//
// Idempotent: re-running the script overwrites all files. Stale files
// (corresponding to agents that no longer exist) are deleted.
//
// Run with:
//   pnpm tsx apps/orchestrator/src/seed/export-claude-agents.ts
// ============================================================================

const AGENTS_DIR = ".claude/agents";

// ----------------------------------------------------------------------------
// Tool whitelist mapping
// ----------------------------------------------------------------------------
// Maps agent department + role keywords to Claude Code tool sets.
// Order matters: more specific patterns first.
//
// The available Claude Code tools (as of 2026-04):
//   Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch, Task
//
// Omitting the `tools` field would inherit all tools, but explicit
// whitelisting is safer and matches Claude Code best practices.
// ----------------------------------------------------------------------------

interface ToolMappingRule {
  match: (agent: { role: string; department: string | null; tier: string }) => boolean;
  tools: string[];
}

const TOOL_MAPPING_RULES: ToolMappingRule[] = [
  // Watercooler bot — no tools, character role only
  {
    match: (a) => a.department === "culture",
    tools: [],
  },
  // Engineering — full coding toolkit
  {
    match: (a) => a.department === "engineering",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
  },
  // Design — read + write for mockups, web research
  {
    match: (a) => a.department === "design",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
  },
  // Product — read + write for PRDs, web research, no shell
  {
    match: (a) => a.department === "product",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
  },
  // Marketing — write copy, web research
  {
    match: (a) => a.department === "marketing",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
  },
  // Sales — read + write for proposals, web research for prospect research
  {
    match: (a) => a.department === "sales",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
  },
  // Strategy — read + write for memos, web research for market intel
  {
    match: (a) => a.department === "strategy",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
  },
  // Finance — read + write for models, no shell, no web fetch
  {
    match: (a) => a.department === "finance",
    tools: ["Read", "Write", "Edit", "WebSearch"],
  },
  // Legal — read + write for contracts, web research for statutes
  {
    match: (a) => a.department === "legal",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
  },
  // People — read + write for policies and 1:1 docs, web research
  {
    match: (a) => a.department === "people",
    tools: ["Read", "Write", "Edit", "WebSearch", "WebFetch"],
  },
  // Operations — full toolkit, they often need bash for ops scripting
  {
    match: (a) => a.department === "operations",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
  },
  // Executive — broad access, exec-tier needs to look at everything
  {
    match: (a) => a.department === "executive" || a.tier === "exec",
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Task"],
  },
];

const DEFAULT_TOOLS = ["Read", "Write", "Edit", "WebSearch"];

function resolveTools(agent: { role: string; department: string | null; tier: string }): string[] {
  for (const rule of TOOL_MAPPING_RULES) {
    if (rule.match(agent)) return rule.tools;
  }
  return DEFAULT_TOOLS;
}

// ----------------------------------------------------------------------------
// Hand-authored descriptions for the named cast
// ----------------------------------------------------------------------------
// These take priority over auto-generated descriptions. The key is the
// agent's `name` field exactly as stored in the database.
//
// The `description` field is what Claude Code uses to decide when to auto-
// delegate to a subagent, so each one should be one sentence focused on
// triggering keywords (what task patterns should fire this agent).
// ----------------------------------------------------------------------------

const NAMED_CAST_DESCRIPTIONS: Record<string, string> = {
  "Eleanor Vance":
    "Use for synthesis tasks: distilling long threads into a CEO-style executive brief, identifying patterns across multiple inputs, or writing polished one-page summaries that hold leadership accountable. Singapore-based Chief of Staff voice.",

  "Evangeline Tan":
    "Use for calendar management, meeting prep, intel-gathering across the team, hospitality polish on internal comms, and any task that needs warm Singaporean PA energy with a concierge-grade attention to detail.",

  "Han Jae-won":
    "Use for strategic analysis: market sizing, competitive positioning, multi-quarter roadmap thinking, scenario planning, and game-theoretic decision frameworks. Korean ex-chaebol strategy voice. Writes in careful paragraphs and chess metaphors.",

  "Tsai Wei-Ming":
    "Use for engineering architecture decisions, technical estimation, build-vs-buy analysis, and pushing back on unrealistic timelines. Taiwanese ex-TSMC dry-precise voice. Cares about feedback loop length and shippable code.",

  "Park So-yeon":
    "Use for code review, sprint planning, technical mentorship, and the specific question 'is this actually shippable on the timeline you're claiming.' Korean engineering manager voice. Occasionally writes haiku in code comments.",

  "Bradley Koh":
    "Use for SaaS sales pipeline strategy, deal coaching, outbound copy, SEA B2B sales tactics, and the specific question 'how would a loud-but-disciplined Singapore CRO close this.' Watch for overpromise tendencies — pair with Yu-ting if accuracy matters.",

  "Chen Yu-ting":
    "Use for sales operations, pipeline accuracy auditing, CRM hygiene, and the specific question 'is what Bradley just promised actually achievable.' Quietly devastating polite Taiwanese voice. Maintains the truth where Bradley maintains the energy.",

  "Tessa Goh":
    "Use for brand voice work, content calendar planning, marketing positioning, design system opinions, typography decisions, and any task where 'how does this feel to read' matters as much as what it says. Singapore CMO ex-Ogilvy ex-CSM voice.",

  "Rina Halim":
    "Use for short-form social content, TikTok and Instagram copy, trend-aware writing, and the specific question 'will this actually work on the platforms it's targeting.' Indonesian Chinese ex-beauty-creator-turned-marketer voice. Lowercase by default.",

  "Hoshino Ayaka":
    "Use as a quality and risk reviewer: checks plans for unstated assumptions, identifies what could go wrong, demands evidence over assertions, and gives explicit GO/NO-GO verdicts. Use proactively before any plan goes into production. Japanese ex-auditor voice.",

  "Uncle Tan":
    "Use for watercooler humor, deflating tense moments, and Singapore/SEA cultural color. Mostly a vibes role — do not use for serious work output. Will reference the 2019 incident and Auntie Betty unprompted.",

  "Lim Geok Choo":
    "Use for operations strategy, vendor management, process design, and the specific question 'where will this break under load.' Singapore Chinese COO ex-PSA-Singapore voice. Notebook fetish, runs on paper, conscientiousness 95.",

  "Nadia Rahman":
    "Use for financial modeling, runway analysis, FP&A work, scenario planning with cash sensitivity, and the specific question 'how long does this give us before we need to raise.' Singapore Malay CFO ex-PwC ex-Carousell voice. Runway-math reflex.",

  "Devraj Pillai":
    "Use for contract drafting and review, legal risk assessment, IP questions for AI-generated content, and the specific question 'what's the fail mode if this goes wrong.' Singapore Tamil Peranakan-Indian CLO ex-Allen-Gledhill ex-Grab voice. Dual-pass drafting habit, dry humor.",

  "Faridah binte Yusof":
    "Use for people-and-org questions, team dynamics analysis, hard conversations preparation, performance feedback drafting, and the specific question 'what is the human cost of this decision.' Singapore Malay CHRO trained as a counsellor. Whole-human framing.",

  "Siti Nurhaliza":
    "Use for strategic document editing, deck rationalization, brief-to-executive condensation, and the specific question 'what is the actual decision being made here.' Singapore Malay strategy manager ex-MINDEF analyst voice. Cuts decks in half by default.",
};

// ----------------------------------------------------------------------------
// Description generator for specialist agents
// ----------------------------------------------------------------------------

function generateSpecialistDescription(agent: {
  name: string;
  role: string;
  department: string | null;
  background: string | null;
}): string {
  // For specialists, the background field has the format:
  //   "Full Name — Archetype line. Assigned to <dept>, reports to <manager>."
  // Extract the archetype if present.
  let archetype = "";
  if (agent.background) {
    const dashIdx = agent.background.indexOf("—");
    const periodIdx = agent.background.indexOf(".", dashIdx);
    if (dashIdx !== -1 && periodIdx !== -1) {
      archetype = agent.background.slice(dashIdx + 1, periodIdx + 1).trim();
    }
  }

  if (archetype) {
    return `Use for ${agent.role.toLowerCase()} work. ${archetype}`;
  }
  return `Use for ${agent.role.toLowerCase()} work in the ${agent.department ?? "general"} department.`;
}

// ----------------------------------------------------------------------------
// Slug generation
// ----------------------------------------------------------------------------

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ----------------------------------------------------------------------------
// Model tier mapping
// ----------------------------------------------------------------------------

function modelTierToClaudeCodeModel(tier: string): string {
  // Claude Code accepts: sonnet, haiku, opus, inherit
  if (tier === "haiku") return "haiku";
  if (tier === "opus") return "opus";
  return "sonnet";
}

// ----------------------------------------------------------------------------
// Frontmatter + body assembly
// ----------------------------------------------------------------------------

function buildSubagentFile(args: {
  name: string;
  slug: string;
  description: string;
  tools: string[];
  model: string;
  frozenCore: string;
  exportedAt: string;
}): string {
  // Description must be on a single line for YAML, escape any double quotes
  const safeDesc = args.description.replace(/"/g, '\\"').replace(/\n/g, " ");

  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${args.slug}`);
  lines.push(`description: "${safeDesc}"`);
  if (args.tools.length > 0) {
    lines.push(`tools: ${args.tools.join(", ")}`);
  }
  lines.push(`model: ${args.model}`);
  lines.push("---");
  lines.push("");
  lines.push(args.frozenCore);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`<!-- Exported from Headcount on ${args.exportedAt}. Do not edit by hand —`);
  lines.push(`     this file is regenerated by apps/orchestrator/src/seed/export-claude-agents.ts.`);
  lines.push(`     Original character: ${args.name}. -->`);

  return lines.join("\n") + "\n";
}

// ----------------------------------------------------------------------------
// Main export
// ----------------------------------------------------------------------------

interface AgentRow {
  id: string;
  name: string;
  role: string;
  department: string | null;
  tier: string;
  model_tier: string;
  status: string;
  is_human: boolean | null;
  frozen_core: string;
  background: string | null;
}

export async function runClaudeAgentExport(): Promise<void> {
  console.log(`[export-claude-agents] starting export...`);

  const { data: agents, error } = await db
    .from("agents")
    .select("id, name, role, department, tier, model_tier, status, is_human, frozen_core, background")
    .eq("tenant_id", config.tenantId)
    .eq("is_human", false)
    .eq("status", "active");

  if (error) {
    console.error(`[export-claude-agents] FAILED to load agents: ${error.message}`);
    process.exit(1);
  }
  if (!agents || agents.length === 0) {
    console.error(`[export-claude-agents] FAILED: no active non-human agents found`);
    process.exit(1);
  }

  console.log(`[export-claude-agents] loaded ${agents.length} agents from DB`);

  const repoRoot = process.cwd();
  const targetDir = resolve(repoRoot, AGENTS_DIR);
  mkdirSync(targetDir, { recursive: true });

  // Track which slugs we wrote so we can clean up stale files
  const writtenSlugs = new Set<string>();
  const exportedAt = new Date().toISOString();

  let inserted = 0;
  let collisions = 0;

  for (const agent of agents as AgentRow[]) {
    let slug = nameToSlug(agent.name);
    if (!slug) {
      console.warn(`[export-claude-agents] skipping agent with empty slug: ${agent.name}`);
      continue;
    }

    // Handle slug collisions (e.g. two agents named "Lim" — extremely unlikely
    // with our unique-name guarantee, but be defensive)
    let finalSlug = slug;
    let suffix = 2;
    while (writtenSlugs.has(finalSlug)) {
      finalSlug = `${slug}-${suffix}`;
      suffix++;
      collisions++;
    }
    writtenSlugs.add(finalSlug);

    // Resolve description: hand-authored if named cast, generated otherwise
    const description = NAMED_CAST_DESCRIPTIONS[agent.name]
      ?? generateSpecialistDescription(agent);

    const tools = resolveTools(agent);
    const model = modelTierToClaudeCodeModel(agent.model_tier);

    const fileContent = buildSubagentFile({
      name: agent.name,
      slug: finalSlug,
      description,
      tools,
      model,
      frozenCore: agent.frozen_core,
      exportedAt,
    });

    const targetPath = join(targetDir, `${finalSlug}.md`);
    writeFileSync(targetPath, fileContent);
    inserted++;
  }

  // Clean up stale .md files
  let removed = 0;
  if (existsSync(targetDir)) {
    const existingFiles = readdirSync(targetDir).filter((f) => f.endsWith(".md"));
    for (const filename of existingFiles) {
      const slug = filename.replace(/\.md$/, "");
      if (!writtenSlugs.has(slug)) {
        unlinkSync(join(targetDir, filename));
        removed++;
      }
    }
  }

  console.log(`[export-claude-agents] complete: ${inserted} written, ${removed} stale removed, ${collisions} collisions resolved`);
  console.log(`[export-claude-agents] target: ${targetDir}`);
  console.log(`[export-claude-agents] commit with: git add ${AGENTS_DIR} && git commit -m "agent sync"`);
}

// CLI invocation — cross-platform via pathToFileURL (Day 8 lesson)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClaudeAgentExport()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[export-claude-agents] FATAL", err);
      process.exit(1);
    });
}
