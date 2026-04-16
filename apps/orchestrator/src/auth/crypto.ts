// ============================================================================
// auth/crypto.ts - AES-256-GCM symmetric encryption for credentials at rest
// ----------------------------------------------------------------------------
// Day 27. Encrypts agent_credentials.access_token + refresh_token before they
// hit the database. Threat model: anyone with read access to the DB (compromised
// service-role key, leaked Supabase backup, rogue developer) shouldn't be able
// to use the tokens to impersonate the agent on Google APIs.
//
// Format on disk: base64-encoded JSON of { iv, tag, ciphertext } each base64.
// Versioning: prefixed with "v1:" so future rotations / algorithm changes can
// detect old ciphertexts and migrate transparently.
//
// Key: 32 bytes, base64-encoded in CRED_ENCRYPTION_KEY env var. If unset, the
// helpers degrade to a no-op pass-through (encrypt() and decrypt() return the
// input verbatim) so existing plaintext rows keep working until the operator
// sets the key. A startup warning is logged from index.ts.
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const PREFIX = "v1:";
const ALGO = "aes-256-gcm" as const;

function getKey(): Buffer | null {
  const raw = config.credEncryptionKey;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("CRED_ENCRYPTION_KEY is not valid base64");
  }
  if (key.length !== 32) {
    throw new Error(`CRED_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

/**
 * True if a value looks like our encrypted format (has the v1: prefix).
 * Used so encrypt() is idempotent (won't double-encrypt) and decrypt() can
 * pass through plaintext rows.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext string. Returns the ciphertext envelope. If no key is
 * configured, returns the input verbatim (no-op) so the caller can keep
 * writing without a hard dependency on the key being set.
 */
export function encryptCredential(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted, idempotent
  const iv = randomBytes(12); // GCM standard IV size
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
  });
  return PREFIX + Buffer.from(envelope, "utf8").toString("base64");
}

/**
 * Decrypt a value that may or may not be encrypted. Plaintext (no prefix)
 * passes through. Encrypted values are decrypted; if the key is missing or
 * the auth tag fails, throws.
 */
export function decryptCredential(value: string): string {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) {
    throw new Error("Encountered encrypted credential but CRED_ENCRYPTION_KEY is unset");
  }
  const envelopeJson = Buffer.from(value.slice(PREFIX.length), "base64").toString("utf8");
  const { iv, tag, ciphertext } = JSON.parse(envelopeJson) as {
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

/** True if a usable encryption key is configured. */
export function isEncryptionKeyConfigured(): boolean {
  return getKey() !== null;
}
