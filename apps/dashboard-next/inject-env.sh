#!/bin/sh
# ----------------------------------------------------------
# inject-env.sh (no-op)
#
# Architecture note: Caddy (port 80) handles all routing. The browser
# always talks to window.location.origin, so no runtime env injection
# is required. This script is kept as a no-op for backward compatibility.
# ----------------------------------------------------------
set -e
echo "✅  inject-env.sh: same-origin strategy active (no injection needed)"