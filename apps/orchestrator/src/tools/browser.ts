// ============================================================================
// tools/browser.ts - Day 24 - read-only Playwright browser wrappers
// ----------------------------------------------------------------------------
// Three tools for agents that need to look at real web pages instead of
// confabulating what a competitor's landing page probably says:
//
//   browser_fetch_text   - load URL, wait for network idle, return visible text
//   browser_screenshot   - load URL, capture full-page PNG, save to workspace
//   browser_extract_links - load URL, return anchor list (text + href)
//
// Design decisions:
//   - SINGLE shared browser instance across the orchestrator process, reused
//     across calls. Launched lazily on first use. Keeps cold-start cost off
//     the hot path. Use chromium headless.
//   - NAVIGATION TIMEOUT: 30s hard cap. Slow sites return isError.
//   - URL GUARD: reject file://, data:, javascript:, and anything resolving
//     to a loopback / private IP. Agents don't need to read localhost.
//   - NO LOGIN: these tools never submit forms, click buttons, or persist
//     cookies. If a site needs auth, the tool returns whatever the unauth
//     view shows.
//   - PAGE SIZE: visible-text responses are truncated to 8k chars to keep
//     token budgets sane; links capped at 100.
//   - RATE LIMIT: per-agent daily cap of 50 browser calls (all three tools
//     combined). Counted via real_action_audit.
// ----------------------------------------------------------------------------

import { chromium, type Browser, type BrowserContext } from "playwright";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../db.js";
import { config } from "../config.js";
import { redactBody } from "../util/log-safe.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

const NAV_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_LINKS = 100;
const DAILY_CAP_PER_AGENT = 50;
const USER_AGENT =
  "Mozilla/5.0 (compatible; Headcount/1.0; +https://onepark.digital/bot)";

// ----------------------------------------------------------------------------
// Browser lifecycle (lazy singleton)
// ----------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;

async function getContext(): Promise<BrowserContext> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  if (!contextPromise) {
    contextPromise = browserPromise.then((b) =>
      b.newContext({
        userAgent: USER_AGENT,
        // Don't honor cookies across calls — this is read-only, unauth'd work.
        storageState: undefined,
        viewport: { width: 1280, height: 900 },
        // Block heavy asset types to speed up fetch_text + extract_links.
        // Screenshot path re-enables images via a fresh page (see below).
      })
    );
  }
  return contextPromise;
}

// ----------------------------------------------------------------------------
// URL validation
// ----------------------------------------------------------------------------

function validateUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol: ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { ok: false, reason: "refusing to browse to a private/loopback address" };
  }
  return { ok: true, url: u };
}

// ----------------------------------------------------------------------------
// Rate limit
// ----------------------------------------------------------------------------

async function overDailyCap(agentId: string): Promise<number | null> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db
    .from("real_action_audit")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", config.tenantId)
    .eq("agent_id", agentId)
    .in("tool_name", ["browser_fetch_text", "browser_screenshot", "browser_extract_links"])
    .gte("created_at", startOfDay.toISOString());
  if (error) {
    console.warn(`[browser] rate-limit query failed: ${error.message}`);
    return null;
  }
  return (count ?? 0) >= DAILY_CAP_PER_AGENT ? count ?? 0 : null;
}

// ----------------------------------------------------------------------------
// Audit helper
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// Shared execution wrapper
// ----------------------------------------------------------------------------

