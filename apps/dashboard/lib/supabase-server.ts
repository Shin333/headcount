// Server-side Supabase client that reads/writes the auth cookie. Use this in
// route handlers, server components, and middleware to check the CEO session.
// Distinct from `lib/supabase.ts`, which is the realtime/anon-key client used
// by client components.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function supabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll throws when called from a Server Component. The session is
          // refreshed in middleware so we can safely ignore here.
        }
      },
    },
  });
}

export const CEO_EMAIL = (process.env.CEO_EMAIL ?? "").trim().toLowerCase();

/** Returns the signed-in CEO user, or null if not authenticated / wrong email. */
export async function getCeoUser() {
  if (!CEO_EMAIL) return null;
  const supabase = supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  if ((data.user.email ?? "").toLowerCase() !== CEO_EMAIL) return null;
  return data.user;
}
