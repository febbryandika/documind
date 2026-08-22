import { NextResponse } from "next/server";

// Pass-through for now. SPEC §3.1 turns this into the redirect-to-/sign-in
// guard once Better Auth is wired up.
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
