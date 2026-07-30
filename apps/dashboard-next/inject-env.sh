#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh
#
# Writes /app/public/env.js so the browser knows how to reach the
# backend. The host server's LAN IP is fixed (192.168.29.141), so we
# don't need any detection logic — we just bake it in.
#
# To change the host IP later, edit HOST_LAN_IP below.
# ----------------------------------------------------------
set -e

HOST_LAN_IP="192.168.29.141"
BACKEND_PORT="${BACKEND_PORT:-4000}"

BACKEND_URL="http://${HOST_LAN_IP}:${BACKEND_PORT}"
SOCKET_URL="${NEXT_PUBLIC_SOCKET_URL:-$BACKEND_URL}"

mkdir -p /app/public
cat > /app/public/env.js <<EOF
window.__ENV__ = {
  NEXT_PUBLIC_BACKEND_URL: "${BACKEND_URL}",
  NEXT_PUBLIC_API_URL:     "${BACKEND_URL}",
  NEXT_PUBLIC_SOCKET_URL:  "${SOCKET_URL}",
  DETECTED_HOST_IP:        "${HOST_LAN_IP}"
};
EOF

echo "✅  Wrote /app/public/env.js"
echo "    NEXT_PUBLIC_API_URL=${BACKEND_URL}"
echo "    NEXT_PUBLIC_SOCKET_URL=${SOCKET_URL}"