# Dockerfile for the AEGIS Next.js dashboard (apps/dashboard-next)
# Multi-stage build that produces a lightweight, production‑ready image.
# ------------------------------------------------------------
# 1️⃣ Build stage – install dependencies and compile the app
FROM node:22-alpine AS builder
WORKDIR /app

# Install npm dependencies (including only production deps for speed)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the source code and build the Next.js app
COPY . .
# Enable the standalone output (next.config.mjs already sets this)
RUN npm run build

# ------------------------------------------------------------
# 2️⃣ Runtime stage – copy only the built output into a minimal image
FROM node:22-alpine AS runtime
WORKDIR /app

# Create a non‑root user to run the app securely
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy the built "standalone" output from the builder stage
COPY --from=builder /app/.next/standalone .
COPY --from=builder /app/.next/static ./ .next/static
COPY --from=builder /app/public ./public

# Set environment variables for production
ENV NODE_ENV=production
ENV PORT=3000

# Expose the port the app runs on
EXPOSE 3000

# Run as non‑root user
USER appuser

# Start the application
CMD ["node", "server.js"]
