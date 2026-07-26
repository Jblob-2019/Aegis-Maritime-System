# Multi-stage Dockerfile for the Node.js backend API (ESM)
# -----------------------------------------------------------
# 1️⃣ Install production dependencies (no dev deps)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 2️⃣ Runtime image – copy only what we need
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Create a non‑root user for security
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER app
EXPOSE 4000

# Health check – uses Node's built-in http module (no extra deps)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node --input-type=module -e "import('http').then(http => http.get('http://localhost:4000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)))"

CMD ["node", "src/api-server.js"]
