# Aegis Maritime System — Codebase Audit

**Generated:** 2026-08-30  
**Branch:** jana  
**Commit:** 35f0a99 (backend fix 2)

---

## Executive Summary

A maritime vessel tracking system with three components:
- **Backend** (Node.js/Express + Socket.IO + MongoDB) — `apps/backend-api/`
- **Frontend** (React + Vite + Tailwind) — `apps/dashboard-next/`
- **Firmware** (ESP32 LoRa transmitter + receiver) — `firmware/esp32/`

**Architecture:** LoRa (433 MHz, SF10) → ESP32 receiver → HTTPS → Backend API → WebSocket → Dashboard

**Deploy:** Docker Compose + Watchtower + self-hosted GH Actions → LAN host

---

## PART 1: Normal Codebase Audit

### 1.1 Backend API (`apps/backend-api/src/api-server.js`)

#### ✅ Strengths
- **Modern ESM + JSDoc types** — no TypeScript toolchain overhead
- **Helmet + CORS + rate-limit** — good security baseline
- **JWT auth** (HS256, timing-safe verify) with env-configurable secrets
- **Hardware API key auth** on `/api/location` with constant-time compare
- **Mongo indexes** on `timestamp` and `boatId+timestamp` for query patterns
- **Per-boat zone tracking** via `Map` avoids cross-boat race conditions
- **Graceful shutdown** with SIGINT/SIGTERM handlers
- **Input validation** with clear error messages, zone alias normalization

#### ⚠️ Issues Found

| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| **High** | JWT middleware **bypassed entirely** — `authenticateJwt` sets `req.user = { id: 'dev-user', role: 'admin' }` and calls `next()` without verifying token | Line 355-359 | Enable real JWT verification; remove bypass |
| **High** | **Hardcoded fallback secrets** in production paths (`SAFE_JWT_SECRET`, `SAFE_HARDWARE_API_KEY`) | Lines 75, 82 | Fail fast in production if env vars missing (already partially done) |
| **Medium** | **No request body size limit** on `/api/location` beyond express.json(10kb) — could be tighter for LoRa payloads | Line 165 | Add explicit size check (~500 bytes max for 30-byte packet + JSON overhead) |
| **Medium** | **Mongo connection** lacks retry logic — fails silently in background | Lines 183-195 | Add connection retry with exponential backoff |
| **Medium** | **No structured logging** — `console.log`/`console.error` only | Throughout | Use `pino` or similar; add request IDs |
| **Low** | **Mock endpoints** `/api/logistics`, `/api/comms/latest` return random data | Lines 594-624 | Document as placeholders; move to separate service or remove |
| **Low** | **CORS allows any origin** in dev if `ALLOWED_ORIGINS` empty | Line 147 | Document behavior; consider stricter default |

#### Code Quality
- Clean separation: config → models → middleware → routes → error handling
- JSDoc types are comprehensive and accurate
- Good use of `Map` for per-boat state (avoids race conditions)
- Hardware key validation uses `crypto.timingSafeEqual` correctly

---

### 1.2 Serial Bridge (`apps/backend-api/src/services/serial-bridge.js`)

#### ✅ Strengths
- Simple, focused: reads serial → parses `BOAT1,` packets → POSTs to backend
- Auto-reconnect on port close
- Uses `timingSafeEqual` for hardware key

#### ⚠️ Issues Found

| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| **High** | **No TLS/HTTPS** to backend — `BRIDGE_TARGET` defaults to `http://localhost:4000` | Line 30 | Enforce HTTPS in production; validate cert |
| **Medium** | **No validation** of parsed GPS coordinates before forwarding | Lines 64-68 | Reuse `validateLocationPayload` logic from api-server |
| **Medium** | **Single boat hardcoded** (`BOAT1`) — no multi-boat support | Line 57 | Parse boatId from packet or add config |
| **Low** | **No health endpoint** or metrics | N/A | Add `/health` for monitoring |

---

### 1.3 Frontend Dashboard (`apps/dashboard-next/src/dashboard/page.jsx`)

