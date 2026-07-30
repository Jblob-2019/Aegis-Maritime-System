// ===========================================================================
// api-server.js — AEGIS Maritime backend
// Modern JavaScript (ESM) with JSDoc type hints. No TypeScript toolchain.
// ===========================================================================
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import http from 'node:http'
import { Server } from 'socket.io'

// ---------------------------------------------------------------------------
// JSDoc type definitions (replace the previous TypeScript interfaces)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BoatRecord
 * @property {string}  [_id]      Mongo document id
 * @property {string}  boatId     Optional boat identifier (default "BOAT1")
 * @property {number}  lat        Latitude (decimal degrees)
 * @property {number}  lon        Longitude (decimal degrees)
 * @property {number} [distance]  Distance to the nearest boundary in km
 * @property {string} [zone]      "SAFE" | "WARNING" | "DANGER" | "ALERT" | "CLEAR"
 * @property {Date}    timestamp  When the ping was recorded
 */

/**
 * @typedef {Object} AlertEvent
 * @property {string}  [_id]
 * @property {string}  boatId
 * @property {string}  zone
 * @property {number}  lat
 * @property {number}  lon
 * @property {Date}    timestamp
 */

/**
 * @typedef {Object} LocationPayload
 * @property {string} [boatId]
 * @property {number} lat
 * @property {number} lon
 * @property {number} [distance]
 * @property {string} [zone]
 */

/**
 * @typedef {import('express').Request}  Request
 * @typedef {import('express').Response} Response
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Default backend port (override via PORT env, e.g. set in docker-compose.yml).
// Compose publishes the backend on 4000, so 4000 is the right default.
const PORT = Number(process.env.PORT) || 4000
const FRONTEND_URL = process.env.FRONTEND_URL
const MONGO_URI = process.env.MONGO_URI

if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not set – backend cannot connect to MongoDB Atlas.')
  console.error('   Make sure docker-compose.yml has env_file: .env and the host .env exists.')
  process.exit(1)
}

// Mask the password before logging so we don't leak secrets to the log output.
const maskedUri = MONGO_URI.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@)/, '$1***$3')
console.log('🔧 Backend starting with PORT=', PORT)
console.log('🔧 MONGO_URI =', maskedUri)

// CORS: allow FRONTEND_URL if set, otherwise reflect request origin to enable cross-origin API calls & WebSockets.
const corsOrigin = FRONTEND_URL && FRONTEND_URL !== '*' ? FRONTEND_URL : true
const corsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}

// ---------------------------------------------------------------------------
// App + Socket.IO setup
// ---------------------------------------------------------------------------

const app = express()
app.use(cors(corsOptions))
app.use(express.json())

const server = http.createServer(app)
const io = new Server(server, { cors: corsOptions })

// ---------------------------------------------------------------------------
// 1. Connect to MongoDB
// ---------------------------------------------------------------------------

mongoose
  .connect(MONGO_URI, {
    // Time out quickly if the Atlas cluster can't be reached so we see the
    // error in the logs instead of hanging silently.
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  })
  .then(() => console.log('✅ MongoDB Atlas Connected!'))
  .catch((err) => console.log('❌ MongoDB Connection Error:', err))

// ---------------------------------------------------------------------------
// 2. Mongoose schemas & models
// ---------------------------------------------------------------------------

const boatSchema = new mongoose.Schema({
  boatId:    { type: String, default: 'BOAT1' },
  lat:       { type: Number, required: true },
  lon:       { type: Number, required: true },
  distance:  { type: Number },
  zone:      { type: String },
  timestamp: { type: Date, default: Date.now },
})
// Indexes for the queries the API makes (get-latest, history per boat).
boatSchema.index({ timestamp: -1 })
boatSchema.index({ boatId: 1, timestamp: -1 })
const Boat = mongoose.model('Boat', boatSchema)

const alertSchema = new mongoose.Schema({
  boatId:    { type: String, default: 'BOAT1' },
  zone:      { type: String },
  lat:       { type: Number },
  lon:       { type: Number },
  timestamp: { type: Date, default: Date.now },
})
alertSchema.index({ timestamp: -1 })
const AlertEvent = mongoose.model('AlertEvent', alertSchema)

/**
 * Per-boat last zone seen by the server (used to detect zone changes).
 * Using a Map avoids race conditions where two boats racing through zones
 * incorrectly trigger alerts for each other.
 * @type {Map<string, string|null>}
 */
