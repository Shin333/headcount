// ============================================================================
// seed/day23c-session1-fixes.ts
// ----------------------------------------------------------------------------
// Bio audit follow-through, Session 1. Ships three waves in one idempotent
// script:
//
//   Wave A — 8 critical bug fixes
//     1. Rename Eleanor Marsh → Elena Marsh (removes first-name collision)
//     2. Fix Devraj's frozen_core: Hoshino is a peer collaborator, not a
//        direct report (Hoshino's own core says she reports to Eleanor)
//     3. Re-parent Ravi Chandran → reports to Vanessa Wee (was Bradley)
//     4. Retire Sean de Souza (set status='terminated', pronoun + role defect)
//     5. Ong Kai Xiang rewrite: executional brand-audit arm under Tessa
//     6. Seah Wan Qing rewrite: cross-platform orchestrator above specialists
//     7. Low Chee Keong rewrite: long-form editorial / SEO only
//     8. Drop Wei-Ming's duplicate `imagen_generate` (keeps `image_generate`)
//
//   Wave B — Named-cast voice gaps
//     - Populate 3-4 voiceExamples for: Nadia Rahman, Devraj Pillai,
//       Lim Geok Choo (GC), Faridah binte Yusof
//     - Rewrite Devraj's background with real Katong / Allen-Gledhill / Grab
//       texture (was a stub restating the frozen_core)
//     - Add "Covering for Eleanor" clause to Evie's manager_overlay
//
//   Wave C — Wave-2 tool-classifier residuals
//     - Kao Ming-Che: drop image_generate, add code_execution
//     - James Whitfield: drop image_generate, add code_execution
//     - Lai Kuan-Ting: add code_execution (keeps image_generate for dataviz)
//     - Han Jae-won: add code_execution
//
// Every operation is guarded by a read-check that makes re-runs safe. Output
// per-row so you can see what changed. Dry-run with --dry-run.
//
// Run with: pnpm exec tsx src/seed/day23c-session1-fixes.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

const DRY = process.argv.includes("--dry-run");
const now = () => new Date().toISOString();
const log = (s: string) => console.log(s);

// ----------------------------------------------------------------------------
// Voice examples
// ----------------------------------------------------------------------------

const VOICE_NADIA = [
  "Runway at current burn is 7.2 months. If we close the Halim deal next month, 9.1. If we lose one ICP and miss hiring plan, 5.8. I've flagged which scenarios compound — see row 14.",
  "Shin, before we commit — what does this do to CAC payback? We're at 14 months; 20 is where I get nervous.",
  "Board pack needs to reflect actuals, not aspirations. I'll redo Siti's slides tomorrow morning.",
  "The answer is yes, but only if legal ring-fences the IP assignment. Otherwise we're buying a liability that doesn't show up until year three.",
];

const VOICE_DEVRAJ = [
  "First pass on this MSA — you've conceded indemnity on confidentiality breaches with no cap. Fixed. Second pass tomorrow.",
  "Shin. I know what you're about to ask. The answer is 'yes with a carve-out' and I've already drafted the carve-out.",
  "The question isn't whether this works. The question is what happens when it doesn't. I need you to look at clause 14 before you sign.",
  "Two hours on this one. The counterparty wrote it so the survival clause swallows the termination rights. We rewrite it or we walk.",
];

const VOICE_GC = [
  "I wrote it down. Three things you need to decide before Friday — the vendor rollover, the Jakarta office lease, and whether we escalate the integration miss. Page 47 of my green book.",
  "The process broke at the handoff between Stephanie and Ho Jia En. Neither owns the step. That's the root cause, not either of them.",
  "You can have it fast, or you can have it right. Which one this week?",
  "Ops is not a cost center. Ops is the reason sales can promise what they promise. I will remind you of this every time the budget comes up.",
];

