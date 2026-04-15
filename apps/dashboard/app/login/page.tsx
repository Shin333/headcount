"use client";

import { useState } from "react";
import { supabaseBrowser } from "../../lib/supabase-browser";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMsg("");
    const supabase = supabaseBrowser();
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      setErrorMsg(error.message);
      setStatus("error");
    } else {
      setStatus("sent");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Headcount</h1>
        <p className="text-sm text-stone-500 mb-6">Sign in with the CEO email.</p>
        {status === "sent" ? (
          <div className="rounded border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            Magic link sent to <strong>{email}</strong>. Check your inbox and click the link to sign in.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded border border-stone-300 px-3 py-2 text-sm focus:border-stone-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={status === "sending"}
              className="w-full rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
            >
              {status === "sending" ? "Sending..." : "Send magic link"}
            </button>
            {errorMsg && (
              <p className="text-xs text-red-700">{errorMsg}</p>
            )}
            <p className="text-xs text-stone-400 pt-2">
              Only the configured CEO email can sign in. Other emails will be rejected after the magic link is clicked.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
