// ----------------------------------------------------------------------------
// tools/artifacts.ts - artifact creation tools (Day 9b)
// ----------------------------------------------------------------------------
// Two tools:
//   1. code_artifact_create   - for executable code files. Always pairs with
//                                Opus + adaptive thinking + effort:high.
//                                Output cap: 16k tokens.
//   2. markdown_artifact_create - for structured markdown documents. Standard
//                                 model tier, no extended thinking.
//
// Both call the same internal createArtifactImpl which:
//   1. Resolves the file path via tools/workspace.ts
//   2. Writes the file to disk
//   3. Inserts an artifacts row in Supabase
//   4. If parent_artifact_id is set, marks the parent as 'superseded'
//      (unless the parent is already 'accepted')
//   5. Returns a ToolResult with the artifact metadata as structured payload
//      so the runner can attach it to the agent's outgoing message
//
// Day 9b deliberately ships these as two separate tools rather than one
// generic create_artifact tool. The reason: distinct names give Wei-Ming
// a clearer mental model ("when I produce code, I call code_artifact_create")
// and let us configure adaptive thinking only on the code tool.
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";
import { getActiveProjectsForAgent } from "../projects/members.js";
import { postToChannel } from "../comms/channel.js";
import { buildArtifactPath, writeArtifactFile } from "./workspace.js";

// ----------------------------------------------------------------------------
// Shared implementation
// ----------------------------------------------------------------------------

interface CreateArtifactArgs {
  contentType: "markdown" | "plaintext" | "code";
  language: string | null;
  title: string;
  summary: string;
  filename: string;
  content: string;
  parentArtifactId: string | null;
  context: ToolExecutionContext;
}

