// ============================================================================
// agents/context-builder.ts - Day 24: Agent Working Memory Refactor
// ----------------------------------------------------------------------------
// Clean abstraction for building agent context blocks. Before Day 24,
// each ritual (dm-responder, project-responder, heartbeat) manually
// assembled context strings by concatenating blocks. This module
// centralizes that logic so new context sources can be added in one place.
//
// Usage:
//   const ctx = new AgentContextBuilder(agent, clock);
//   await ctx.addProjectContext();
//   await ctx.addCommitments();
//   await ctx.addChannelHistory(projectId);
//   await ctx.addPinnedMessages(projectId);
//   const contextBlock = ctx.build();
//   const imageBlocks = await ctx.extractImages();
// ============================================================================

import type { Agent } from "@headcount/shared";
import type { WorldClock } from "../world/clock.js";
import type { ImageBlock } from "./vision.js";

export class AgentContextBuilder {
  private sections: Array<{ label: string; content: string }> = [];
  private allText: string[] = [];

  constructor(
    private agent: Agent,
    private clock: WorldClock
  ) {
    // Always include the time
    this.addRaw(`Current company time: ${formatTime(clock.company_time)}`);
  }

  /** Add raw text to the context (no section header) */
  addRaw(text: string): this {
    this.allText.push(text);
    this.sections.push({ label: "", content: text });
    return this;
  }

  /** Add a labelled section */
  addSection(label: string, content: string): this {
    if (!content.trim()) return this;
    this.allText.push(content);
    this.sections.push({ label, content });
    return this;
  }

  /** Add project context for this agent */
  async addProjectContext(): Promise<this> {
    const { buildProjectContextBlock } = await import("../projects/members.js");
    const block = await buildProjectContextBlock(this.agent.id);
    if (block) this.addSection("Active Projects", block);
    return this;
  }

  /** Add pending commitments */
  async addCommitments(): Promise<this> {
    const { getPendingCommitmentsForAgent, formatCommitmentsBlock } = await import(
      "../commitments/store.js"
    );
    const pending = await getPendingCommitmentsForAgent(this.agent.id);
    const block = formatCommitmentsBlock(pending);
    if (block) this.addSection("Commitments", block);
    return this;
  }

  /** Day 22: Add recent artifacts created by this agent.
   *  This gives agents memory of their own past work so they don't
   *  confabulate about what they have or haven't done. */
  async addCompletedWork(limit = 10): Promise<this> {
    try {
      const { db } = await import("../db.js");
      const { config } = await import("../config.js");
      const { data: artifacts } = await db
        .from("artifacts")
        .select("title, file_path, created_at")
        .eq("tenant_id", config.tenantId)
        .eq("agent_id", this.agent.id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (artifacts && artifacts.length > 0) {
        const lines = artifacts.map((a: any) => {
          const time = new Date(a.created_at).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Taipei",
          });
          return `- [${time}] "${a.title}" → ${a.file_path}`;
        });
        this.addSection(
          "Your Recent Work (artifacts you created)",
          `You have already produced the following artifacts today. Do NOT claim you haven't done this work:\n${lines.join("\n")}`
        );
      }
    } catch {
      // Non-critical — don't break context building
    }
    return this;
  }

  /** Add channel history + pinned messages for a project */
  async addChannelContext(projectId: string, projectTitle: string): Promise<this> {
    const {
      getChannelHistory,
      getPinnedMessages,
      formatChannelHistory,
      loadAgentNames,
    } = await import("../comms/channel.js");

    const history = await getChannelHistory(projectId, 40);
    const pinned = await getPinnedMessages(projectId);

    const allIds = [
      ...history.map((m) => m.agent_id),
      ...(pinned ?? []).map((m) => m.agent_id),
    ];
    const names = await loadAgentNames(allIds);
    const block = formatChannelHistory(projectTitle, history, names, pinned);

    if (block) {
      this.allText.push(block);
      this.sections.push({ label: "", content: block }); // Channel history has its own headers
    }
    return this;
  }

  /** Add DM thread history */
  addThreadHistory(threadBlock: string | null): this {
    if (threadBlock) this.addSection("Thread History", threadBlock);
    return this;
  }

  /** Add a custom context note (e.g. "You are reading a private direct message.") */
  addNote(note: string): this {
    return this.addRaw(note);
  }

  /** Build the final context string */
  build(): string {
    return this.sections
      .map((s) => (s.label ? `${s.content}` : s.content))
      .join("\n\n");
  }

  /** Extract and load images from all accumulated text */
  async extractImages(): Promise<ImageBlock[]> {
    const { extractAndLoadImages } = await import("./vision.js");
    return extractAndLoadImages(this.allText.join("\n"));
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Taipei",
  });
}
