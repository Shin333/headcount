// ----------------------------------------------------------------------------
// auth/google-oauth.ts - Google OAuth 2.0 flow for agent credentials
// ----------------------------------------------------------------------------
// Day 9b ships read-only Google Calendar access for Evie. This module handles
// the OAuth handshake:
//
//   1. Build the consent URL with calendar.readonly scope
//   2. Open the user's browser to the consent URL
//   3. Spin up a one-shot localhost HTTP server on port 5174 to catch the
//      callback (the redirect URI registered with Google)
//   4. Exchange the auth code for access + refresh tokens via Google's
//      token endpoint
//   5. Store the tokens in agent_credentials, attributed to the target agent
//
// Also exports getValidAccessToken() which the calendar-read tool calls
// before each API request. It checks expires_at, refreshes via the refresh
// token if needed, and returns a usable access token.
//
// No external SDK dependencies - we use Node 20+'s built-in fetch and http
// modules. The googleapis package is 7+ MB for two endpoint calls; raw HTTP
// is cleaner.
// ----------------------------------------------------------------------------

import { createServer } from "node:http";
import { exec } from "node:child_process";
import { db } from "../db.js";
import { config } from "../config.js";
import { encryptCredential, decryptCredential } from "./crypto.js";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  refresh_token?: string;
  scope: string;
  token_type: string;
}

// ----------------------------------------------------------------------------
// Configuration loader
// ----------------------------------------------------------------------------

export function loadGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "[google-oauth] missing env vars. Required: GOOGLE_OAUTH_CLIENT_ID, " +
        "GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI. Check apps/orchestrator/.env"
    );
  }

  return { clientId, clientSecret, redirectUri };
}

// ----------------------------------------------------------------------------
// Browser opener (cross-platform)
// ----------------------------------------------------------------------------

function openInBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "win32") {
    // Use start with empty title arg to handle URLs with & characters
    cmd = `start "" "${url}"`;
  } else if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.warn(`[google-oauth] could not auto-open browser: ${err.message}`);
      console.warn(`[google-oauth] please open this URL manually:\n${url}`);
    }
  });
}

// ----------------------------------------------------------------------------
// Consent URL builder
// ----------------------------------------------------------------------------

export function buildConsentUrl(args: {
  config: GoogleOAuthConfig;
  scopes: string[];
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.config.clientId,
    redirect_uri: args.config.redirectUri,
    response_type: "code",
    scope: args.scopes.join(" "),
    access_type: "offline", // get a refresh token
    prompt: "consent", // always show the consent screen so we get a fresh refresh token
    state: args.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ----------------------------------------------------------------------------
// Token exchange
// ----------------------------------------------------------------------------

async function exchangeCodeForTokens(
  config: GoogleOAuthConfig,
  code: string
): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${errBody}`);
  }

  return (await res.json()) as GoogleTokenResponse;
}

// ----------------------------------------------------------------------------
// Refresh token flow
// ----------------------------------------------------------------------------

async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string
): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google token refresh failed: ${res.status} ${errBody}`);
  }

  // Note: refresh response does NOT contain a new refresh_token
  return (await res.json()) as GoogleTokenResponse;
}

// ----------------------------------------------------------------------------
// One-shot localhost callback receiver
// ----------------------------------------------------------------------------

interface CallbackResult {
  code: string;
  state: string;
}

function waitForCallback(args: {
  port: number;
  expectedState: string;
  timeoutMs: number;
}): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${args.port}`);
      if (url.pathname !== "/oauth/google/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body style="font-family:sans-serif;padding:2rem"><h1>OAuth error</h1><p>${error}</p><p>Check the orchestrator console.</p></body></html>`
        );
        server.close();
        reject(new Error(`Google returned error: ${error}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing code or state");
        return;
      }

      if (state !== args.expectedState) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("State mismatch - possible CSRF");
        server.close();
        reject(new Error("State mismatch in OAuth callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;padding:2rem;text-align:center">
          <h1>✅ Authorized</h1>
          <p>You can close this window and return to the orchestrator console.</p>
        </body></html>`
      );

      // Give the response a beat to flush before closing
      setTimeout(() => server.close(), 100);
      resolve({ code, state });
    });

    server.on("error", (err) => {
      reject(new Error(`Callback server failed to start on port ${args.port}: ${err.message}`));
    });

    server.listen(args.port, "127.0.0.1", () => {
      console.log(`[google-oauth] callback server listening on http://localhost:${args.port}`);
    });

    // Hard timeout
    setTimeout(() => {
      server.close();
      reject(new Error(`OAuth callback did not arrive within ${args.timeoutMs}ms`));
    }, args.timeoutMs);
  });
}

// ----------------------------------------------------------------------------
// High-level grant flow
// ----------------------------------------------------------------------------

/**
 * Run the full OAuth grant flow for a single agent + scope.
 *
 * Steps:
 *   1. Generate a random state token (CSRF protection)
 *   2. Build the consent URL
 *   3. Spin up the callback server on port 5174
 *   4. Open the user's browser to the consent URL
 *   5. Wait for the callback (or 5 minute timeout)
 *   6. Exchange the auth code for tokens
 *   7. Upsert the tokens into agent_credentials
 *
 * Used by the grant-evie-calendar.ts seed script. Idempotent: re-running
 * for the same agent + provider + scope overwrites the existing credential.
 */
