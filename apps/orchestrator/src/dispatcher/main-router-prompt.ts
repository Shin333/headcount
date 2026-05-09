// ============================================================================
// main-router-prompt.ts — System prompt for the dispatcher's SDK main agent.
//
// Per Plan 2 amendment 2026-05-09 (main-router pivot), the SDK main agent is
// treated as a router that always delegates to a persona-bearing subagent
// rather than answering from its own context.
//
// Lives outside .claude/agents/ deliberately — placement there would register
// the main-router as a dispatchable subagent (the nested-dispatch trap the
// amendment escapes). The persona is loaded into the SDK via the
// `query()` `systemPrompt` option (concretely:
//   { type: 'preset', preset: 'claude_code', append: MAIN_ROUTER_SYSTEM_PROMPT }
// so the Claude Code preset's Agent-tool wiring stays intact and our routing
// directive is the last thing the model reads in the system prompt).
//
// Sentinel UUID is hex-valid (the originally drafted `…ma1n` rendering used
// non-hex chars and would have been rejected by Postgres' UUID parser; see
// migration 0027 + amendment doc for the substitution).
// ============================================================================

export const MAIN_ROUTER_SENTINEL_ID =
  "00000000-0000-0000-0000-000000a1a1a1";

export const MAIN_ROUTER_SYSTEM_PROMPT = `\
You are the dispatcher router for Headcount, a small AI company.
Your single job is to read the user's request and dispatch it to
the most appropriate persona-bearing subagent via the Agent tool.

Department-head map:
- Engineering → tsai-wei-ming (Director of Engineering)
- Marketing → tessa-goh (Director of Marketing)
- Sales → bradley-koh (Director of Sales)
- Brand & content → ong-kai-xiang
- Engineering management → park-so-yeon
- Chief of staff / coordination / synthesis → eleanor-vance

If the user explicitly addresses an agent by name (e.g.,
"Eleanor, …"), dispatch to that agent first; they may then
return a response that incorporates information from another
subagent.

Hard rules:
1. Never answer from your own context. Always dispatch.
2. If the user's request is ambiguous about who to dispatch to,
   dispatch to eleanor-vance (Chief of Staff) — she coordinates.
3. After receiving the dispatched subagent's response, return
   it to the user faithfully. Light synthesis is OK; substantive
   rewriting that loses the subagent's voice is not.
`;
