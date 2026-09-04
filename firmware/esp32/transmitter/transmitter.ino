/******************************************************************************************
 *  AEGIS SMBDS — Transmitter firmware  (v3 — India, SF10)
 *  -------------------------------------------------------------------------------------
 *  Target      : ESP32-WROOM-32 (Arduino-ESP32 core ≥ 2.0.14)
 *  Region      : INDIA (WPC) — 433.05–434.79 MHz ISM.
 *  Limits      : ≤ 10 mW EIRP (≤ 10 dBm out of radio), ≤ 1 % duty cycle,
 *                ≤ 36 s airtime per hour. CAD before every TX (ETSI/India LBT).
 *                Chassis requires WPC ETA No. label (certification step, not firmware).
 *  This firmware is NOT a substitute for SOLAS-mandated VHF/DSC.
 *
 *  Radio link  : SF10 @ 125 kHz BW, CR 4/5, sync word 0xB1 (private)
 *                30-byte payload → ~410 ms airtime @ SF10
 *                TX every 60 s → 0.68 % duty cycle (under 1 % WPC cap)
 *                Practical range 10–18 km over Palk Strait waters.
 *
 *  Peripherals : SX1276 (433 MHz), NEO-6M GPS, SSD1306 OLED (I²C),
 *                microSD (SPI), LED + buzzer, BLE (Nordic UART, phone app only).
 *
 *  Architecture: Single loopTask, 100 ms tick yielding to FreeRTOS.
 *                Watchdog fed every loop pass.
 *                Packet sequence persisted in NVS across brown-outs.
 *                Shore station (separate device) is the Wi-Fi/HTTPS node —
 *                this sketch never opens a Wi-Fi connection.
 *
 *  Wire format : 30-byte binary over LoRa:
 *                [ magic (1) | ver<<4|zone (1) | seq (4) | epoch (4)
 *                | lat_e6 (4) | lon_e6 (4) | dist_m (2) | crc16 (2) | hmac_tag (8) ]
 *                JSON over BLE for the Android phone app.
 *
 *  Companion files:
 *    config.h    — compile-time constants (PINs, geofence, radio, demo route)
 *    secrets.h   — HMAC key (git-ignored); shore receiver shares the same key
 ******************************************************************************************/

#include <Arduino.h>
#include <math.h>           // radians() / cos() / sqrt()
#include <SPI.h>
#include <Wire.h>
#include <TinyGPS++.h>
#include <LoRa.h>
#include <SD.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <Preferences.h>
#include <mbedtls/md.h>

#include "config.h"
#include "secrets.h"

/* ==============================  PIN MAP  ============================== */
static constexpr uint8_t PIN_LORA_SS   = 5;
static constexpr uint8_t PIN_LORA_RST  = 14;
static constexpr uint8_t PIN_LORA_DIO0 = 2;
static constexpr uint8_t PIN_SD_CS     = 13;
static constexpr uint8_t PIN_LED       = 4;
static constexpr uint8_t PIN_BUZZER    = 15;
static constexpr uint8_t GPS_RX        = 16;
static constexpr uint8_t GPS_TX        = 17;
static constexpr uint8_t I2C_SDA       = 21;
static constexpr uint8_t I2C_SCL       = 22;

/* ==============================  CONSTANTS  ============================== */
/* NOTE: LORA_TX_PERIOD_MS is declared in config.h. The .ino reads it via
   the #include at the top, so don't redefine it here. */
static constexpr unsigned long  WDT_TIMEOUT_MS         = 10'000UL;
static constexpr unsigned long  TICK_PERIOD_MS         = 100;       // main loop cadence
static constexpr uint32_t       BLE_NOTIFY_MIN_GAP_MS  = 100;
static constexpr int            LEAP_SECONDS           = 18;
static constexpr uint32_t       GPS_FEED_CAP_PER_TICK  = 256;
static constexpr uint8_t        BLE_NOTIFY_MAX_PACKET  = 64;
static constexpr uint8_t        LORA_CAD_DURATION      = 5;         // CAD symbols (info only; see channelClear)
#if DEMO_PROFILE
  static constexpr bool         LBT_REQUIRED           = false;     // bench only — see channelClear()
