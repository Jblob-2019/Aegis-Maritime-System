# Aegis Maritime System — One-Command Deploy + Auto-Update Plan (Updated)

## To‑Do List (in execution order)

1. **Frontend (Next.js) – enable standalone output**
   - Edit `aegis-frontend/next.config.mjs` to add `output: "standalone"`.
   - Remove `ignoreBuildErrors` / `ignoreDuringBuilds` once the build succeeds.
   - Verify `npm run build` succeeds locally.

2. **Create Dockerfile for Next.js frontend**
   - Multi‑stage Dockerfile (`deps → builder → runner`).
   - Use non‑root user, expose port 3000, healthcheck.
   - Add `.dockerignore` to exclude `node_modules`, `.next`, `.git`, `.env*`, `*.log`.
   - Add `start` script in `package.json` (`next start -p 3000`).

3. **Backend Dockerfile**
   - Multi‑stage Dockerfile (`deps → runner`).
   - Non‑root user, expose port 4000, healthcheck (`/health`).
   - Add `.dockerignore` similar to frontend.

4. **Root `docker-compose.yml`**
   - Services: `mongo`, `backend`, `frontend`, `nginx`, `watchtower`.
   - Use image references `ghcr.io/${GH_OWNER}/aegis-backend:latest` and `ghcr.io/${GH_OWNER}/aegis-frontend:latest`.
   - Environment variables from `.env` (MONGO credentials, JWT secret, etc.).
   - Add watchtower labels to `backend` and `frontend`.
   - Add healthchecks for all services where appropriate.
   - Mount `nginx/nginx.conf` and `nginx/certs`.

5. **Add `.env.example` at repo root**
   - Include placeholders for `GH_OWNER`, `MONGO_ROOT_USER`, `MONGO_ROOT_PASSWORD`, `JWT_SECRET`, `PUBLIC_SOCKET_URL`.
   - Document that `.env` must be created on the server and never committed.

6. **Nginx configuration** (`nginx/nginx.conf`)
   - Reverse‑proxy `/api/` and `/socket.io/` to `backend:4000`.
   - Proxy everything else to `frontend:3000`.
   - TLS termination placeholders – mount certs via `nginx/certs/`.

7. **Create `nginx/certs/.gitkeep`** to keep the directory in the repo.

8. **GitHub Actions workflow** (`.github/workflows/deploy.yml`)
   - Trigger on push to `main` when files under `apps/backend-api/**` or `aegis-frontend/**` change.
   - Build backend image and push to GHCR.
   - Build frontend image and push to GHCR.
   - Use `docker/build-push-action@v5` with cache‑from/‑to.
   - Permissions: `contents: read`, `packages: write`.

9. **Update `README.md`**
   - Add a **One‑Command Deploy** section with the steps:
     ```
     git clone <repo>
     cp .env.example .env   # fill in values
     docker compose up -d
     ```
   - Explain that all subsequent pushes to `main` automatically rebuild and redeploy via Watchtower.
   - Note that `firmware/` is completely separate and must be flashed manually.

10. **Remove/disable legacy Vercel deployment files**
    - Either delete `vercel.json` and the GitHub Pages workflow or add a comment that they are deprecated.
    - Ensure the CI pipeline no longer builds the Vercel target.

11. **Verification steps (manual)**
    - `docker compose config` – validate YAML.
    - `docker compose build` – ensure both images build.
    - `docker compose up -d` – confirm containers start, health endpoints are reachable.
    - Push a trivial change to backend or frontend and watch Watchtower pull the new image and restart the container within the poll interval.
    - Confirm that `firmware/` is untouched by Docker (`docker compose ps` shows only mongo, backend, frontend, nginx, watchtower).

12. **Finalize**
    - Commit the new Dockerfiles, workflow, nginx config, `.env.example`, and updated README.
    - Tag a release (optional) and push to main.

---
**Next step**: After exiting plan mode, I will start implementing the items above in the exact order listed.
