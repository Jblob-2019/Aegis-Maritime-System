#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh
# Runtime env shim for the Next.js frontend container.
# Detects the host's LAN IP (the Docker bridge gateway) so the
# browser can reach the backend at <host-lan-ip>:4000 (or :80 via Nginx)
# from any device on the same network.
# ----------------------------------------------------------
set -e

HOST_LAN_IP=""

# 1. Try the default route gateway (the Docker bridge IP, usually 192.168.x.x).
HOST_LAN_IP=$(ip route 2>/dev/null | awk '/default/ {print $3; exit}')

# 2. Fallback: hostname -I (first IPv4 address).
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

# 3. Fallback: ifconfig.
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(ifconfig 2>/dev/null | grep -E 'inet [0-9]' | grep -v 127.0.0.1 | awk '{print $2}' | head -n1)
fi

# 4. Fallback: external service (only if network is available).
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || true)
fi

if [ -z "$HOST_LAN_IP" ]; then
  echo "❌  Could not detect host LAN IP. Set NEXT_PUBLIC_API_URL manually."
  exit 1
fi

echo "✅  Detected host LAN IP: $HOST_LAN_IP"

# Compose-level env vars take precedence. If unset, build a URL that the
# browser can actually reach from a different device.
BACKEND_URL="${NEXT_PUBLIC_API_URL:-http://${HOST_LAN_IP}:4000}"
SOCKET_URL="${NEXT_PUBLIC_SOCKET_URL:-http://${HOST_LAN_IP}:4000}"

# If the compose URL points at the internal Docker hostname, replace it
# with the LAN IP so the browser can resolve it.
case "$BACKEND_URL" in
  *://backend:*)
    BACKEND_URL="http://${HOST_LAN_IP}:4000"
    ;;
esac
case "$SOCKET_URL" in
  *://backend:*)
    SOCKET_URL="http://${HOST_LAN_IP}:4000"
    ;;
esac

mkdir -p /app/public
cat > /app/public/env.js <<EOF
window.__ENV__ = {
  NEXT_PUBLIC_BACKEND_URL: "${BACKEND_URL}",
  NEXT_PUBLIC_API_URL:     "${BACKEND_URL}",
  NEXT_PUBLIC_SOCKET_URL:  "${SOCKET_URL}"
};
EOF

echo "✅  Wrote /app/public/env.js with"
echo "    NEXT_PUBLIC_API_URL=${BACKEND_URL}"
echo "    NEXT_PUBLIC_SOCKET_URL=${SOCKET_URL}"