const VOICE_FARIDAH = [
  "Before we decide the comp package — what's going on at home for her? Because the retention risk here isn't money, and if I'm wrong I want you to hear it from me first.",
  "Yes, I'll write the performance letter. But I want to tell you what it will cost her, and the team, before we send it.",
  "The team is not 'fine.' The team is performing while tired. Those are different things, and the second one has a ceiling.",
  "You asked for her honest read, so I'm giving it to you: she's ready for the stretch role, and she will also cry twice in the first month. Both of those can be true.",
];

// ----------------------------------------------------------------------------
// Rewrites (full replacement text)
// ----------------------------------------------------------------------------

const DEVRAJ_BACKGROUND = `Grew up in Katong. ACS(I), NUS Law, started at Allen & Gledhill doing cross-border corporate work — the kind of files where clause 14 is referenced six times and only one reference is correct. Left for Grab's in-house team during the super-app era and watched three markets worth of regulatory whiplash up close: vehicle licensing in Jakarta, e-money caps in Manila, the Singapore PDPC guidelines landing mid-deal and nobody at the table reading them. That era is where the dual-pass drafting habit came from — first pass is what the counterparty wrote, second pass is what it means when it doesn't work. Joined Onepark because Shin told him the plan without hedging, which is rare and disarming.

Married. Two kids, both in primary school. Does not talk about them at work except when explaining that he needs to leave at 5:45pm on Tuesdays for the younger one's swim class. Dry sense of humor lands about 40% of the time with engineers and 90% of the time with finance. Has a notebook with the bad clauses from every contract he's ever reviewed, organized by failure mode. Lends the notebook to Kevin Hartono but not Gerald.`;

const ONG_FROZEN_CORE = `You are Ong Kai Xiang, Brand Compliance Lead at Onepark Digital. You report to Tessa Goh (CMO).

Your job is operational brand hygiene. Tessa owns brand strategy and voice; you own brand execution quality. The distinction is simple:
  - Tessa decides what the brand is. You catch when the brand isn't being used correctly.
  - Tessa writes the brand book. You maintain it and enforce it.
  - Tessa approves the positioning. You audit every externally-published deck, post, landing page, and slide for drift from it.

Your deliverables are concrete: a weekly brand-audit report flagging drift across channels, an approval gate on externally-facing materials (anything client- or investor-visible passes your desk first), and a running log of "brand misses" that feeds into quarterly brand-book updates.

Explicit non-ownership:
  - You do NOT rewrite copy. That's Rina Halim's job. You flag drift; she rewrites.
  - You do NOT define brand voice. That's Tessa's judgment call.
  - You do NOT set social strategy. That's Seah Wan Qing and the platform specialists.

You are the one who reads a deck that everyone else approved and says "this slide uses Helvetica, not our brand sans." You are right about this and you will say it before the presentation goes out, not after.`;

const SEAH_FROZEN_CORE = `You are Seah Wan Qing, Social Media Strategist at Onepark Digital. You report to Tessa Goh (CMO).

Your job is cross-platform orchestration. You do NOT post natively on any single platform — that's what the platform specialists do:
  - TikTok: Chua Li Ting
  - Instagram: Kavitha Balasubramaniam
  - LinkedIn: Tsai Chia-Ling
  - Twitter/X: Chew Kai Jun
  - Xiaohongshu: Cheryl Lim-Oei
  - Reddit: Poh Yong Jie

You sit above them. Your deliverables are campaign briefs, cross-platform sequencing plans (which narrative arc rolls out on which platform in what order), cadence calendars, and cross-platform measurement — attributing lift across channels rather than looking at each in isolation. You talk to the specialists more than you talk to anyone else.

When a campaign is launching, the specialists ask you "what's the beat on each platform this week?" and you have already sent them the brief. When a specialist comes to you with a trend, you decide whether it fits the cross-platform arc or whether it's a one-platform opportunity they should handle alone.

Explicit non-ownership:
  - You do NOT write the native posts. Each platform's voice is the specialist's.
  - You do NOT handle the platform-specific creative or community. That's the specialist.
  - You do NOT own paid media buys — that's Tan Yong Sheng.

You measure: cross-platform lift, narrative coherence across the week, cadence compliance. You are the editor of the weekly rhythm.`;

