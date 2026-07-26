# Dockerfile for the AEGIS Next.js dashboard (apps/dashboard-next)
# Multi-stage build that produces a lightweight, production-ready image
# and automatically detects the host IP at runtime so the browser
# always connects to the backend on the correct address.
# ------------------------------------------------------------
# 1️⃣ Build stage – install ALL deps (devDependencies are needed for the build)
#    and compile the Next.js app.
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

# Copy source and build the Next.js app (standalone output)
COPY . .
RUN npm run build

# ------------------------------------------------------------
# 2️⃣ Runtime stage – copy only the built output + auto-detect IP
FROM node:22-alpine AS runtime
WORKDIR /app

# Tools needed for IP detection
RUN apk add --no-cache curl iproute2

# Copy the built "standalone" output from the builder
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Add the env-injection script
COPY inject-env.sh /usr/local/bin/inject-env.sh
RUN chmod +x /usr/local/bin/inject-env.sh

# Production environment
ENV NODE_ENV=production
ENV PORT=3000
# Default backend port the inject-env.sh script will use if BACKEND_PORT
# is not set via docker-compose.yml. Keep this in sync with the backend.
ENV BACKEND_PORT=4000
EXPOSE 3000

# Run as non-root for defense-in-depth
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Run the script, then start the Next.js server
ENTRYPOINT ["/bin/sh", "-c", "/usr/local/bin/inject-env.sh && node server.js"]
