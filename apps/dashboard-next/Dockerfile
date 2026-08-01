# Dockerfile for the AEGIS React (Vite) dashboard (apps/dashboard-next)
# ------------------------------------------------------------
# 1️⃣ Build stage
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY . .
RUN npm run build

# ------------------------------------------------------------
# 2️⃣ Runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app

# Install 'serve' to host the static files
RUN npm install -g serve

# Copy the built Vite output
COPY --from=builder /app/dist ./dist

# Add the env-injection script
COPY inject-env.sh /usr/local/bin/inject-env.sh
RUN chmod +x /usr/local/bin/inject-env.sh

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

# Run the env injector, then start the static server
ENTRYPOINT ["/bin/sh", "-c", "/usr/local/bin/inject-env.sh && serve -s dist -l 3000"]