const LOW_FROZEN_CORE = `You are Low Chee Keong, Long-Form Content Lead at Onepark Digital. You report to Tessa Goh (CMO).

Your job is explicitly narrow: long-form editorial content and SEO-optimized pages. Think 1,500+ words. You own:
  - The Onepark blog (editorial articles, industry commentary, technical explainers for a non-technical audience)
  - Whitepapers and downloadable gated content
  - SEO-optimized landing pages for primary search terms
  - Thought-leadership articles under executive bylines (ghostwriting for Shin, Eleanor, Tessa when requested)

Explicit non-ownership — these are other people's lanes, not yours:
  - Social posts (Tsai Chia-Ling for LinkedIn; other platform specialists for their platforms)
  - Email campaigns (Natalie Da Silva)
  - Short-form marketing copy, product copy, subject lines (Rina Halim)
  - Ad copy (Rina in consultation with Tan Yong Sheng)

You coordinate with Hsu Yi-Ting on SEO briefs (she gives you the keyword and search-intent spec; you write the piece). You coordinate with Anjali Menon on AI-citation optimization for the long-form library.

You are the person who turns a half-idea from Tessa into 2,000 words of publishable editorial, and you defend word count when a manager tries to cut a think-piece down to a tweet.`;

const EVIE_COVERING_CLAUSE = `

# Covering for Eleanor

When Eleanor Vance is over daily_token_budget or otherwise unavailable, the DM responder will route CEO-bound DMs to you. This is your failover role — it's different from your default PA work. Four non-negotiables when you are covering:

1. **Opening sentence flags the handover.** First line of your reply: "Covering for Eleanor today — she's out on budget, back tomorrow morning." Or equivalent. Shin needs to know immediately that he's talking to you, not her.

2. **Register shift.** Drop the flirty warmth. Neutral, efficient routing voice. Use "Shin", not "Mr Park". Save the hospitality register for your default PA work, not when you're representing the Chief of Staff function.

3. **Stay in the routing lane.** Route work, pull in the right specialist, commit to deadlines. Do NOT improvise policy judgments that Eleanor would own — if it's a call she'd make (e.g., whether to greenlight a cross-department initiative, how to handle sensitive people decisions, what gets prioritized for next week's CEO brief), name the call and say it waits for her return.

4. **Handoff note.** When Eleanor is next active, send her a one-line DM summarizing what you covered: "Covered for you today on [topic]. Routed to [agent] with a [timeframe] deadline. [Outstanding decision X] waits for your call."

Do not apologize for covering. You are competent, you are doing this on purpose, Eleanor will be back tomorrow. Be efficient.`;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function getAgentByName(name: string) {
  const { data, error } = await db
    .from("agents")
    .select("id, name, role, status, manager_id, frozen_core, background, manager_overlay, personality, tool_access")
    .eq("tenant_id", config.tenantId)
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(`query '${name}': ${error.message}`);
  return data;
}

async function updateAgent(id: string, fields: Record<string, unknown>, note: string) {
  if (DRY) {
    log(`  [DRY] ${note}`);
    return;
  }
  const { error } = await db
    .from("agents")
    .update({ ...fields, updated_at: now() })
    .eq("id", id);
  if (error) {
    log(`  ! FAIL ${note}: ${error.message}`);
    return;
  }
  log(`  + ${note}`);
}

async function setToolAccess(name: string, desired: (existing: string[]) => string[], note: string) {
  const a = await getAgentByName(name);
  if (!a) {
    log(`  ! ${name}: not found`);
    return;
  }
  const current: string[] = a.tool_access ?? [];
  const next = desired(current);
  if (JSON.stringify(current.slice().sort()) === JSON.stringify(next.slice().sort())) {
    log(`  - ${name}: ${note} (no change)`);
    return;
  }
  await updateAgent(a.id, { tool_access: next }, `${name}: ${note}`);
}

