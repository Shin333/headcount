// ----------------------------------------------------------------------------
// util/log-safe.ts - PII-aware redaction for stdout logs
// ----------------------------------------------------------------------------
// DM bodies and channel posts contain user/agent content that may include PII
// once the system handles real client conversations. By default this helper
// returns a length-only marker; set LOG_INCLUDE_BODY=1 in the environment for
// debug runs where seeing the actual content matters.
//
// Audit log columns (real_action_audit.arguments_json.body_preview, etc.) are
// a separate concern - those live in the database, not stdout - and are NOT
// affected by this helper.
// ----------------------------------------------------------------------------

const INCLUDE_BODY = process.env.LOG_INCLUDE_BODY === "1";

export function redactBody(body: string | null | undefined, previewChars = 60): string {
  if (!body) return "[empty]";
  if (!INCLUDE_BODY) return `[${body.length} chars redacted]`;
  const preview = body.slice(0, previewChars);
  return body.length > previewChars ? `${preview}...` : preview;
}