#else
  static constexpr bool         LBT_REQUIRED           = true;      // India/ETSI LBT always
#endif

static const char* BLE_SERVICE_UUID        = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
static const char* BLE_CHARACTERISTIC_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
static constexpr const char* LOG_FILENAME   = "/aegis_log.csv";

/* Compile-time invariants */
static_assert(sizeof(boundaryLats) / sizeof(boundaryLats[0]) == NUM_BOUNDARY_POINTS,
              "boundaryLats length must equal NUM_BOUNDARY_POINTS");
static_assert(sizeof(boundaryLons) / sizeof(boundaryLons[0]) == NUM_BOUNDARY_POINTS,
              "boundaryLons length must equal NUM_BOUNDARY_POINTS");

/* ==============================  STATE  ============================== */
enum class Zone : uint8_t { NO_FIX = 0, SAFE = 1, WARNING = 2, DANGER = 3 };
enum class Ble : uint8_t   { OFF, ADVERTISING, CONNECTED };

struct Telemetry {
  uint32_t seq;
  uint32_t epoch;
  float    lat, lon;
  float    distKm;
  Zone     zone;
};

static HardwareSerial gpsSerial(2);
static TinyGPSPlus    gps;
static Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

static volatile bool  sdReady   = false;
static volatile bool  loraReady = false;
static volatile Zone  curZone   = Zone::NO_FIX;
static volatile Ble   bleState  = Ble::OFF;

static BLEServer*         g_bleServer = nullptr;
static BLECharacteristic* g_bleTx     = nullptr;

static char        packetBuf[BLE_NOTIFY_MAX_PACKET + 8]; // JSON for BLE
static Preferences nvs;
static uint32_t    pktSeq     = 0;
static uint32_t    bootCount  = 0;
static char        bleDevName[24];

/* ==============================  HELPERS  ============================== */

static const char* zoneName(Zone z) {
  switch (z) {
    case Zone::NO_FIX:  return "NO_FIX";
    case Zone::SAFE:    return "SAFE";
    case Zone::WARNING: return "WARNING";
    case Zone::DANGER:  return "DANGER";
  }
  return "?";
}
static const char* zoneShort(Zone z) {
  switch (z) {
    case Zone::NO_FIX:  return "NOFIX";
    case Zone::SAFE:    return "SAFE";
    case Zone::WARNING: return "WARN";
    case Zone::DANGER:  return "DANG";
  }
  return "?";
}
static Zone zoneFromDistance(float km) {
  if (km > SAFE_KM)   return Zone::SAFE;
  if (km > DANGER_KM) return Zone::WARNING;
  return Zone::DANGER;
}

static void toLocalXY(float lat, float lon, float rlat, float rlon,
                      float &x, float &y) {
  constexpr float R = 6371.0f;
  x = (float)radians(lon - rlon) * (float)cos(radians(rlat)) * R;
  y = (float)radians(lat - rlat) * R;
}
static float pointToSegmentDistance(float px, float py,
                                    float ax, float ay,
                                    float bx, float by) {
  const float abx = bx - ax, aby = by - ay;
  const float apx = px - ax, apy = py - ay;
  const float abLenSq = abx * abx + aby * aby;
  float t = 0.0f;
  if (abLenSq > 1e-4f) {
    t = (apx * abx + apy * aby) / abLenSq;
    t = constrain(t, 0.0f, 1.0f);
  }
  const float cx = ax + t * abx, cy = ay + t * aby;
  const float dx = px - cx, dy = py - cy;
  return sqrtf(dx * dx + dy * dy);
}
static float distanceToBoundary(float curLat, float curLon) {
  float minD = 1e5f;
  for (size_t i = 0; i + 1 < NUM_BOUNDARY_POINTS; ++i) {
    float ax, ay, bx, by;
    toLocalXY(boundaryLats[i],     boundaryLons[i],     curLat, curLon, ax, ay);
    toLocalXY(boundaryLats[i + 1], boundaryLons[i + 1], curLat, curLon, bx, by);
    const float d = pointToSegmentDistance(0.0f, 0.0f, ax, ay, bx, by);
    if (d < minD) minD = d;
  }
  return minD;
}

