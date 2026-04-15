# Headcount — Pipeline & Technical Debt Tracker

**Last updated:** 2026-04-10 (Day 15.5 / Phase B)

---

## Shipped Days

| Day | Name | What shipped | Status |
|-----|------|-------------|--------|
| 1 | Foundation | Tick loop, agents table, forum, morning greeting | ✅ Shipped |
| 2a | Dashboard | CEO dashboard with Today/Company/Messages views | ✅ Shipped |
| 2b | Watercooler + Reflection | Chatter ritual, personality reflection loop | ✅ Shipped |
| 3 | Standups + CEO Brief | Daily standup ritual, CEO morning brief | ✅ Shipped |
| 4 | DM System | 1:1 DMs, dashboard send, DM responder ritual | ✅ Shipped |
| 5 | Agent Tools | web_search (Tavily), tool grants, research-tier agents | ✅ Shipped |
| 6 | Reports | Scheduled report rituals (eng roadmap, pipeline review) | ✅ Shipped |
| 7 | Org Restructure | 120 agents, named cast, dormant specialists, tiers | ✅ Shipped |
| 8 | Uncle Tan | Watercooler bot with character | ✅ Shipped |
| 9a | Tool Registry | Centralized tool registration, per-agent grants | ✅ Shipped |
| 9b | Artifacts | markdown_artifact_create, code_artifact_create, ArtifactCard | ✅ Shipped |
| 9d | Cost Controls | Hourly cost cap, daily token budgets, cost tracking | ✅ Shipped |
| 11 | Artifact Parser | parseArtifactsBlock extracted, test suite, SWC-safe | ✅ Shipped |
| 12a | Dashboard v2 | Messages view redesign, conversation rail, side panel | ✅ Shipped |
| 13 | Nanobanana | image_generate tool (Gemini 2.5 Flash), workspace image serving | ✅ Shipped |
| 14 | Delegation | dm_send, roster_lookup, project_create, Eleanor routing | ✅ Shipped |
| 14b | Truncation Fix | max_output_tokens on markdown tool, truncation loop detector, honest reply | ✅ Shipped |
| 15 | Project Context | project_members table, auto-propagation via dm_send, context injection in dm-responder, "ask don't invent" addendum | ✅ Shipped |
| 15.5 | Thread Memory | Thread history injection (last 10 messages) in dm-responder trigger prompt | ✅ Shipped |
| 16-B | Event-Driven DMs | Supabase realtime subscription on dms INSERT, guarded mutex, fallback tick | ✅ Shipping now |

---

## Active Project: Onepark Digital Website v1

**Project ID:** `1806c510-7cd0-4452-bc14-6b4d760cdf1b`
**Status:** In progress — design locked, architecture approved, bio workstream in flight

### Deliverables Tracker

| Deliverable | Owner | Status | Artifact Path |
|-------------|-------|--------|---------------|
| Design direction document | Tessa Goh | ✅ Done | `workspace/marketing/onepark-website-v1-design-direction-2026-04-09-fda6.md` |
| Sharpened Concept C spec | Tessa Goh | ✅ Done | `workspace/marketing/onepark-concept-c-sharpened-spec-2026-04-09-9ae2.md` |
| Named cast personality notes | Eleanor Vance | ✅ Done | `workspace/executive/named-cast-personality-notes-for-rina-2026-04-09-d769.md` |
| Architecture plan | Tsai Wei-Ming | ✅ Done | `workspace/engineering/onepark-website-architecture-plan-2026-04-10-ca6f.md` |
| UX flow & structure map | Michelle Pereira (via Eleanor) | ✅ Done | `workspace/executive/onepark-website-flow-structure-map-2026-04-10-6209.md` |
| Repo scaffold | Tsai Wei-Ming | ⏳ Pending — approved, not started |  |
| Homepage hero copy (3 variants) | Tessa Goh (reassigned from Rina) | ⏳ Pending |  |
| Manifesto draft (300 words) | Tessa Goh (reassigned from Rina) | ⏳ Pending |  |
| /team page bios (named cast) | Tessa Goh (intake calls in progress) | 🔄 In progress |  |
| Agent portrait generation | Heng Kok Wei | ⏸️ On hold — waiting for design lock |  |
| Faizal architecture review | Faizal Harun | ⏳ Pending — waiting for Wei-Ming's scaffold |  |

### Decisions Made

| Decision | Choice | Date |
|----------|--------|------|
| Hero concept | Concept C — Agent Introduction | 2026-04-09 |
| Supabase-backed /team and /work | Yes | 2026-04-10 |
| Contact form backend | Server action + Resend (Option A) | 2026-04-10 |
| Portrait hosting | Supabase Storage (Option A) | 2026-04-10 |
| Domain | TBD — checking availability | 2026-04-10 |

### Decisions Pending (from flow map)

