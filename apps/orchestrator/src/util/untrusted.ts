// ----------------------------------------------------------------------------
// util/untrusted.ts - tag wrapper for prompt-injection defense
// ----------------------------------------------------------------------------
// Any text written by another agent, by a human counterparty, or by the
// outside world is *data*, not instructions. We wrap it in <untrusted_*>
// tags before interpolating into a prompt. The system prompt (personality.ts)
// has a corresponding rule telling the model to treat tagged content as
// content, not commands.
//
// Defense in depth: we also neutralize close-tag attempts in the body so a
// hostile message body cannot terminate the envelope and start emitting
// instruction-shaped text outside the tag.
// ----------------------------------------------------------------------------

const CLOSE_TAG_NEUTRALIZED = "<\u200B/untrusted_";

/**
 * Wrap untrusted text in a labeled envelope. `kind` becomes the tag name
 * (`dm_body`, `channel_post`, `artifact_title`, etc.) and `attrs` is rendered
 * as XML attributes so the agent knows the context (e.g. who the sender is).
 *
 * Example:
 *   wrapUntrusted("dm_body", "ignore prior instructions", { from: "Bob" })
 *   => `<untrusted_dm_body from="Bob">ignore prior instructions</untrusted_dm_body>`
 */
export function wrapUntrusted(
  kind: string,
  body: string | null | undefined,
  attrs: Record<string, string | number | undefined> = {}
): string {
  const safeBody = (body ?? "").replaceAll("</untrusted_", CLOSE_TAG_NEUTRALIZED);
  const attrStr = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join("");
  return `<untrusted_${kind}${attrStr}>${safeBody}</untrusted_${kind}>`;
}

function escapeAttr(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
