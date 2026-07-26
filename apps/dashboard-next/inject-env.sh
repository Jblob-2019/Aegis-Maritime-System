#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh
# Detects the host machine's IP at container start and writes
# a runtime env file that the browser reads before the Next.js
# app boots. This lets the same Docker image work on any host
# (LAN, public server, cloud) without rebuilding.
# ----------------------------------------------------------
set -e

HOST_IP=""

# 1. hostname -I (works on most Linux containers)
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')

# 2. ip route (fallback for systems without hostname -I)
if [ -z "$HOST_IP" ]; then
  HOST_IP=$(ip route get 1 2>/dev/null | awk '{print $7;exit}')
fi

# 3. ifconfig (very old fallback)
if [ -z "$HOST_IP" ]; then
  HOST_IP=$(ifconfig 2>/dev/null | grep -E 'inet [0-9]' | grep -v 127.0.0.1 | awk '{print $2}' | head -n1)
fi

# 4. External service (works from inside a container with internet)
if [ -z "$HOST_IP" ]; then
  HOST_IP=$(curl -s https://api.ipify.org || true)
fi

# If everything failed, bail out with a clear error
if [ -z "$HOST_IP" ]; then
  echo "❌  Could not detect host IP. Set NEXT_PUBLIC_BACKEND_URL manually."
  exit 1
fi

echo "✅  Detected host IP: $HOST_IP"

# Default backend port (can be overridden by env)
BACKEND_PORT="${BACKEND_PORT:-5000}"
BACKEND_URL="http://${HOST_IP}:${BACKEND_PORT}"

# Write the runtime env file Next.js will serve as /env.js
mkdir -p /app/public
cat > /app/public/env.js <<EOF
window.__ENV__ = {
  NEXT_PUBLIC_BACKEND_URL: "${BACKEND_URL}",
  NEXT_PUBLIC_API_URL:     "${BACKEND_URL}",
  NEXT_PUBLIC_SOCKET_URL:  "${BACKEND_URL}"
};
EOF

echo "✅  Wrote /app/public/env.js with"
echo "    NEXT_PUBLIC_BACKEND_URL=${BACKEND_URL}"