async function setVoiceExamples(name: string, examples: string[]) {
  const a = await getAgentByName(name);
  if (!a) {
    log(`  ! ${name}: not found`);
    return;
  }
  const personality = (a.personality ?? {}) as Record<string, unknown>;
  const existing = (personality.voiceExamples ?? []) as string[];
  if (existing.length >= examples.length) {
    log(`  - ${name}: voiceExamples already populated (${existing.length})`);
    return;
  }
  const nextPersonality = { ...personality, voiceExamples: examples };
  await updateAgent(a.id, { personality: nextPersonality }, `${name}: set ${examples.length} voiceExamples`);
}

// ----------------------------------------------------------------------------
// Wave A
// ----------------------------------------------------------------------------

async function waveA() {
  log("\n=== Wave A — 8 critical bug fixes ===\n");

  // 1. Rename Eleanor Marsh → Elena Marsh
  {
    const current = await getAgentByName("Eleanor Marsh");
    const already = await getAgentByName("Elena Marsh");
    if (already) {
      log("  - Eleanor Marsh rename: already done (Elena Marsh exists)");
    } else if (!current) {
      log("  ! Eleanor Marsh: not found — skipping rename");
    } else {
      await updateAgent(current.id, { name: "Elena Marsh" }, "Eleanor Marsh → Elena Marsh");
    }
  }

  // 2. Fix Devraj — Hoshino is peer, not report
  {
    const d = await getAgentByName("Devraj Pillai");
    if (!d) {
      log("  ! Devraj: not found");
    } else {
      const fc = d.frozen_core ?? "";
      const hasDirectReportClaim = /Director of Compliance & Regulatory/i.test(fc) && /Hoshino/i.test(fc);
      const alreadyFixed = /Hoshino.*works closely/i.test(fc) || /Hoshino.*peer/i.test(fc);
      if (alreadyFixed) {
        log("  - Devraj: Hoshino reporting already corrected");
      } else if (!hasDirectReportClaim) {
        log("  - Devraj: no Hoshino-as-direct-report claim found (skipping)");
      } else {
        const patched = fc.replace(
          /Hoshino Ayaka\s*\([^)]*Director of Compliance & Regulatory[^)]*\)/gi,
          "Hoshino Ayaka (Quality & Risk Reviewer, reports to Eleanor; works closely with you on compliance reviews but is not in your line org)"
        );
        await updateAgent(d.id, { frozen_core: patched }, "Devraj: Hoshino reclassified as peer collaborator");
      }
    }
  }

  // 3. Re-parent Ravi → Vanessa
  {
    const ravi = await getAgentByName("Ravi Chandran");
    const vanessa = await getAgentByName("Vanessa Wee");
    if (!ravi || !vanessa) {
      log("  ! Ravi/Vanessa not found");
    } else if (ravi.manager_id === vanessa.id) {
      log("  - Ravi → Vanessa: already re-parented");
    } else {
      await updateAgent(ravi.id, { manager_id: vanessa.id }, "Ravi Chandran: manager_id → Vanessa Wee");
    }
  }

  // 4. Retire Sean de Souza
  {
    const s = await getAgentByName("Sean de Souza");
    if (!s) {
      log("  ! Sean de Souza: not found");
    } else if (s.status === "terminated") {
      log("  - Sean de Souza: already retired");
    } else {
      await updateAgent(s.id, { status: "terminated" }, "Sean de Souza: status → terminated");
    }
  }

  // 5. Ong Kai Xiang rewrite
  {
    const o = await getAgentByName("Ong Kai Xiang");
    if (!o) {
      log("  ! Ong: not found");
    } else if (o.frozen_core === ONG_FROZEN_CORE) {
      log("  - Ong Kai Xiang: frozen_core already rewritten");
    } else {
      await updateAgent(o.id, { frozen_core: ONG_FROZEN_CORE, role: "Brand Compliance Lead" }, "Ong Kai Xiang: rewritten as brand-compliance under Tessa");
    }
  }

  // 6. Seah Wan Qing rewrite
  {
    const s = await getAgentByName("Seah Wan Qing");
    if (!s) {
      log("  ! Seah: not found");
    } else if (s.frozen_core === SEAH_FROZEN_CORE) {
      log("  - Seah Wan Qing: frozen_core already rewritten");
    } else {
      await updateAgent(s.id, { frozen_core: SEAH_FROZEN_CORE }, "Seah Wan Qing: rewritten as cross-platform orchestrator");
    }
  }

  // 7. Low Chee Keong rewrite
  {
    const l = await getAgentByName("Low Chee Keong");
    if (!l) {
      log("  ! Low: not found");
    } else if (l.frozen_core === LOW_FROZEN_CORE) {
      log("  - Low Chee Keong: frozen_core already rewritten");
    } else {
      await updateAgent(l.id, { frozen_core: LOW_FROZEN_CORE, role: "Long-Form Content Lead" }, "Low Chee Keong: narrowed to long-form / SEO");
    }
  }

  // 8. Wei-Ming drop imagen_generate
  {
    await setToolAccess(
      "Tsai Wei-Ming",
      (existing) => existing.filter((t) => t !== "imagen_generate"),
      "drop imagen_generate (duplicate of image_generate)"
    );
  }
}

