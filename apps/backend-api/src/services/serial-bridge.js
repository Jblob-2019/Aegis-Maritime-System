// ===========================================================================
// serial-bridge.js — AEGIS LoRa/USB serial bridge
// Reads NMEA-style packets from an ESP32 over USB and forwards them
// to the local backend over HTTP. Modern JavaScript (ESM) + JSDoc types.
// ===========================================================================

import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import axios from 'axios'

/**
 * @typedef {Object} BridgePayload
 * @property {number} lat
 * @property {number} lon
 * @property {number} distance
 * @property {string} zone
 */

// ---------------------------------------------------------------------------
// Configuration – update the COM port to match your base station.
// ---------------------------------------------------------------------------

/** @type {string} */
const SERIAL_PATH = process.env.SERIAL_PATH || 'COM5'
/** @type {number} */
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD) || 115_200
/** @type {string} */
// Default backend URL (override via BRIDGE_TARGET env var).
// Default port matches api-server.js and docker-compose.yml.
const BRIDGE_TARGET = process.env.BRIDGE_TARGET || 'http://localhost:4000/api/location'

const HARDWARE_API_KEY = process.env.HARDWARE_API_KEY
if (process.env.NODE_ENV === 'production' && !HARDWARE_API_KEY) {
  console.error('❌ HARDWARE_API_KEY is missing. The bridge cannot authenticate with the backend in production.')
  process.exit(1)
}
const SAFE_HARDWARE_API_KEY = HARDWARE_API_KEY || 'aegis-hardware-secret-2026'

const port = new SerialPort({ path: SERIAL_PATH, baudRate: SERIAL_BAUD })
const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }))

console.log('🔌 USB Serial Bridge Started! Listening to ESP32…')
console.log(`    path=${SERIAL_PATH}  baud=${SERIAL_BAUD}  target=${BRIDGE_TARGET}`)

// ---------------------------------------------------------------------------
// Listen for incoming lines from the ESP32
// ---------------------------------------------------------------------------

/**
 * @param {string} data
 */
parser.on('data', async (data) => {
  // Print exactly what the ESP32 is saying over USB
  console.log(`[ESP32]: ${data}`)

  // If the data contains a boat packet...
  if (data.includes('BOAT1,')) {
    try {
      const rawString = data.split('BOAT1,')[1]
      const parts = rawString.split(',')

      if (parts.length >= 4) {
        /** @type {BridgePayload} */
        const payload = {
          lat: parseFloat(parts[0]),
          lon: parseFloat(parts[1]),
          distance: parseFloat(parts[2]),
          zone: parts[3].trim(),
        }

        // Forward to the backend (bypasses WiFi and firewalls)
        await axios.post(BRIDGE_TARGET, payload, {
          headers: { 'X-Aegis-Key': SAFE_HARDWARE_API_KEY }
        })
        console.log('✅ Successfully bridged packet to local database!')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('⚠️ Failed to parse or send data:', message)
    }
  }
})

port.on('error', (err) => {
  console.error('❌ Serial Port Error (Is the Arduino Serial Monitor closed?):', err.message)
})

port.on('open', () => {
  console.log('✅ Serial Port Opened Successfully!')
})

port.on('close', () => {
  console.error('⚠️ Serial Port Closed! Will attempt to reconnect in 5 seconds...')
  setTimeout(() => {
    if (!port.isOpen) {
      port.open((err) => {
        if (err) console.error('Reconnect failed:', err.message)
      })
    }
  }, 5000)
})