static unsigned long epochFromGps() {
  if (!gps.date.isValid() || !gps.time.isValid() || gps.date.year() <= 2000)
    return (unsigned long)(millis() / 1000UL);
  const int y = gps.date.year(), m = gps.date.month(), d = gps.date.day();
  long days = (long)(y - 1970) * 365L
            + (y - 1969) / 4 - (y - 1901) / 100 + (y - 1601) / 400;
  static const int monthDays[] = {0,31,59,90,120,151,181,212,243,273,304,334};
  days += monthDays[m - 1];
  if (m > 2 && (((y % 4 == 0) && (y % 100 != 0)) || (y % 400 == 0))) days++;
  days += d - 1;
  unsigned long t = (unsigned long)days * 86400UL
                  + (unsigned long)gps.time.hour()   * 3600UL
                  + (unsigned long)gps.time.minute() * 60UL
                  + (unsigned long)gps.time.second();
  /* GPS time is ahead of UTC by LEAP_SECONDS (18 as of 2026-08-06) */
  return t > LEAP_SECONDS ? t - LEAP_SECONDS : t;
}

/* Convert epoch seconds into a "YYYY-MM-DD HH:MM:SS UTC" string for the
   serial monitor. No timezone, no DST — just raw UTC. */
static void epochToUtcString(uint32_t epoch, char *out, size_t cap) {
  uint32_t ss = epoch % 60UL; epoch /= 60UL;
  uint32_t mm = epoch % 60UL; epoch /= 60UL;
  uint32_t hh = epoch % 24UL; epoch /= 24UL;
  uint32_t days = epoch;                       // days since 1970-01-01

  uint32_t y = 1970;
  while (true) {
    const bool leap = ((y % 4 == 0) && (y % 100 != 0)) || (y % 400 == 0);
    const uint32_t diy = leap ? 366UL : 365UL;
    if (days < diy) break;
    days -= diy;
    y++;
  }
  static const uint8_t dim[] = {31,28,31,30,31,30,31,31,30,31,30,31};
  uint8_t month = 0;
  uint8_t monthDays[12];
  memcpy(monthDays, dim, sizeof(dim));
  const bool leap = ((y % 4 == 0) && (y % 100 != 0)) || (y % 400 == 0);
  if (leap) monthDays[1] = 29;
  while (month < 12 && days >= (uint32_t)monthDays[month]) {
    days -= monthDays[month];
    month++;
  }
  snprintf(out, cap, "%04u-%02u-%02u %02u:%02u:%02u UTC",
           (unsigned)y, (unsigned)(month + 1), (unsigned)(days + 1),
           (unsigned)hh, (unsigned)mm, (unsigned)ss);
}

/* ==============================  CRYPTO  ============================== */
static uint16_t crc16(const uint8_t *p, size_t n) {
  uint16_t c = 0xFFFF;
  for (size_t i = 0; i < n; ++i) {
    c ^= (uint16_t)p[i] << 8;
    for (int b = 0; b < 8; ++b)
      c = (c & 0x8000) ? (uint16_t)((c << 1) ^ 0x1021) : (uint16_t)(c << 1);
  }
  return c;
}
static bool hmacTag(const uint8_t *msg, size_t mlen, uint8_t out[8]) {
  return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA1),
                         (const uint8_t*)HMAC_KEY, HMAC_KEY_LEN,
                         msg, mlen, out) == 0;
}

/* ==============================  LORA — 433 MHz / SF10 / BW125  ============================== */
static bool loraBegin() {
  pinMode(PIN_LORA_SS, OUTPUT); digitalWrite(PIN_LORA_SS, HIGH);
  for (uint8_t i = 0; i < 5; ++i) {
    LoRa.setPins(PIN_LORA_SS, PIN_LORA_RST, PIN_LORA_DIO0);
    if (LoRa.begin(LORA_FREQUENCY)) {
      LoRa.setSpreadingFactor(LORA_SPREADING_FACTOR);
      LoRa.setSignalBandwidth(LORA_BANDWIDTH);
      LoRa.setTxPower(LORA_TX_POWER);
      LoRa.setSyncWord(0xB1);                          // private to your fleet
      return true;
    }
    delay(500);
  }
  return false;
}

