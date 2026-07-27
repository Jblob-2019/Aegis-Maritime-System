#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh
# Runtime env shim for the Next.js frontend container.
#
# The browser already receives the correct API URL via
# NEXT_PUBLIC_API_URL baked into the image at build time
# (because docker-compose.yml sets NEXT_PUBLIC_API_URL=http://backend:4000).
# This script only writes /app/public/env.js so that the client
# code can read it from window.__ENV__ as a defensive fallback.
# No external network calls – works on offline servers.
# ----------------------------------------------------------
set -e

BACKEND_URL="${NEXT_PUBLIC_API_URL:-http://backend:4000}"
SOCKET_URL="${NEXT_PUBLIC_SOCKET_URL:-$BACKEND_URL}"

mkdir -p /app/public
cat > /app/public/env.js <<EOF
window.__ENV__ = {
  NEXT_PUBLIC_BACKEND_URL: "${BACKEND_URL}",
  NEXT_PUBLIC_API_URL:     "${BACKEND_URL}",
  NEXT_PUBLIC_SOCKET_URL:  "${SOCKET_URL}"
};
EOF

echo "✅  Wrote /app/public/env.js"
echo "    NEXT_PUBLIC_API_URL=${BACKEND_URL}"