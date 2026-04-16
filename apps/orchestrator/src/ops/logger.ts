// ============================================================================
// ops/logger.ts - structured JSON logger via pino
// ----------------------------------------------------------------------------
// One-line-per-event JSON logging that PM2 captures to logs/orchestrator.out.log
// in a format any cloud log backend (Axiom, Better Stack, Grafana Cloud, Loki)
// can ingest and index. Each event has a stable `event` field and structured
// fields beyond that — so you can later query "show me every dm_responder
// event for agent_name='Siti Nurhaliza' between 02:00 and 03:00 UTC" without
// regex-spelunking through stdout.
//
// Existing console.log/warn/error calls keep working — they go to stdout
// unchanged, just unstructured. The point of this module is to give NEW
// code paths (and gradually retrofit hot ones) a structured channel.
//
// Helpers:
//   logger              raw pino instance, use logger.info({ ... }, "msg")
//   logAgent(...)       agent-scoped event with consistent fields
//   logRitual(...)      ritual lifecycle event
//   logCost(...)        cost-tracking event (alerts, circuit trips)
//   logTool(...)        tool invocation event
//
// To ship to Axiom (or any other backend), point pm2-logrotate at the JSON
// log file and pipe it via the vendor's agent. Or swap the transport here
// for `pino-axiom` once you have a token.
// ============================================================================

import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  // Structured JSON in prod (PM2 / cloud backends parse this); pretty
  // human-readable in dev.
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino/file",
          options: { destination: 1 }, // stdout, no transport thread
        },
      }),
  base: {
    service: "headcount-orchestrator",
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ----------------------------------------------------------------------------
// Convenience helpers — these set a stable `event` field so log queries
// can group by event type without parsing the message string.
// ----------------------------------------------------------------------------

export function logAgent(
  event: string,
  fields: { agent_id?: string; agent_name?: string; tier?: string; [k: string]: unknown },
  msg?: string
): void {
  logger.info({ event: `agent.${event}`, ...fields }, msg ?? event);
}

export function logRitual(
  event: string,
  fields: { ritual?: string; [k: string]: unknown },
  msg?: string
): void {
  logger.info({ event: `ritual.${event}`, ...fields }, msg ?? event);
}

export function logCost(
  event: string,
  fields: { spend?: number; cap?: number; [k: string]: unknown },
  msg?: string
): void {
  logger.warn({ event: `cost.${event}`, ...fields }, msg ?? event);
}

export function logTool(
  event: string,
  fields: { tool?: string; agent_name?: string; ok?: boolean; duration_ms?: number; [k: string]: unknown },
  msg?: string
): void {
  logger.info({ event: `tool.${event}`, ...fields }, msg ?? event);
}
