#!/usr/bin/env node
// ============================================================================
// tools/test-nanobanana.mjs - Day 13 standalone test script
// ----------------------------------------------------------------------------
// Validates that the nanobanana image_generate pipeline works in isolation
// before any agent tries to use it. Run this FIRST after installing the
// @google/genai package and setting GEMINI_API_KEY.
//
// What this tests:
//   1. @google/genai package is installed and importable
//   2. GEMINI_API_KEY environment variable is set
//   3. The Gemini image generation API responds successfully
//   4. The response contains image bytes
//   5. The image can be saved to disk as a valid PNG
//
// What this does NOT test:
//   - Tool registration in the orchestrator registry
//   - Per-agent daily cap enforcement (no DB connection)
//   - Audit log writes (no DB connection)
//   - Artifact row creation (no DB connection)
//   - Dashboard image rendering (no UI)
//
// Run from the repo root with:
//   pnpm tsx apps/orchestrator/src/tools/test-nanobanana.mjs
// or:
//   node --import tsx apps/orchestrator/src/tools/test-nanobanana.mjs
//
// On success: writes test-output-<timestamp>.png to current directory and
// prints the file path.
// On failure: prints a clear error and exits non-zero.
// ============================================================================

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PROMPT =
  "A minimalist 3D rendered banana wearing tiny round glasses, soft studio lighting, " +
  "neutral cream background, centered composition, subtle depth of field. " +
  "Style: clean modern product photography. No text.";

const ASPECT_RATIO = "1:1";
const MODEL = "gemini-2.5-flash-image";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`${GREEN}✓${RESET} ${msg}`);
const fail = (msg) => console.log(`${RED}✗${RESET} ${msg}`);
const warn = (msg) => console.log(`${YELLOW}!${RESET} ${msg}`);
const step = (msg) => console.log(`${CYAN}▸${RESET} ${msg}`);

async function main() {
  console.log("");
  console.log("=========================================");
  console.log(" Day 13 - nanobanana standalone test");
  console.log("=========================================");
  console.log("");

  // ----- Step 1: API key check -----
  step("checking GEMINI_API_KEY...");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    fail("GEMINI_API_KEY is not set in your environment.");
    log("");
    log("To fix:");
    log("  1. Get an API key from https://aistudio.google.com/apikey");
    log("  2. Add to your orchestrator .env file:");
    log("       GEMINI_API_KEY=your_key_here");
    log("  3. Re-run this script");
    log("");
    log("  Or for a one-shot test (PowerShell):");
    log('       $env:GEMINI_API_KEY="your_key_here"; pnpm tsx apps/orchestrator/src/tools/test-nanobanana.mjs');
    process.exit(1);
  }
  ok(`GEMINI_API_KEY is set (${apiKey.length} chars)`);

  // ----- Step 2: SDK import -----
  step("importing @google/genai...");
  let GoogleGenAI;
  try {
    const mod = await import("@google/genai");
    GoogleGenAI = mod.GoogleGenAI;
  } catch (err) {
    fail(`failed to import @google/genai: ${err.message}`);
    log("");
    log("To fix:");
    log("  pnpm add @google/genai");
    log("");
    process.exit(1);
  }
  ok("@google/genai imported successfully");

  // ----- Step 3: API call -----
  step(`calling Gemini API with model ${MODEL}...`);
  step(`prompt: "${PROMPT.slice(0, 80)}..."`);
  const startMs = Date.now();
  let response;
  try {
    const ai = new GoogleGenAI({ apiKey });
    response = await ai.models.generateContent({
      model: MODEL,
      contents: PROMPT,
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: ASPECT_RATIO },
      },
    });
  } catch (err) {
    fail(`API call failed: ${err.message}`);
    log("");
    log("Common causes:");
    log("  - Invalid API key (regenerate at https://aistudio.google.com/apikey)");
    log("  - API key has no billing enabled (image preview models require paid tier)");
    log("  - Model name has changed (currently expecting gemini-2.5-flash-image)");
    log("  - Network/firewall blocking generativelanguage.googleapis.com");
    log("");
    log("Full error:");
    console.error(err);
    process.exit(1);
  }
  const apiMs = Date.now() - startMs;
  ok(`API responded in ${apiMs}ms`);

  // ----- Step 4: Extract image bytes -----
  step("extracting image data from response...");
  const candidates = response.candidates;
  if (!candidates || candidates.length === 0) {
    fail("response had no candidates");
    log("Response shape:");
    console.log(JSON.stringify(response, null, 2).slice(0, 500));
    process.exit(1);
  }

  const parts = candidates[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    fail("response candidate had no content parts");
    log("Candidate shape:");
    console.log(JSON.stringify(candidates[0], null, 2).slice(0, 500));
    process.exit(1);
  }

  let imageBuffer = null;
  let mimeType = "image/png";
  for (const part of parts) {
    if (part.inlineData?.data) {
      imageBuffer = Buffer.from(part.inlineData.data, "base64");
      mimeType = part.inlineData.mimeType ?? "image/png";
      break;
    }
  }

  if (!imageBuffer) {
    fail("response had no inline image data");
    warn("This usually means a safety filter rejection. Try a different prompt.");
    log("Parts received:");
    console.log(JSON.stringify(parts, null, 2).slice(0, 500));
    process.exit(1);
  }

  ok(`extracted ${imageBuffer.length} bytes (${(imageBuffer.length / 1024).toFixed(0)} KB), mime: ${mimeType}`);

  // ----- Step 5: Save to disk -----
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputPath = resolve(`test-output-${timestamp}.${ext}`);
  step(`saving to ${outputPath}...`);
  try {
    writeFileSync(outputPath, imageBuffer);
  } catch (err) {
    fail(`failed to write file: ${err.message}`);
    process.exit(1);
  }
  ok(`saved successfully`);

  // ----- Done -----
  console.log("");
  console.log(`${GREEN}✓ Day 13 nanobanana test complete${RESET}`);
  console.log("");
  log(`Output: ${outputPath}`);
  log(`Open the file to verify the image looks correct.`);
  console.log("");
  log("Next steps:");
  log("  1. If the image looks good, run the grant script:");
  log("       pnpm tsx apps/orchestrator/src/seed/grant-day13-image.ts");
  log("  2. Restart the orchestrator");
  log("  3. DM Tessa Goh and ask her to generate a hero image for something");
  log("  4. Watch the dashboard MESSAGES view for her reply");
  console.log("");
}

main().catch((err) => {
  fail(`unexpected error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
