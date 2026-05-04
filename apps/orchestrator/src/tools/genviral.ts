// ============================================================================
// tools/genviral.ts - Day 28 - social-media draft posting via Genviral
// ----------------------------------------------------------------------------
// Three tools that together let an agent produce a ready-to-approve draft
// in the CEO's Instagram or TikTok inbox:
//
//   genviral_list_accounts
//     Returns the connected social accounts + platforms so the agent knows
//     which account_id to target. Called once per session (cached).
//
//   genviral_create_draft
//     Uploads images to Supabase Storage (public-read) and POSTs a draft
//     to Genviral's /posts endpoint. TikTok uses post_mode=MEDIA_UPLOAD
//     (agent-drafts-only — the CEO picks trending audio and publishes in
//     the native TikTok app). Instagram carousels post without music.
//     Records the draft in social_drafts for dashboard tracking.
//
//   genviral_check_status
//     Polls Genviral for status changes on a previously-created draft.
//     Updates social_drafts.status. Optional — the dashboard can also
//     poll directly.
//
// All three respect the DAILY_COST_CAP_USD circuit breaker indirectly:
// they don't call Anthropic, but they do consume Genviral quota. The
// daily_token_budget gate doesn't apply (not a token spend) but we audit
// everything to real_action_audit for traceability.
// ============================================================================

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";
import { uploadToStorage } from "../util/supabase-storage.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

const GENVIRAL_BASE = "https://www.genviral.io/api/partner/v1";

interface GenviralAccount {
  id: string;
  platform: "instagram" | "tiktok" | "youtube" | "facebook" | "pinterest" | "linkedin";
  username?: string;
  display_name?: string;
  status?: string;
}

function requireKey(): string | null {
  const key = config.genviralApiKey;
  if (!key) return null;
  return key;
}

