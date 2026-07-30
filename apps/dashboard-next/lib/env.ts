// Runtime env loader.
//
// Architecture: Caddy (port 80) sits in front of the stack.
//   Browser → http://<host>/                  → Caddy → frontend:3000
//   Browser → http://<host>/api/...           → Caddy → backend:4000
//   Browser → http://<host>/socket.io/...    → Caddy → backend:4000
//
// So the frontend just talks to the same origin it loaded from.
// The backend container's hostname/IP is irrelevant to the browser.

export function getRuntimeEnv() {
  const origin =
    typeof window !== "undefined" ? window.location.origin : ""

  return {
    NEXT_PUBLIC_BACKEND_URL: origin,
    NEXT_PUBLIC_API_URL: origin,
    NEXT_PUBLIC_SOCKET_URL: origin,
  }
}