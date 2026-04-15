// ----------------------------------------------------------------------------
// tools/workspace.ts - file system operations for the artifact layer
// ----------------------------------------------------------------------------
// Owns all interaction with the workspace/ folder. The artifact tools
// (code_artifact_create, markdown_artifact_create) call into this module
// rather than touching the filesystem directly. This keeps the artifact
// tool definitions focused on schema and the file logic in one place.
//
// Repo root detection: walks up from process.cwd() looking for a .git/
// folder or pnpm-workspace.yaml file. This fixes the Day 9a bug where
// running from apps/orchestrator/ wrote files into the wrong directory.
//
// Day 9b filename convention:
//   workspace/<department>/<slug>-<YYYY-MM-DD>-<short-id>.<ext>
// where:
//   - department comes from the agent's department field (lowercased)
//   - slug is the user-supplied filename slugified
//   - date is YYYY-MM-DD in UTC (consistent with the simulation clock)
//   - short-id is the first 4 hex chars of a random UUID, for collision
//     resistance when two artifacts share a slug-date pair
//   - ext is determined by content_type and language
// ----------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ----------------------------------------------------------------------------
// Repo root detection
// ----------------------------------------------------------------------------

let cachedRepoRoot: string | null = null;

/**
 * Walks up from process.cwd() looking for a .git folder or pnpm-workspace.yaml
 * file. Returns the directory that contains either marker. Caches the result
 * after the first call so subsequent calls are O(1).
 *
 * Throws if neither marker is found anywhere up the tree. The orchestrator
 * should never be run outside the headcount repo, so this throw is intended
 * to fail loudly during startup rather than silently write to a wrong path.
 */
export function findRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot;

  let current = resolve(process.cwd());
  const root = resolve("/");

  while (current !== root) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, "pnpm-workspace.yaml"))) {
      cachedRepoRoot = current;
      return current;
    }
    current = dirname(current);
  }

  throw new Error(
    `[workspace] could not find repo root from ${process.cwd()}. ` +
      `Looked for .git/ or pnpm-workspace.yaml. Are you running outside the headcount repo?`
  );
}

// ----------------------------------------------------------------------------
// Slug + filename generation
// ----------------------------------------------------------------------------

/**
 * Convert a user-supplied filename or title into a filesystem-safe slug.
 * Lowercase, hyphenated, alphanumerics only. Strips file extensions because
 * we control those separately based on content_type/language.
 */
export function slugify(input: string): string {
  // Drop file extension if present
  const noExt = input.replace(/\.[a-zA-Z0-9]+$/, "");
  return noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60); // cap at 60 chars to keep paths reasonable
}

/**
 * Today's date in UTC as YYYY-MM-DD. Note: this uses real wall-clock time,
 * not the simulation company clock. The reasoning: artifacts on disk are
 * real files that the user will look at in real time, so the date in the
 * filename should match the real day they were created. The artifact row's
 * `created_at` column is a separate timestamp that records the same moment.
 */
export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pick a 4-hex-char short ID from a random UUID. Used as a collision
 * suffix in filenames so two artifacts with the same slug+date don't
 * collide.
 */
export function shortId(): string {
  return randomUUID().slice(0, 4);
}

// ----------------------------------------------------------------------------
// Extension resolution
// ----------------------------------------------------------------------------

const LANGUAGE_TO_EXT: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  tsx: "tsx",
  jsx: "jsx",
  python: "py",
  ruby: "rb",
  go: "go",
  rust: "rs",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  csharp: "cs",
  cpp: "cpp",
  c: "c",
  sql: "sql",
  bash: "sh",
  shell: "sh",
  powershell: "ps1",
  yaml: "yaml",
  json: "json",
  toml: "toml",
  html: "html",
  css: "css",
  scss: "scss",
  vue: "vue",
  svelte: "svelte",
  php: "php",
  lua: "lua",
  r: "r",
  scala: "scala",
};

/**
 * Pick the file extension for an artifact. For code, uses the language map
 * with a fallback to .txt for unknown languages. For markdown/plaintext,
 * fixed extensions.
 */
export function pickExtension(
  contentType: "markdown" | "plaintext" | "code",
  language: string | null
): string {
  if (contentType === "markdown") return "md";
  if (contentType === "plaintext") return "txt";
  // code
  if (!language) return "txt";
  return LANGUAGE_TO_EXT[language.toLowerCase()] ?? "txt";
}

