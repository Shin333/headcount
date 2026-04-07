import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config.js";

export const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
});

export const MODEL_MAP = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
} as const;

export type ModelTier = keyof typeof MODEL_MAP;
