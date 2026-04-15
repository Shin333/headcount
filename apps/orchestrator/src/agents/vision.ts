// ============================================================================
// agents/vision.ts - Day 19: Agent Vision
// ----------------------------------------------------------------------------
// Enables agents to "see" workspace images referenced in their context.
//
// When a channel message or trigger references a workspace image path like
// `workspace/design/images/eleanor-vance-portrait-2026-04-10-a1fa.png`,
// this module:
//   1. Extracts all workspace image paths from the text
//   2. Loads them as base64 from disk
//   3. Returns Anthropic API image content blocks ready for injection
//
// Usage in the runner:
//   const imageBlocks = await extractAndLoadImages(triggerText + channelHistory);
//   // Then pass imageBlocks to runAgentTurn which builds multi-content messages
//
// Cost considerations:
//   - Each image costs ~1600 tokens (for a 512x512 PNG) to ~6400 tokens (1024x1024)
//   - Limit to MAX_IMAGES_PER_TURN to prevent context window blowout
//   - Only inject images that are directly referenced in the current turn's context
// ============================================================================

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";

// Hard cap on images per turn to prevent context window blowout
const MAX_IMAGES_PER_TURN = 4;

// Supported image extensions
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// Media type mapping
const MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/webp";
    data: string;
  };
}

/**
 * Find the repo root by walking up from cwd looking for pnpm-workspace.yaml or .git.
 */
function findRepoRoot(): string {
  let current = resolve(process.cwd());
  const root = resolve("/");
  while (current !== root) {
    if (
      existsSync(join(current, "pnpm-workspace.yaml")) ||
      existsSync(join(current, ".git"))
    ) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error(`could not find repo root from ${process.cwd()}`);
}

/**
 * Extract all workspace image paths from a text block.
 * Matches patterns like:
 *   workspace/design/images/name-2026-04-10-abcd.png
 *   `workspace/marketing/hero-image-2026-04-10-1234.jpg`
 */
export function extractImagePaths(text: string): string[] {
  // Match workspace/ paths that end with image extensions
  const regex = /workspace\/[\w\-\/]+\.(?:png|jpg|jpeg|webp)/gi;
  const matches = text.match(regex) ?? [];

  // Deduplicate
  return Array.from(new Set(matches));
}

/**
 * Load a workspace image from disk and return it as an Anthropic image block.
 * Returns null if the file doesn't exist or isn't a valid image type.
 */
async function loadImageAsBlock(
  workspacePath: string
): Promise<ImageBlock | null> {
  try {
    const ext = extname(workspacePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return null;

    const repoRoot = findRepoRoot();
    const absolutePath = resolve(join(repoRoot, workspacePath));

    // Security: ensure path is within workspace/
    const workspaceRoot = resolve(join(repoRoot, "workspace"));
    if (!absolutePath.startsWith(workspaceRoot)) {
      console.warn(`[vision] path escapes workspace: ${workspacePath}`);
      return null;
    }

    if (!existsSync(absolutePath)) {
      console.warn(`[vision] file not found: ${workspacePath}`);
      return null;
    }

    const buffer = await readFile(absolutePath);
    const base64 = buffer.toString("base64");
    const mediaType = MEDIA_TYPES[ext] ?? "image/png";

    // Log the size for cost tracking
    const sizeKb = (buffer.length / 1024).toFixed(1);
    console.log(`[vision] loaded ${workspacePath} (${sizeKb} KB)`);

    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64,
      },
    };
  } catch (err) {
    console.warn(
      `[vision] failed to load ${workspacePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/**
 * Extract workspace image paths from the given text, load them as base64,
 * and return Anthropic-compatible image content blocks.
 *
 * Automatically deduplicates paths and caps at MAX_IMAGES_PER_TURN.
 * Returns an empty array if no images are found or loadable.
 */
export async function extractAndLoadImages(
  text: string
): Promise<ImageBlock[]> {
  const paths = extractImagePaths(text);
  if (paths.length === 0) return [];

  // Cap the number of images to prevent context window blowout
  const cappedPaths = paths.slice(0, MAX_IMAGES_PER_TURN);
  if (paths.length > MAX_IMAGES_PER_TURN) {
    console.log(
      `[vision] found ${paths.length} images, capping at ${MAX_IMAGES_PER_TURN}`
    );
  }

  const blocks: ImageBlock[] = [];
  for (const path of cappedPaths) {
    const block = await loadImageAsBlock(path);
    if (block) blocks.push(block);
  }

  if (blocks.length > 0) {
    console.log(`[vision] injecting ${blocks.length} image(s) into agent context`);
  }

  return blocks;
}

/**
 * Build a multi-content message that includes both text and images.
 * Used by the runner to construct the trigger message with image context.
 *
 * If no images are provided, returns the plain text string (cheaper path).
 * If images are provided, returns an array of content blocks.
 */
export function buildTriggerWithImages(
  triggerText: string,
  images: ImageBlock[]
): string | Array<{ type: "text"; text: string } | ImageBlock> {
  if (images.length === 0) return triggerText;

  // Build a multi-content array: images first, then the trigger text
  // Images first so the agent "sees" them before reading the task
  const content: Array<{ type: "text"; text: string } | ImageBlock> = [];

  content.push({
    type: "text",
    text: `[${images.length} workspace image(s) attached for your review]`,
  });

  for (const img of images) {
    content.push(img);
  }

  content.push({
    type: "text",
    text: triggerText,
  });

  return content;
}