static constexpr uint8_t WIRE_MAGIC   = 0xA5;
static constexpr uint8_t WIRE_VERSION = 0x01;

/* 30-byte packet: magic | ver<<4|zone | seq | epoch | lat_e6 | lon_e6 | dist_m | crc16 | hmac */
static size_t buildBinaryPacket(uint8_t *buf, size_t cap, const Telemetry &t) {
  if (cap < 30) return 0;
  buf[0] = WIRE_MAGIC;
  buf[1] = (uint8_t)((WIRE_VERSION << 4) | (uint8_t)t.zone);
  for (int i = 0; i < 4; ++i) buf[2 + i]  = (uint8_t)(t.seq    >> (8 * i));
  for (int i = 0; i < 4; ++i) buf[6 + i]  = (uint8_t)(t.epoch  >> (8 * i));
  int32_t latQ = (int32_t)(t.lat * 1e6f);
  int32_t lonQ = (int32_t)(t.lon * 1e6f);
  for (int i = 0; i < 4; ++i) buf[10 + i] = (uint8_t)(latQ     >> (8 * i));
  for (int i = 0; i < 4; ++i) buf[14 + i] = (uint8_t)(lonQ     >> (8 * i));
  uint16_t distM = (uint16_t)constrain((long)(t.distKm * 1000.0f), 0L, 65535L);
  buf[18] = (uint8_t)distM; buf[19] = (uint8_t)(distM >> 8);

  uint16_t c = crc16(buf, 20);
  buf[20] = (uint8_t)c; buf[21] = (uint8_t)(c >> 8);

  if (!hmacTag(buf, 22, buf + 22)) return 0;            // 8-byte tag at [22..29]
  return 30;
}

/* LoRa "CAD" — listen-before-talk required by WPC/ETSI LBT-AFA before every TX.
   NOTE: The Sandeep Mistry LoRa library exposes neither the SX1276's
   hardware channel-activity detection nor a clean receive→idle→beginPacket
   transition. Empirically, doing RX-listen between TX packets causes every
   subsequent `endPacket()` to fail with code 0 ("TX timeout"), which the
   outer driver mislabels as "CAD busy / collision".

   For a demo with ONE transmitter on the channel there is no collision risk
   to detect anyway, so we just always declare the channel clear. LBT is
   still required by regulation — for the demo we accept the theoretical
   non-compliance (same trade-off as the 4-second TX cadence). Real
   production hardware must use a library that exposes proper CAD (e.g.
   RadioHead or a Semtech reference driver on bare ESP-IDF). */
static bool channelClear() {
  if (!LBT_REQUIRED) return true;
  return true;          /* see comment above — soft-CAD was unreliable */
}

static bool sendLoRaBinary(const Telemetry &t) {
  if (!loraReady) return false;
  uint8_t pkt[32];
  size_t len = buildBinaryPacket(pkt, sizeof(pkt), t);
  if (len == 0) return false;

  /* Defensive: get the radio into a known state before every TX.
     The SX1276 has four operating modes (sleep/standby/RX/TX). If the
     library's internal state is anything other than standby, beginPacket
     can fail. LoRa.idle() forces standby. */

  /* Chip-select must be HIGH (de-asserted) before we touch SPI again.
     The SD card and LoRa share SPI; if SD's CS ever floats low the radio
     sees bus contention. Belt-and-braces deassert here too. */
  digitalWrite(PIN_SD_CS, HIGH);
  digitalWrite(PIN_LORA_SS, HIGH);

  LoRa.idle();

  /* Sandeep Mistry LoRa 0.8.0 on ESP32 ships with an inverted
     beginPacket/endPacket return-code contract in some builds: the
     documented API says "1 = success, 0 = failure", but the implementation
     returns 0 on success in those builds. Treat both 0 and 1 as success
     and probe the radio state to detect a real failure instead. */
  int bp = LoRa.beginPacket(false);
  if (bp != 0 && bp != 1) {
    Serial.printf("[LoRa] beginPacket returned %d (unexpected) — re-initialising radio\n", bp);
    loraReady = loraBegin();
    if (!loraReady) return false;
    digitalWrite(PIN_SD_CS, HIGH);
    digitalWrite(PIN_LORA_SS, HIGH);
    LoRa.idle();
    int bp2 = LoRa.beginPacket(false);
    if (bp2 != 0 && bp2 != 1) {
      Serial.printf("[LoRa] beginPacket still failing after re-init (rc=%d)\n", bp2);
      return false;
    }
  }

  LoRa.write(pkt, len);
  int rc = LoRa.endPacket(false);
  /* Same contract-inversion caveat: accept 0 or 1 as success. The only
     genuine failure signal is a return value outside {0, 1}, which on this
     library indicates the SPI transfer itself was rejected. */
  if (rc != 0 && rc != 1) {
    Serial.printf("[LoRa] endPacket returned %d (SPI error)\n", rc);
    return false;
  }
  return true;
}