async function genviralFetch<T>(path: string, init: RequestInit = {}): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const key = requireKey();
  if (!key) {
    return { ok: false, status: 0, error: "GENVIRAL_API_KEY not set in orchestrator env" };
  }
  const res = await fetch(`${GENVIRAL_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: `Genviral ${res.status}: ${text.slice(0, 500)}` };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: res.status, error: `Genviral returned non-JSON: ${text.slice(0, 300)}` };
  }
}

async function audit(args: {
  toolName: string;
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
    tool_name: args.toolName,
    arguments_json: args.argsForAudit,
    result_summary: args.resultSummary,
    result_full_json: args.resultFull,
    success: args.success,
    error_message: args.errorMessage,
    duration_ms: args.durationMs,
    triggered_by_dm_id: args.triggeredByDmId,
  });
}

// ============================================================================
// Tool: genviral_list_accounts
// ============================================================================

export const genviralListAccountsTool: Tool = {
  real_action: true,
  definition: {
    name: "genviral_list_accounts",
    description:
      "List the social-media accounts the CEO has connected in Genviral, so you know which account_id to target. Returns platform + id + username for each. Call this ONCE at the start of a content-drafting session and reuse the ids. Never hardcode account ids from prior runs; they can change.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  executor: async (_input, context): Promise<ToolResult> => {
    const toolName = "genviral_list_accounts";
    const start = Date.now();
    const ctx = context as ToolExecutionContext;

    const r = await genviralFetch<{ accounts: GenviralAccount[] }>("/accounts");
    if (!r.ok) {
      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: {}, resultSummary: "list_accounts failed",
        resultFull: null, success: false, errorMessage: r.error,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return { toolName, content: `Error: ${r.error}`, isError: true };
    }

    const accounts = r.data.accounts ?? [];
    const summary = `${accounts.length} connected account(s): ${accounts.map((a) => `${a.platform}=${a.username ?? a.id}`).join(", ")}`;
    await audit({
      toolName, agentId: ctx.agentId,
      argsForAudit: {}, resultSummary: summary,
      resultFull: { accounts }, success: true, errorMessage: null,
      durationMs: Date.now() - start,
      triggeredByDmId: ctx.triggeredByDmId ?? null,
    });

    const lines = accounts.map((a) => `- ${a.platform}: id=${a.id}${a.username ? ` (@${a.username})` : ""}${a.status ? ` [${a.status}]` : ""}`).join("\n");
    return {
      toolName,
      content: accounts.length === 0
        ? "No social accounts connected in Genviral. Tell the CEO to connect one in the Genviral dashboard first."
        : `Connected accounts:\n${lines}`,
      isError: false,
      structuredPayload: { accounts },
    };
  },
};

// ============================================================================
// Tool: genviral_create_draft
// ============================================================================

interface CreateDraftInput {
  account_id: string;
  platform: "instagram" | "tiktok";
  caption: string;
  hashtags?: string[];
  image_paths: string[]; // local paths under workspace/
  audio_suggestion?: string; // TikTok only
  project_id?: string; // optional, for dashboard grouping
}

export const genviralCreateDraftTool: Tool = {
  real_action: true,
  definition: {
    name: "genviral_create_draft",
    description:
      "Create a carousel draft in the CEO's Instagram or TikTok account. Images must already exist as local files under workspace/ (from code_artifact_create, nanobanana, imagen, or browser_screenshot). The tool uploads them to Supabase Storage, hits Genviral's /posts endpoint with the right post_mode for the platform, and records the draft in social_drafts. For TikTok: uses MEDIA_UPLOAD so the CEO picks trending audio in the native app. For Instagram: posts the draft directly (no sound selection on IG carousels). Returns the draft id and a preview URL. DO NOT call this to publish — the CEO approves + publishes from the native app. LOCKOUT: exactly ONE successful draft per (platform, account_id) per 24 hours across the whole team. If anyone already fired today's IG carousel, your call will be rejected — check 'Your recent work' and team context before calling.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "Genviral account id (from genviral_list_accounts)" },
        platform: { type: "string", enum: ["instagram", "tiktok"], description: "Target platform" },
        caption: { type: "string", description: "Post caption (hashtag-free; hashtags go in the hashtags array)" },
        hashtags: { type: "array", items: { type: "string" }, description: "20-30 hashtags, no '#' prefix needed. Will be appended to the caption on publish." },
        image_paths: { type: "array", items: { type: "string" }, description: "Local file paths under workspace/ for each slide of the carousel (6-8 slides recommended)" },
        audio_suggestion: { type: "string", description: "(TikTok only, optional) URL or identifier of the suggested trending audio — appears as a note for the CEO to find in the native app" },
        project_id: { type: "string", description: "(Optional) Headcount project_id for dashboard grouping" },
      },
      required: ["account_id", "platform", "caption", "image_paths"],
    },
  },
  max_output_tokens: 4000,
  executor: async (input, context): Promise<ToolResult> => {
    const toolName = "genviral_create_draft";
    const start = Date.now();
    const ctx = context as ToolExecutionContext;
    const typed = input as unknown as CreateDraftInput;

    if (!typed.image_paths?.length) {
      return { toolName, content: "Error: image_paths is required (at least 1 slide).", isError: true };
    }
    if (typed.image_paths.length > 10) {
      return { toolName, content: "Error: Instagram/TikTok carousels are capped at 10 slides.", isError: true };
    }

    // ---- Daily-lockout guard ----
    // We cap one successful draft per (platform, account_id) every 24 hours. The
    // agents previously looped and fired 3 drafts in 15 min because no signal
    // told them the work was done. Checking real_action_audit is authoritative:
    // if a prior call succeeded against this account today, stand down.
    //
    // No override flag is exposed to the agents — they've proven they will set
    // any escape hatch to true to keep working. If the CEO wants a second
    // draft, they raise the cap in code.
    const lockoutSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: priorFires } = await db
      .from("real_action_audit")
      .select("id,agent_id,created_at,arguments_json,result_full_json")
      .eq("tool_name", "genviral_create_draft")
      .eq("success", true)
      .eq("tenant_id", config.tenantId)
      .gte("created_at", lockoutSince)
      .order("created_at", { ascending: false })
      .limit(20);

    const sameAccountFire = (priorFires ?? []).find((row) => {
      const args = (row.arguments_json ?? {}) as Record<string, unknown>;
      return args.account_id === typed.account_id && args.platform === typed.platform;
    });

    if (sameAccountFire) {
      const ageMin = Math.round((Date.now() - new Date(sameAccountFire.created_at).getTime()) / 60000);
      const priorDraftId = (sameAccountFire.result_full_json as { draft_id?: string } | null)?.draft_id ?? "unknown";
      const msg = `Locked out: a ${typed.platform} draft for this account already fired ${ageMin}min ago (draft_id=${priorDraftId}, by agent=${sameAccountFire.agent_id}). The CEO reviews drafts manually in the native app — firing a second one today creates dashboard clutter. Stand down. If today's draft was bad, tell Shin in DM; do not retry.`;
      console.log(`[genviral_create_draft] ${ctx.agentName} LOCKED OUT: prior fire ${ageMin}min ago`);
      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { account_id: typed.account_id, platform: typed.platform, slide_count: typed.image_paths.length, blocked: true },
        resultSummary: `blocked by 24h lockout (prior fire ${ageMin}min ago)`,
        resultFull: { prior_audit_id: sameAccountFire.id, prior_draft_id: priorDraftId },
        success: false, errorMessage: "daily_lockout",
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return { toolName, content: msg, isError: true };
    }

    // ---- Upload images to Supabase Storage ----
    const dateKey = new Date().toISOString().slice(0, 10);
    const slotKey = randomUUID().slice(0, 8);
    const keyPrefix = `nocodeships/${dateKey}/${ctx.agentId.slice(0, 8)}-${slotKey}`;
    const publicUrls: string[] = [];

    for (let i = 0; i < typed.image_paths.length; i++) {
      const relPath = typed.image_paths[i]!;
      // Resolve relative to orchestrator cwd — workspace/ sits two levels up at repo root
      const absPath = path.isAbsolute(relPath)
        ? relPath
        : path.join(process.cwd(), "..", "..", relPath);

      let buffer: Buffer;
      try {
        buffer = await readFile(absPath);
      } catch (err) {
        return {
          toolName,
          content: `Error reading slide ${i + 1} at ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }

      const ext = path.extname(relPath).toLowerCase();
      const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
      const slideKey = `${keyPrefix}/slide-${String(i + 1).padStart(2, "0")}${ext || ".png"}`;

      const up = await uploadToStorage({ key: slideKey, buffer, contentType });
      if (!up.ok) {
        return { toolName, content: `Upload failed for slide ${i + 1}: ${up.error}`, isError: true };
      }
      publicUrls.push(up.public_url);
    }

    // ---- Insert social_drafts row (pre-flight) ----
    const draftId = randomUUID();
    await db.from("social_drafts").insert({
      id: draftId,
      tenant_id: config.tenantId,
      agent_id: ctx.agentId,
      project_id: typed.project_id ?? null,
      platform: typed.platform,
      account_id: typed.account_id,
      post_type: "slideshow",
      caption: typed.caption,
      hashtags: typed.hashtags ?? [],
      image_urls: publicUrls,
      audio_suggestion: typed.audio_suggestion ?? null,
      status: "drafting",
    });

    // ---- Hit Genviral ----
    // Payload shape (verified by probing /posts on 2026-04-17):
    //   { caption, accounts: [{id}], media: { type: 'slideshow' | 'video', urls: [...] } }
    // Legacy fields `account_id`, `post_mode`, `media.images` are rejected with 422.
    const postMode = typed.platform === "tiktok" ? "MEDIA_UPLOAD" : "DIRECT";
    const captionWithTags = typed.hashtags?.length
      ? `${typed.caption}\n\n${typed.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`
      : typed.caption;

    const body = {
      caption: captionWithTags,
      accounts: [{ id: typed.account_id }],
      media: {
        type: "slideshow",
        urls: publicUrls,
      },
    };

    const r = await genviralFetch<Record<string, unknown>>("/posts", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      await db.from("social_drafts").update({
        status: "error",
        error_message: r.error,
        updated_at: new Date().toISOString(),
      }).eq("id", draftId);

      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { account_id: typed.account_id, platform: typed.platform, slide_count: typed.image_paths.length },
        resultSummary: "genviral post failed",
        resultFull: { draft_id: draftId, error: r.error },
        success: false, errorMessage: r.error,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return { toolName, content: `Genviral rejected the draft: ${r.error}`, isError: true };
    }

    // ---- Success path ----
    // Genviral's 2xx response shape isn't documented for us — extract a post id from
    // the known candidates, fall back to stringifying so we at least get *something*
    // for the audit trail. The raw response is always captured below.
    const rawResp = r.data as Record<string, unknown>;
    const genviralPostId = String(
      rawResp.id ?? rawResp.post_id ?? (rawResp.post as { id?: string } | undefined)?.id ?? (rawResp.data as { id?: string } | undefined)?.id ?? "unknown"
    );

    await db.from("social_drafts").update({
      genviral_post_id: genviralPostId,
      genviral_post_mode: postMode,
      status: "uploaded",
      updated_at: new Date().toISOString(),
    }).eq("id", draftId);

    const summary = `${typed.platform} draft created: genviral id=${genviralPostId}, ${typed.image_paths.length} slide(s)`;
    console.log(`[genviral_create_draft] ${ctx.agentName} ${summary}`);
    console.log(`[genviral_create_draft] raw response keys: ${Object.keys(rawResp).join(",")}`);

    await audit({
      toolName, agentId: ctx.agentId,
      argsForAudit: {
        account_id: typed.account_id,
        platform: typed.platform,
        slide_count: typed.image_paths.length,
        caption_preview: typed.caption.slice(0, 100),
      },
      resultSummary: summary,
      resultFull: { draft_id: draftId, genviral_post_id: genviralPostId, post_mode: postMode, image_urls: publicUrls, raw_response: rawResp },
      success: true, errorMessage: null,
      durationMs: Date.now() - start,
      triggeredByDmId: ctx.triggeredByDmId ?? null,
    });

    const nextStep = typed.platform === "tiktok"
      ? "Open TikTok app → Drafts → the post is there. Pick a trending sound, tweak the caption if needed, publish."
      : "Open Instagram app → notification will show the scheduled draft. Review, approve, publish.";

    return {
      toolName,
      content: [
        `Draft created on ${typed.platform}.`,
        `Genviral post id: ${genviralPostId}`,
        `Headcount draft id: ${draftId}`,
        `Slides uploaded: ${typed.image_paths.length}`,
        typed.audio_suggestion ? `Suggested audio: ${typed.audio_suggestion}` : "",
        "",
        `Next step for the CEO: ${nextStep}`,
      ].filter(Boolean).join("\n"),
      isError: false,
      structuredPayload: {
        draft_id: draftId,
        genviral_post_id: genviralPostId,
        platform: typed.platform,
        post_mode: postMode,
        image_urls: publicUrls,
      },
    };
  },
};

// ============================================================================
// Tool: genviral_check_status
// ============================================================================

export const genviralCheckStatusTool: Tool = {
  real_action: true,
  definition: {
    name: "genviral_check_status",
    description:
      "Check the current status of a draft you created earlier via genviral_create_draft. Use when the CEO asks 'did my TikTok post go up yet?' or before following up on a pending draft. Updates our internal social_drafts record if the status changed.",
    input_schema: {
      type: "object",
      properties: {
        genviral_post_id: { type: "string", description: "The id returned by genviral_create_draft" },
      },
      required: ["genviral_post_id"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const toolName = "genviral_check_status";
    const start = Date.now();
    const ctx = context as ToolExecutionContext;
    const postId = typeof input.genviral_post_id === "string" ? input.genviral_post_id : "";

    if (!postId) return { toolName, content: "Error: genviral_post_id is required.", isError: true };

    const r = await genviralFetch<{ id: string; status: string; published_url?: string; error?: string }>(`/posts/${encodeURIComponent(postId)}`);
    if (!r.ok) {
      return { toolName, content: `Genviral status check failed: ${r.error}`, isError: true };
    }

    const remoteStatus = r.data.status.toLowerCase();
    const mapped =
      remoteStatus === "published" || remoteStatus === "live"
        ? "published"
        : remoteStatus === "failed" || remoteStatus === "error"
          ? "error"
          : remoteStatus === "draft" || remoteStatus === "pending" || remoteStatus === "uploaded"
            ? "uploaded"
            : "uploaded";

    const patch: Record<string, unknown> = { status: mapped, updated_at: new Date().toISOString() };
    if (mapped === "published") {
      patch.external_url = r.data.published_url ?? null;
      patch.published_at = new Date().toISOString();
    } else if (mapped === "error") {
      patch.error_message = r.data.error ?? "unknown";
    }
    await db.from("social_drafts").update(patch).eq("genviral_post_id", postId);

    const summary = `Genviral status=${r.data.status}${r.data.published_url ? `, url=${r.data.published_url}` : ""}`;
    await audit({
      toolName, agentId: ctx.agentId,
      argsForAudit: { genviral_post_id: postId },
      resultSummary: summary,
      resultFull: r.data as unknown as Record<string, unknown>,
      success: true, errorMessage: null,
      durationMs: Date.now() - start,
      triggeredByDmId: ctx.triggeredByDmId ?? null,
    });

    return {
      toolName,
      content: [
        `Status: ${r.data.status}`,
        r.data.published_url ? `URL: ${r.data.published_url}` : "",
        r.data.error ? `Error: ${r.data.error}` : "",
      ].filter(Boolean).join("\n"),
      isError: false,
      structuredPayload: { genviral_post_id: postId, status: r.data.status, published_url: r.data.published_url ?? null },
    };
  },
};
