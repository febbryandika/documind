import type { NextConfig } from "next";

// Vercel and Fly are different registrable domains, so a session cookie set by
// the API is scoped to *.fly.dev and proxy.ts — which runs on the Vercel origin
// — can never see it. Sign-in would succeed and then every protected page would
// bounce straight back to /sign-in. Locally the problem is invisible: both apps
// sit on localhost, and cookies ignore the port.
//
// So in production the browser talks to the API through this origin instead.
// The rewrite is a transparent proxy, which puts the Set-Cookie on the Vercel
// origin where the guard in proxy.ts can read it, and makes the request
// same-origin into the bargain.
//
// The prefix is /api-proxy rather than /api because /documents and
// /documents/:id are real page routes here — rewriting those would shadow the
// pages. It also needs no change to proxy.ts's matcher, whose `api` exclusion
// already covers anything starting with "api".
//
// API_ORIGIN is server-side only and read at build time, because Vercel bakes
// the rewrite table into the deployment. Unset (local `next dev`) there is no
// rewrite at all and NEXT_PUBLIC_API_URL points straight at localhost:3001.
const apiOrigin = process.env.API_ORIGIN;

const nextConfig: NextConfig = {
  async rewrites() {
    if (!apiOrigin) return [];

    return [
      {
        source: "/api-proxy/:path*",
        destination: `${apiOrigin.replace(/\/+$/, "")}/:path*`,
      },
    ];
  },
};

export default nextConfig;