export async function runGrantFlow(args: {
  agentId: string;
  agentName: string;
  provider: string;
  scope: string;
  scopes: string[]; // the actual Google scope strings (e.g. ['https://www.googleapis.com/auth/calendar.readonly'])
  grantedBy: string;
}): Promise<void> {
  const oauthConfig = loadGoogleOAuthConfig();

  // Parse port from redirect URI
  const redirectUrl = new URL(oauthConfig.redirectUri);
  const port = parseInt(redirectUrl.port, 10);
  if (!port || isNaN(port)) {
    throw new Error(`Invalid port in GOOGLE_OAUTH_REDIRECT_URI: ${oauthConfig.redirectUri}`);
  }

  const state = `${args.agentId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const consentUrl = buildConsentUrl({
    config: oauthConfig,
    scopes: args.scopes,
    state,
  });

  console.log("");
  console.log(`[google-oauth] starting grant flow for ${args.agentName}`);
  console.log(`[google-oauth] scope: ${args.scope}`);
  console.log(`[google-oauth] opening browser to consent screen...`);
  console.log("");

  openInBrowser(consentUrl);

  // Wait for callback (5 min timeout)
  const callback = await waitForCallback({
    port,
    expectedState: state,
    timeoutMs: 5 * 60 * 1000,
  });

  console.log(`[google-oauth] callback received, exchanging code for tokens...`);

  const tokens = await exchangeCodeForTokens(oauthConfig, callback.code);

  if (!tokens.refresh_token) {
    console.warn(
      `[google-oauth] WARNING: Google did not return a refresh_token. ` +
        `This usually means the user has previously authorized this app. ` +
        `Visit https://myaccount.google.com/permissions to revoke access for ` +
        `'Onepark Digital AI Agency', then re-run this script to get a fresh refresh_token.`
    );
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Upsert into agent_credentials
  const { error: upsertErr } = await db.from("agent_credentials").upsert(
    {
      tenant_id: config.tenantId,
      agent_id: args.agentId,
      provider: args.provider,
      scope: args.scope,
      // Day 27: AES-256-GCM at rest. encryptCredential is a no-op pass-through
      // when CRED_ENCRYPTION_KEY is unset, so existing flows keep working
      // until the operator provisions the key.
      access_token: encryptCredential(tokens.access_token),
      refresh_token: tokens.refresh_token ? encryptCredential(tokens.refresh_token) : null,
      expires_at: expiresAt,
      granted_by: args.grantedBy,
      granted_at: new Date().toISOString(),
    },
    {
      onConflict: "tenant_id,agent_id,provider,scope",
    }
  );

  if (upsertErr) {
    throw new Error(`Failed to store credentials in DB: ${upsertErr.message}`);
  }

  console.log("");
  console.log(`[google-oauth] ✅ ${args.agentName} now has ${args.provider}/${args.scope} access`);
  console.log(`[google-oauth] tokens expire at ${expiresAt}`);
  console.log(`[google-oauth] refresh token will rotate them automatically`);
  console.log("");
}

// ----------------------------------------------------------------------------
// Get-or-refresh access token (called from tools at runtime)
// ----------------------------------------------------------------------------

/**
 * Look up an agent's credential for a given provider+scope, refresh the
 * access token if it's expired or about to expire, and return a usable
 * access token. Updates the row's last_used_at and use_count.
 *
 * Returns null if no credential exists for this agent+provider+scope.
 * The caller (tool executor) should treat null as "not authorized" and
 * return a useful error message to the agent.
 */
export async function getValidAccessToken(args: {
  agentId: string;
  provider: string;
  scope: string;
}): Promise<string | null> {
  const { data: cred, error } = await db
    .from("agent_credentials")
    .select("id, access_token, refresh_token, expires_at, use_count")
    .eq("tenant_id", config.tenantId)
    .eq("agent_id", args.agentId)
    .eq("provider", args.provider)
    .eq("scope", args.scope)
    .maybeSingle();

  if (error) {
    console.error(`[google-oauth] failed to load credential: ${error.message}`);
    return null;
  }
  if (!cred) {
    return null;
  }

  // Day 27: decrypt-on-read. Plaintext rows pass through unchanged so the
  // backfill seed can run incrementally.
  let accessToken: string;
  try {
    accessToken = decryptCredential(cred.access_token);
  } catch (err) {
    console.error(`[google-oauth] failed to decrypt access_token for agent ${args.agentId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const refreshToken = cred.refresh_token
    ? (() => {
        try {
          return decryptCredential(cred.refresh_token);
        } catch (err) {
          console.error(`[google-oauth] failed to decrypt refresh_token for agent ${args.agentId}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      })()
    : null;

  // Check if token is expired or expires within the next 60 seconds
  const expiresAt = cred.expires_at ? new Date(cred.expires_at).getTime() : 0;
  const now = Date.now();
  const expiresInMs = expiresAt - now;

  if (expiresInMs < 60_000) {
    if (!refreshToken) {
      console.error(
        `[google-oauth] access token expired and no refresh token available for agent ${args.agentId}`
      );
      return null;
    }

    console.log(`[google-oauth] refreshing access token for agent ${args.agentId.slice(0, 8)}...`);
    try {
      const oauthConfig = loadGoogleOAuthConfig();
      const refreshed = await refreshAccessToken(oauthConfig, refreshToken);
      accessToken = refreshed.access_token;
      const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

      await db
        .from("agent_credentials")
        .update({
          // Day 27: re-encrypt the rotated token before storing
          access_token: encryptCredential(accessToken),
          expires_at: newExpiresAt,
        })
        .eq("id", cred.id);
    } catch (err) {
      console.error(
        `[google-oauth] refresh failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  // Update last_used_at and use_count
  await db
    .from("agent_credentials")
    .update({
      last_used_at: new Date().toISOString(),
      use_count: (cred.use_count ?? 0) + 1,
    })
    .eq("id", cred.id);

  return accessToken;
}
