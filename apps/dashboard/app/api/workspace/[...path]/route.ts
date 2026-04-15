// ============================================================================
// app/api/workspace/[...path]/route.ts - Day 13
// ----------------------------------------------------------------------------
// Serves files from the workspace/ directory to the dashboard so image
// artifacts can be displayed inline. Strict path validation prevents path
// traversal attacks.
//
// SECURITY RULES (non-negotiable):
//   1. The requested path must resolve to a file inside the workspace/
//      directory at the repo root. No exceptions.
//   2. Reject any path containing ".." segments before normalization.
//   3. Reject any path containing absolute path markers (starts with /, ~,
//      drive letters, etc.).
//   4. Only serve files with allowed extensions (png, jpg, jpeg, webp).
//      Markdown and code artifacts are NOT served by this route - they are
//      served via the artifacts API which queries the database.
//   5. After resolving, verify the absolute path starts with the absolute
//      path of workspace/. This is the final defense.
//
// If any check fails, return 404 (not 403) - we don't want to leak info
// about which paths exist vs which paths are forbidden.
// ============================================================================

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, normalize, isAbsolute } from "node:path";
import { NextResponse } from "next/server";

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Find the repo root by walking up from process.cwd() looking for
 * pnpm-workspace.yaml or .git. Mirrors the orchestrator's findRepoRoot.
 */
function findRepoRoot(): string {
  let current = resolve(process.cwd());
  const root = resolve("/");
  while (current !== root) {
    if (existsSync(join(current, "pnpm-workspace.yaml")) || existsSync(join(current, ".git"))) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error(`could not find repo root from ${process.cwd()}`);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: pathSegments } = await params;

    // ----- Validation: every segment must be safe -----
    if (!pathSegments || pathSegments.length === 0) {
      return new NextResponse("Not found", { status: 404 });
    }

    for (const segment of pathSegments) {
      // No null bytes
      if (segment.includes("\0")) {
        return new NextResponse("Not found", { status: 404 });
      }
      // No traversal
      if (segment === ".." || segment === ".") {
        return new NextResponse("Not found", { status: 404 });
      }
      // No absolute path markers
      if (isAbsolute(segment) || segment.startsWith("~")) {
        return new NextResponse("Not found", { status: 404 });
      }
      // No backslashes (Windows path injection)
      if (segment.includes("\\")) {
        return new NextResponse("Not found", { status: 404 });
      }
      // No drive letters (Windows)
      if (/^[a-zA-Z]:/.test(segment)) {
        return new NextResponse("Not found", { status: 404 });
      }
    }

    const requestedRelative = pathSegments.join("/");

    // Reject if normalized form differs in dangerous ways
    const normalized = normalize(requestedRelative);
    if (normalized.includes("..") || isAbsolute(normalized)) {
      return new NextResponse("Not found", { status: 404 });
    }

    // ----- Extension check -----
    const lastDot = normalized.lastIndexOf(".");
    if (lastDot === -1) {
      return new NextResponse("Not found", { status: 404 });
    }
    const ext = normalized.slice(lastDot).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return new NextResponse("Not found", { status: 404 });
    }

    // ----- Resolve to absolute path -----
    const repoRoot = findRepoRoot();
    const workspaceRoot = resolve(join(repoRoot, "workspace"));
    const absolutePath = resolve(join(workspaceRoot, normalized));

    // ----- Final containment check -----
    // The absolute resolved path MUST start with the workspace root.
    // This catches any traversal that survived the per-segment checks.
    if (!absolutePath.startsWith(workspaceRoot + require("node:path").sep) && absolutePath !== workspaceRoot) {
      return new NextResponse("Not found", { status: 404 });
    }

    // ----- File existence -----
    if (!existsSync(absolutePath)) {
      return new NextResponse("Not found", { status: 404 });
    }

    // ----- Read and serve -----
    const buffer = await readFile(absolutePath);
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=3600, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[workspace api] error serving file:", err);
    return new NextResponse("Not found", { status: 404 });
  }
}
