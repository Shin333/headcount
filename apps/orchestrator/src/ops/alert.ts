// ============================================================================
// ops/alert.ts — Operator alerting (2026-07-14 fleet-model fix).
//
// A single visible-alert primitive for the dispatcher. Always logs at error
// level; additionally pushes a Telegram message when TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID are present in the environment. No secret is hardcoded — if
// the env vars are absent the alert degrades to a structured log line, so this
// is safe to ship without wiring credentials first.
//
// Used when the Codex failover volume cap trips (a sustained Claude outage that
// would otherwise drain the ChatGPT quota) so Shin finds out immediately rather
// than via a surprise bill.
// ============================================================================

import { logger } from "./logger.js";

export async function alertOperator(
  event: string,
  message: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  // Structured log is the durable record; the Telegram push is best-effort.
  logger.error({ event, ...meta }, message);

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚠️ dispatcher: ${message}`,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      logger.warn(
        { event: "dispatcher.alert_telegram_failed", status: res.status },
        "Telegram alert POST returned non-2xx",
      );
    }
  } catch (e) {
    // Never let alerting failure crash the worker.
    logger.warn(
      { event: "dispatcher.alert_telegram_error", err: (e as Error).message },
      "Telegram alert POST threw",
    );
  }
}
