# Headcount — Pipeline & Technical Debt Tracker

**Last updated:** 2026-04-10 (Day 18.5)

---

## Shipped Days (26 builds)

| Day | Name | What shipped |
|-----|------|-------------|
| 1 | Foundation | Tick loop, agents table, forum, morning greeting |
| 2a | Dashboard | CEO dashboard with Today/Company/Messages views |
| 2b | Watercooler + Reflection | Chatter ritual, personality reflection loop |
| 3 | Standups + CEO Brief | Daily standup ritual, CEO morning brief |
| 4 | DM System | 1:1 DMs, dashboard send, DM responder ritual |
| 5 | Agent Tools | web_search (Tavily), tool grants, research-tier agents |
| 6 | Reports | Scheduled report rituals (eng roadmap, pipeline review) |
| 7 | Org Restructure | 120 agents, named cast, dormant specialists, tiers |
| 8 | Uncle Tan | Watercooler bot with character |
| 9a | Tool Registry | Centralized tool registration, per-agent grants |
| 9b | Artifacts | markdown_artifact_create, code_artifact_create, ArtifactCard |
| 9d | Cost Controls | Hourly cost cap, daily token budgets, cost tracking |
| 11 | Artifact Parser | parseArtifactsBlock extracted, test suite, SWC-safe |
| 12a | Dashboard v2 | Messages view redesign, conversation rail, side panel |
| 13 | Nanobanana | image_generate tool (Gemini 2.5 Flash), workspace image serving |
| 14 | Delegation | dm_send, roster_lookup, project_create, Eleanor routing |
| 14b | Truncation Fix | max_output_tokens on markdown tool, truncation loop detector |
| 15 | Project Context | project_members table, auto-propagation, context injection |
| 15.5 | Thread Memory | Thread history injection (last 10 messages) in dm-responder |
| 16-B | Event-Driven DMs | Supabase realtime on dms INSERT, guarded mutex |
| 17 | Project Channels | project_messages, project_post, project-responder, Haiku pre-filter, artifact auto-announce, backfill |
| 17.5 | Dashboard Channels | Meeting Rooms tab, CEO posts from UI, GET/POST API routes |
| 18 | Commitments | commitments table, commitment_create tool, stall-detector (5-min, 3 nudges), auto-resolve on artifact |
| 18.5 | Imagen 4 | imagen_generate tool, photorealistic images, personGeneration: ALLOW_ALL |

---

## Upcoming Days

| Day | Name | Scope | Priority |
|-----|------|-------|----------|
| 19 | Agent Vision | Inject workspace images into agent context as base64 so they can review visual assets | **High** — biggest UX gap |
| 19.5 | Dashboard Projects Tab | Project metadata, members, commitments, channel stats in UI | Medium |
| 20 | Roadmap Confabulation Fix | Scope Wei-Ming's roadmap to actual work, stop fictional CVE/migration posts, block roadmap auto-post to channels | **High** — spreads false info |
| 21 | Proactive Work Detection | Auto-trigger agents when artifact dependencies land (Phase 3 of meeting room) | **High** — the "agents react to dependencies" feature |
| 22 | DM SKIP Pre-filter | Haiku pre-filter before full Sonnet call in dm-responder | Medium — cost saving |
| 23 | Dashboard Workbench | Artifact browser, cost panel, agent roster | Medium |
| 24 | Agent Working Memory Refactor | Clean abstraction for context injection layers | Medium |
| 25 | Persistent Project Heartbeat | Slow tick per active project, proactive agent turns | Medium |

---

## Technical Debt

### Critical

| Item | Impact | Notes |
|------|--------|-------|
| **Eleanor confabulates roster data** | Invented 8 fake agents | "Ask don't invent" isn't enough. Need hard rule: "NEVER list agents without calling roster_lookup." |
| **Wei-Ming roadmap confabulates** | Invented CVE, migration, hire asks | Roadmap generates plausible fiction. Disable auto-post to channels or scope to actual project work. |
| **Agents can't see images** | CEO must relay all visual feedback | Day 19 fix: base64 image injection into context. |

### Medium

| Item | Impact |
|------|--------|
| Wei-Ming roadmap fires on Opus multiple times/day | ~$1/day wasted |
| DM SKIP costs $0.02/agent (full Sonnet call) | Adds up at scale |
| Specialists hit token budget during project work | Manual SQL fix each time |
| Eleanor hits budget during heavy routing | 200k not enough for directors |
| 12 pre-existing tsc errors (chatter.ts + runner.ts) | No runtime impact |
| Artifact UUID parse — Eleanor passed short ID "b3cc" | Need input validation |

### Low

| Item |
|------|
| No cleanup for old project members |
| No delegation depth tracking on DMs |
| No auto-retry after truncation loop kills |
| Dashboard channel view has no image previews |
| No dashboard project metadata view |

---

## Cost Optimizations

| Item | Status | Savings |
|------|--------|---------|
| Haiku pre-filter for meeting room turns | ✅ Done (Day 17) | ~70% less per round |
| Move Wei-Ming roadmap to Sonnet | ⏳ Pending | ~$0.50/day |
| Reduce roadmap frequency to once/day | ⏳ Pending | ~$0.50/day |
| Haiku pre-filter for DM SKIPs | ⏳ Pending | $0.02/SKIP |
| Auto-bump specialist budgets on project join | ⏳ Pending | Prevents manual SQL |
| Batch API for scheduled rituals | ⏳ Future | 50% off async work |
| Prompt caching audit | ⏳ Future | Up to 90% off repeats |

---

## Lessons Learned

1. **Confabulation is the #1 structural risk.** Eleanor faked 8 names. Wei-Ming faked a CVE. Prompts alone don't prevent it — tool enforcement is needed.
2. **Meeting rooms produce real coordination.** Agents reference each other's work, catch edge cases independently, correct each other's mistakes.
3. **Agents talk about work instead of doing it.** Rina said "within the hour" 3 times. Commitments layer + direct nudges are the fix.
4. **Image model matters enormously.** Nano Banana = cartoonish. Imagen 4 = photorealistic. Same API key, different model.
5. **CEO is the visual bottleneck.** Agents can't see images until Day 19.
6. **Cost cap bursts are real.** Project kickoffs cost 5-10× steady state. $20/hr cap is workable.
7. **Directors need higher token budgets for project work.** 200k isn't enough.
8. **Tessa and Eleanor both handle corrections well.** Character integrity from frozen_core works as designed.
