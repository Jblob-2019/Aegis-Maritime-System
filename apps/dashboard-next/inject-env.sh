#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh
#
# Writes /app/dist/env.js so the browser knows how to reach
# the backend. The LAN IP is auto-detected from the host's
# network interfaces at runtime — no hard-coded IP required.
#
# Override with HOST_LAN_IP env var if detection picks the
# wrong interface on a multi-homed host.
# ----------------------------------------------------------
set -e

detect_lan_ip() {
  # 1. honour explicit override
  if [ -n "$HOST_LAN_IP" ]; then
    echo "$HOST_LAN_IP"
    return
  fi

  # 2. busybox `hostname -I` lists all host IPs. Pick the first
  #    routable IPv4 — skip loopback (127.0.0.0/8) and link-local
  #    (169.254.0.0/16). Works under Docker network_mode: host.
  for ip in $(hostname -I 2>/dev/null); do
    case "$ip" in
      127.*|169.254.*) continue ;;
      *.*.*.*)         echo "$ip"; return ;;
    esac
  done

  # 3. last-ditch fallback (offline / misconfigured)
  echo "127.0.0.1"
}

HOST_LAN_IP="$(detect_lan_ip)"
BACKEND_PORT="${BACKEND_PORT:-4000}"

# Strip trailing slashes; treat empty PUBLIC_SOCKET_URL as unset.
SOCKET_URL="${NEXT_PUBLIC_SOCKET_URL:-}"
case "$SOCKET_URL" in
  */) SOCKET_URL="${SOCKET_URL%/}" ;;
  https://yourdomain.com|http://yourdomain.com|"") SOCKET_URL="" ;;
esac
[ -z "$SOCKET_URL" ] && SOCKET_URL="http://${HOST_LAN_IP}:${BACKEND_PORT}"

BACKEND_URL="http://${HOST_LAN_IP}:${BACKEND_PORT}"

mkdir -p /app/dist
cat > /app/dist/env.js <<EOF
window.__ENV__ = {
  NEXT_PUBLIC_BACKEND_URL: "${BACKEND_URL}",
  NEXT_PUBLIC_API_URL:     "${BACKEND_URL}",
  NEXT_PUBLIC_SOCKET_URL:  "${SOCKET_URL}",
  DETECTED_HOST_IP:        "${HOST_LAN_IP}"
};
EOF

echo "✅  Wrote /app/dist/env.js"
echo "    NEXT_PUBLIC_API_URL=${BACKEND_URL}"
echo "    NEXT_PUBLIC_SOCKET_URL=${SOCKET_URL}"
echo "    DETECTED_HOST_IP=${HOST_LAN_IP}"