| Decision | Options | Owner |
|----------|---------|-------|
| /work audience scope | Evaluator-only vs dual-serving | Shin |
| /build-log bridge to /work | Strict separation vs bridged | Shin |
| /team agent bio links | Outward to case studies vs self-contained | Shin |
| /manifesto terminal CTA | → /contact (convert) vs → /build-log (deepen) | Shin |

---

## Upcoming Days (Planned)

| Day | Name | Scope | Priority |
|-----|------|-------|----------|
| 16-C | Commitments Layer | `commitments` table, `commitment_create` tool, stall detection ritual, auto-resolution on artifact creation | High — fixes the "agents commit but don't follow through" stall pattern |
| 16-D | Dashboard: Workbench Tab | Artifact browser, cost panel, project view, debug DMs | Medium — CEO visibility into what's happening |
| 16-E | Dashboard: Company Tab | Forum viewer, watercooler, weekly reports, agent roster browse | Low — nice to have, not blocking |
| 17 | Agent Working Memory | Refactor dm-responder context blocks into a clean abstraction instead of piling layers | Medium — architectural hygiene before more context blocks get added |

---

## Technical Debt

| Item | Severity | Where | Notes |
|------|----------|-------|-------|
| `chatter.ts` has 9 tsc errors (chosen possibly undefined) | Low | `apps/orchestrator/src/rituals/chatter.ts` | Pre-existing since Day 2b. Doesn't affect runtime. Fix: add null checks. |
| `runner.ts` has 3 tsc errors (cache_control on TextBlockParam) | Low | `apps/orchestrator/src/agents/runner.ts` | SDK type drift. Works at runtime. Fix: `// @ts-expect-error` or SDK bump. |
| Wei-Ming daily roadmap fires on Opus ($0.12/pop) even when no project work is happening | Medium | `report-runner` ritual config | 4 duplicate roadmaps yesterday. Consider making it conditional on active projects or reducing to Sonnet. |
| Eleanor hits daily token budget mid-project routing | High | `agents.daily_token_budget` | Hit twice in one day. 200k may not be enough for directors doing heavy routing. Consider 500k or dynamic budget that scales with active projects. |
| Specialists (Michelle, Faizal, Choi Seung-hyun) also hit budget | Medium | `agents.daily_token_budget` | Fixed by manual SQL. Need to ensure all project-pulled specialists get bumped automatically. |
| No cleanup mechanism for old project members | Low | `project_members` table | Projects accumulate members forever. Add cleanup when projects are completed/cancelled. |
| DM responder SKIP costs $0.01-$0.02 per agent per SKIP | Medium | `dm-responder.ts` | Eleanor pays $0.02 just to decide "SKIP" on a message that doesn't need a reply. At scale this adds up. Consider a cheaper pre-filter (Haiku for SKIP detection, Sonnet for actual replies). |
| No dashboard Projects view | Medium | Dashboard | CEO can't see project status, members, or artifacts in the UI. SQL only. |
| Agents don't auto-retry after runner-killed loops | Low | `runner.ts` | If a truncation loop kills an agent's turn, the DM is marked read but no re-trigger happens. Manual re-poke required. |
| `dms` table has no `project_id` column | Low | Schema | Day 15 rejected this (Version C). Revisit if cross-thread project history becomes needed. |
| No delegation depth tracking | Low | `dms` table metadata | Deferred since Day 14. No observed need yet. |

---

## Lessons Learned (running log)

1. **Cost cap bursts are real.** Project kickoffs are 5-10× steady-state spend. $0.50/hr cap was way too low. $20/hr is workable.
2. **Director daily token budgets need to be higher for project work.** 200k may not be enough. Eleanor hit budget twice in one day.
3. **Agents are reactive, not proactive.** They only act on incoming DMs or scheduled rituals. Commitments without triggers produce stalls.
4. **Confabulation is the biggest structural risk.** When agents lack context, they invent plausible alternatives. Agent-to-agent confabulation is worse than agent-to-human because agents don't push back.
5. **Thread memory is essential for multi-turn exchanges.** Without it, agents forget what they said 30 seconds ago.
6. **Project context injection prevents project-level confabulation.** Day 15 fixed the "inventing a phantom org study" failure mode.
7. **The "Eleanor as cron job" pattern works but doesn't scale.** Event-driven DM processing (Day 16-B) + commitments (Day 16-C) is the real fix.
8. **Tessa has real taste and will defend design decisions.** She pushed back on warm minimalism, enforced the two-weight Inter rule, and chose the hero copy herself. That's the frozen_core working.
9. **Wei-Ming does real research before committing.** He web-searched Next.js 15 MDX support, Tailwind v4 config changes, and Supabase SSR patterns before writing the architecture plan. The code_artifact tools + web_search combo produces consultant-grade output.
10. **Eleanor's coaching rounds are genuinely useful.** Her advice to Rina ("one clean round beats three messy ones") and Faizal ("flag severity, not just issues") demonstrates emergent management quality from the frozen_core + learned_addendum system.
