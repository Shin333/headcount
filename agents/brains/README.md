# Agent brains

This directory holds persistent memory for each AI agent in the company. One file per agent, named by slug (matching `.claude/agents/<slug>.md`).

## Curation

The nightly learning ritual (Phase 4, runs at 02:00 daily) reads each agent's recent project work from the database and updates the corresponding brain file. Updates are append-and-reorganize, not replace.

## Reading

Each agent reads its own brain at the start of every project Eleanor delegates to it. The brain provides context the agent has learned over time — preferences, patterns, lessons, open questions.

## Manual edits

Hand edits are allowed and preserved. The nightly ritual reorganizes content but does not delete user-authored material. If you want to seed an agent with specific knowledge, edit its brain file directly.

## Bootstrap

Brain files are bootstrapped by `apps/orchestrator/src/migrations/foundation/bootstrap-brains.ts` (Phase 1 Task 3.1). The script is idempotent: re-running skips any brain that already exists.
