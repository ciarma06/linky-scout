import { NextResponse } from "next/server";

// Route protection is handled client-side (AuthContext + (protected) layout)
// because the JWT lives in localStorage and is not readable by server-side middleware.
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)",
  ],
};
