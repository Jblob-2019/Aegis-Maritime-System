// Runtime env loader.
// The Docker container injects a /env.js file at startup that exposes
// window.__ENV__ with the correct host IP. We read from that first so
// the browser always uses the right backend URL, even when the
// image is deployed on a different machine.

export function getRuntimeEnv() {
  if (typeof window !== "undefined" && (window as any).__ENV__) {
    return (window as any).__ENV__
  }
  // Fallback to build-time env (works offline / during prerender).
  // Port matches the backend default (4000) configured in api-server.js
  // and docker-compose.yml.
  return {
    NEXT_PUBLIC_BACKEND_URL:
      process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000",
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ||
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      "http://localhost:4000",
    NEXT_PUBLIC_SOCKET_URL:
      process.env.NEXT_PUBLIC_SOCKET_URL ||
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      "http://localhost:4000",
  }
}