async function createArtifactImpl(args: CreateArtifactArgs): Promise<ToolResult> {
  const toolName = args.contentType === "code" ? "code_artifact_create" : "markdown_artifact_create";

  // Resolve the file path
  let filePath;
  try {
    filePath = buildArtifactPath({
      agentDepartment: args.context.agentDepartment,
      filename: args.filename,
      contentType: args.contentType,
      language: args.language,
    });
  } catch (err) {
    return {
      toolName,
      content: `Error resolving artifact path: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  // Write the file
  let writeResult;
  try {
    writeResult = writeArtifactFile(filePath, args.content);
  } catch (err) {
    return {
      toolName,
      content: `Error writing artifact file: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  // Resolve parent version if applicable
  let version = 1;
  if (args.parentArtifactId) {
    const { data: parent, error: parentErr } = await db
      .from("artifacts")
      .select("id, version, status")
      .eq("id", args.parentArtifactId)
      .eq("tenant_id", config.tenantId)
      .maybeSingle();

    if (parentErr) {
      console.warn(`[artifacts] failed to load parent artifact: ${parentErr.message}`);
    } else if (parent) {
      version = (parent.version ?? 1) + 1;

      // Mark the parent superseded unless it's already accepted
      if (parent.status === "draft") {
        await db
          .from("artifacts")
          .update({ status: "superseded" })
          .eq("id", args.parentArtifactId);
      }
    } else {
      console.warn(
        `[artifacts] parent_artifact_id ${args.parentArtifactId} not found - creating as version 1`
      );
    }
  }

  // Insert the artifacts row
  const { data: inserted, error: insertErr } = await db
    .from("artifacts")
    .insert({
      tenant_id: config.tenantId,
      agent_id: args.context.agentId,
      title: args.title.slice(0, 200),
      summary: args.summary.slice(0, 1000),
      content_type: args.contentType,
      language: args.language,
      file_path: filePath.relative,
      size_bytes: writeResult.sizeBytes,
      parent_artifact_id: args.parentArtifactId,
      version,
      status: "draft",
      triggered_by_dm_id: args.context.triggeredByDmId ?? null,
      triggered_by_post_id: args.context.triggeredByPostId ?? null,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    return {
      toolName,
      content: `Error inserting artifact row: ${insertErr?.message ?? "no row returned"}. File was written to disk at ${filePath.relative} but the database row failed.`,
      isError: true,
    };
  }

  console.log(
    `[artifacts] ${args.context.agentName} created ${toolName}: ${filePath.relative} (v${version}, ${writeResult.sizeBytes} bytes, id=${inserted.id.slice(0, 8)})`
  );

  // Day 17: auto-post artifact creation to any active project channels
  // the creator is a member of. This is how other agents "hear" when
  // dependencies land — the artifact creation event becomes a channel
  // message that triggers the project-responder pre-filter.
  //
  // Day 20: skip auto-post for report/roadmap artifacts. These are
  // scheduled ritual outputs, not project deliverables. Auto-posting
  // them to project channels causes agents to react to fictional
  // engineering status (Wei-Ming's confabulated roadmaps). Only post
  // artifacts whose title does NOT look like a scheduled report.
  const isScheduledReport =
    args.title.toLowerCase().includes("roadmap") ||
    args.title.toLowerCase().includes("pipeline review") ||
    args.title.toLowerCase().includes("marketing pulse") ||
    args.title.toLowerCase().includes("weekly report") ||
    filePath.relative.includes("engineering-roadmap");

  if (!isScheduledReport) {
    try {
      const activeProjects = await getActiveProjectsForAgent(args.context.agentId);
      for (const project of activeProjects) {
        const sizeStr = writeResult.sizeBytes < 1024
          ? `${writeResult.sizeBytes} B`
          : writeResult.sizeBytes < 1024 * 1024
            ? `${(writeResult.sizeBytes / 1024).toFixed(1)} KB`
            : `${(writeResult.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

        await postToChannel({
          projectId: project.id,
          agentId: args.context.agentId,
          body: `Created artifact: **${args.title}** at \`${filePath.relative}\` (${sizeStr}). ${args.summary || ""}`.trim(),
          messageType: "artifact",
        });
        console.log(
          `[artifacts] auto-posted to project channel "${project.title}" (${project.id.slice(0, 8)})`
        );

        // Day 21: check if this artifact unblocks any other project members
        try {
          const { checkDependencyTriggers } = await import("../rituals/project-heartbeat.js");
          await checkDependencyTriggers(
            project.id,
            args.context.agentId,
            args.title,
            args.summary || ""
          );
        } catch (depErr) {
          console.warn(`[artifacts] dependency check failed: ${depErr instanceof Error ? depErr.message : String(depErr)}`);
        }
      }
    } catch (channelErr) {
      // Never let channel posting failure break artifact creation
      console.warn(
        `[artifacts] failed to post to project channel: ${channelErr instanceof Error ? channelErr.message : String(channelErr)}`
      );
    }
  } else {
    console.log(`[artifacts] skipping channel auto-post for scheduled report: "${args.title}"`);
  }

  // Day 18 + Day 22 fix: auto-resolve MATCHING pending commitments.
  // Old behavior: resolved oldest pending commitment on ANY artifact creation.
  // This caused Heng's "generate 18 portraits" to resolve after 1 portrait.
  // New behavior: extract keywords from artifact title and match against
  // commitment descriptions. Only resolve if there's a keyword overlap.
  try {
    const { getPendingCommitmentsForAgent, resolveCommitment } = await import("../commitments/store.js");
    const pending = await getPendingCommitmentsForAgent(args.context.agentId);
    if (pending.length > 0) {
      // Extract significant words from artifact title (3+ chars, lowercase)
      const titleWords = new Set(
        args.title.toLowerCase().split(/[\s\-_:,.()/]+/).filter((w: string) => w.length >= 3)
      );

      // Find the best matching commitment
      let bestMatch: { commitment: any; score: number } | null = null;
      for (const c of pending) {
        const descWords = c.description.toLowerCase().split(/[\s\-_:,.()/]+/).filter((w: string) => w.length >= 3);
        const overlap = descWords.filter((w: string) => titleWords.has(w)).length;
        if (overlap > 0 && (!bestMatch || overlap > bestMatch.score)) {
          bestMatch = { commitment: c, score: overlap };
        }
      }

      if (bestMatch) {
        await resolveCommitment(bestMatch.commitment.id, "artifact", inserted.id);
        console.log(
          `[artifacts] auto-resolved commitment "${bestMatch.commitment.description}" (${bestMatch.commitment.id.slice(0, 8)}) for ${args.context.agentName} (${bestMatch.score} keyword matches with "${args.title}")`
        );
      } else {
        console.log(
          `[artifacts] no matching commitment found for artifact "${args.title}" by ${args.context.agentName} — ${pending.length} pending but none match`
        );
      }
    }
  } catch (commitErr) {
    // Never let commitment resolution failure break artifact creation
    console.warn(
      `[artifacts] commitment auto-resolve failed: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`
    );
  }

  // Return a structured payload so the runner can render it in the agent's
  // outgoing message
  return {
    toolName,
    content: `Created artifact "${args.title}" at ${filePath.relative} (version ${version}, ${writeResult.sizeBytes} bytes). Reference this in your reply so Shin can find it.`,
    isError: false,
    structuredPayload: {
      artifact_id: inserted.id,
      file_path: filePath.relative,
      content_type: args.contentType,
      language: args.language,
      version,
      size_bytes: writeResult.sizeBytes,
      title: args.title,
      summary: args.summary,
    },
  };
}

// ----------------------------------------------------------------------------
// Argument parsing helpers
// ----------------------------------------------------------------------------

function asString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

function asOptionalString(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function requireContext(context: ToolExecutionContext | undefined, toolName: string): ToolResult | null {
  if (!context) {
    return {
      toolName,
      content: `Error: ${toolName} requires execution context (agent identity). The runner must pass a context arg.`,
      isError: true,
    };
  }
  return null;
}

// ----------------------------------------------------------------------------
// code_artifact_create tool
// ----------------------------------------------------------------------------

export const codeArtifactCreateTool: Tool = {
  extended_thinking: true,
  // Day 22: bumped from 16k to 32k. Faizal's /team component (AgentCard +
  // TeamGrid + 18 agents + types + interactions) exceeded 16k and hit the
  // truncation loop detector 3 times. Complex React components need room.
  max_output_tokens: 32000,
  definition: {
    name: "code_artifact_create",
    description:
      "Create a new code file as an artifact. Use this when you need to produce executable code that Shin can copy or apply directly to his codebase. Always include a clear summary of what the code does and any caveats about running it. Always produce COMPLETE files, never partial diffs or 'replace this function' fragments. If you are iterating on a previous code artifact, set parent_artifact_id to the previous artifact's id so the version chain is preserved.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Short human-readable title, e.g. 'Refactored auth handler with timing-safe comparison'",
        },
        summary: {
          type: "string",
          description: "1-3 sentences explaining what's in the file and any caveats about using it",
        },
        filename: {
          type: "string",
          description:
            "Filename including extension, e.g. 'auth-handler.ts'. Will be slugified and prefixed with date and short id.",
        },
        language: {
          type: "string",
          description:
            "Language identifier: typescript, javascript, python, sql, bash, etc. Used to determine the file extension.",
        },
        content: {
          type: "string",
          description:
            "The full file content. Always complete files, never partial diffs.",
        },
        parent_artifact_id: {
          type: "string",
          description:
            "Optional UUID of a previous artifact this iterates on. The previous artifact will be marked superseded.",
        },
      },
      required: ["title", "summary", "filename", "language", "content"],
    },
  },
  executor: async (input, context) => {
    const ctxErr = requireContext(context, "code_artifact_create");
    if (ctxErr) return ctxErr;

    const title = asString(input, "title");
    const summary = asString(input, "summary");
    const filename = asString(input, "filename");
    const language = asString(input, "language");
    const content = asString(input, "content");
    const parentArtifactId = asOptionalString(input, "parent_artifact_id");

    if (!title || !filename || !language || !content) {
      return {
        toolName: "code_artifact_create",
        content: "Error: title, filename, language, and content are all required.",
        isError: true,
      };
    }

    return createArtifactImpl({
      contentType: "code",
      language,
      title,
      summary,
      filename,
      content,
      parentArtifactId,
      context: context!,
    });
  },
};

