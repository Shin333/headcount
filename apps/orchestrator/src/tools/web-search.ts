import type { Tool, ToolResult } from "./types.js";
import { env } from "../config.js";
import { cacheGet, cacheSet } from "./cache.js";

// ----------------------------------------------------------------------------
// tools/web-search.ts - web_search tool, backed by Tavily (Day 5)
// ----------------------------------------------------------------------------
// Tavily is the de-facto AI agent web search backend. Free tier: 1000/month.
// Returns clean snippets, no HTML parsing required.
//
// API docs: https://docs.tavily.com/docs/rest-api/api-reference
// Endpoint: POST https://api.tavily.com/search
// Auth: api_key in request body (not header)
// ----------------------------------------------------------------------------

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 3;
const MAX_SNIPPET_CHARS = 500;

// ---- Tool definition (what the model sees) ----------------------------------

const definition = {
  name: "web_search",
  description:
    "Search the web for current information. Use this when you need to verify a specific factual claim, check recent news or events, or look up something that happened recently. Do NOT use this for opinions, internal company knowledge, or things you can reasonably know without searching. Returns up to 3 results with title, URL, and a short snippet from each. Always cite the URL when you use information from a result.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          "The search query. Be specific and concrete. Good: 'Singapore IRAS GST rate 2025'. Bad: 'taxes'.",
      },
    },
    required: ["query"],
  },
};

// ---- Executor ---------------------------------------------------------------

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
  answer?: string;
  query?: string;
}

async function executor(input: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof input.query === "string" ? input.query.trim() : "";

  if (!query) {
    return {
      toolName: "web_search",
      content: "Error: query is required and must be a non-empty string.",
      isError: true,
    };
  }

  if (!env.TAVILY_API_KEY) {
    return {
      toolName: "web_search",
      content:
        "Error: web_search is not configured. The TAVILY_API_KEY environment variable is missing on the server.",
      isError: true,
    };
  }

  // Day 5.3: cache check before live Tavily call
  const cached = await cacheGet({ toolName: "web_search", cacheKey: query });
  if (cached !== null) {
    console.log(`[tool:web_search] CACHE HIT for "${query}"`);
    return {
      toolName: "web_search",
      content: cached,
      isError: false,
      cacheHit: true,
    };
  }

  console.log(`[tool:web_search] querying Tavily: "${query}"`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: MAX_RESULTS,
        include_answer: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => "(no body)");
      console.error(`[tool:web_search] Tavily HTTP ${response.status}: ${errText}`);
      return {
        toolName: "web_search",
        content: `Error: Tavily API returned HTTP ${response.status}. The search could not be completed. Please retry or proceed without search results.`,
        isError: true,
      };
    }

    const data = (await response.json()) as TavilyResponse;
    const results = data.results ?? [];

    if (results.length === 0) {
      return {
        toolName: "web_search",
        content: `No results found for query: "${query}". Try a different query or proceed without search results.`,
        isError: false,
      };
    }

    // Format results - truncate snippets to control cost
    const formatted = results
      .slice(0, MAX_RESULTS)
      .map((r, i) => {
        const title = r.title ?? "(untitled)";
        const url = r.url ?? "(no url)";
        const snippet = (r.content ?? "").slice(0, MAX_SNIPPET_CHARS);
        const truncated = (r.content?.length ?? 0) > MAX_SNIPPET_CHARS ? "..." : "";
        return `Result ${i + 1}:\nTitle: ${title}\nURL: ${url}\nSnippet: ${snippet}${truncated}`;
      })
      .join("\n\n");

    console.log(`[tool:web_search] returned ${results.length} results for "${query}"`);

    const fullContent = `Search results for "${query}":\n\n${formatted}\n\nRemember to cite the URL when you use information from these results.`;

    // Day 5.3: cache the successful result for 1 hour (default TTL)
    // Only cache successes - errors and empties bypass the cache so they retry
    await cacheSet({
      toolName: "web_search",
      cacheKey: query,
      resultContent: fullContent,
    });

    return {
      toolName: "web_search",
      content: fullContent,
      isError: false,
      cacheHit: false,
    };
  } catch (err) {
    clearTimeout(timer);
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errMsg.includes("aborted");
    console.error(`[tool:web_search] failed: ${errMsg}`);
    return {
      toolName: "web_search",
      content: isTimeout
        ? `Error: web_search timed out after ${REQUEST_TIMEOUT_MS}ms. Proceed without search results.`
        : `Error: web_search failed: ${errMsg}. Proceed without search results.`,
      isError: true,
    };
  }
}

// ---- Exported tool ----------------------------------------------------------

export const webSearchTool: Tool = {
  definition,
  executor,
};
