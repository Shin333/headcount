// Browser-side Supabase client with cookie-based session, for the /login page.
// The realtime/anon client in `lib/supabase.ts` does NOT persist sessions and
// is intentionally separate.
import { createBrowserClient } from "@supabase/ssr";

export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createBrowserClient(url, anonKey);
}
