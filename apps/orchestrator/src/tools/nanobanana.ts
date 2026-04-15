// ============================================================================
// tools/nanobanana.ts - Day 13 - Google Gemini image generation
// ----------------------------------------------------------------------------
// Generates an image from a text prompt using Google's Gemini image models
// (marketed as "Nano Banana"). Saves the result to workspace/<dept>/images/
// and inserts an artifact row so the dashboard can render it.
//
// Default model: gemini-2.5-flash-image
//   - Stable, well-documented, ~$0.039/image (1290 output tokens at $30/1M)
//   - Faster and cheaper than the Pro variant
//   - Supports aspect_ratio config
//
// Per-agent daily cap: 20 generations. Enforced by counting today's
// real_action_audit rows for tool_name='image_generate' for this agent.
// At ~$0.039/image, 20/day per agent = ~$0.78/agent-day worst case, well
// under the $5/hour cost cap.
//
// Storage: binary PNG written to workspace/<dept>/images/, served by the
// dashboard via /api/workspace/[...path] (which has strict path validation).
//
// Failure modes (all return ToolResult with isError=true, never throw):
//   - GEMINI_API_KEY not set       -> "image generation is not configured"
//   - Per-agent cap reached        -> "daily image cap reached"
//   - Safety filter triggered      -> "image rejected by safety filter"
//   - API quota / 429              -> "image API quota exceeded"
//   - Network or other errors      -> "image generation failed: <msg>"
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";
import { buildImageArtifactPath, writeImageArtifactFile } from "./workspace-image.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const DEFAULT_MODEL = "gemini-2.5-flash-image";
const DEFAULT_ASPECT_RATIO = "1:1";
const DAILY_CAP_PER_AGENT = 20;

// Approximate cost per image. Gemini 2.5 Flash Image is $30/M output tokens
// and each image is ~1290 output tokens, so 1290 * 30 / 1_000_000 ~= $0.0387.
// Recorded in real_action_audit for cost reporting; not used for billing.
const APPROX_COST_PER_IMAGE_USD = 0.039;

// Allowed aspect ratios per Gemini docs (gemini-2.5-flash-image)
const ALLOWED_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]);

// ----------------------------------------------------------------------------
// Per-agent daily cap check
// ----------------------------------------------------------------------------

async function countImagesToday(agentId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await db
    .from("real_action_audit")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", config.tenantId)
    .eq("agent_id", agentId)
    .eq("tool_name", "image_generate")
    .eq("success", true)
    .gte("created_at", startOfDay.toISOString());

  if (error) {
    console.warn(`[nanobanana] failed to count today's images for ${agentId}: ${error.message}`);
    return 0; // fail open - better to allow one extra than block legitimate use
  }
  return count ?? 0;
}

// ----------------------------------------------------------------------------
// Audit logging
// ----------------------------------------------------------------------------

async function writeAudit(args: {
  agentId: string;
  argsForAudit: Record<string, unknown>;
  resultSummary: string;
  resultFull: Record<string, unknown> | null;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
  triggeredByDmId: string | null;
}): Promise<void> {
  await db.from("real_action_audit").insert({
    tenant_id: config.tenantId,
    agent_id: args.agentId,
    tool_name: "image_generate",
    arguments_json: args.argsForAudit,
    result_summary: args.resultSummary,
    result_full_json: args.resultFull,
    success: args.success,
    error_message: args.errorMessage,
    duration_ms: args.durationMs,
    triggered_by_dm_id: args.triggeredByDmId,
  });
}

// ----------------------------------------------------------------------------
// Gemini API call
// ----------------------------------------------------------------------------
//
// We use the @google/genai SDK rather than raw fetch because the SDK handles
// the response parsing (extracting inlineData from candidates[].content.parts).
// The SDK is small and has no native dependencies.
//
// If the SDK isn't installed, the dynamic import will throw and we surface
// a friendly error pointing the user at the runbook.
// ----------------------------------------------------------------------------

interface GeminiImageResult {
  buffer: Buffer;
  mimeType: string;
}

// Minimal local type for the @google/genai SDK shape we use. We deliberately
// do NOT import types from @google/genai because the package may not be
// installed yet (it's a Day 13 add-on). The dynamic import below pulls the
// real implementation at runtime; if the package is missing, the user gets
// a friendly error from inside the tool rather than a tsc compile failure.
interface GoogleGenAIClient {
  models: {
    generateContent(args: {
      model: string;
      contents: string;
      config: {
        responseModalities: string[];
        imageConfig: { aspectRatio: string };
      };
    }): Promise<{
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: string; mimeType?: string };
          }>;
        };
      }>;
    }>;
  };
}

