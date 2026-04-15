// ============================================================================
// components/lib/parseArtifactsBlock.ts - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// DMs that contain artifact references end with an <artifacts> block like:
//
//   <artifacts>
//     <artifact id="..." path="workspace/engineering/foo.ts" type="code"
//               lang="typescript" version="1" size="1234"
//               title="..." summary="..." />
//   </artifacts>
//
// We parse this out of the body so the text reads cleanly and render the
// artifacts as cards below the text.
//
// ----------------------------------------------------------------------------
// 9b.2 BUG NOTE - DO NOT REINTRODUCE
// ----------------------------------------------------------------------------
// The original parser used `new RegExp(\`${name}="([^"]*)"\`)` inside a loop
// to extract attribute values. This worked in dev but the Next.js SWC
// minifier mangled the template literal regex into something that threw
// "p1 is not defined" at runtime in production. The fix is pure string
// scanning with indexOf/slice - no template literal regexes anywhere in
// this file. If you find yourself reaching for `new RegExp(\`...${var}...\`)`
// in this file, STOP and use indexOf/slice instead.
//
// ----------------------------------------------------------------------------
// 14b BUG NOTE - undefined body guard
// ----------------------------------------------------------------------------
// parseArtifactsBlock is called from MessagesView, InboxView, TodayView in
// the message-list render path. Realtime payloads occasionally arrive with
// an undefined body field (e.g., when the row was inserted with body=null
// at the database level, or when the realtime payload is partial). Without
// a guard, calling body.lastIndexOf throws TypeError and crashes the entire
// dashboard render. The function should never crash on bad input - it should
// return a safe empty result and let the UI render gracefully.
// ============================================================================

export interface ParsedArtifact {
  id: string;
  path: string;
  type: string;
  lang: string;
  version: string;
  size: string;
  title: string;
  summary: string;
}

/**
 * Pull a single attribute value out of an attribute string.
 *
 * Example: extractAttr('id="abc" path="foo.ts"', "path") returns "foo.ts"
 *
 * Returns "" if the attribute is missing. Decodes &quot; to literal " in
 * the result so titles/summaries with embedded quotes round-trip correctly.
 */
export function extractAttr(attrs: string, name: string): string {
  if (typeof attrs !== "string") return "";
  const needle = `${name}="`;
  const start = attrs.indexOf(needle);
  if (start === -1) return "";
  const valueStart = start + needle.length;
  const end = attrs.indexOf('"', valueStart);
  if (end === -1) return "";
  return attrs.slice(valueStart, end).replace(/&quot;/g, '"');
}

/**
 * Parse a DM or post body that may end with an <artifacts> block.
 *
 * Returns the text portion (with the block stripped) and an array of
 * parsed artifacts. If there is no block, returns the original body and
 * an empty artifacts array.
 *
 * Uses lastIndexOf so a stray earlier "<artifacts>" mention in the body
 * doesn't confuse the parser - we always anchor on the trailing block.
 *
 * Defensive: if body is null, undefined, or not a string, returns an
 * empty result rather than throwing. See "14b BUG NOTE" at top of file.
 */
export function parseArtifactsBlock(body: string | null | undefined): {
  text: string;
  artifacts: ParsedArtifact[];
} {
  // Day 14b guard: never crash on bad input
  if (typeof body !== "string" || body.length === 0) {
    return { text: "", artifacts: [] };
  }

  const blockStart = body.lastIndexOf("<artifacts>");
  const blockEnd = body.lastIndexOf("</artifacts>");
  if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
    return { text: body, artifacts: [] };
  }
  const textWithoutBlock = body.slice(0, blockStart).trimEnd();
  const blockBody = body.slice(blockStart + "<artifacts>".length, blockEnd);

  const artifacts: ParsedArtifact[] = [];
  let cursor = 0;
  while (cursor < blockBody.length) {
    const tagStart = blockBody.indexOf("<artifact", cursor);
    if (tagStart === -1) break;
    const tagEnd = blockBody.indexOf("/>", tagStart);
    if (tagEnd === -1) break;
    const attrs = blockBody.slice(tagStart + "<artifact".length, tagEnd);
    artifacts.push({
      id: extractAttr(attrs, "id"),
      path: extractAttr(attrs, "path"),
      type: extractAttr(attrs, "type"),
      lang: extractAttr(attrs, "lang"),
      version: extractAttr(attrs, "version"),
      size: extractAttr(attrs, "size"),
      title: extractAttr(attrs, "title"),
      summary: extractAttr(attrs, "summary"),
    });
    cursor = tagEnd + 2;
  }

  return { text: textWithoutBlock, artifacts };
}

/**
 * Format a byte count as a human-readable size string.
 * Example: 1500 -> "1.5 KB", 524288 -> "512.0 KB"
 */
export function formatSize(bytes: string): string {
  if (typeof bytes !== "string") return "";
  const n = parseInt(bytes, 10);
  if (isNaN(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