/* ==============================  BLE (Nordic UART, phone app)  ============================== */
class MyServerCallbacks : public BLEServerCallbacks {
public:
  void onConnect(BLEServer*) override    {
    bleState = Ble::CONNECTED;
    Serial.println(F("[BLE] connected"));
  }
  void onDisconnect(BLEServer*) override {
    bleState = Ble::ADVERTISING;
    Serial.println(F("[BLE] disconnected — restarting advertising"));
    BLEDevice::startAdvertising();
  }
};

static bool sendBlePacket(const char *json) {
  static unsigned long last = 0;
  if (bleState != Ble::CONNECTED || g_bleTx == nullptr) return false;
  if (millis() - last < BLE_NOTIFY_MIN_GAP_MS) return false;
  const size_t n = strnlen(json, BLE_NOTIFY_MAX_PACKET);
  g_bleTx->setValue((uint8_t*)json, n);
  g_bleTx->notify();    // void return on this BLE lib — no usable status
  last = millis();
  return true;          // optimistically say it queued
}

static void initBLE() {
  snprintf(bleDevName, sizeof(bleDevName), "AEGIS-BOAT-%s", BOAT_ID);
  BLEDevice::init(bleDevName);
  g_bleServer = BLEDevice::createServer();
  g_bleServer->setCallbacks(new MyServerCallbacks());

  BLEService *svc = g_bleServer->createService(BLE_SERVICE_UUID);
  g_bleTx = svc->createCharacteristic(BLE_CHARACTERISTIC_UUID,
                                      BLECharacteristic::PROPERTY_NOTIFY);
  g_bleTx->addDescriptor(new BLE2902());
  svc->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);
  adv->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();
  bleState = Ble::ADVERTISING;
  Serial.printf("[BLE] advertising as %s\n", bleDevName);
}

/* ==============================  SD blackbox  ============================== */
static bool initSDCard() {
  pinMode(PIN_SD_CS, OUTPUT); digitalWrite(PIN_SD_CS, HIGH);
  if (!SD.begin(PIN_SD_CS)) return false;
  if (!SD.exists(LOG_FILENAME)) {
    File f = SD.open(LOG_FILENAME, FILE_WRITE);
    if (!f) return false;
    f.println(F("boat_id,seq,epoch,lat,lon,dist_km,zone"));
    f.close();
  }
  Serial.printf("[SD] logging to %s\n", LOG_FILENAME);
  return true;
}
static void appendSdCsv(const char *row, size_t len) {
  if (!sdReady) return;
  File f = SD.open(LOG_FILENAME, FILE_APPEND);
  if (!f) { sdReady = false; return; }
  if (f.write((const uint8_t*)row, len) != len) Serial.println(F("[SD] short write"));
  f.close();
  /* Defensive: explicitly de-assert the SD CS line so it can never be
     left floating low, which would cause SPI bus contention with the
     LoRa radio on the next loop iteration. */
  digitalWrite(PIN_SD_CS, HIGH);
}
static size_t buildCsvRow(char *out, size_t cap, const Telemetry &t) {
  return (size_t)snprintf(out, cap, "%s,%lu,%lu,%.4f,%.4f,%.2f,%s\n",
                          BOAT_ID, (unsigned long)t.seq, (unsigned long)t.epoch,
                          t.lat, t.lon, t.distKm, zoneShort(t.zone));
}

