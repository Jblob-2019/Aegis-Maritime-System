// ===========================================================================
// api-server.js — AEGIS Maritime backend
// Modern JavaScript (ESM) with JSDoc type hints. No TypeScript toolchain.
// ===========================================================================
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  console.error('❌ MONGO_URI is not set. Aborting.')
  process.exit(1)
}

// CORS: require FRONTEND_URL to be set explicitly in production. Refuse the
// wildcard so a misconfigured deploy doesn't expose the API to any origin.
if (!FRONTEND_URL || FRONTEND_URL === '*') {
  console.warn(
    '⚠️  FRONTEND_URL is not set (or is "*"). Falling back to same-origin only. ' +
      'Set FRONTEND_URL to the deployed dashboard origin to allow cross-origin requests.',
  )
}
const corsOrigin = FRONTEND_URL && FRONTEND_URL !== '*' ? FRONTEND_URL : false
const corsOptions = {
  origin: corsOrigin, // false = no CORS (same-origin only)
  methods: ['GET', 'POST'],
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
  .connect(MONGO_URI)
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
// 3. ESP32 posts raw location data here
// ---------------------------------------------------------------------------

/**
 * @param {Request}  req
 * @param {Response} res
 */
app.post('/api/location', async (req, res) => {
  const { boatId, lat, lon, distance, zone } = /** @type {LocationPayload} */ (req.body)
  const resolvedBoatId = boatId || 'BOAT1'

  if (lat !== undefined && lon !== undefined) {
    try {
      const newData = new Boat({
        boatId:   resolvedBoatId,
        lat:      parseFloat(/** @type {any} */ (lat)),
        lon:      parseFloat(/** @type {any} */ (lon)),
        distance: parseFloat(/** @type {any} */ (distance)),
        zone:     zone,
      })

      await newData.save()

      // Real-time push to all connected dashboards
      io.emit('locationUpdate', newData)

      // Persist zone-change events on a per-boat basis.
      const prevZone = lastZoneByBoat.get(resolvedBoatId) ?? null
      if (zone && zone !== prevZone) {
        lastZoneByBoat.set(resolvedBoatId, zone)
        const alert = new AlertEvent({
          boatId: resolvedBoatId,
          zone,
          lat: parseFloat(/** @type {any} */ (lat)),
          lon: parseFloat(/** @type {any} */ (lon)),
        })
        await alert.save()
        io.emit('alertEvent', alert)
      }

      console.log(`[SAVED TO DB] Lat: ${lat}, Lon: ${lon}, Zone: ${zone}`)
      res.status(201).json({ message: 'Data saved!', data: newData })
    } catch (err) {
      console.error('❌ DB Save Error:', err)
      res.status(500).json({ error: 'Failed to save to database' })
    }
  } else {
    res.status(400).json({ error: 'Invalid data — lat and lon required' })
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

// Re-export the project root for debugging in dev tools (optional)
export const __filename = fileURLToPath(import.meta.url)
export const __dirname = path.dirname(__filename)
