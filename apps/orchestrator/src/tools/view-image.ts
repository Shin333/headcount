// ============================================================================
// tools/view-image.ts - Day 28 - load a workspace image into agent vision
// ----------------------------------------------------------------------------
// Closes the architectural gap where browser_screenshot + image_generate
// produce PNGs on disk but agents have no way to look at them on later turns.
// view_image reads a PNG/JPG/WebP from workspace/, base64-encodes it, and
// returns an ImageBlock that the runner unpacks into the next tool_result
// as Anthropic-compatible image content — so the agent actually SEES the
// image on the next round.
//
// Security: only reads inside workspace/ (same guard as vision.ts).
// Cost: ~1,600 tokens for a 512x512 PNG up to ~6,400 for 1024x1024.
//
// Typical use:
//   Tessa: "Kavitha, review these reference grids and tell me the common
//          grid ratios"
//   Kavitha: view_image("workspace/browser-captures/abc/2026-04-17...aidaily.png")
//          → next round she can see the screenshot and write a real review
// ============================================================================

import { loadImageAsBlock } from "../agents/vision.js";
import type { Tool, ToolResult } from "./types.js";

export const viewImageTool: Tool = {
  definition: {
    name: "view_image",
    description:
      "Load a workspace image (PNG / JPG / JPEG / WebP) into your vision for this turn. Use when you need to actually SEE an image file — a screenshot from browser_screenshot, an image from image_generate or imagen_generate, a reference screenshot someone else captured. Pass a workspace-relative path like 'workspace/browser-captures/abc/2026-04-17-aidaily.png'. Images must be inside workspace/ (security). On the next round you will see the image inline and can describe, critique, or compare it. Each image costs ~1600-6400 tokens depending on resolution; don't load more than you need.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative path to the image (e.g. 'workspace/marketing/reference/grid.png'). Absolute paths are rejected.",
        },
      },
      required: ["path"],
    },
  },
  executor: async (input): Promise<ToolResult> => {
    const toolName = "view_image";
    const rawPath = typeof input.path === "string" ? input.path.trim() : "";
    if (!rawPath) {
      return { toolName, content: "Error: path is required.", isError: true };
    }
    if (!rawPath.startsWith("workspace/")) {
      return {
        toolName,
        content: `Error: path must start with 'workspace/' (got '${rawPath}'). Absolute paths and paths outside workspace/ are rejected.`,
        isError: true,
      };
    }
    if (rawPath.includes("..")) {
      return {
        toolName,
        content: "Error: path cannot contain '..' (directory traversal rejected).",
        isError: true,
      };
    }

    const block = await loadImageAsBlock(rawPath);
    if (!block) {
      return {
        toolName,
        content: `Could not load image at '${rawPath}'. It may not exist, or it isn't a supported format (png/jpg/jpeg/webp). Double-check the path with read_artifact or list the directory first.`,
        isError: true,
      };
    }

    const sizeBytes = Math.round((block.source.data.length * 3) / 4); // base64 → bytes approx
    console.log(`[view_image] loaded ${rawPath} (${(sizeBytes / 1024).toFixed(1)} KB, ${block.source.media_type})`);

    return {
      toolName,
      content: `Image loaded: ${rawPath} (${block.source.media_type}, ${(sizeBytes / 1024).toFixed(1)} KB). You can see it inline in your next response.`,
      isError: false,
      imageBlocks: [block],
    };
  },
};
