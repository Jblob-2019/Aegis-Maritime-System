#!/bin/sh
set -e

# Nginx entrypoint that generates a config based on the presence of TLS certificates.
# If fullchain.pem and privkey.pem exist, a HTTPS server is created that redirects HTTP -> HTTPS.
# If they are missing, a simple HTTP server is used.
#
# Both server blocks proxy /api/* and /socket.io/* to the backend container
# so the browser can talk to the API using the same origin (no CORS needed).

CERT_DIR="/etc/nginx/certs"
FULLCHAIN="$CERT_DIR/fullchain.pem"
PRIVKEY="$CERT_DIR/privkey.pem"
NGINX_CONF="/etc/nginx/nginx.conf"

generate_http() {
  cat > "$NGINX_CONF" <<'EOF'
worker_processes  1;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile        on;
    keepalive_timeout  65;

    server {
        listen 80;
        server_name _;

        # API + Socket.IO -> backend container
        location /api/ {
            proxy_pass         http://backend:4000;
            proxy_set_header   Host $host;
            proxy_set_header   X-Real-IP $remote_addr;
            proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
        location /socket.io/ {
            proxy_pass         http://backend:4000;
            proxy_http_version 1.1;
            proxy_set_header   Upgrade $http_upgrade;
            proxy_set_header   Connection "upgrade";
            proxy_set_header   Host $host;
        }

        # Everything else -> frontend
        location / {
            proxy_pass         http://frontend:3000;
            proxy_set_header   Host $host;
            proxy_set_header   X-Real-IP $remote_addr;
            proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
    }
}
EOF
}

generate_https() {
  cat > "$NGINX_CONF" <<'EOF'
worker_processes  1;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile        on;
    keepalive_timeout  65;

    # HTTP -> HTTPS redirect
    server {
        listen 80;
        server_name _;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name _;
        ssl_certificate     /etc/nginx/certs/fullchain.pem;
        ssl_certificate_key /etc/nginx/certs/privkey.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         HIGH:!aNULL:!MD5;

        # API + Socket.IO -> backend container
        location /api/ {
            proxy_pass         http://backend:4000;
            proxy_set_header   Host $host;
            proxy_set_header   X-Real-IP $remote_addr;
            proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
        location /socket.io/ {
            proxy_pass         http://backend:4000;
            proxy_http_version 1.1;
            proxy_set_header   Upgrade $http_upgrade;
            proxy_set_header   Connection "upgrade";
            proxy_set_header   Host $host;
        }

        # Everything else -> frontend
        location / {
            proxy_pass         http://frontend:3000;
            proxy_set_header   Host $host;
            proxy_set_header   X-Real-IP $remote_addr;
            proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
    }
}
EOF
}

if [ -f "$FULLCHAIN" ] && [ -f "$PRIVKEY" ]; then
  echo "TLS certificates found – configuring HTTPS"
  generate_https
else
  echo "TLS certificates not found – falling back to HTTP only"
  generate_http
fi

# Run nginx in the foreground
echo "Starting nginx…"
exec nginx -g 'daemon off;'