const lastZoneByBoat = new Map()

// ---------------------------------------------------------------------------
// 2b. Health check
// ---------------------------------------------------------------------------

/**
 * @param {Request}  _req
 * @param {Response} res
 */
app.get('/health', (_req, res) => {
  const dbState = mongoose.connection.readyState
  const dbConnected = dbState === 1

  res.status(200).json({
    status: 'ok',
    service: 'aegis-backend-api',
    db: dbConnected ? 'connected' : 'disconnected',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// 2c. Auth login (token-based)
// ---------------------------------------------------------------------------

/**
 * Demo-grade login endpoint. The hackathon route (the front-end still
 * supports the admin/admin123 shortcut) goes through here as well so the
 * back-end is the single source of truth for credentials.
 *
 * In production replace this with hashed-password verification against a
 * User model + a signed JWT. For now, credentials are read from env so
 * operators can rotate them without redeploying.
 *
 * @param {Request}  req
 * @param {Response} res
 */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {}
  const adminUser = process.env.ADMIN_USER || 'admin'
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123'

  if (!username || !password) {
    return res.status(400).json({ message: 'username and password are required' })
  }

  if (username !== adminUser || password !== adminPass) {
    return res.status(401).json({ message: 'Invalid credentials. Access Denied.' })
  }

  // Token: short opaque string. In production this would be a JWT signed
  // with JWT_SECRET. We pass back a base64 timestamp so the existing
  // front-end (which only stores it in localStorage) keeps working.
  const token = Buffer.from(`${username}:${Date.now()}`).toString('base64')
  res.json({
    role: 'admin',
    token,
    boatId: null,
  })
})

// ---------------------------------------------------------------------------
// 2d. Input validation helpers
// ---------------------------------------------------------------------------

const ALLOWED_ZONES = ['SAFE', 'WARNING', 'DANGER', 'ALERT', 'CLEAR', 'UNKNOWN']

/**
 * Coerce a value into a finite number, or return NaN.
 * @param {unknown} v
 * @returns {number}
 */
function toFiniteNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Validate a `POST /api/location` payload. Returns either the cleaned data
 * (with parsed floats) or a string describing the first failure.
 * @param {unknown} body
 * @returns {{ ok: true, data: LocationPayload } | { ok: false, error: string }}
 */
function validateLocationPayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object' }
  }
  const { boatId, lat, lon, distance, zone } = body

  if (typeof boatId !== 'string' || boatId.trim() === '' || boatId.length > 64) {
    return { ok: false, error: 'boatId must be a non-empty string (max 64 chars)' }
  }

  const latN = toFiniteNumber(lat)
  const lonN = toFiniteNumber(lon)
  if (!Number.isFinite(latN) || latN < -90 || latN > 90) {
    return { ok: false, error: 'lat must be a finite number between -90 and 90' }
  }
  if (!Number.isFinite(lonN) || lonN < -180 || lonN > 180) {
    return { ok: false, error: 'lon must be a finite number between -180 and 180' }
  }

  let distanceN = null
  if (distance !== undefined && distance !== null) {
    distanceN = toFiniteNumber(distance)
    if (!Number.isFinite(distanceN) || distanceN < 0 || distanceN > 10000) {
      return { ok: false, error: 'distance must be a non-negative finite number' }
    }
  }

  if (zone !== undefined && zone !== null && !ALLOWED_ZONES.includes(zone)) {
    return {
      ok: false,
      error: `zone must be one of: ${ALLOWED_ZONES.join(', ')}`,
    }
  }

  return {
    ok: true,
    data: {
      boatId: boatId.trim(),
      lat: latN,
      lon: lonN,
      distance: distanceN,
      zone: zone ?? undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// 3. ESP32 posts raw location data here
// ---------------------------------------------------------------------------

/**
 * @param {Request}  req
 * @param {Response} res
 */
app.post('/api/location', async (req, res) => {
  const validation = validateLocationPayload(req.body)
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error })
  }
  const { boatId, lat, lon, distance, zone } = validation.data

  try {
    const newData = new Boat({
      boatId,
      lat,
      lon,
      distance,
      zone,
    })

    await newData.save()

    // Real-time push to all connected dashboards
    io.emit('locationUpdate', newData)

    // Persist zone-change events on a per-boat basis.
    const prevZone = lastZoneByBoat.get(boatId) ?? null
    if (zone && zone !== prevZone) {
      lastZoneByBoat.set(boatId, zone)
      const alert = new AlertEvent({
        boatId,
        zone,
        lat,
        lon,
      })
      await alert.save()
      io.emit('alertEvent', alert)
    }

    console.log(`[SAVED TO DB] BoatId: ${boatId}, Lat: ${lat}, Lon: ${lon}, Zone: ${zone}`)
    res.status(201).json({ message: 'Data saved!', data: newData })
  } catch (err) {
    console.error('❌ DB Save Error:', err)
    res.status(500).json({ error: 'Failed to save to database' })
  }
})

