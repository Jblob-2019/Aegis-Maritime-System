// Runtime env loader.
//
// The frontend container's startup script (apps/dashboard-next/inject-env.sh)
// detects the host's LAN IP and writes it to /app/public/env.js as
// window.__ENV__. The browser reads that file at startup and uses the
// discovered IP for every API call + Socket.IO connection.
//
// Why "same-origin" is NOT used here:
//   When the frontend talks to window.location.origin, it relies on a
//   reverse proxy (Nginx/Caddy) to forward /api/* to the backend. We
//   don't need that proxy if we just publish the backend port on the
//   host — the browser can hit http://<host-lan-ip>:4000 directly.

export function getRuntimeEnv() {
  if (typeof window !== "undefined" && (window as any).__ENV__) {
    return (window as any).__ENV__
  }

  const buildApi =
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    "http://localhost:4000"

  return {
    NEXT_PUBLIC_BACKEND_URL: buildApi,
    NEXT_PUBLIC_API_URL: buildApi,
    NEXT_PUBLIC_SOCKET_URL:
      process.env.NEXT_PUBLIC_SOCKET_URL || buildApi,
  }
}