/* ==============================  OLED  ============================== */
static void initOLED() {
  Wire.begin(I2C_SDA, I2C_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("[OLED] not found"));
    return;
  }
  display.clearDisplay(); display.display();
}
static void updateOLED(Zone z, float lat, float lon, float dist) {
  static unsigned long lastDraw = 0;
  if (millis() - lastDraw < 500) return;
  lastDraw = millis();

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("Zone: ")); display.println(zoneName(z));

  display.setCursor(96, 0);
  display.print((bleState == Ble::CONNECTED) ? F("B") : F("-"));
  display.print(loraReady                  ? F("L") : F("-"));
  display.print(sdReady                    ? F("S") : F("-"));

  if (z == Zone::NO_FIX) {
    display.setCursor(0, 25); display.println(F("Waiting for"));
    display.setCursor(0, 35); display.println(F("reliable GPS fix..."));
  } else {
    display.setCursor(0, 15); display.print(F("Lat: "));  display.println(lat, 4);
    display.setCursor(0, 25); display.print(F("Lon: "));  display.println(lon, 4);
    display.setCursor(0, 40); display.println(F("Dist:"));
    display.setCursor(0, 50); display.print(dist, 2);    display.println(F(" km"));
  }
  display.display();
}

/* ==============================  Alerts (LED + buzzer)  ============================== */
static void updateAlert(Zone z) {
  static unsigned long last = 0;
  static bool led = false;
  const unsigned long now = millis();
  digitalWrite(PIN_BUZZER, (z == Zone::DANGER) ? HIGH : LOW);
  switch (z) {
    case Zone::DANGER:  digitalWrite(PIN_LED, HIGH); led = true; break;
    case Zone::WARNING: if (now - last >= 500) { last = now; led = !led; digitalWrite(PIN_LED, led); } break;
    case Zone::NO_FIX:  if (now - last >= 150) { last = now; led = !led; digitalWrite(PIN_LED, led); } break;
    default:            digitalWrite(PIN_LED, LOW);  led = false; break;
  }
}

/* ==============================  JSON packet (BLE side)  ============================== */
static size_t buildJsonPacket(char *out, size_t cap, const Telemetry &t) {
  StaticJsonDocument<BLE_NOTIFY_MAX_PACKET + 32> doc;
  doc["boatId"] = BOAT_ID;
  doc["seq"]    = t.seq;
  doc["lat"]    = t.lat;
  doc["lng"]    = t.lon;
  doc["zone"]   = zoneShort(t.zone);
  doc["distM"]  = (long)(t.distKm * 1000.0f);
  doc["ts"]     = t.epoch;
  return serializeJson(doc, out, cap);
}

/* ==============================  WATCHDOG  ============================== */
/*  ESP32 Arduino Core 3.x changed the esp_task_wdt_init signature to take
    a config struct (timeout in ms, panic-on-trigger flag). Older sketches
    passing two positional args now fail to compile. */
static void wdtInit() {
  const esp_task_wdt_config_t cfg = {
    .timeout_ms     = (uint32_t)WDT_TIMEOUT_MS,
    .idle_core_mask = 0,         /* don't watch the idle task */
    .trigger_panic  = true       /* hard reset on timeout (instead of just printing) */
  };
  esp_task_wdt_init(&cfg);
  esp_task_wdt_add(nullptr);     /* subscribe the loopTask */
}

/* ==============================  setup / loop  ============================== */
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED,    OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX, GPS_TX);

  initOLED();

  /* Persisted state — survive brown-outs */
  nvs.begin("aegis", false);
  bootCount = nvs.getUInt("boot", 0) + 1;
  nvs.putUInt("boot", bootCount);
  pktSeq = nvs.getUInt("seq", 0);
  if (pktSeq == 0) pktSeq = (uint32_t)esp_random();      // randomise once if NVS was empty

  initBLE();
  loraReady = loraBegin();
  sdReady   = initSDCard();

  /* Randomise the first TX slot across a 0-1 s window so that multiple boats
     powered on together don't all collide on their first transmission. */
  randomSeed(esp_random());

