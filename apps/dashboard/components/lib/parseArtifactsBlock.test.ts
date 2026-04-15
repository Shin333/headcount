// ============================================================================
// components/lib/parseArtifactsBlock.test.ts - Day 11
// ----------------------------------------------------------------------------
// Smoke tests for the artifact block parser. Run with:
//   node --test apps/dashboard/components/lib/parseArtifactsBlock.test.ts
//
// Note: this file uses node:test (built into Node 20+). No test framework
// dependency. To run, you may need to compile to JS first or use tsx:
//   npx tsx --test apps/dashboard/components/lib/parseArtifactsBlock.test.ts
//
// These tests exist to protect the 9b.2 fix. If you're refactoring the
// parser and these tests fail, STOP and fix the parser, not the tests.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArtifactsBlock, extractAttr, formatSize } from "./parseArtifactsBlock.js";

test("parseArtifactsBlock: returns body unchanged when no block present", () => {
  const body = "Hello, this is a regular DM with no artifacts.";
  const result = parseArtifactsBlock(body);
  assert.equal(result.text, body);
  assert.deepEqual(result.artifacts, []);
});

test("parseArtifactsBlock: parses single artifact with all fields", () => {
  const body = `Here's the file you asked for.

<artifacts>
  <artifact id="art_123" path="workspace/engineering/luhn.ts" type="code" lang="typescript" version="1" size="2048" title="Luhn algorithm" summary="Validates card numbers" />
</artifacts>`;
  const result = parseArtifactsBlock(body);
  assert.equal(result.text, "Here's the file you asked for.");
  assert.equal(result.artifacts.length, 1);
  const a = result.artifacts[0]!;
  assert.equal(a.id, "art_123");
  assert.equal(a.path, "workspace/engineering/luhn.ts");
  assert.equal(a.type, "code");
  assert.equal(a.lang, "typescript");
  assert.equal(a.version, "1");
  assert.equal(a.size, "2048");
  assert.equal(a.title, "Luhn algorithm");
  assert.equal(a.summary, "Validates card numbers");
});

test("parseArtifactsBlock: parses multiple artifacts", () => {
  const body = `Two files attached.

<artifacts>
  <artifact id="art_1" path="a.ts" type="code" lang="typescript" version="1" size="100" title="A" summary="first" />
  <artifact id="art_2" path="b.md" type="markdown" lang="" version="1" size="200" title="B" summary="second" />
</artifacts>`;
  const result = parseArtifactsBlock(body);
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifacts[0]!.id, "art_1");
  assert.equal(result.artifacts[1]!.id, "art_2");
  assert.equal(result.artifacts[1]!.type, "markdown");
});

test("parseArtifactsBlock: handles malformed block (missing closing tag)", () => {
  const body = `Body text\n<artifacts>\n<artifact id="x" path="y.ts"`;
  const result = parseArtifactsBlock(body);
  // Missing </artifacts> means the block is invalid - return body as-is.
  assert.equal(result.text, body);
  assert.deepEqual(result.artifacts, []);
});

test("parseArtifactsBlock: handles empty block", () => {
  const body = `Hello\n\n<artifacts>\n</artifacts>`;
  const result = parseArtifactsBlock(body);
  assert.equal(result.text, "Hello");
  assert.deepEqual(result.artifacts, []);
});

test("extractAttr: returns empty string for missing attribute", () => {
  assert.equal(extractAttr('id="abc"', "missing"), "");
});

test("extractAttr: decodes &quot; back to literal quotes", () => {
  assert.equal(extractAttr('title="say &quot;hi&quot;"', "title"), 'say "hi"');
});

test("formatSize: bytes", () => {
  assert.equal(formatSize("512"), "512 B");
});

test("formatSize: kilobytes", () => {
  assert.equal(formatSize("1536"), "1.5 KB");
});

test("formatSize: megabytes", () => {
  assert.equal(formatSize("2097152"), "2.0 MB");
});

test("formatSize: invalid input returns empty string", () => {
  assert.equal(formatSize("not a number"), "");
});
