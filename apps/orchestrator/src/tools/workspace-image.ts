// ============================================================================
// tools/workspace-image.ts - Day 13 image artifact filesystem helper
// ----------------------------------------------------------------------------
// Day 9b's workspace.ts handles text artifacts (code + markdown) with a
// 1 MB cap and a UTF-8-only writeFile call. Images are binary and bigger,
// so they need their own write function.
//
// We deliberately don't modify workspace.ts itself - keeping the text path
// untouched means the Day 9b code (which handles 99% of artifacts) is
// unchanged and the Day 11 parseArtifactsBlock tests stay green.
//
// Image artifacts live at:
//   workspace/<department>/images/<slug>-<YYYY-MM-DD>-<short-id>.<ext>
//
// where <ext> is png, jpg, jpeg, or webp.
// ============================================================================

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  findRepoRoot,
  slugify,
  todayUtcDate,
  shortId,
  departmentFolder,
  type ArtifactFilePath,
} from "./workspace.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

const IMAGE_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

/**
 * Resolve the file path an image artifact should be written to.
 * Mirrors buildArtifactPath in workspace.ts but for the images/ subfolder
 * and binary extensions.
 */
export function buildImageArtifactPath(args: {
  agentDepartment: string | null;
  filename: string;
  mimeType: string;
}): ArtifactFilePath {
  const dept = departmentFolder(args.agentDepartment);
  const slug = slugify(args.filename);
  const date = todayUtcDate();
  const id = shortId();
  const ext = IMAGE_MIME_TO_EXT[args.mimeType.toLowerCase()] ?? "png";

  const filename = `${slug || "image"}-${date}-${id}.${ext}`;
  const relative = join("workspace", dept, "images", filename).replace(/\\/g, "/");
  const absolute = join(findRepoRoot(), "workspace", dept, "images", filename);

  return { relative, absolute, filename };
}

export interface WriteImageResult {
  filePath: ArtifactFilePath;
  sizeBytes: number;
}

/**
 * Write a binary image to disk with path-escape protection and a 5 MB cap.
 *
 * Defends against:
 *   - empty content
 *   - oversized content (> 5 MB)
 *   - path escape (resolved path must live under repo root)
 */
export function writeImageArtifactFile(
  filePath: ArtifactFilePath,
  buffer: Buffer
): WriteImageResult {
  if (!buffer || buffer.length === 0) {
    throw new Error("[workspace-image] cannot write empty buffer");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `[workspace-image] image too large: ${buffer.length} bytes (max ${MAX_IMAGE_BYTES})`
    );
  }

  const root = findRepoRoot();
  const resolved = resolve(filePath.absolute);
  if (!resolved.startsWith(resolve(root))) {
    throw new Error(
      `[workspace-image] image path ${resolved} escapes repo root ${root} - refusing to write`
    );
  }

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, buffer);

  const stats = statSync(resolved);
  return { filePath, sizeBytes: stats.size };
}