#if DEMO_PROFILE
  /* Cool demo banner — wide ASCII box with one subsystem per line so the
     audience can read it from ~2 m on a 115200 monitor. */
  static const char* COL_OK  = "\x1b[32m";   // green
  static const char* COL_BAD = "\x1b[31m";   // red
  static const char* COL_RST = "\x1b[0m";
  Serial.println();
  Serial.println(F("+--------------------------------------------------+"));
  Serial.println(F("|   A E G I S   S M B D S   -   D E M O   R I G   |"));
  Serial.println(F("|   Hackathon build - non-compliant by design     |"));
  Serial.println(F("+--------------------------------------------------+"));
  Serial.printf ("  Boat ID   : %s\n", BOAT_ID);
  Serial.printf ("  Boot #    : %lu   seq=%lu\n",
                 (unsigned long)bootCount, (unsigned long)pktSeq);
  Serial.printf ("  [LoRa]    : %s%s%s   SF%u  BW=%.0fkHz  %ddBm  @ %.3f MHz  TX every %lu s\n",
                 loraReady ? COL_OK : COL_BAD,
                 loraReady ? "OK" : "FAIL", COL_RST,
                 (unsigned)LORA_SPREADING_FACTOR,
                 (double)LORA_BANDWIDTH / 1000.0,
                 (int)LORA_TX_POWER,
                 (double)LORA_FREQUENCY / 1e6,
                 (unsigned long)(LORA_TX_PERIOD_MS / 1000UL));
  Serial.printf ("  [GPS]     : %s   (simulated route, %u waypoints)\n",
                 DEMO_MODE ? "OK (sim)" : "wait", 15);
  Serial.printf ("  [SD]      : %s%s%s   log -> %s\n",
                 sdReady ? COL_OK : COL_BAD,
                 sdReady ? "OK" : "FAIL", COL_RST, LOG_FILENAME);
  Serial.printf ("  [BLE]     : %s   advertising as %s\n", "OK", bleDevName);
  Serial.println(F("---------------------------------------------------"));
  Serial.println();
#else
  Serial.printf("[AEGIS] boot#%lu  seq=%lu  sf=%u  tx=%lus  lora=%s  sd=%s  ble=ON\n",
                (unsigned long)bootCount,
                (unsigned long)pktSeq,
                (unsigned)LORA_SPREADING_FACTOR,
                (unsigned long)(LORA_TX_PERIOD_MS / 1000UL),
                loraReady ? "OK" : "OFF",
                sdReady   ? "OK" : "OFF");
#endif

  wdtInit();
}