interface GoogleGenAIConstructor {
  new (config: { apiKey: string }): GoogleGenAIClient;
}

async function callGeminiImageApi(args: {
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio: string;
}): Promise<GeminiImageResult> {
  // Dynamic import so the orchestrator doesn't crash on startup if the SDK
  // is missing. Users can install it later via `pnpm add @google/genai`.
  // We use a string variable for the module name so tsc doesn't try to
  // resolve the import at compile time.
  let GoogleGenAI: GoogleGenAIConstructor;
  try {
    const moduleName = "@google/genai";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import(/* @vite-ignore */ moduleName)) as any;
    GoogleGenAI = mod.GoogleGenAI as GoogleGenAIConstructor;
  } catch {
    throw new Error(
      "@google/genai package not installed. Run: pnpm add @google/genai"
    );
  }

  const ai = new GoogleGenAI({ apiKey: args.apiKey });

  const response = await ai.models.generateContent({
    model: args.model,
    contents: args.prompt,
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: args.aspectRatio,
      },
    },
  });

  // Extract the first image part from the response
  const candidates = response.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error("Gemini returned no candidates");
  }
  const parts = candidates[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error("Gemini returned no content parts");
  }

  for (const part of parts) {
    const inline = (part as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inline?.data) {
      const buffer = Buffer.from(inline.data, "base64");
      const mimeType = inline.mimeType ?? "image/png";
      return { buffer, mimeType };
    }
  }

  // No image part found - usually means safety filter or model refusal
  throw new Error(
    "Gemini returned no image data (likely a safety filter rejection or model refusal)"
  );
}

// ----------------------------------------------------------------------------
// The tool
// ----------------------------------------------------------------------------

