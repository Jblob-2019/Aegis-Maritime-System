#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh
#
# Detects the host's LAN IP at container start and writes it into
# /app/public/env.js so the browser can call the backend at the
# right address.
#
# Strategy:
#   1. Use `ip route get 1.1.1.1` to find the default route source IP.
#      That's the host's LAN-facing IP from the container's perspective.
#   2. Fallback to `hostname -I` (first IPv4).
#   3. Fallback to `ifconfig`.
#   4. Last resort: ask api.ipify.org for the public IP (works on cloud).
# ----------------------------------------------------------
set -e

HOST_LAN_IP=""

# 1. Default route source IP (most reliable for Docker bridge / LAN).
HOST_LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')

# 2. hostname -I (first IPv4).
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

# 3. ifconfig (legacy systems).
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(ifconfig 2>/dev/null | grep -E 'inet [0-9]' | grep -v 127.0.0.1 | awk '{print $2}' | head -n1)
fi

# 4. External service (only if outbound works).
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || true)
fi

if [ -z "$HOST_LAN_IP" ]; then
  echo "❌  Could not detect host LAN IP. Set NEXT_PUBLIC_API_URL manually."
  exit 1
fi

echo "✅  Detected host LAN IP: $HOST_LAN_IP"

# Build the URLs.
BACKEND_PORT="${BACKEND_PORT:-4000}"
BACKEND_URL="${NEXT_PUBLIC_API_URL:-http://${HOST_LAN_IP}:${BACKEND_PORT}}"
SOCKET_URL="${NEXT_PUBLIC_SOCKET_URL:-http://${HOST_LAN_IP}:${BACKEND_PORT}}"

# Write the runtime env file.
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