#### ✅ Strengths
- **Single-file tactical HUD** — all state, UI, logic in one component (~1500 lines)
- **Real-time via Socket.IO** + 5s polling fallback
- **Zone-aware alerting** with toast stack + modal for DANGER
- **Multi-tab navigation** (TACTICAL, BOUNDARY GRID, LOGISTICS, COMMS, DETAILED LOGS)
- **Leaflet map** integration with weather layers (Open-Meteo + OpenWeatherMap)
- **Detailed logs** with filtering, pagination, zone badge rendering
- **Accessibility** considerations (ARIA labels, semantic HTML)

#### ⚠️ Issues Found

| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| **High** | **Massive single component** (1500+ lines) — violates SRP, hard to test/maintain | Entire file | Split into: `useBoats`, `useAlerts`, `useWebSocket`, `useEnvData`, `FleetPanel`, `TelemetryPanel`, `ThreatsPanel`, `LogsPanel`, `Header`, `Footer`, `Toasts`, `DangerModal` |
| **High** | **Hardcoded API key** in OpenWeatherMap call | Line 146 | Move to env var; never commit keys |
| **Medium** | **No TypeScript** — JSDoc only in backend; frontend is untyped JSX | Entire project | Add TypeScript; at minimum JSDoc props for components |
| **Medium** | **Duplicate code blocks** — STRATEGIC/LOGISTICS/COMMS tabs rendered twice (lines 627-748 and 851-904, 1231-1254) | Multiple | Extract to `TabContent` component with render prop |
| **Medium** | **Magic numbers/strings** throughout — zone colors, intervals, timeouts | Lines 14-22, 169, 420, etc. | Extract to constants module |
| **Medium** | **No error boundaries** — crash in any child kills whole dashboard | N/A | Wrap panels in `<ErrorBoundary>` |
| **Medium** | **WebSocket reconnection** handled by socket.io but no UI indicator for stale data | Lines 332-338 | Show "stale" badge when >30s since last update |
| **Low** | **`useCallback` deps** include functions that change (e.g., `addAlert` in `handleBoatsUpdate`) | Line 319 | Verify deps; use `useRef` for stable callbacks |
| **Low** | **Inline styles** mixed with Tailwind — inconsistent | Throughout | Standardize on Tailwind + CSS variables |
| **Low** | **No tests** — zero test coverage | N/A | Add Vitest + React Testing Library |

#### Architecture Notes
- State management is all `useState`/`useRef` — works for current scope but will scale poorly
- Socket.IO + REST polling dual path is good for resilience
- Demo mode embedded in component — should be separate hook/context

---

### 1.4 Firmware — Transmitter (`firmware/esp32/transmitter/transmitter.ino`)

#### ✅ Strengths
- **Excellent documentation** — wire format, radio config, regulatory notes in header
- **Production-grade considerations**: LBT (CAD), HMAC-SHA1, CRC16, NVS persistence, watchdog
- **30-byte binary packet** — efficient, includes magic, version, seq, epoch, lat/lon (1e6), distance, CRC, HMAC
- **Dual output**: LoRa binary + BLE JSON (Nordic UART for phone app)
- **SD card blackbox** logging (CSV)
- **OLED status display** with subsystem indicators
- **Zone calculation** from IMBL polyline (point-to-segment distance)
- **Demo mode** with simulated route for hackathon
- **Static assertions** for compile-time boundary array validation

#### ⚠️ Issues Found

| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| **High** | **LBT (CAD) disabled** — `channelClear()` always returns `true` | Lines 302-305 | Implement proper CAD using RadioHead or ESP-IDF driver; this is a regulatory requirement (WPC/ETSI) |
| **High** | **No boatId in wire format** — receiver derives from seq MSB (placeholder) | Line 253 (receiver) | Add 1-2 byte boatId to packet; update both TX/RX |
| **Medium** | **SHA-1 for HMAC** — cryptographically weak | Line 243 | Migrate to HMAC-SHA256 (mbedTLS supports it) |
| **Medium** | **GPS epoch calculation** ignores leap seconds correctly but no timezone handling | Lines 183-199 | Document assumption (UTC only); OK for maritime |
| **Medium** | **SD card CS not protected** during LoRa SPI transactions — potential bus contention | Lines 321-322 | Current deassert is good; consider SPI mutex |
| **Medium** | **BLE notify** has no delivery confirmation | Line 378 | Acceptable for telemetry; document |
| **Low** | **Magic numbers** for pins, timeouts scattered | Lines 57-66, 71-82 | Already well-organized in `config.h` (not shown) |
| **Low** | **`delay()` in setup** blocks watchdog feed during LoRa init | Line 260 | Use `vTaskDelay` or feed WDT in loop |

#### Code Quality
- **Exceptionally well-written** embedded C++
- Clear separation: helpers → crypto → radio → BLE → SD → OLED → alerts → setup/loop
- Good use of `static constexpr`, `enum class`, RAII patterns
- Defensive programming: bounds checks, const-time compare, error handling
- Comments explain *why*, not just *what*

---

### 1.5 Firmware — Receiver (`firmware/esp32/receiver/receiver.ino`)

#### ✅ Strengths
- **Matches transmitter wire format exactly** — same CRC/HMAC verification
- **Ring buffer queue** (16 slots) for offline backfill
- **Dedup table** (8 boats) with LRU eviction
- **TLS with CA pinning** — `WiFiClientSecure` + `setCACert`
- **Exponential backoff** for WiFi reconnect + POST retry
- **Watchdog** with proper config struct for ESP32 Arduino Core 3.x
- **Explicit no-modem-CRC** — documented why (shared register bit)

#### ⚠️ Issues Found

| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| **High** | **BoatId derived from seq MSB** — fragile, breaks with multiple boats | Lines 252-253, 283-284 | Requires transmitter wire format change (add boatId) |
| **Medium** | **Static CA cert** in `secrets.h` — rotation requires reflash | Line 194 | Add OTA cert update or multiple CA pins |
| **Medium** | **No HTTPS cert validation beyond CA pin** — no hostname verification | Line 194 | `client.setInsecure()` not used (good), but add `server_name` check |
| **Low** | **Ring buffer drops oldest** when full — no persistence across reboot | Lines 155-174 | Acceptable for 16-slot buffer; document |
| **Low** | **`vTaskDelay(10)`** in loop — tight polling | Line 465 | Increase to 50-100ms; LoRa parse is event-driven |

#### Code Quality
- Clean, production-ready embedded code
- Good separation of concerns: packet verify → JSON → queue → drain
- Constant-time HMAC compare prevents timing attacks
- Comments explain hardware quirks (SX1276 CRC register sharing)

---

### 1.6 Infrastructure & Deploy

#### docker-compose.yml
| Severity | Issue | Recommendation |
|----------|-------|----------------|
| **High** | **Hardcoded LAN IP** (`192.168.29.141`) in compose file | Use `${HOST_LAN_IP}` from `.env`; auto-detect in entrypoint |
| **High** | **`network_mode: host`** — bypasses Docker networking, security isolation | Use bridge network with port mapping; add nginx reverse proxy |
| **Medium** | **No MongoDB service** — relies on external Atlas | Document requirement; add optional local mongo for dev |
| **Medium** | **Watchtower polls every 120s** — slow for rapid iteration | Reduce to 30s for dev; keep 120s for prod |
| **Low** | **No healthchecks** on backend/frontend services | Add `/health` endpoints + Docker healthcheck |

#### Package.json (root)
- `concurrently` for dev — good
- `kill-port` for cleanup — good
- Root deps (`axios`, `serialport`) seem unused — verify and remove

---

### 1.7 Documentation & Maintenance

| Item | Status |
|------|--------|
| README.md | Exists but minimal |
| API docs | None (no OpenAPI/Swagger) |
| Architecture diagram | None |
| Firmware build instructions | In code comments only |
| Environment variables | `.env.example` missing (planned in aegis-review-plan) |
| Changelog | None |
| Contributing guide | None |

