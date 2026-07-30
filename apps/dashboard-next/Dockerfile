# Dockerfile for the AEGIS Next.js dashboard (apps/dashboard-next)
# Multi-stage build that produces a lightweight, production-ready image.
# At runtime, inject-env.sh writes /app/public/env.js so the browser
# can reach the backend at the configured host IP.
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
# 2️⃣ Runtime stage – copy only the built output.
FROM node:22-alpine AS runtime
WORKDIR /app

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
EXPOSE 3000

# Run as non-root for defense-in-depth
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Give the non-root user ownership of the app directory (including /app/public)
# so inject-env.sh can write /app/public/env.js at container start.
RUN chown -R appuser:appgroup /app

USER appuser

# Run the script, then start the Next.js server
ENTRYPOINT ["/bin/sh", "-c", "/usr/local/bin/inject-env.sh && node server.js"]