// ----------------------------------------------------------------------------
// Department folder mapping
// ----------------------------------------------------------------------------

/**
 * Map an agent's department to its workspace subfolder. Falls back to
 * "misc" for agents with no department or an unrecognized one. The folder
 * names match the slugs in the departments table from Day 7.
 */
export function departmentFolder(agentDepartment: string | null): string {
  if (!agentDepartment) return "misc";
  const known = new Set([
    "engineering",
    "marketing",
    "sales",
    "strategy",
    "operations",
    "finance",
    "legal",
    "people",
    "executive",
    "design",
    "product",
    "culture",
  ]);
  const lower = agentDepartment.toLowerCase();
  return known.has(lower) ? lower : "misc";
}

// ----------------------------------------------------------------------------
// Path assembly
// ----------------------------------------------------------------------------

export interface ArtifactFilePath {
  /** Relative path from repo root, e.g. "workspace/engineering/auth-2026-04-08-a8f3.ts" */
  relative: string;
  /** Absolute path on disk, e.g. "D:\Projects\headcount\workspace\engineering\..." */
  absolute: string;
  /** The filename portion only, e.g. "auth-2026-04-08-a8f3.ts" */
  filename: string;
}

/**
 * Build a complete artifact file path from inputs. Does NOT create the file
 * or any directories - just resolves where the file *should* live. The
 * caller (writeArtifactFile) does the actual filesystem operations.
 */
export function buildArtifactPath(args: {
  agentDepartment: string | null;
  filename: string;
  contentType: "markdown" | "plaintext" | "code";
  language: string | null;
}): ArtifactFilePath {
  const dept = departmentFolder(args.agentDepartment);
  const slug = slugify(args.filename);
  const date = todayUtcDate();
  const id = shortId();
  const ext = pickExtension(args.contentType, args.language);

  const filename = `${slug || "untitled"}-${date}-${id}.${ext}`;
  const relative = join("workspace", dept, filename).replace(/\\/g, "/");
  const absolute = join(findRepoRoot(), "workspace", dept, filename);

  return { relative, absolute, filename };
}

// ----------------------------------------------------------------------------
// File write
// ----------------------------------------------------------------------------

export interface WriteArtifactResult {
  filePath: ArtifactFilePath;
  sizeBytes: number;
}

/**
 * Write an artifact file to disk. Creates the parent directory if it doesn't
 * exist. Returns the resolved path and the file size for the artifacts
 * table row.
 *
 * Defends against:
 *   - empty content (returns an error rather than writing an empty file)
 *   - oversized content (caps at 1 MB; anything larger is rejected since
 *     the artifact layer is for code and markdown, not binary blobs)
 *   - path escape attempts (resolved path must start with the repo root)
 */
export function writeArtifactFile(
  filePath: ArtifactFilePath,
  content: string
): WriteArtifactResult {
  if (!content || content.length === 0) {
    throw new Error("[workspace] cannot write empty content as an artifact");
  }
  if (content.length > 1_000_000) {
    throw new Error(
      `[workspace] content too large: ${content.length} bytes (max 1 MB for Day 9b)`
    );
  }

  // Defense against path escape: the absolute path must live under repo root
  const root = findRepoRoot();
  const resolved = resolve(filePath.absolute);
  if (!resolved.startsWith(resolve(root))) {
    throw new Error(
      `[workspace] artifact path ${resolved} escapes repo root ${root} - refusing to write`
    );
  }

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, "utf-8");

  const stats = statSync(resolved);
  return {
    filePath,
    sizeBytes: stats.size,
  };
}

// ----------------------------------------------------------------------------
// Workspace bootstrap (called once at orchestrator startup)
// ----------------------------------------------------------------------------

/**
 * Ensure the workspace/ folder exists with a .gitkeep so the directory is
 * tracked by git even though its contents are gitignored. Idempotent -
 * safe to call on every orchestrator boot.
 */
export function ensureWorkspaceExists(): void {
  const root = findRepoRoot();
  const workspaceDir = join(root, "workspace");
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }
  const gitkeep = join(workspaceDir, ".gitkeep");
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, "", "utf-8");
  }
}
