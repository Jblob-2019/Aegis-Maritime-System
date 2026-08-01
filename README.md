# Aegis Maritime System

Monorepo for maritime tracking with backend API, web dashboards, and ESP32 firmware.

## Workspace Layout

- apps/
  - backend-api/          Express + Socket.IO API and serial bridge
    - src/
      - api-server.js     Main backend server entrypoint
      - services/
        - serial-bridge.js  USB serial to API bridge
  - dashboard-next/       Next.js dashboard
  - dashboard-vite/       Vite React dashboard
- firmware/
  - esp32/
    - receiver/
      - receiver.ino
    - transmitter/
      - transmitter.ino
- scripts/
  - start.ps1             Runs all app dev servers from workspace root

## Dev Commands

From the repository root:

- npm run dev            Start backend + both dashboards
- npm run dev:backend    Start backend API only
- npm run dev:vite       Start Vite dashboard only
- npm run dev:next       Start Next dashboard only

From apps/backend-api:

- npm run dev            Start API server
- npm run dev:bridge     Start serial bridge (COM input to API)

---

## One‑Command Deploy + Auto‑Update (Docker + Watchtower)

**Goal:** Backend + Next.js dashboard run together in Docker. After the initial setup, a simple
`git push` to `main` rebuilds the images and Watchtower automatically pulls the new
containers – no SSH, no manual restarts. Firmware lives completely outside Docker and
remains unchanged.

### 1️⃣ First‑time server setup (run **once**)
```bash
# Clone the repo on your server
git clone https://github.com/your-username/Aegis-Maritime-System.git
cd Aegis-Maritime-System

# Copy the example env and fill in real secrets (never commit this file)
cp .env.example .env
# Edit .env – set GH_OWNER, Mongo credentials, JWT_SECRET, PUBLIC_SOCKET_URL, etc.
# For example: nano .env

# Pull the images (or let compose build them locally the first time)
# If you keep the images private, you need to log in to GHCR first:
# docker login ghcr.io -u <your‑github‑user> -p <PAT with read:packages>

docker compose up -d
```
That command starts:
- `mongo` (the database)
- `backend` (Node.js API)
- `frontend` (Next.js server, built as a standalone binary)
- `nginx` (TLS termination and reverse proxy)
- `watchtower` (polls GHCR every 2 minutes for new images and restarts the containers)

### 2️⃣ Deploy on every push to `main`
The workflow `.github/workflows/deploy.yml` watches for changes under `apps/backend-api/**`
or `apps/dashboard-next/**` (plus the workflow file itself). When a push happens it:
- builds a new Docker image for the backend and pushes it to `ghcr.io/<owner>/aegis-backend:latest`
- builds a new Docker image for the Next.js frontend and pushes it to `ghcr.io/<owner>/aegis-frontend:latest`
- Watchtower, already running on the server, sees the new digests, pulls the images and
  recreates only the containers whose images changed. No downtime for Mongo, Nginx stays up.

### 3️⃣ Firmware stays separate
`firmware/` is **never** referenced in `docker‑compose.yml`. Flash the ESP32 with the
Arduino IDE or PlatformIO as you already do – the backend API will accept the data
once the Docker deployment is live.

---

## How it works under the hood
- **Dockerfile (frontend)** – multi‑stage build that produces a **standalone** Next.js
  binary (`server.js`) and copies only the needed files into the final image.
- **Dockerfile (backend)** – installs production dependencies only, runs as a non‑root
  user, and health‑checks `/health`.
- **nginx** – reverse‑proxies `/api/*` and `/socket.io/*` to the backend, everything else
  to the frontend. TLS certificates are mounted from `nginx/certs/` on the host.
- **Watchtower** – runs with the `com.centurylinklabs.watchtower.enable=true`
  label on `backend` and `frontend`. It polls GHCR (default every 2 minutes) and
  restarts containers when a newer image digest appears.

## FAQ
- *Do I need to rebuild images locally?* No. The CI workflow builds and pushes them.
- *Can I keep the images private?* Yes – just make sure the server runs `docker login ghcr.io` once with a PAT that has the `read:packages` scope.
- *What if I want a different dashboard?* Update `docker-compose.yml` to point at your alternate Next.js project. The same workflow still works.

Enjoy a zero‑touch, production‑ready deployment!

---

## LAN Deploy (Ubuntu server)

For a single-host LAN deploy (the typical Aegis setup — an Ubuntu box with a Wi-Fi/Ethernet NIC serving phones and laptops on the same network):

- Both `frontend` and `backend` use `network_mode: host`, so they bind directly to the host's network interfaces. No port translation, no Docker bridge NAT.
- `apps/dashboard-next/inject-env.sh` auto-detects the host's primary IPv4 at container start (via `hostname -I`) and bakes it into `window.__ENV__`. **No IP editing required.**
- Override only if your server has multiple NICs and the wrong one is picked: set `HOST_LAN_IP=<lan-ip>` in `.env` before `docker compose up`.
- CORS reflects the request `Origin` by default (`api-server.js`). For a public-internet deploy, lock it down with `ALLOWED_ORIGINS=https://your.domain,...` in `.env`.

Quick check after `docker compose up -d`:
```bash
# Should print the server's LAN IP — phones should be able to open this URL.
docker compose logs frontend | grep DETECTED_HOST_IP
```
