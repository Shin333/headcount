// CEO-only auth gate. Runs on every request (except static assets and the
// auth pages themselves). Two failure modes:
//   - HTML routes (page navigation): redirect to /login
//   - /api/** routes: respond 401 JSON (clients should refresh + re-auth)
//
// Identity check: the session's email must match CEO_EMAIL exactly. Anyone
// else - even a valid Supabase user from a different account - is rejected.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const CEO_EMAIL = (process.env.CEO_EMAIL ?? "").trim().toLowerCase();

export async function middleware(req: NextRequest) {
  // Always let the browser refresh the cookie via the response.
  const response = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(toSet) {
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  const { data } = await supabase.auth.getUser();
  const email = data.user?.email?.toLowerCase() ?? "";
  const authorized = !!CEO_EMAIL && email === CEO_EMAIL;

  if (authorized) return response;

  // Unauthenticated. API routes get 401; page navigations redirect to /login.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return new NextResponse(
      JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } }
    );
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

// Matcher: protect everything EXCEPT static assets, the login page, and the
// auth callback. /api/health is intentionally protected too - it's not public.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|login|auth/callback).*)",
  ],
};