// ---------------------------------------------------------------------------
// 4. React dashboard gets the latest record
// ---------------------------------------------------------------------------

/**
 * @param {Request}  _req
 * @param {Response} res
 */
app.get('/api/location', async (_req, res) => {
  try {
    const latest = await Boat.findOne().sort({ timestamp: -1 })
    if (latest) {
      res.json(latest)
    } else {
      res.json({
        lat: 9.30,
        lon: 80.50,
        distance: 25.0,
        zone: 'SAFE',
        timestamp: new Date().toISOString(),
      })
    }
  } catch (err) {
    console.error('❌ DB Fetch Error:', err)
    res.status(500).json({ error: 'Failed to fetch data' })
  }
})

// ---------------------------------------------------------------------------
// 5. Movement history (latest 200 records, optionally filtered by boatId)
// ---------------------------------------------------------------------------

/**
 * @param {Request}  req
 * @param {Response} res
 */
app.get('/api/location/history', async (req, res) => {
  try {
    const query = {}
    if (req.query.boatId) query.boatId = String(req.query.boatId)
    const all = await Boat.find(query).sort({ timestamp: -1 }).limit(200)
    res.json(all)
  } catch (err) {
    console.error('❌ DB History Error:', err)
    res.status(500).json({ error: 'Failed to fetch history' })
  }
})

// ---------------------------------------------------------------------------
// 5b. Latest location per boat (group by boatId)
// ---------------------------------------------------------------------------

/**
 * @param {Request}  _req
 * @param {Response} res
 */
app.get('/api/location/latest', async (_req, res) => {
  try {
    const latestPerBoat = await Boat.aggregate([
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$boatId',
          boatId:    { $first: '$boatId' },
          lat:       { $first: '$lat' },
          lon:       { $first: '$lon' },
          distance:  { $first: '$distance' },
          zone:      { $first: '$zone' },
          timestamp: { $first: '$timestamp' },
        },
      },
      { $sort: { boatId: 1 } },
    ])
    res.json(latestPerBoat)
  } catch (err) {
    console.error('❌ DB Latest Error:', err)
    res.status(500).json({ error: 'Failed to fetch latest boat locations' })
  }
})

// ---------------------------------------------------------------------------
// 6. Alert events (newest 100, optionally filtered by boatId)
// ---------------------------------------------------------------------------

/**
 * @param {Request}  req
 * @param {Response} res
 */
app.get('/api/alerts', async (req, res) => {
  try {
    const query = {}
    if (req.query.boatId) query.boatId = String(req.query.boatId)
    const alerts = await AlertEvent.find(query).sort({ timestamp: -1 }).limit(100)
    res.json(alerts)
  } catch (err) {
    console.error('❌ DB Alerts Error:', err)
    res.status(500).json({ error: 'Failed to fetch alerts' })
  }
})

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`)
})
