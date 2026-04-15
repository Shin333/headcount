// ============================================================================
// components/primitives/ArtifactCard.tsx - Day 13 (image support)
// ----------------------------------------------------------------------------
// Renders a single artifact reference as a card. Used inside post bodies
// (after parseArtifactsBlock has separated text from artifacts).
//
// The card shows the filename, type/size badge, optional title and
// summary, a "copy path" button, and the full path.
//
// Day 13 addition: image artifacts (type="image") render the actual image
// inline above the metadata, fetched via /api/workspace/<path>. The image
// is clickable to open at full size in a new tab.
// ============================================================================

"use client";

import { useState } from "react";
import { formatSize, type ParsedArtifact } from "../lib/parseArtifactsBlock";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isImageArtifact(artifact: ParsedArtifact): boolean {
  if (artifact.type === "image") return true;
  // Defensive: also detect by extension if type wasn't set correctly
  const lastDot = artifact.path.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = artifact.path.slice(lastDot).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Build the dashboard URL to fetch a workspace file. The path stored in the
 * artifact is repo-relative (e.g. "workspace/marketing/images/hero-2026-04-09.png"),
 * but the API route is mounted at /api/workspace and expects the part AFTER
 * the workspace/ prefix.
 */
function buildImageUrl(artifactPath: string): string {
  const stripped = artifactPath.startsWith("workspace/")
    ? artifactPath.slice("workspace/".length)
    : artifactPath;
  // Encode each path segment but keep the slashes
  const encoded = stripped
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `/api/workspace/${encoded}`;
}

export function ArtifactCard({ artifact }: { artifact: ParsedArtifact }) {
  const [copied, setCopied] = useState(false);
  const [imageError, setImageError] = useState(false);
  const filename = artifact.path.split("/").pop() ?? artifact.path;
  const isImage = isImageArtifact(artifact);

  const typeLabel = isImage
    ? "image"
    : artifact.type === "code"
      ? artifact.lang || "code"
      : artifact.type === "markdown"
        ? "markdown"
        : "text";
  const sizeLabel = formatSize(artifact.size);
  const imageUrl = isImage ? buildImageUrl(artifact.path) : null;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(artifact.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked in some contexts - ignore
    }
  };

  return (
    <div className="mt-3 rounded-md border border-ink-300 bg-ink-50 p-3">
      {/* Image preview - Day 13 */}
      {isImage && imageUrl && !imageError && (
        <a
          href={imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-3 block overflow-hidden rounded border border-ink-200 bg-white"
          title="Click to open at full size"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt={artifact.title || filename}
            className="block max-h-96 w-full object-contain"
            onError={() => setImageError(true)}
          />
        </a>
      )}
      {isImage && imageError && (
        <div className="mb-3 rounded border border-dashed border-red-300 bg-red-50 p-3 text-center">
          <p className="font-mono text-[10px] text-red-700">
            failed to load image · check that the orchestrator wrote the file
          </p>
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="mt-0.5 font-mono text-lg">{isImage ? "🖼️" : "📄"}</div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs font-medium text-ink-900 break-all">{filename}</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-500">
            {typeLabel}
            {sizeLabel ? ` · ${sizeLabel}` : ""}
            {artifact.version && artifact.version !== "1" ? ` · v${artifact.version}` : ""}
          </div>
          {artifact.title ? (
            <div className="mt-2 text-sm font-medium text-ink-800">{artifact.title}</div>
          ) : null}
          {artifact.summary ? (
            <div className="mt-1 text-xs leading-relaxed text-ink-600">{artifact.summary}</div>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={copyPath}
              className="rounded border border-ink-300 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-700 transition hover:border-ink-500 hover:bg-ink-100"
            >
              {copied ? "copied" : "copy path"}
            </button>
            <span className="font-mono text-[10px] text-ink-400 break-all">{artifact.path}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
