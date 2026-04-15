// Magic-link landing route. Supabase redirects the user here with a `code`
// query param; we exchange it for a session cookie, then bounce to the home
// page. If the email doesn't match CEO_EMAIL, middleware will catch it on the
// next request.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";

  const response = NextResponse.redirect(new URL(next, url.origin));

  if (!code) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const back = new URL("/login", url.origin);
    back.searchParams.set("error", error.message);
    return NextResponse.redirect(back);
  }

  return response;
}