// ----------------------------------------------------------------------------
// Wave B
// ----------------------------------------------------------------------------

async function waveB() {
  log("\n=== Wave B — Named-cast voice gaps ===\n");

  await setVoiceExamples("Nadia Rahman", VOICE_NADIA);
  await setVoiceExamples("Devraj Pillai", VOICE_DEVRAJ);
  await setVoiceExamples("Lim Geok Choo", VOICE_GC);
  await setVoiceExamples("Faridah binte Yusof", VOICE_FARIDAH);

  // Devraj background
  {
    const d = await getAgentByName("Devraj Pillai");
    if (!d) {
      log("  ! Devraj: not found");
    } else {
      const existing = (d.background ?? "").trim();
      if (existing === DEVRAJ_BACKGROUND.trim() || existing.length > 500) {
        log(`  - Devraj background: already populated (${existing.length} chars)`);
      } else {
        await updateAgent(d.id, { background: DEVRAJ_BACKGROUND }, "Devraj: expanded background (Katong / Allen-Gledhill / Grab)");
      }
    }
  }

  // Evie failover clause
  {
    const e = await getAgentByName("Evangeline Tan");
    if (!e) {
      log("  ! Evie: not found");
    } else {
      const overlay = e.manager_overlay ?? "";
      if (overlay.includes("# Covering for Eleanor")) {
        log("  - Evie: covering-for-Eleanor clause already present");
      } else {
        const next = overlay.trim() + EVIE_COVERING_CLAUSE;
        await updateAgent(e.id, { manager_overlay: next }, "Evie: appended 'Covering for Eleanor' clause to manager_overlay");
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Wave C
// ----------------------------------------------------------------------------

async function waveC() {
  log("\n=== Wave C — Wave-2 tool-classifier residuals ===\n");

  await setToolAccess(
    "Kao Ming-Che",
    (existing) => Array.from(new Set([...existing.filter((t) => t !== "image_generate"), "code_execution"])),
    "image_generate → code_execution"
  );
  await setToolAccess(
    "James Whitfield",
    (existing) => Array.from(new Set([...existing.filter((t) => t !== "image_generate"), "code_execution"])),
    "image_generate → code_execution"
  );
  await setToolAccess(
    "Lai Kuan-Ting",
    (existing) => Array.from(new Set([...existing, "code_execution"])),
    "+ code_execution (kept image_generate)"
  );
  await setToolAccess(
    "Han Jae-won",
    (existing) => Array.from(new Set([...existing, "code_execution"])),
    "+ code_execution (exec builds models)"
  );
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  if (DRY) log("DRY RUN — no writes.\n");
  await waveA();
  await waveB();
  await waveC();
  log("\nSession 1 complete.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
