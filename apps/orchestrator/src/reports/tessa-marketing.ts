import type { ReportRitual, ReportContext, GeneratedReport } from "./types.js";
import { runAgentTurn } from "../agents/runner.js";

// ----------------------------------------------------------------------------
// reports/tessa-marketing.ts - Day 6
// ----------------------------------------------------------------------------
// Tessa Goh's marketing status. Fires every other day at 11:00 company time.
//
// Tessa does NOT have tool access. Her status is character-driven, not
// research-driven. She can describe campaigns in flight, content shipped,
// and directional performance - but the prompt explicitly tells her to
// frame numbers as "directional" or "approximate" rather than specific
// measured metrics, since she has no telemetry source.
//
// This is a deliberate test case: can a non-tool agent produce useful
// scheduled work output? If the answer is yes, the architecture supports
// "specialist agents who don't need tools" as a real category.
// ----------------------------------------------------------------------------

const RITUAL_NAME = "tessa_marketing_status";

export const tessaMarketingRitual: ReportRitual = {
  name: RITUAL_NAME,
  displayName: "Marketing Status",
  agentName: "Tessa Goh",

  computeNextRunAt({ now }) {
    // Every other day at default 60x speed = ~48 wall minutes between runs.
    const next = new Date(now.getTime() + 48 * 60 * 1000);
    return next;
  },

  async generate(ctx: ReportContext): Promise<GeneratedReport | null> {
    const { agent, clock, recentReports } = ctx;
    const companyDate = clock.company_time.toISOString().substring(0, 10);

    const recentReportsContext =
      recentReports.length > 0
        ? `# Your last ${recentReports.length} marketing status update${recentReports.length === 1 ? "" : "s"}\n\n` +
          recentReports
            .map(
              (r, i) =>
                `## ${i + 1}: ${r.title} (${r.company_date})\n\n${r.body}`
            )
            .join("\n\n---\n\n") +
          `\n\n# End of past updates\n\n` +
          `Build on what you said before. Campaigns you mentioned should have plausible progress. If something was "in flight" two updates ago, it should be either "shipped" or "still in flight with a reason" by now. Don't reset.`
        : `This is your first marketing status. Establish what's happening - what campaigns are running, what content is in flight, what you're paying attention to.`;

    const contextBlock = [
      `You are writing your scheduled marketing status update.`,
      `Today is ${companyDate}, 11:00 company time.`,
      `IMPORTANT: You do not have access to live analytics. When you reference numbers (engagement, reach, conversion), frame them as DIRECTIONAL or APPROXIMATE - never specific measured figures. Use phrases like "trending up", "roughly", "in the ballpark of". This is a status update from your gut and your inbox, not a dashboard report.`,
      ``,
      recentReportsContext,
    ].join("\n");

    const trigger = `Write your marketing status update for ${companyDate} as a markdown document.

Structure:

# Marketing Status - ${companyDate}

## In flight
(*Italicized intro line setting the mood.* Then 2-4 campaigns or content pieces currently running, with directional progress.)

## Shipped since last update
(1-3 bullets. What actually went out the door.)

## What I'm watching
(1-2 bullets. Trends, signals, things you want to flag before they become urgent.)

## Asks
(0-2 things you need from the CEO or other directors. "Nothing right now" is fine.)

Stay in your voice: italics for setting the mood, specific campaign names, occasional Bengal-cat-of-it-all energy. Numbers are directional, never specific. Frame everything as "from the marketing seat" rather than "from the dashboard."

Respond ONLY with the markdown document. No preamble.`;

    const result = await runAgentTurn({
      agent,
      trigger,
      contextBlock,
      maxTokens: 1000,
    });

    if (result.skipped || !result.text.trim()) {
      console.log(`[tessa-marketing] generate skipped or empty (${result.skipped ?? "empty"})`);
      return null;
    }

    return {
      title: `Marketing Status - ${companyDate}`,
      body: result.text.trim(),
      metadata: {
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
      },
    };
  },
};
