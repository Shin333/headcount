// ============================================================================
// util/supabase-storage.ts - Day 28 - upload images to Supabase Storage
// ----------------------------------------------------------------------------
// Genviral fetches slideshow images from public URLs; it doesn't host them.
// This helper pushes agent-generated image buffers into a public-read bucket
// in our existing Supabase project and returns the URL. Used by the genviral
// tool before POSTing to Genviral's /posts endpoint.
//
// The bucket is created manually from the Supabase dashboard (one-time
// operator step); this helper just uploads into it. If the bucket is
// missing, upload returns a clear error pointing at the setup step.
// ============================================================================

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { env } from "../config.js";

const storageClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

export interface UploadResult {
  ok: true;
  public_url: string;
  path: string;
  bytes: number;
}
export interface UploadError {
  ok: false;
  error: string;
}

/**
 * Upload a buffer to the public-read bucket at the given key. Returns the
 * URL Genviral (or any other external service) can fetch without auth.
 * Idempotent: uses upsert so re-uploading the same key overwrites.
 */
export async function uploadToStorage(args: {
  key: string; // e.g. "nocodeships/2026-04-17/slot-1/slide-3.png"
  buffer: Buffer;
  contentType: string; // "image/png", "image/jpeg", etc
}): Promise<UploadResult | UploadError> {
  const { key, buffer, contentType } = args;
  const bucket = config.supabaseStorageBucket;

  const { error } = await storageClient.storage.from(bucket).upload(key, buffer, {
    contentType,
    upsert: true,
    cacheControl: "3600",
  });

  if (error) {
    const msg = error.message || String(error);
    if (msg.toLowerCase().includes("bucket not found")) {
      return {
        ok: false,
        error: `Supabase Storage bucket "${bucket}" not found. Create it in the Supabase dashboard (Storage → New bucket → public-read).`,
      };
    }
    return { ok: false, error: `Supabase Storage upload failed: ${msg}` };
  }

  const { data: urlData } = storageClient.storage.from(bucket).getPublicUrl(key);
  if (!urlData?.publicUrl) {
    return { ok: false, error: "Supabase Storage returned no public URL (bucket may not be public)" };
  }

  return {
    ok: true,
    public_url: urlData.publicUrl,
    path: key,
    bytes: buffer.byteLength,
  };
}

/**
 * Convenience wrapper: read a local file path from disk + upload under a
 * derived key. Useful when an agent has just produced an image via
 * nanobanana or browser_screenshot and it sits on the orchestrator's
 * filesystem.
 *
 * The derived key keeps files organized by draft date + agent, which keeps
 * the bucket browsable in the Supabase dashboard if you ever need to audit.
 */
export async function uploadLocalFile(args: {
  localPath: string;
  keyPrefix: string; // e.g. "nocodeships/2026-04-17/slot-1"
  filename?: string; // default: basename of localPath
  contentType?: string; // inferred from extension if omitted
}): Promise<UploadResult | UploadError> {
  const { localPath, keyPrefix } = args;
  const filename = args.filename ?? path.basename(localPath);
  const ext = path.extname(filename).toLowerCase();
  const contentType =
    args.contentType ??
    ({
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    }[ext] ?? "application/octet-stream");

  let buffer: Buffer;
  try {
    buffer = await readFile(localPath);
  } catch (err) {
    return {
      ok: false,
      error: `Could not read local file "${localPath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const key = `${keyPrefix.replace(/\/+$/, "")}/${filename}`;
  return uploadToStorage({ key, buffer, contentType });
}
