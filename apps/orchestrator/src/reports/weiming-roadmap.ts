import type { ReportRitual, ReportContext, GeneratedReport } from "./types.js";
import { runAgentTurn } from "../agents/runner.js";
import { getToolsForAgent } from "../tools/registry.js";

// ----------------------------------------------------------------------------
// reports/weiming-roadmap.ts - Day 6 + Day 20 confabulation fix
// ----------------------------------------------------------------------------
// Day 6 original: fired every 30 wall minutes on Opus with no grounding.
// Wei-Ming would fabricate CVEs, migrations, fork statuses, and staffing
// requests that don't exist. The team reacted to these as real.
//
// Day 20 fix:
//   1. Frequency: 30 wall minutes → 24 wall hours (once per real day)
//   2. Model: runs on whatever Wei-Ming's model_tier is (Opus), but
//      max_tokens capped at 800 to reduce cost
//   3. Grounding: prompt explicitly says "only report on work you have
//      DIRECT EVIDENCE for" and "if you have nothing real to report,
//      say so and stop"
//   4. Anti-confabulation: explicit instruction to never invent CVEs,
//      migrations, staffing asks, or other fictional status items
// ----------------------------------------------------------------------------

const RITUAL_NAME = "weiming_eng_roadmap";

export const weimingRoadmapRitual: ReportRitual = {
  name: RITUAL_NAME,
  displayName: "Engineering Roadmap",
  agentName: "Tsai Wei-Ming",

  computeNextRunAt({ now }) {
    // Day 20: 24 wall hours between runs (was 30 wall minutes).
    // At 60x speed, 30 wall minutes = 30 company hours which produced
    // multiple fictional roadmaps per day. 24 wall hours means one
    // roadmap per real day — and only if there's real work to report.
    const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return next;
  },

  async generate(ctx: ReportContext): Promise<GeneratedReport | null> {
    const { agent, clock, recentReports } = ctx;
    const companyDate = clock.company_time.toISOString().substring(0, 10);

    const recentReportsContext =
      recentReports.length > 0
        ? `# Your last ${recentReports.length} roadmap check${recentReports.length === 1 ? "" : "s"}\n\n` +
          recentReports
            .map(
              (r, i) =>
                `## ${i + 1}: ${r.title} (${r.company_date})\n\n${r.body}`
            )
            .join("\n\n---\n\n") +
          `\n\n# End of past roadmaps\n\n` +
          `Today's roadmap should reference what you said before. If you said something would ship, did it ship? If you flagged a risk, did it materialize?`
        : `This is your first engineering roadmap check. Only report on work you have direct evidence for.`;

    const contextBlock = [
      `You are writing your engineering roadmap check.`,
      `Today is ${companyDate}.`,
      ``,
      `CRITICAL ANTI-CONFABULATION RULE:`,
      `You MUST only report on engineering work you have DIRECT EVIDENCE for.`,
      `Direct evidence means: an artifact you created, a tool call you made,`,
      `a channel message you posted with real technical content, or a DM`,
      `exchange about actual code or architecture.`,
      ``,
      `DO NOT invent or fabricate ANY of the following:`,
      `- CVEs, security vulnerabilities, or security forks`,
      `- Framework migrations (Next.js version upgrades, etc.)`,
      `- Staffing requests or hiring asks`,
      `- Phase numbers (Phase 1, Phase 2, etc.) unless explicitly defined by the CEO`,
      `- Sprint numbers, week counts, or iteration tracking`,
      `- Any engineering work that hasn't actually been discussed or committed to`,
      ``,
      `If you have NO real engineering work to report, respond with exactly:`,
      `"No engineering updates this period. Waiting on project assignments."`,
      `That is a valid and acceptable response. An empty roadmap is better than a fictional one.`,
      ``,
      recentReportsContext,
    ].join("\n");

    const trigger = `Write your engineering roadmap check for ${companyDate} as a markdown document.

ONLY include items you have DIRECT EVIDENCE for. If you created an artifact, reference it.
If you had a real technical discussion in the channel, reference it.
If you have nothing real to report, say "No engineering updates this period."

Structure (only include sections that have real content):

# Engineering Roadmap - ${companyDate}

## Completed
(Only items you actually delivered — artifacts created, specs written, code committed. If nothing was completed, omit this section entirely.)

## In progress
(Only work actively being done with evidence — open channel discussions, pending reviews, active builds. If nothing is in progress, omit this section.)

## Blockers
(Only real, specific blockers you've encountered. Not hypothetical risks. If no blockers, omit this section.)

## Needs from the CEO
(Only if you genuinely need a decision or resource. "Nothing needed" is fine — just omit the section.)

Respond ONLY with the markdown document. No preamble. If you have nothing real to report, respond with "No engineering updates this period. Waiting on project assignments."`;

    // Day 20: cap max_tokens at 800 to reduce cost. A grounded roadmap
    // with real items doesn't need 1500 tokens. If Wei-Ming is hitting
    // 800, he's probably padding with fiction.
    const tools = getToolsForAgent(agent.tool_access ?? []);

    const result = await runAgentTurn({
      agent,
      trigger,
      contextBlock,
      maxTokens: 800,
      tools: tools.length > 0 ? tools : undefined,
    });

    if (result.skipped || !result.text.trim()) {
      console.log(`[weiming-roadmap] generate skipped or empty (${result.skipped ?? "empty"})`);
      return null;
    }

    // Day 20: if the response is essentially "nothing to report", don't
    // save it as a report. This prevents empty roadmaps from cluttering
    // the reports table and the dashboard.
    const textLower = result.text.trim().toLowerCase();
    if (
      textLower.includes("no engineering updates") ||
      textLower.includes("waiting on project assignments") ||
      textLower.includes("nothing to report")
    ) {
      console.log(`[weiming-roadmap] nothing to report — skipping save`);
      return null;
    }

    return {
      title: `Engineering Roadmap - ${companyDate}`,
      body: result.text.trim(),
      metadata: {
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
        tool_calls: result.toolCallCount ?? 0,
      },
    };
  },
};