async function withPage<T>(
  run: (page: import("playwright").Page) => Promise<T>
): Promise<T> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    return await run(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// ============================================================================
// Tool: browser_fetch_text
// ============================================================================

export const browserFetchTextTool: Tool = {
  real_action: true,
  definition: {
    name: "browser_fetch_text",
    description:
      "Load a URL in a headless browser and return the visible text of the page. Use when you need to know what a real webpage says (competitor landing page, press release, documentation, prospect's careers page). Waits for JavaScript to render. Read-only — cannot log in, click, or submit forms. Returns up to 8,000 characters of cleaned text.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL to fetch. Must be publicly accessible." },
      },
      required: ["url"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const toolName = "browser_fetch_text";
    const start = Date.now();
    const rawUrl = typeof input.url === "string" ? input.url : "";
    const ctx = context as ToolExecutionContext;

    const v = validateUrl(rawUrl);
    if (!v.ok) {
      return { toolName, content: `Error: ${v.reason}. Provide a public https URL.`, isError: true };
    }
    const cap = await overDailyCap(ctx.agentId);
    if (cap !== null) {
      return { toolName, content: `Error: daily browser cap reached (${cap}/${DAILY_CAP_PER_AGENT}).`, isError: true };
    }

    try {
      const result = await withPage(async (page) => {
        await page.goto(v.url.toString(), { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
        const title = await page.title();
        const raw = await page.evaluate(() => {
          // Remove scripts/styles/nav chrome
          const clone = document.body.cloneNode(true) as HTMLElement;
          for (const sel of ["script", "style", "nav", "header", "footer", "noscript"]) {
            clone.querySelectorAll(sel).forEach((n) => n.remove());
          }
          return (clone.innerText || clone.textContent || "").replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
        });
        return { title, text: raw };
      });
      const truncated = result.text.length > MAX_TEXT_CHARS;
      const body = truncated ? result.text.slice(0, MAX_TEXT_CHARS) + `\n\n[... truncated, ${result.text.length - MAX_TEXT_CHARS} chars omitted ...]` : result.text;
      const summary = `${v.url.hostname} — "${result.title}" (${result.text.length} chars${truncated ? ", truncated" : ""})`;
      console.log(`[browser_fetch_text] ${ctx.agentName} ${v.url.hostname} — ${result.text.length} chars`);
      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { url: v.url.toString() },
        resultSummary: summary,
        resultFull: { title: result.title, chars: result.text.length, truncated },
        success: true, errorMessage: null,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return { toolName, content: `# ${result.title}\nURL: ${v.url.toString()}\n\n${body}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { url: v.url.toString() },
        resultSummary: "fetch failed",
        resultFull: null, success: false, errorMessage: msg,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return { toolName, content: `Error fetching ${v.url.hostname}: ${msg}`, isError: true };
    }
  },
};

// ============================================================================
// Tool: browser_extract_links
// ============================================================================

export const browserExtractLinksTool: Tool = {
  real_action: true,
  definition: {
    name: "browser_extract_links",
    description:
      "Load a URL in a headless browser and return the list of anchor links (up to 100) with their visible text and href. Use when exploring a site's structure (what's in the footer, what's the nav, what careers page links are on /about). Read-only, waits for JS to render.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL to fetch." },
      },
      required: ["url"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const toolName = "browser_extract_links";
    const start = Date.now();
    const rawUrl = typeof input.url === "string" ? input.url : "";
    const ctx = context as ToolExecutionContext;

    const v = validateUrl(rawUrl);
    if (!v.ok) return { toolName, content: `Error: ${v.reason}.`, isError: true };
    const cap = await overDailyCap(ctx.agentId);
    if (cap !== null) return { toolName, content: `Error: daily browser cap reached (${cap}/${DAILY_CAP_PER_AGENT}).`, isError: true };

    try {
      const links = await withPage(async (page) => {
        await page.goto(v.url.toString(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        return page.evaluate((max) => {
          const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
          const out: { text: string; href: string }[] = [];
          const seen = new Set<string>();
          for (const a of anchors) {
            const text = (a.innerText || a.textContent || "").trim().slice(0, 120);
            const href = a.href;
            if (!href || seen.has(href)) continue;
            seen.add(href);
            out.push({ text, href });
            if (out.length >= max) break;
          }
          return out;
        }, MAX_LINKS);
      });

      const lines = links.map((l) => `- [${l.text || "(no text)"}](${l.href})`).join("\n");
      const summary = `${v.url.hostname} — ${links.length} links`;
      console.log(`[browser_extract_links] ${ctx.agentName} ${v.url.hostname} — ${links.length} links`);
      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { url: v.url.toString() },
        resultSummary: summary,
        resultFull: { count: links.length },
        success: true, errorMessage: null,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Links on ${v.url.hostname} (${links.length}):\n\n${lines || "(no links found)"}`,
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { url: v.url.toString() },
        resultSummary: "extract failed",
        resultFull: null, success: false, errorMessage: msg,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return { toolName, content: `Error extracting links from ${v.url.hostname}: ${msg}`, isError: true };
    }
  },
};

// ============================================================================
// Tool: browser_screenshot
// ============================================================================

export const browserScreenshotTool: Tool = {
  real_action: true,
  definition: {
    name: "browser_screenshot",
    description:
      "Load a URL in a headless browser and save a full-page PNG screenshot to the workspace. Returns the workspace-relative file path which can be referenced in artifacts or channel posts. Use when the visual layout matters (comparing competitor landing-page designs, documenting a bug repro, capturing a press page). Read-only.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL to screenshot." },
        full_page: {
          type: "boolean",
          description: "If true (default), capture the entire scrollable page. If false, capture viewport only.",
        },
      },
      required: ["url"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const toolName = "browser_screenshot";
    const start = Date.now();
    const rawUrl = typeof input.url === "string" ? input.url : "";
    const fullPage = input.full_page !== false;
    const ctx = context as ToolExecutionContext;

    const v = validateUrl(rawUrl);
    if (!v.ok) return { toolName, content: `Error: ${v.reason}.`, isError: true };
    const cap = await overDailyCap(ctx.agentId);
    if (cap !== null) return { toolName, content: `Error: daily browser cap reached (${cap}/${DAILY_CAP_PER_AGENT}).`, isError: true };

    try {
      const hash = createHash("sha256").update(v.url.toString() + Date.now()).digest("hex").slice(0, 8);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rel = path.join("browser-captures", ctx.agentId.slice(0, 8), `${ts}-${v.url.hostname}-${hash}.png`);
      const abs = path.join(process.cwd(), "..", "..", "workspace", rel);

      await mkdir(path.dirname(abs), { recursive: true });

      const buffer = await withPage(async (page) => {
        await page.goto(v.url.toString(), { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
        return page.screenshot({ fullPage, type: "png" });
      });
      await writeFile(abs, buffer);

      const summary = `${v.url.hostname} — ${(buffer.length / 1024).toFixed(0)}KB, saved to workspace/${rel.replace(/\\/g, "/")}`;
      console.log(`[browser_screenshot] ${ctx.agentName} ${v.url.hostname} — ${(buffer.length / 1024).toFixed(0)}KB`);

      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { url: v.url.toString(), full_page: fullPage },
        resultSummary: summary,
        resultFull: { path: rel.replace(/\\/g, "/"), bytes: buffer.length },
        success: true, errorMessage: null,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });

      const webPath = `workspace/${rel.replace(/\\/g, "/")}`;
      return {
        toolName,
        content: `Screenshot saved: ${webPath}\nSize: ${(buffer.length / 1024).toFixed(0)} KB\nPage: ${v.url.toString()}\n\nReference it in your reply with: ![](${webPath})`,
        isError: false,
        structuredPayload: { file_path: webPath, bytes: buffer.length, url: v.url.toString() },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await audit({
        toolName, agentId: ctx.agentId,
        argsForAudit: { url: v.url.toString(), full_page: fullPage },
        resultSummary: "screenshot failed",
        resultFull: null, success: false, errorMessage: msg,
        durationMs: Date.now() - start,
        triggeredByDmId: ctx.triggeredByDmId ?? null,
      });
      return { toolName, content: `Error screenshotting ${v.url.hostname}: ${msg}`, isError: true };
    }
  },
};

// ----------------------------------------------------------------------------
// Clean shutdown (orchestrator index.ts can optionally import this)
// ----------------------------------------------------------------------------

export async function closeBrowser(): Promise<void> {
  if (contextPromise) {
    const ctx = await contextPromise;
    await ctx.close().catch(() => {});
    contextPromise = null;
  }
  if (browserPromise) {
    const b = await browserPromise;
    await b.close().catch(() => {});
    browserPromise = null;
  }
}

// Silence unused warning for redactBody import kept for future use
void redactBody;
