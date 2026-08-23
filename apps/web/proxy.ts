import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Next 16 deprecated the `middleware` file convention and renamed it to `proxy`;
// behaviour is unchanged. SPEC §2/§3.1 still say middleware.ts.
//
// Optimistic guard: this reads the cookie, it does not validate the session.
// Every API route re-resolves the session server-side (SPEC §3.1), so a forged
// cookie buys nothing beyond rendering an empty shell.
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();

  return NextResponse.redirect(new URL("/sign-in", request.url));
}

export const config = {
  // /sign-in and /sign-up must stay out of the matcher, or the redirect loops.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sign-in|sign-up).*)",
  ],
};
