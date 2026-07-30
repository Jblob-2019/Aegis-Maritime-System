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
    const env = (window as any).__ENV__
    if (env.NEXT_PUBLIC_BACKEND_URL && !env.NEXT_PUBLIC_BACKEND_URL.includes("yourdomain.com")) {
      return env
    }
  }

  const buildApi =
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL

  if (buildApi && !buildApi.includes("yourdomain.com")) {
    return {
      NEXT_PUBLIC_BACKEND_URL: buildApi,
      NEXT_PUBLIC_API_URL: buildApi,
      NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL || buildApi,
    }
  }

  // Dynamic browser fallback: automatically connect to backend port 4000 on current hostname
  let dynamicBackendUrl = "http://localhost:4000"
  if (typeof window !== "undefined" && window.location) {
    const protocol = window.location.protocol || "http:"
    const hostname = window.location.hostname || "localhost"
    dynamicBackendUrl = `${protocol}//${hostname}:4000`
  }

  return {
    NEXT_PUBLIC_BACKEND_URL: dynamicBackendUrl,
    NEXT_PUBLIC_API_URL: dynamicBackendUrl,
    NEXT_PUBLIC_SOCKET_URL: dynamicBackendUrl,
  }
}