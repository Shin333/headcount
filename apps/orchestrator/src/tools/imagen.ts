// ============================================================================
// tools/imagen.ts - Day 18.5 - Google Imagen 3 photorealistic image generation
// ----------------------------------------------------------------------------
// Generates photorealistic images using Google's Imagen 3 model
// (imagen-3.0-generate-002). This is a SEPARATE model from Nano Banana
// (gemini-2.5-flash-image) and uses a different API method.
//
// Use Imagen 3 (this tool) for:
//   - Photorealistic portraits and headshots
//   - Product photography
//   - Anything that needs to look like a real photograph
//
// Use Nano Banana (image_generate) for:
//   - Icons, illustrations, sketches
//   - Quick visual concepts and mood boards
//   - Generic graphics where photorealism isn't needed
//   - Text-heavy images (logos, infographics)
//
// Imagen 3 is ~$0.03/image. Nano Banana is ~$0.039/image.
// Imagen 3 is actually cheaper AND better for photorealistic work.
//
// Uses the same GEMINI_API_KEY as Nano Banana. The @google/genai SDK
// provides the `generateImages` method for Imagen models.
//
// Per-agent daily cap: 10 (lower than Nano Banana because these are
// higher-stakes images that should be more deliberate).
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";
import { buildImageArtifactPath, writeImageArtifactFile } from "./workspace-image.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const IMAGEN_MODEL = "imagen-3.0-generate-002";
const DAILY_CAP_PER_AGENT = 10;
const APPROX_COST_PER_IMAGE_USD = 0.03;
const TOOL_NAME = "imagen_generate";

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
    .eq("tool_name", TOOL_NAME)
    .eq("success", true)
    .gte("created_at", startOfDay.toISOString());

  if (error) {
    console.warn(`[imagen] failed to count today's images: ${error.message}`);
    return 0;
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
    tool_name: TOOL_NAME,
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
// Imagen 3 API call
// ----------------------------------------------------------------------------
// Imagen 3 uses a different API method than Nano Banana:
//   Nano Banana:  ai.models.generateContent() with responseModalities: ["IMAGE"]
//   Imagen 3:     ai.models.generateImages() with a GenerateImagesConfig
//
// The response shape is also different — Imagen returns generated_images[]
// with image.imageBytes (Buffer) directly, not base64 in inlineData.
// ----------------------------------------------------------------------------

interface ImagenResult {
  buffer: Buffer;
  mimeType: string;
}

async function callImagenApi(args: {
  apiKey: string;
  prompt: string;
  aspectRatio: string;
}): Promise<ImagenResult> {
  // Dynamic import — same pattern as nanobanana.ts
  let GoogleGenAI: any;
  try {
    const moduleName = "@google/genai";
    const mod = (await import(/* @vite-ignore */ moduleName)) as any;
    GoogleGenAI = mod.GoogleGenAI;
  } catch {
    throw new Error(
      "@google/genai package not installed. Run: pnpm add @google/genai"
    );
  }

  const ai = new GoogleGenAI({ apiKey: args.apiKey });

  // Imagen uses generateImages, not generateContent.
  // CRITICAL: personGeneration must be "ALLOW_ALL" for portrait generation.
  // Without this, the API rejects any prompt containing people.
  //
  // Try imagen-3.0-generate-002 first, fall back to imagen-3.0-generate-001
  // if the newer model isn't available in this API version.
  const modelsToTry = [IMAGEN_MODEL, "imagen-3.0-generate-001"];
  let lastError: Error | null = null;

  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateImages({
        model,
        prompt: args.prompt,
        config: {
          numberOfImages: 1,
          aspectRatio: args.aspectRatio,
          personGeneration: "ALLOW_ALL",
        },
      });

      // Imagen returns generatedImages[] with image data
      const images = response.generatedImages;
      if (!images || images.length === 0) {
        throw new Error(
          "Imagen returned no images (likely a safety filter rejection)"
        );
      }

      const firstImage = images[0];
      if (!firstImage?.image?.imageBytes) {
        throw new Error("Imagen returned no image bytes");
      }

      // imageBytes may be a Buffer or a base64 string depending on SDK version
      let buffer: Buffer;
      if (firstImage.image.imageBytes instanceof Buffer) {
        buffer = firstImage.image.imageBytes;
      } else if (typeof firstImage.image.imageBytes === "string") {
        buffer = Buffer.from(firstImage.image.imageBytes, "base64");
      } else {
        buffer = Buffer.from(firstImage.image.imageBytes);
      }

      console.log(`[imagen] generated with model ${model} (${buffer.length} bytes)`);
      return { buffer, mimeType: "image/png" };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();
      // If it's a 404 / model not found, try the next model
      if (msg.includes("404") || msg.includes("not found") || msg.includes("not available")) {
        console.warn(`[imagen] model ${model} not available, trying next...`);
        continue;
      }
      // For any other error, throw immediately
      throw lastError;
    }
  }

  throw lastError ?? new Error("All Imagen models failed");
}