---

## PART 2: Ponytail Dev Audit (Ultra-Lazy / YAGNI Lens)

> *The best code is the code never written. Delete before adding. Stdlib first. Shortest working diff wins.*

### 2.1 What to DELETE (Immediate Wins)

| File/Code | Reason | Effort |
|-----------|--------|--------|
| **JWT bypass** (`api-server.js:355-359`) | Security hole; 3 lines to fix properly | 5 min |
| **Hardcoded OpenWeatherMap key** (`page.jsx:146`) | Leaked secret; move to env | 2 min |
| **Mock endpoints** `/api/logistics`, `/api/comms/latest` | Dead code; not used by real hardware | 10 min |
| **Duplicate tab renders** (STRATEGIC/LOGISTICS/COMMS ×2) | Copy-paste bug; delete one set | 15 min |
| **Root `axios`, `serialport` deps** | Unused in root package.json | 1 min |
| **`test_db.js`** | Orphan test file; no test runner | 1 min |
| **`components.json`** (shadcn config) | Unused — project uses custom UI | 1 min |

### 2.2 What to REPLACE with Stdlib/Native

| Current | Replace With | Why |
|---------|--------------|-----|
| Custom JWT (`signJwt`/`verifyJwt`) | `jose` library or `jsonwebtoken` | Battle-tested, handles edge cases |
| Manual CORS logic | `cors` options with `origin: true` + env allowlist | 10 lines → 3 lines |
| `toFiniteNumber` + validation | `zod` schema | Declarative, composable, better errors |
| `epochToUtcString` (firmware) | `time.h` / `gmtime_r` | Stdlib, tested |
| `crc16` implementation | `crc16` from `<util/crc16.h>` (AVR) or mbedTLS | Hardware accelerated on some MCUs |

### 2.3 What to CONSOLIDATE

| Area | Current State | Lazy Fix |
|------|---------------|----------|
| **Zone logic** | Duplicated in backend (JS), frontend (JS), transmitter (C++), receiver (C++) | Single source: `config.h` → generate JS constants via build step |
| **Wire format** | Documented in comments only | `packet.md` + codegen for C++ structs + JS parsers |
| **Environment config** | Scattered across `.env`, docker-compose, `public/env.js`, `lib/env.js` | Single `.env.example` → all consumers read from it |
| **Boat ID handling** | Hardcoded `BOAT1` in bridge, derived from seq in receiver | Add to wire format; propagate everywhere |

### 2.4 What NOT to Build (YAGNI)

| Requested/Planned | Verdict | Trigger to Reconsider |
|-------------------|---------|-----------------------|
| Multi-user auth / RBAC | ❌ Single admin is fine for now | Real multi-operator deployment |
| Strategic/Logistics/Comms tabs | ❌ Mock data only | Real backend services exist |
| Historical replay / playback | ❌ Not in requirements | Post-incident analysis need |
| Mobile app | ❌ BLE phone app exists | Native app requirement |
| Kubernetes deploy | ❌ Single-host LAN is target | Multi-host / cloud requirement |
| TypeScript migration | ❌ JSDoc works for now | Team grows >3 devs |

### 2.5 One-Liner Fixes (Ponytail Rung 6)

```javascript
// api-server.js:355 — Replace entire authenticateJwt with:
import jwt from 'jsonwebtoken'
const authenticateJwt = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next() }
  catch { res.status(401).json({ error: 'Invalid token' }) }
}
```

