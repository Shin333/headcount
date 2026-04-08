import type { ReportRitual, ReportContext, GeneratedReport } from "./types.js";
import { runAgentTurn } from "../agents/runner.js";
import { getToolsForAgent } from "../tools/registry.js";

// ----------------------------------------------------------------------------
// reports/weiming-roadmap.ts - Day 6
// ----------------------------------------------------------------------------
// Tsai Wei-Ming's weekly engineering roadmap check. Fires Monday mornings at
// 10:30 company time, after standup and CEO brief.
//
// Wei-Ming has web_search access (Day 5.2). His roadmap can include actual
// technical research - "did the new Anthropic API change anything we depend
// on?" or "what's the status of the n8n self-hosted licensing?"
//
// Cadence at default 60x speed: ~7 wall days between firings (since one
// company day = 24 wall minutes, one company week = ~168 wall minutes).
// In practice we cap the wait at ~30 wall minutes for testing - that's
// "every 30 wall minutes" rather than "every Monday." Better for the
// build day's testing tempo. The character framing still says "weekly"
// in the prompt so the report content reflects a weekly cadence.
// ----------------------------------------------------------------------------

const RITUAL_NAME = "weiming_eng_roadmap";

export const weimingRoadmapRitual: ReportRitual = {
  name: RITUAL_NAME,
  displayName: "Engineering Roadmap",
  agentName: "Tsai Wei-Ming",

  computeNextRunAt({ now }) {
    // Wall-time aligned: ~30 wall minutes between runs.
    // At 60x speed that's ~30 company hours ≈ 1.25 company days, which is
    // shorter than a real "weekly" cadence but produces enough test data
    // to verify the ritual on a build day. Phase B+ can dial this back.
    const next = new Date(now.getTime() + 30 * 60 * 1000);
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
          `Today's roadmap should reference what you said before. If you said something would ship, did it ship? If you flagged a risk, did it materialize? Engineers track their own predictions.`
        : `This is your first weekly roadmap check. Establish what the engineering team is working on, what's planned, and what you're worried about.`;

    const contextBlock = [
      `You are writing your weekly engineering roadmap check.`,
      `Today is Monday morning, ${companyDate}, 10:30 company time.`,
      `You may use the web_search tool to verify current technical claims, check API documentation, or look up library or framework changes that affect the roadmap. Use search the way an engineer reads a changelog - prefer official docs over blogs, cite version numbers and dates.`,
      ``,
      recentReportsContext,
    ].join("\n");

    const trigger = `Write your weekly engineering roadmap check for ${companyDate} as a markdown document.

Structure:

# Engineering Roadmap - Week of ${companyDate}

## Shipped last week
(2-4 bullets. Concrete things, no vague "improvements made". If last week was a wash, say so.)

## In progress this week
(2-4 bullets. What the team is actually building right now, who's on what.)

## Blockers and risks
(0-3 bullets. Real engineering risks, infra concerns, dependency issues. If you used web_search to verify something, cite the URL and the date you pulled it.)

## What I need from the CEO
(0-2 specific asks. Hiring, infra budget, scope decisions. "Nothing this week" is a valid answer.)

Stay in your voice: methodical, low-tolerance for vibes, specific about versions and dates. Use web_search if you genuinely need to verify something current. Do NOT search for things you can reasonably know.

Respond ONLY with the markdown document. No preamble.`;

    const tools = getToolsForAgent(agent.tool_access ?? []);

    const result = await runAgentTurn({
      agent,
      trigger,
      contextBlock,
      maxTokens: 1500,
      tools: tools.length > 0 ? tools : undefined,
    });

    if (result.skipped || !result.text.trim()) {
      console.log(`[weiming-roadmap] generate skipped or empty (${result.skipped ?? "empty"})`);
      return null;
    }

    return {
      title: `Engineering Roadmap - Week of ${companyDate}`,
      body: result.text.trim(),
      metadata: {
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
        tool_calls: result.toolCallCount ?? 0,
      },
    };
  },
};
