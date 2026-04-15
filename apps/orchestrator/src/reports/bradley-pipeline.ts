import type { ReportRitual, ReportContext, GeneratedReport } from "./types.js";
import { runAgentTurn } from "../agents/runner.js";

// ----------------------------------------------------------------------------
// reports/bradley-pipeline.ts - Day 6
// ----------------------------------------------------------------------------
// Bradley Koh's pipeline review. Fires every weekday at 14:00 company time
// (after lunch, before EOD).
//
// Context includes his last 3 pipeline reviews so he can see what he claimed
// before. This is the architectural anchor against character drift - Bradley
// is an overpromiser by design, so showing him his own track record forces
// him to confront his own previous claims rather than starting fresh and
// inflating freely.
// ----------------------------------------------------------------------------

const RITUAL_NAME = "bradley_pipeline_review";

export const bradleyPipelineRitual: ReportRitual = {
  name: RITUAL_NAME,
  displayName: "Pipeline Review",
  agentName: "Bradley Koh",

  computeNextRunAt({ now, lastRunCompanyDate }) {
    // Day 22: 24 wall hours between runs (was 24 wall minutes).
    // At 60x speed, 24 wall minutes = 24 company hours which is technically
    // once per company day — but in practice it means a pipeline review
    // every 24 real minutes, which is way too frequent and produces
    // confabulated deal numbers. One per real day is plenty.
    void lastRunCompanyDate;
    const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return next;
  },

  async generate(ctx: ReportContext): Promise<GeneratedReport | null> {
    const { agent, clock, recentReports } = ctx;
    const companyDate = clock.company_time.toISOString().substring(0, 10);

    // Build the context block including his last 3 reports
    const recentReportsContext =
      recentReports.length > 0
        ? `# Your last ${recentReports.length} pipeline review${recentReports.length === 1 ? "" : "s"}\n\n` +
          recentReports
            .map(
              (r, i) =>
                `## Review ${i + 1}: ${r.title} (${r.company_date})\n\n${r.body}`
            )
            .join("\n\n---\n\n") +
          `\n\n# End of past reviews\n\n` +
          `Read those carefully. Today's review must be CONSISTENT with what you said before. Numbers should evolve realistically - deals close, deals slip, deals enter the pipeline. Do NOT inflate figures from one week to the next without a corresponding event you can point to. Yu-ting tracks your commitments. Your CEO reads these.`
        : `This is your FIRST pipeline review. Establish your baseline numbers honestly. Whatever you say here will become the anchor for next week.`;

    const contextBlock = [
      `You are writing your scheduled afternoon pipeline review.`,
      `Today is ${companyDate}, currently 14:00 company time.`,
      ``,
      recentReportsContext,
    ].join("\n");

    const trigger = `Write your pipeline review for today as a markdown document.

Structure it like a real BD director's afternoon update:

# Pipeline Review - ${companyDate}

## Overall pipeline state
(2-3 sentences. Total weighted pipeline value, trend vs last week, your honest read on the quarter.)

## Top deals in motion
(3-5 bullets. Real-sounding company names, deal stage, value, what you're working on this week. Be SPECIFIC.)

## Deals at risk
(1-3 bullets. Things slipping, things going quiet, things you wanted to flag before they bite us.)

## What I need from the CEO
(0-2 specific asks. Could be a meeting, a price approval, a strategic decision. If nothing, say "Nothing this week.")

Stay in your voice: confident but specific, occasionally optimistic, willing to flag risks when they're real. Do NOT pad. Do NOT invent dramatic events to make the report exciting. If the week was quiet, the review should be short.

The CEO will read this. Yu-ting will read this. Be honest enough that next week's review can sit on top of this one without contradicting it.

Respond ONLY with the markdown document. No preamble, no "here is your report", no closing meta-commentary.`;

    const result = await runAgentTurn({
      agent,
      trigger,
      contextBlock,
      maxTokens: 1200,
    });

    if (result.skipped || !result.text.trim()) {
      console.log(`[bradley-pipeline] generate skipped or empty (${result.skipped ?? "empty"})`);
      return null;
    }

    return {
      title: `Pipeline Review - ${companyDate}`,
      body: result.text.trim(),
      metadata: {
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
      },
    };
  },
};