```javascript
// page.jsx:146 — Move to .env:
const weatherRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${import.meta.env.VITE_OPENWEATHER_KEY}`)
```

```cpp
// transmitter.ino:302 — Enable real LBT:
static bool channelClear() {
  if (!LBT_REQUIRED) return true;
  LoRa.receive();                    // Enter RX mode
  delay(2);                          // Listen for CAD symbols
  return LoRa.parsePacket() == 0;    // Channel clear if no packet
}
```

---

## PART 3: Priority Action Plan

### 🔴 Critical (Do First — Security/Compliance)
1. **Enable real JWT auth** — remove bypass in `api-server.js:355`
2. **Remove hardcoded API key** from frontend
3. **Add boatId to LoRa wire format** — update transmitter + receiver
4. **Enable real LBT (CAD)** on transmitter for WPC compliance
5. **Migrate HMAC to SHA-256**

### 🟡 High (Architecture/Scale)
6. **Split dashboard** into logical components + custom hooks
7. **Add TypeScript** to frontend (or JSDoc props at minimum)
8. **Extract zone constants** to single source (`config.h` → codegen)
9. **Add structured logging** (pino) to backend
10. **Fix docker-compose** — remove `network_mode: host`, add nginx

### 🟢 Medium (Quality/DX)
11. **Add tests** — Vitest (frontend), Jest (backend), Unity (firmware)
12. **Create `.env.example`** and document all required vars
13. **Add OpenAPI spec** for backend endpoints
14. **Add healthchecks** to Docker services
15. **Consolidate env loading** — single source of truth

### ⚪ Low (Nice to Have)
16. **Error boundaries** on frontend panels
17. **Stale data indicator** on dashboard
18. **OTA cert update** for receiver
19. **Changelog** + contributing guide
20. **Architecture diagram** (Mermaid in README)

---

## PART 4: File Inventory (Source Only)

```
apps/backend-api/
├── package.json
├── src/
│   ├── api-server.js          # 678 lines — main backend
│   └── services/
│       └── serial-bridge.js   # 102 lines — USB→HTTP bridge

apps/dashboard-next/
├── package.json
├── vite.config.js
├── src/
│   ├── main.jsx               # Entry
│   ├── App.jsx                # Router + providers
│   ├── dashboard/page.jsx     # 1492 lines — MAIN TACTICAL HUD
│   ├── login/page.jsx         # Login page
│   ├── lib/
│   │   ├── env.js             # Runtime env injection
│   │   └── utils.js           # cn() helper
│   └── imports/               # Auto-generated SVG assets
├── components/
│   ├── LeafletMap.jsx         # Map wrapper
│   ├── WeatherCanvasLayer.js  # Weather overlay
│   ├── weatherLayers.js       # Layer configs
│   └── ui/                    # 35+ shadcn-style components
└── public/
    ├── data/                  # GeoJSON boundaries
    └── env.js                 # Injected at build time

firmware/esp32/
├── transmitter/
│   └── transmitter.ino        # 705 lines — boat side
└── receiver/
    └── receiver.ino           # 466 lines — shore side

docker-compose.yml             # 44 lines
package.json                   # Root workspace
.claude/plans/aegis-review-plan.md
```

---

## PART 5: Metrics

| Metric | Value |
|--------|-------|
| **Total source files** | ~50 (excluding node_modules, dist, ui components) |
| **Backend LOC** | ~780 (api-server + serial-bridge) |
| **Frontend LOC** | ~1,500 (main dashboard) + ~2,000 (ui components) |
| **Firmware LOC** | ~1,170 (transmitter + receiver) |
| **Test coverage** | 0% |
| **TypeScript adoption** | 0% (JSDoc only in backend) |
| **Dependencies (prod)** | Backend: 11, Frontend: 52, Firmware: ~15 libs |
| **Docker services** | 3 (backend, frontend, watchtower) + optional mongo |

---

## Conclusion

**The system works** — data flows from ESP32 → LoRa → receiver → HTTPS → backend → WebSocket → dashboard. The firmware is exceptionally well-engineered for embedded. The backend is clean modern Node.js. The frontend is a **monolithic component** that needs splitting before it becomes unmaintainable.

**Top 3 fixes for maximum ROI:**
1. Fix JWT auth bypass (security)
2. Split dashboard into hooks + components (maintainability)
3. Add boatId to wire format (correctness for multi-boat)

Everything else is polish. Ship the lazy version first.