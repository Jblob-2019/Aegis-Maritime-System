#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh
# Runtime env shim for the Next.js frontend container.
#
# Detects the host's LAN IP (the IP a browser on the same network can
# actually reach) and writes it into /app/public/env.js so the client
# code uses window.__ENV__.NEXT_PUBLIC_BACKEND_URL.
#
# Strategy:
#   1. Try `ip route get 1` to find the default gateway (the Docker bridge
#      IP, e.g. 192.168.1.1 — the host's LAN-facing address from the
#      container's point of view).
#   2. If that returns nothing, fall back to `hostname -I`.
#   3. Fall back to `ifconfig` (legacy systems).
#   4. Last resort, ask api.ipify.org for the public IP (works on cloud
#      servers that map the container's external IP to the host's).
#   5. Build the backend URL: prefer http://<host-ip>:<BACKEND_PORT>; if
#      BACKEND_PORT is 80 (Nginx is fronting the API), use http://<host-ip>.
# ----------------------------------------------------------
set -e

HOST_LAN_IP=""

# 1. Default route gateway (most reliable for Docker bridge / home LAN)
HOST_LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')

# 2. hostname -I (first IPv4)
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

# 3. ifconfig
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(ifconfig 2>/dev/null | grep -E 'inet [0-9]' | grep -v 127.0.0.1 | awk '{print $2}' | head -n1)
fi

# 4. External service (only if the network allows outbound)
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || true)
fi

if [ -z "$HOST_LAN_IP" ]; then
  echo "❌  Could not detect host LAN IP. Set NEXT_PUBLIC_API_URL manually."
  exit 1
fi

echo "✅  Detected host LAN IP: $HOST_LAN_IP"

# ----------------------------------------------------------------------
# Build the backend URL the browser will use.
# ----------------------------------------------------------------------
# Honor an explicit override (e.g. NEXT_PUBLIC_API_URL=...)
# but rewrite any internal Docker hostname to the LAN IP.
BACKEND_URL="${NEXT_PUBLIC_API_URL:-}"
case "$BACKEND_URL" in
  *://backend:*|*"backend:4000"*)
    BACKEND_URL=""          # forces the auto-detection branch below
    ;;
esac

if [ -z "$BACKEND_URL" ]; then
  PORT="${BACKEND_PORT:-4000}"
  if [ "$PORT" = "80" ]; then
    BACKEND_URL="http://${HOST_LAN_IP}"
  else
    BACKEND_URL="http://${HOST_LAN_IP}:${PORT}"
  fi
fi

# Same logic for the socket URL
SOCKET_URL="${NEXT_PUBLIC_SOCKET_URL:-$BACKEND_URL}"
case "$SOCKET_URL" in
  *://backend:*|*"backend:4000"*)
    SOCKET_URL="$BACKEND_URL"
    ;;
esac

mkdir -p /app/public
cat > /app/public/env.js <<EOF
window.__ENV__ = {
  NEXT_PUBLIC_BACKEND_URL: "${BACKEND_URL}",
  NEXT_PUBLIC_API_URL:     "${BACKEND_URL}",
  NEXT_PUBLIC_SOCKET_URL:  "${SOCKET_URL}",
  // The browser will fall back to window.location.origin if __ENV__
  // is missing, so even when this file is absent the same-origin
  // strategy still works.
  DETECTED_HOST_IP:        "${HOST_LAN_IP}"
};
EOF

echo "✅  Wrote /app/public/env.js"
echo "    NEXT_PUBLIC_API_URL=${BACKEND_URL}"
echo "    NEXT_PUBLIC_SOCKET_URL=${SOCKET_URL}"