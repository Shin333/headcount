// ----------------------------------------------------------------------------
// seed/day9b-grant-tools.ts - grant new tools to agents (Day 9b)
// ----------------------------------------------------------------------------
// Updates the tool_access arrays for the named cast to include the new
// Day 9b tools, and adds the "tools available" paragraph to Evie's
// frozen_core so she knows she can read the calendar.
//
// Tool grants:
//   - Evangeline Tan:    + calendar_read, markdown_artifact_create
//   - Tsai Wei-Ming:     + code_artifact_create, markdown_artifact_create
//   - Park So-yeon:      + code_artifact_create, markdown_artifact_create
//   - All other named:   + markdown_artifact_create
//   - 104 specialists:   no changes (still dormant)
//
// This script is idempotent - re-running it has no effect on agents that
// already have the tools. It uses array union semantics: existing tools
// are preserved, new tools are added if not present.
//
// Run with:
//   pnpm tsx apps/orchestrator/src/seed/day9b-grant-tools.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

// ----------------------------------------------------------------------------
// Tool grant table
// ----------------------------------------------------------------------------

interface ToolGrant {
  agentName: string;
  newTools: string[];
}

const NAMED_CAST_GRANTS: ToolGrant[] = [
  // Evie gets the calendar tool plus markdown for taking notes
  {
    agentName: "Evangeline Tan",
    newTools: ["calendar_read", "markdown_artifact_create"],
  },

  // Engineering gets code + markdown
  {
    agentName: "Tsai Wei-Ming",
    newTools: ["code_artifact_create", "markdown_artifact_create"],
  },
  {
    agentName: "Park So-yeon",
    newTools: ["code_artifact_create", "markdown_artifact_create"],
  },

  // Everyone else in the named cast gets markdown only
  { agentName: "Eleanor Vance", newTools: ["markdown_artifact_create"] },
  { agentName: "Han Jae-won", newTools: ["markdown_artifact_create"] },
  { agentName: "Bradley Koh", newTools: ["markdown_artifact_create"] },
  { agentName: "Chen Yu-ting", newTools: ["markdown_artifact_create"] },
  { agentName: "Tessa Goh", newTools: ["markdown_artifact_create"] },
  { agentName: "Rina Halim", newTools: ["markdown_artifact_create"] },
  { agentName: "Hoshino Ayaka", newTools: ["markdown_artifact_create"] },
  { agentName: "Lim Geok Choo", newTools: ["markdown_artifact_create"] },
  { agentName: "Nadia Rahman", newTools: ["markdown_artifact_create"] },
  { agentName: "Devraj Pillai", newTools: ["markdown_artifact_create"] },
  { agentName: "Faridah binte Yusof", newTools: ["markdown_artifact_create"] },
  { agentName: "Siti Nurhaliza", newTools: ["markdown_artifact_create"] },
  // Uncle Tan deliberately excluded - he's a vibes character, no work tools
];

// ----------------------------------------------------------------------------
// Evie frozen_core extension (the "tools available" paragraph)
// ----------------------------------------------------------------------------

const EVIE_TOOLS_PARAGRAPH = `

# Tools available to you (Day 9b onwards)

You have access to two tools:

- **calendar_read**: read Shin's actual Google Calendar. Use this when he asks about his schedule, meetings, availability, or anything time-related. Default range is now to 7 days ahead - widen it if he asks about further out. Always confirm what you found before drawing conclusions; never assume anything you can verify by reading the calendar directly.

- **markdown_artifact_create**: create markdown files in the workspace folder. Use this for meeting prep notes, agendas, briefings, or anything Shin will want to reference later as a real file rather than a chat message.

**Real-world note:** The events you see in Shin's calendar are real meetings with real people. Treat them with the same care you'd treat a real person's calendar - because that's what this is. Onepark Digital is a real Singapore company and your work matters in real life now, not just in simulation.`;

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

export async function runDay9bGrantTools(): Promise<void> {
  console.log(`[day9b-grant-tools] starting...`);

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const grant of NAMED_CAST_GRANTS) {
    const { data: agent, error: queryErr } = await db
      .from("agents")
      .select("id, name, tool_access")
      .eq("tenant_id", config.tenantId)
      .eq("name", grant.agentName)
      .maybeSingle();

    if (queryErr) {
      console.error(`[day9b-grant-tools] failed to query ${grant.agentName}: ${queryErr.message}`);
      continue;
    }

    if (!agent) {
      console.warn(`[day9b-grant-tools] agent not found: ${grant.agentName}`);
      notFound++;
      continue;
    }

    const existingTools: string[] = agent.tool_access ?? [];
    const merged = Array.from(new Set([...existingTools, ...grant.newTools]));

    if (merged.length === existingTools.length) {
      console.log(
        `[day9b-grant-tools] ${grant.agentName} already has all tools, skipping`
      );
      skipped++;
      continue;
    }

    const { error: updateErr } = await db
      .from("agents")
      .update({ tool_access: merged, updated_at: new Date().toISOString() })
      .eq("id", agent.id);

    if (updateErr) {
      console.error(
        `[day9b-grant-tools] failed to update ${grant.agentName}: ${updateErr.message}`
      );
      continue;
    }

    const added = grant.newTools.filter((t) => !existingTools.includes(t));
    console.log(`[day9b-grant-tools] ${grant.agentName} +[${added.join(", ")}]`);
    updated++;
  }

  // -------------------------------------------------------------------------
  // Patch Evie's frozen_core with the tools paragraph
  // -------------------------------------------------------------------------
  const { data: evie, error: evieErr } = await db
    .from("agents")
    .select("id, frozen_core")
    .eq("tenant_id", config.tenantId)
    .eq("name", "Evangeline Tan")
    .maybeSingle();

  if (evieErr) {
    console.error(`[day9b-grant-tools] failed to load Evie for frozen_core update: ${evieErr.message}`);
  } else if (!evie) {
    console.warn(`[day9b-grant-tools] Evie not found for frozen_core update`);
  } else {
    const currentCore = evie.frozen_core ?? "";
    if (currentCore.includes("# Tools available to you")) {
      console.log(`[day9b-grant-tools] Evie's frozen_core already has tools paragraph, skipping`);
    } else {
      const newCore = currentCore + EVIE_TOOLS_PARAGRAPH;
      const { error: coreErr } = await db
        .from("agents")
        .update({ frozen_core: newCore, updated_at: new Date().toISOString() })
        .eq("id", evie.id);

      if (coreErr) {
        console.error(`[day9b-grant-tools] failed to update Evie's frozen_core: ${coreErr.message}`);
      } else {
        console.log(`[day9b-grant-tools] Evie's frozen_core extended with Day 9b tools paragraph`);
      }
    }
  }

  console.log(``);
  console.log(
    `[day9b-grant-tools] complete: ${updated} updated, ${skipped} skipped, ${notFound} not found`
  );
}

// CLI invocation - cross-platform
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDay9bGrantTools()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[day9b-grant-tools] FATAL:", err);
      process.exit(1);
    });
}
