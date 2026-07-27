// Runtime env loader.
// Priority order:
//   1. window.__ENV__ injected by the container at runtime (most accurate).
//   2. NEXT_PUBLIC_BACKEND_URL baked at build time.
//   3. Public socket URL (PUBLIC_SOCKET_URL from the host .env).
//   4. Same-origin fallback (so API calls go to the same host as the page).
//
// Why this matters:
//   - Inside Docker, the backend lives at hostname `backend` – not
//     `localhost`. The browser can't resolve `backend`, so we must use
//     a public URL.
//   - When users open the dashboard from their browser, they need the
//     backend URL to be reachable from *their* machine, not from inside
//     the container. Using the same origin (window.location.origin)
//     means nginx can proxy /api/* to the backend for us.

export function getRuntimeEnv() {
  if (typeof window !== "undefined" && (window as any).__ENV__) {
    return (window as any).__ENV__
  }

  const buildApi =
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    ""

  // If the build-time URL is the internal Docker hostname (http://backend:4000),
  // replace it with the current origin so the browser can reach it.
  let resolved = buildApi
  if (typeof window !== "undefined") {
    if (!resolved || resolved.includes("://backend:")) {
      resolved = window.location.origin
    }
  }

  return {
    NEXT_PUBLIC_BACKEND_URL: resolved,
    NEXT_PUBLIC_API_URL: resolved,
    NEXT_PUBLIC_SOCKET_URL:
      process.env.NEXT_PUBLIC_SOCKET_URL || resolved,
  }
}