export const nanobananaImageGenerateTool: Tool = {
  real_action: true,
  definition: {
    name: "image_generate",
    description:
      "Generate an image from a text prompt using Google Gemini (Nano Banana). Best for illustrations, icons, sketches, mood boards, infographics, and generic graphics. This is the CHEAPER option (~$0.039/image).\n\n⚠️ DO NOT use this tool for photorealistic images, portraits, or headshots. Use imagen_generate (Imagen 3) instead — it produces much higher quality photorealistic output.\n\nUse image_generate (this tool) for: icons, illustrations, diagrams, logos, concept art, stylized graphics.\nUse imagen_generate for: portraits, headshots, product photos, anything that must look like a real photograph.\n\nWriting effective prompts: include subject (what), style (illustration / 3D render / minimalist line / abstract), composition (close-up / wide / isometric / centered / overhead), lighting (golden hour / studio / cinematic / flat / dramatic), color palette, and intended use.\n\nBad prompt: 'a logo for a company'.\nGood prompt: 'minimalist serif wordmark on cream background, single deep amber accent letter, centered, generous whitespace, intended for letterhead'.\n\nDefaults: 1:1 aspect ratio. Per-agent daily cap of 20 generations. Reference the result in your reply so Shin can find the artifact in the dashboard.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed text description of the image. Be specific about subject, style, composition, lighting, color palette. The more concrete the prompt, the better the result.",
        },
        title: {
          type: "string",
          description:
            "Short human-readable title for the artifact card (e.g. 'Onepark hero v1', 'Tessa portrait sketch'). Used as the artifact title and filename slug.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
          description:
            "Image aspect ratio. Default 1:1. Use 16:9 for hero/landscape, 9:16 for mobile vertical, 4:3 for traditional, 3:4 for portrait.",
        },
      },
      required: ["prompt", "title"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const start = Date.now();
    const toolName = "image_generate";

    if (!context) {
      return {
        toolName,
        content: "Error: image_generate requires execution context.",
        isError: true,
      };
    }

    // ----- Parse args -----
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const aspectRatio =
      typeof input.aspect_ratio === "string" && ALLOWED_ASPECT_RATIOS.has(input.aspect_ratio)
        ? input.aspect_ratio
        : DEFAULT_ASPECT_RATIO;

    if (!prompt) {
      return {
        toolName,
        content: "Error: prompt is required and must be non-empty.",
        isError: true,
      };
    }
    if (!title) {
      return {
        toolName,
        content: "Error: title is required and must be non-empty.",
        isError: true,
      };
    }
    if (prompt.length > 4000) {
      return {
        toolName,
        content: "Error: prompt is too long (max 4000 characters).",
        isError: true,
      };
    }

    const argsForAudit = { prompt: prompt.slice(0, 500), title, aspect_ratio: aspectRatio };

    // ----- API key check -----
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "no api key",
        resultFull: null,
        success: false,
        errorMessage: "GEMINI_API_KEY environment variable not set",
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content:
          "Error: image generation is not configured. Tell Shin that GEMINI_API_KEY is missing from the orchestrator environment.",
        isError: true,
      };
    }

    // ----- Per-agent daily cap -----
    const todayCount = await countImagesToday(context.agentId);
    if (todayCount >= DAILY_CAP_PER_AGENT) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "daily cap reached",
        resultFull: null,
        success: false,
        errorMessage: `Daily image cap of ${DAILY_CAP_PER_AGENT} reached for this agent`,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: I've already generated ${todayCount} images today, which is the daily cap of ${DAILY_CAP_PER_AGENT}. Try again tomorrow, or ask Shin to raise the cap if this is urgent.`,
        isError: true,
      };
    }

    // ----- Call Gemini -----
    let imageResult: GeminiImageResult;
    try {
      imageResult = await callGeminiImageApi({
        apiKey,
        model: DEFAULT_MODEL,
        prompt,
        aspectRatio,
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "api error",
        resultFull: null,
        success: false,
        errorMessage: errMsg,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      // Friendlier message for the agent based on common failure patterns
      let friendly = `Error generating image: ${errMsg}`;
      if (errMsg.includes("safety")) {
        friendly = "Error: the image was rejected by the safety filter. Try a different prompt avoiding anything that could be flagged.";
      } else if (errMsg.includes("quota") || errMsg.includes("429")) {
        friendly = "Error: image generation API quota exceeded. Try again in a few minutes.";
      } else if (errMsg.includes("@google/genai")) {
        friendly = "Error: the @google/genai package is not installed. Tell Shin to run `pnpm add @google/genai`.";
      }
      return {
        toolName,
        content: friendly,
        isError: true,
      };
    }

    // ----- Write to disk -----
    let filePath;
    let writeResult;
    try {
      filePath = buildImageArtifactPath({
        agentDepartment: context.agentDepartment,
        filename: title,
        mimeType: imageResult.mimeType,
      });
      writeResult = writeImageArtifactFile(filePath, imageResult.buffer);
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "disk write error",
        resultFull: null,
        success: false,
        errorMessage: errMsg,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error saving generated image: ${errMsg}`,
        isError: true,
      };
    }

    // ----- Insert artifact row -----
    const { data: inserted, error: insertErr } = await db
      .from("artifacts")
      .insert({
        tenant_id: config.tenantId,
        agent_id: context.agentId,
        title: title.slice(0, 200),
        summary: prompt.slice(0, 1000),
        content_type: "image",
        language: null,
        file_path: filePath.relative,
        size_bytes: writeResult.sizeBytes,
        parent_artifact_id: null,
        version: 1,
        status: "draft",
        triggered_by_dm_id: context.triggeredByDmId ?? null,
        triggered_by_post_id: context.triggeredByPostId ?? null,
      })
      .select("id")
      .single();

    if (insertErr || !inserted) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "db insert error",
        resultFull: null,
        success: false,
        errorMessage: insertErr?.message ?? "no row returned",
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error inserting image artifact row: ${insertErr?.message ?? "no row returned"}. The image was saved to disk at ${filePath.relative} but the database row failed.`,
        isError: true,
      };
    }

    const durationMs = Date.now() - start;
    const summary = `Generated ${aspectRatio} image: ${filePath.filename} (${(writeResult.sizeBytes / 1024).toFixed(0)} KB)`;

    await writeAudit({
      agentId: context.agentId,
      argsForAudit,
      resultSummary: summary,
      resultFull: {
        artifact_id: inserted.id,
        file_path: filePath.relative,
        mime_type: imageResult.mimeType,
        size_bytes: writeResult.sizeBytes,
        aspect_ratio: aspectRatio,
        approx_cost_usd: APPROX_COST_PER_IMAGE_USD,
        model: DEFAULT_MODEL,
      },
      success: true,
      errorMessage: null,
      durationMs,
      triggeredByDmId: context.triggeredByDmId ?? null,
    });

    console.log(
      `[nanobanana] ${context.agentName} generated image: ${filePath.relative} (${writeResult.sizeBytes} bytes, id=${inserted.id.slice(0, 8)})`
    );

    // Structured payload so the runner can attach an <artifact> tag to the
    // agent's outgoing reply, same as code/markdown artifacts.
    return {
      toolName,
      content: `Created image artifact "${title}" at ${filePath.relative} (${(writeResult.sizeBytes / 1024).toFixed(0)} KB). Reference this in your reply so Shin can see it in the dashboard.`,
      isError: false,
      structuredPayload: {
        artifact_id: inserted.id,
        file_path: filePath.relative,
        content_type: "image",
        language: null,
        version: 1,
        size_bytes: writeResult.sizeBytes,
        title,
        summary: prompt.slice(0, 1000),
      },
    };
  },
};