// ----------------------------------------------------------------------------
// markdown_artifact_create tool
// ----------------------------------------------------------------------------

export const markdownArtifactCreateTool: Tool = {
  // No extended thinking - markdown drafts don't need it
  // Day 14b: max_output_tokens bumped to 8000. Default of 1500 was causing
  // truncation loops on long-form briefs (design briefs, manifestos, plans).
  // Tessa burned $0.15 in a single failed run because the model wanted to
  // write ~5000 tokens of markdown but max_tokens=1500 cut off the tool call
  // mid-stream, the runner saw an incomplete call, asked her to retry, she
  // generated the same broken call, retry, retry, until the cost cap killed
  // the loop. Bumping the budget makes the artifact path actually usable
  // for the document deliverables it was designed for.
  // Day 22: bumped from 8k to 16k. Bio sets, content specs, and design
  // briefs routinely exceed 8k. The truncation loop is expensive to hit.
  max_output_tokens: 16000,
  definition: {
    name: "markdown_artifact_create",
    description:
      "Create a new markdown document as an artifact. Use this for drafts, briefs, plans, design docs, reports, proposals, and any structured prose document that Shin will want to read or edit as a real file rather than reading inline in a DM. If you are iterating on a previous markdown artifact, set parent_artifact_id.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short human-readable title, e.g. 'Q1 marketing plan draft'",
        },
        summary: {
          type: "string",
          description: "1-3 sentences explaining what's in the document",
        },
        filename: {
          type: "string",
          description:
            "Filename without extension, e.g. 'q1-marketing-plan'. Will be slugified, dated, and given a .md extension.",
        },
        content: {
          type: "string",
          description: "The full markdown document content.",
        },
        parent_artifact_id: {
          type: "string",
          description:
            "Optional UUID of a previous artifact this iterates on. The previous artifact will be marked superseded.",
        },
      },
      required: ["title", "summary", "filename", "content"],
    },
  },
  executor: async (input, context) => {
    const ctxErr = requireContext(context, "markdown_artifact_create");
    if (ctxErr) return ctxErr;

    const title = asString(input, "title");
    const summary = asString(input, "summary");
    const filename = asString(input, "filename");
    const content = asString(input, "content");
    const parentArtifactId = asOptionalString(input, "parent_artifact_id");

    if (!title || !filename || !content) {
      return {
        toolName: "markdown_artifact_create",
        content: "Error: title, filename, and content are all required.",
        isError: true,
      };
    }

    return createArtifactImpl({
      contentType: "markdown",
      language: null,
      title,
      summary,
      filename,
      content,
      parentArtifactId,
      context: context!,
    });
  },
};
