// Runtime env loader.
// The frontend container's startup script (apps/dashboard-next/inject-env.sh)
// auto-detects the host's LAN IP and writes it to /app/public/env.js, which
// the browser reads as `window.__ENV__`. We prefer that over any build-time
// value because the build-time value can't know the host's IP.
//
// Fallback chain (in priority order):
//   1. window.__ENV__  — set by the container at runtime
//   2. window.location.origin — same origin as the page (works through Nginx)
//   3. NEXT_PUBLIC_BACKEND_URL baked at build time
//   4. http://localhost:4000 (only useful in local dev)

export function getRuntimeEnv() {
  const fromWindow =
    typeof window !== "undefined" && (window as any).__ENV__
      ? (window as any).__ENV__
      : null

  // Determine the origin the browser is using to reach the page.
  // If the page is at https://yourdomain.com/ then origin = "https://yourdomain.com".
  // If it's at http://192.168.1.42:3000/ then origin = "http://192.168.1.42:3000".
  const origin =
    typeof window !== "undefined" ? window.location.origin : ""

  const buildApi =
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    ""

  // Prefer the runtime-injected URL, but rewrite the internal Docker
  // hostname (which the browser can't resolve) to the page origin.
  let api = fromWindow?.NEXT_PUBLIC_API_URL || buildApi || ""
  if (api.includes("://backend:") || api.endsWith("://backend")) {
    api = origin
  }

  // If still nothing, fall back to the page's own origin (works when
  // Nginx is fronting the API at /api/* on the same host).
  if (!api && origin) {
    api = origin
  }

  // Last-ditch fallback (dev only).
  if (!api) {
    api = "http://localhost:4000"
  }

  const socket =
    fromWindow?.NEXT_PUBLIC_SOCKET_URL ||
    process.env.NEXT_PUBLIC_SOCKET_URL ||
    api

  return {
    NEXT_PUBLIC_BACKEND_URL: api,
    NEXT_PUBLIC_API_URL: api,
    NEXT_PUBLIC_SOCKET_URL: socket,
  }
}