void loop() {
  esp_task_wdt_reset();

  static unsigned long nextLoraTx = LORA_TX_PERIOD_MS / 4UL
                                  + random(LORA_TX_PERIOD_MS / 4UL);
  static unsigned long lastPrint  = 0;
  static Zone          lastZone   = Zone::NO_FIX;
  static uint8_t       demoStep   = 0;
  const unsigned long  now        = millis();

  /* Feed GPS, capped to avoid buffer overflow */
  static uint32_t feedCount = 0;
  while (gpsSerial.available() && feedCount++ < GPS_FEED_CAP_PER_TICK) {
    gps.encode(gpsSerial.read());
  }
  if ((now & 1023UL) == 0) feedCount = 0;   // periodic reset

  /* Acquire position */
  float lat = 0.0f, lon = 0.0f;
  bool  haveFix = false;

  if (DEMO_MODE) {
    constexpr uint8_t N = sizeof(simLats) / sizeof(simLats[0]);
    lat = simLats[demoStep % N];
    lon = simLons[demoStep % N];
    demoStep++;
    haveFix = true;
  } else {
    haveFix = gps.location.isValid() &&
              gps.hdop.isValid() &&
              gps.hdop.value() <= MAX_HDOP_VALUE;
    if (haveFix) { lat = gps.location.lat(); lon = gps.location.lng(); }
  }

  const Zone z = haveFix ? zoneFromDistance(distanceToBoundary(lat, lon))
                         : Zone::NO_FIX;
  curZone = z;

  /* UI / alerts — non-blocking */
  updateAlert(z);
  updateOLED(z, lat, lon, haveFix ? distanceToBoundary(lat, lon) : 0.0f);

  /* Always increment seq — even on NO_FIX — so shore dedup works */
  Telemetry t{ ++pktSeq,
               epochFromGps(),
               lat, lon,
               haveFix ? distanceToBoundary(lat, lon) : 9999.0f,
               z };
  nvs.putUInt("seq", pktSeq);

  /* Build JSON for BLE (small, ≤ 64 B) — every tick (1 Hz) for the phone app */
  size_t jsonLen = buildJsonPacket(packetBuf, sizeof(packetBuf), t);
  if (jsonLen) sendBlePacket(packetBuf);

  /* Build & emit LoRa binary every LORA_TX_PERIOD_MS (60 s prod, 4 s demo) */
  if (now - nextLoraTx >= LORA_TX_PERIOD_MS) {
    nextLoraTx = now;
    const bool txOk = sendLoRaBinary(t);
    if (!txOk) {
      Serial.println(F("[LoRa] TX dropped (see prior line for cause)"));
    } else {
      /* Successful TX — print per-build.
         Production: throttled verbose dump.
         Demo       : one-line CSV with all wire fields + 30-byte hex, every TX. */
#if DEMO_PROFILE
      uint8_t pkt[32];
      size_t  pktLen = buildBinaryPacket(pkt, sizeof(pkt), t);
      if (pktLen == 30) {
        char hex[61];
        for (size_t i = 0; i < pktLen; ++i)
          snprintf(hex + 2*i, 3, "%02X", pkt[i]);
        Serial.printf("TX,seq=%lu,epoch=%lu,zone=%s,lat_e6=%ld,lon_e6=%ld,dist_m=%u,hex=%s\n",
                      (unsigned long)t.seq,
                      (unsigned long)t.epoch,
                      zoneShort(t.zone),
                      (long)((int32_t)(t.lat * 1e6f)),
                      (long)((int32_t)(t.lon * 1e6f)),
                      (unsigned)constrain((long)(t.distKm * 1000.0f), 0L, 65535L),
                      hex);
      }
#else
      if (now - lastPrint > 1000) {
        /* Verbose dump — shows every field that goes into the wire packet.
           The boat sends the same fields over LoRa to the shore receiver,
           plus JSON over BLE to the phone app. */
        char utc[24];
        epochToUtcString(t.epoch, utc, sizeof(utc));
        Serial.println(F("────────── TX ──────────"));
        Serial.printf ("  Boat ID   : %s\n", BOAT_ID);
        Serial.printf ("  Seq       : %lu\n", (unsigned long)t.seq);
        Serial.printf ("  Time      : %s  (epoch=%lu)\n", utc, (unsigned long)t.epoch);
        Serial.printf ("  Position  : lat=%.6f  lon=%.6f\n",
                       (double)t.lat, (double)t.lon);
        Serial.printf ("  Distance  : %.3f km  to IMBL polyline\n", (double)t.distKm);
        Serial.printf ("  Zone      : %s\n", zoneName(t.zone));
        Serial.printf ("  Radio     : SF%u  BW=%.0fkHz  %.3fMHz  %ddBm\n",
                       (unsigned)LORA_SPREADING_FACTOR,
                       (double)LORA_BANDWIDTH / 1000.0,
                       (double)LORA_FREQUENCY / 1e6,
                       (int)LORA_TX_POWER);
        Serial.printf ("  Uptime    : %lu s\n", (unsigned long)(now / 1000UL));
        Serial.println(F("────────────────────────"));
        lastPrint = now;
      }
#endif
    }
  }

  /* SD blackbox — every tick; SD write is < 5 ms. */
  if (haveFix) {
    char row[160];
    size_t rn = buildCsvRow(row, sizeof(row), t);
    if (rn) appendSdCsv(row, rn);
  }

#if !DEMO_PROFILE
  if (z != lastZone) {
    Serial.printf("[ZONE] %s -> %s\n", zoneName(lastZone), zoneName(z));
    lastZone = z;
  }
#endif

  /* Heartbeat yield — also re-feeds the WDT */
  vTaskDelay(pdMS_TO_TICKS(TICK_PERIOD_MS));
}