// ----------------------------------------------------------------------------
// The tool
// ----------------------------------------------------------------------------

export const imagenGenerateTool: Tool = {
  real_action: true,
  definition: {
    name: TOOL_NAME,
    description:
      "Generate a PHOTOREALISTIC image using Google Imagen 3. Use this tool for portraits, headshots, product photography, and anything that must look like a real photograph. For illustrations, icons, sketches, or generic graphics, use image_generate (Nano Banana) instead — it's cheaper and better suited for non-photorealistic work.\n\n⚠️ IMPORTANT: Use imagen_generate (this tool) ONLY when photorealism is required. Use image_generate for everything else.\n\nWriting effective prompts for photorealism:\n- Specify the subject clearly: 'professional headshot of a woman in her 40s, Southeast Asian, warm expression'\n- Include lighting: 'warm studio lighting, soft key light from upper-left, gentle fill'\n- Include background: 'dark charcoal background, no props, no distractions'\n- Include camera language: '85mm portrait lens, shallow depth of field, f/2.8'\n- Include wardrobe: 'wearing a navy blazer over a white collared shirt'\n\nBad prompt: 'a portrait of an agent'\nGood prompt: 'professional headshot photograph of a man in his 30s, South Asian, confident and approachable expression, wearing smart casual open collar shirt, warm golden studio lighting with soft fill, dark charcoal background, 85mm portrait lens, shallow depth of field, 3:4 portrait orientation'\n\nPer-agent daily cap: 10 generations. Each image costs ~$0.03.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed text description for a photorealistic image. Include subject, lighting, background, camera settings, and wardrobe. Be specific — Imagen 3 responds well to concrete photographic direction.",
        },
        title: {
          type: "string",
          description:
            "Short human-readable title for the artifact (e.g. 'Eleanor Vance portrait', 'Director tier headshot test'). Used as the artifact title and filename slug.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
          description:
            "Image aspect ratio. Use 3:4 for portraits/headshots. Default 1:1.",
        },
      },
      required: ["prompt", "title"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const start = Date.now();

    if (!context) {
      return { toolName: TOOL_NAME, content: "Error: requires execution context.", isError: true };
    }

    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const aspectRatio = typeof input.aspect_ratio === "string" ? input.aspect_ratio : "1:1";

    if (!prompt) return { toolName: TOOL_NAME, content: "Error: prompt is required.", isError: true };
    if (!title) return { toolName: TOOL_NAME, content: "Error: title is required.", isError: true };
    if (!ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
      return { toolName: TOOL_NAME, content: `Error: invalid aspect_ratio. Use: ${[...ALLOWED_ASPECT_RATIOS].join(", ")}`, isError: true };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { toolName: TOOL_NAME, content: "Error: GEMINI_API_KEY not set. Imagen 3 is not configured.", isError: true };
    }

    const argsForAudit = { prompt: prompt.slice(0, 300), title, aspect_ratio: aspectRatio, model: IMAGEN_MODEL };

    // Daily cap
    const todayCount = await countImagesToday(context.agentId);
    if (todayCount >= DAILY_CAP_PER_AGENT) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId, argsForAudit,
        resultSummary: "daily cap reached", resultFull: null,
        success: false, errorMessage: `Daily Imagen cap of ${DAILY_CAP_PER_AGENT} reached`,
        durationMs, triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return { toolName: TOOL_NAME, content: `Error: daily Imagen generation cap reached (${DAILY_CAP_PER_AGENT}/day). Try again tomorrow, or use image_generate (Nano Banana) for non-photorealistic work.`, isError: true };
    }

    // Generate
    let imageResult: ImagenResult;
    try {
      imageResult = await callImagenApi({ apiKey, prompt, aspectRatio });
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);

      // Check for safety filter
      if (errMsg.includes("safety") || errMsg.includes("SAFETY")) {
        await writeAudit({
          agentId: context.agentId, argsForAudit,
          resultSummary: "safety filter", resultFull: null,
          success: false, errorMessage: errMsg,
          durationMs, triggeredByDmId: context.triggeredByDmId ?? null,
        });
        return { toolName: TOOL_NAME, content: "Error: image rejected by safety filter. Adjust the prompt to remove potentially problematic content.", isError: true };
      }

      await writeAudit({
        agentId: context.agentId, argsForAudit,
        resultSummary: "generation failed", resultFull: null,
        success: false, errorMessage: errMsg,
        durationMs, triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return { toolName: TOOL_NAME, content: `Error: Imagen generation failed: ${errMsg}`, isError: true };
    }

    // Save to workspace
    const filePath = buildImageArtifactPath({
      agentDepartment: context.agentDepartment,
      filename: title,
      mimeType: imageResult.mimeType,
    });

    const writeResult = writeImageArtifactFile(filePath, imageResult.buffer);

    // Insert artifact row
    // Day 22: removed `metadata` field — column doesn't exist in artifacts table.
    // This was causing silent insert failures, which is why Heng's portraits
    // never showed up in the DB despite the tool thinking they were saved.
    const { data: inserted, error: insertErr } = await db
      .from("artifacts")
      .insert({
        tenant_id: config.tenantId,
        agent_id: context.agentId,
        file_path: filePath.relative,
        content_type: "image",
        language: imageResult.mimeType,
        title,
        summary: `Photorealistic image (Imagen 3, ${aspectRatio}): ${prompt.slice(0, 200)}`,
        version: 1,
        size_bytes: writeResult.sizeBytes,
        triggered_by_dm_id: context.triggeredByDmId ?? null,
      })
      .select("id")
      .single();

    if (insertErr || !inserted) {
      return { toolName: TOOL_NAME, content: `Error: image saved to ${filePath.relative} but artifact DB row failed: ${insertErr?.message}`, isError: true };
    }

    const durationMs = Date.now() - start;
    await writeAudit({
      agentId: context.agentId, argsForAudit,
      resultSummary: `Generated photorealistic image: ${filePath.relative}`,
      resultFull: { artifact_id: inserted.id, file_path: filePath.relative, size_bytes: writeResult.sizeBytes, model: IMAGEN_MODEL },
      success: true, errorMessage: null, durationMs,
      triggeredByDmId: context.triggeredByDmId ?? null,
    });

    console.log(
      `[imagen] ${context.agentName} generated: ${filePath.relative} (${writeResult.sizeBytes} bytes, ${durationMs}ms, ~$${APPROX_COST_PER_IMAGE_USD})`
    );

    // Auto-post to project channels (same pattern as nanobanana)
    try {
      const { getActiveProjectsForAgent } = await import("../projects/members.js");
      const { postToChannel } = await import("../comms/channel.js");
      const activeProjects = await getActiveProjectsForAgent(context.agentId);
      for (const project of activeProjects) {
        await postToChannel({
          projectId: project.id,
          agentId: context.agentId,
          body: `Created photorealistic image: **${title}** at \`${filePath.relative}\` (Imagen 3, ${aspectRatio})`,
          messageType: "artifact",
        });
      }
    } catch { /* don't break artifact creation */ }

    // Auto-resolve matching commitments (Day 22: keyword matching, not oldest-first)
    try {
      const { getPendingCommitmentsForAgent, resolveCommitment } = await import("../commitments/store.js");
      const pending = await getPendingCommitmentsForAgent(context.agentId);
      if (pending.length > 0) {
        const titleWords = new Set(
          title.toLowerCase().split(/[\s\-_:,.()/]+/).filter((w: string) => w.length >= 3)
        );
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
          console.log(`[imagen] auto-resolved commitment "${bestMatch.commitment.description}" for ${context.agentName}`);
        }
      }
    } catch { /* don't break */ }

    return {
      toolName: TOOL_NAME,
      content: `Generated photorealistic image "${title}" at ${filePath.relative} (Imagen 3, ${aspectRatio}, ${writeResult.sizeBytes} bytes). Reference this in your reply so Shin can find it in the dashboard.`,
      isError: false,
      structuredPayload: {
        artifact_id: inserted.id,
        file_path: filePath.relative,
        content_type: "image",
        language: imageResult.mimeType,
        version: 1,
        size_bytes: writeResult.sizeBytes,
        title,
        summary: `Photorealistic image (Imagen 3): ${prompt.slice(0, 200)}`,
      },
    };
  },
};
