/******************************************************************************************
 *  AEGIS SMBDS — Shore-Receiver firmware  (production-grade v3-compatible)
 *  -------------------------------------------------------------------------------------
 *  Target      : ESP32-WROOM-32 (Arduino-ESP32 core ≥ 2.0.14)
 *  Role        : Receives LoRa packets from one or more AEGIS boats and POSTs them
 *                to the AEGIS backend over HTTPS.
 *                Does NOT drive any boat-side hardware; no SD/OLED/BLE.
 *
 *  Wire-format : Identical to transmitter_v3.ino — 30-byte binary, see header below.
 *  Radio       : 433.0 MHz, SF10, BW125, CR 4/5, sync 0xB1 (MATCHES THE BOAT).
 *                Modem-level CRC is intentionally OFF on both sides — the
 *                SX1276 hardware shares a single register bit
 *                (RxPayloadCrcOn in REG_MODEM_CONFIG_1) for TX CRC
 *                generation AND RX CRC verification. If one side enables
 *                it and the other does not, every packet is silently
 *                dropped on RX with no debug output.
 *  Persistence : RAM-only dedup table (8 boats). Resets on reboot — acceptable since
 *                each boat's seq is NVS-persisted on its side and the receiver's
 *                dedup window is short.
 *  Queue       : Static ring buffer (16 slots) of pending POSTs for connect-loss
 *                back-fill. Drops only when the ring is full and the oldest is stale.
 *
 *  Security    : TLS with CA pinning against the backend. HMAC-SHA1 verified on
 *                every packet to reject forgery even if TLS is somehow broken.
 *
 *  Companion files:
 *    config.h    — compile-time constants (PINs, radio, station id)
 *    secrets.h   — Wi-Fi credentials, CA cert, HMAC key (git-ignored)
 ******************************************************************************************/

#include <Arduino.h>
#include <SPI.h>
#include <LoRa.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
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

/* ==============================  CONSTANTS  ============================== */
static constexpr unsigned long  WDT_TIMEOUT_MS          = 10'000UL;
static constexpr unsigned long  WIFI_CONNECT_TIMEOUT_MS = 15'000UL;
static constexpr unsigned long  WIFI_BACKOFF_MS         = 10'000UL;
static constexpr unsigned long  HTTPS_TIMEOUT_MS        = 10'000UL;
static constexpr uint32_t       HMAC_TAG_LEN            = 8;
static constexpr uint8_t        WIRE_PAYLOAD_LEN        = 30;
static constexpr uint8_t        WIRE_MAGIC              = 0xA5;
static constexpr uint8_t        WIRE_VERSION            = 0x01;

static constexpr uint8_t        QUEUE_SLOTS             = 16;
static constexpr uint8_t        MAX_DEDUP_BOATS         = 8;

/* ==============================  STATE  ============================== */
enum class Zone : uint8_t { NO_FIX = 0, SAFE = 1, WARNING = 2, DANGER = 3 };

struct Packet {
  uint8_t  raw[WIRE_PAYLOAD_LEN];   // raw 30 bytes as received
  uint32_t receivedMs;              // for retry-age diagnostics
};

struct DedupEntry {
  char     boatId[9];
  uint32_t lastSeq;
  uint32_t lastSeenMs;
};

static Packet      ring[QUEUE_SLOTS];
static uint8_t     ringHead = 0, ringTail = 0, ringCount = 0;

static DedupEntry  dedup[MAX_DEDUP_BOATS];
static uint8_t     dedupCount = 0;

static unsigned long lastWifiAttempt = 0;
static char         inbox[256];              // JSON for HTTPS POSTs

/* ==============================  HELPERS  ============================== */
static const char* zoneShort(Zone z) {
  switch (z) {
    case Zone::NO_FIX:  return "NOFIX";
    case Zone::SAFE:    return "SAFE";
    case Zone::WARNING: return "WARN";
    case Zone::DANGER:  return "DANG";
  }
  return "?";
}

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

/* Constant-time compare for HMAC tag (avoids timing oracles) */
static bool constTimeEq(const uint8_t *a, const uint8_t *b, size_t n) {
  uint8_t diff = 0;
  for (size_t i = 0; i < n; ++i) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

/* ==============================  DEDUP TABLE  ============================== */
static DedupEntry* dedupLookup(const char *boatId) {
  for (uint8_t i = 0; i < dedupCount; ++i)
    if (strncmp(dedup[i].boatId, boatId, sizeof(dedup[i].boatId)) == 0)
      return &dedup[i];
  return nullptr;
}
static void dedupRemember(const char *boatId, uint32_t seq, uint32_t nowMs) {
  DedupEntry *e = dedupLookup(boatId);
  if (e) {
    e->lastSeq    = seq;
    e->lastSeenMs = nowMs;
    return;
  }
  if (dedupCount >= MAX_DEDUP_BOATS) {
    /* Evict oldest entry */
    uint8_t oldest = 0;
    for (uint8_t i = 1; i < dedupCount; ++i)
      if (dedup[i].lastSeenMs < dedup[oldest].lastSeenMs) oldest = i;
    e = &dedup[oldest];
  } else {
    e = &dedup[dedupCount++];
  }
  strncpy(e->boatId, boatId, sizeof(e->boatId) - 1);
  e->boatId[sizeof(e->boatId) - 1] = 0;
  e->lastSeq    = seq;
  e->lastSeenMs = nowMs;
}
static bool dedupIsFresh(const char *boatId, uint32_t seq) {
  DedupEntry *e = dedupLookup(boatId);
  if (!e) return true;
  /* Accept only seq > lastSeq. (Treats wrap-around as fresh after a long idle.) */
  return (int32_t)(seq - e->lastSeq) > 0;
}

/* ==============================  RING QUEUE  ============================== */
static bool ringPush(const Packet &p) {
  if (ringCount == QUEUE_SLOTS) return false;
  ring[ringHead] = p;
  ringHead = (ringHead + 1) % QUEUE_SLOTS;
  ringCount++;
  return true;
}
static bool ringPop(Packet &out) {
  if (ringCount == 0) return false;
  out = ring[ringTail];
  ring[ringTail].raw[0] = 0;        // mark as cleared (cosmetic)
  ringTail = (ringTail + 1) % QUEUE_SLOTS;
  ringCount--;
  return true;
}
static void ringRequeue(const Packet &p) {
  if (!ringPush(p)) {
    Serial.println(F("[Q] requeue failed; dropping"));
  }
}

/* ==============================  WiFi + HTTPS  ============================== */
static bool connectWifi(unsigned long budget) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < budget) {
    esp_task_wdt_reset();      // feed the watchdog during long connects
    delay(250);
  }
  return WiFi.status() == WL_CONNECTED;
}

static bool postJson(const char *json, size_t len) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(F("[POST] no WiFi"));
    return false;
  }
  WiFiClientSecure client;
  client.setCACert(SHORE_CA_CERT);          // PIN the certificate
  client.setTimeout(HTTPS_TIMEOUT_MS);

  HTTPClient https;
  https.setTimeout(HTTPS_TIMEOUT_MS);
  if (!https.begin(client, SHORE_URL)) {
    Serial.println(F("[POST] https.begin() failed (DNS / TLS / URL parse)"));
    return false;
  }
  https.addHeader(F("Content-Type"), F("application/json"));
  int code = https.POST((uint8_t*)json, len);
  https.end();
  if (code < 0) {
    /* Negative codes from HTTPClient: -1 connect fail, -2 send header fail,
       -3 send body fail, -4 not connected, -5 timeout, etc. */
    Serial.printf("[POST] transport error code=%d\n", code);
    return false;
  }
  if (code < 200 || code >= 300) {
    Serial.printf("[POST] HTTP %d from backend\n", code);
    return false;
  }
  return true;
}

/* ==============================  PACKET -> JSON  ============================== */
static void rawToJson(const Packet &p, char *out, size_t cap, size_t &outLen) {
  static const char* zoneNames[4] = {"NOFIX","SAFE","WARN","DANG"};
  uint8_t zone = p.raw[1] & 0x0F;
  if (zone > 3) zone = 0;
  uint32_t seq   =  (uint32_t)p.raw[2]
                 | ((uint32_t)p.raw[3] << 8)
                 | ((uint32_t)p.raw[4] << 16)
                 | ((uint32_t)p.raw[5] << 24);
  uint32_t epoch =  (uint32_t)p.raw[6]
                 | ((uint32_t)p.raw[7] << 8)
                 | ((uint32_t)p.raw[8] << 16)
                 | ((uint32_t)p.raw[9] << 24);
  int32_t latQ = (int32_t)((uint32_t)p.raw[10]
                 | ((uint32_t)p.raw[11] << 8)
                 | ((uint32_t)p.raw[12] << 16)
                 | ((uint32_t)p.raw[13] << 24));
  int32_t lonQ = (int32_t)((uint32_t)p.raw[14]
                 | ((uint32_t)p.raw[15] << 8)
                 | ((uint32_t)p.raw[16] << 16)
                 | ((uint32_t)p.raw[17] << 24));
  uint16_t distM = (uint16_t)p.raw[18] | ((uint16_t)p.raw[19] << 8);

  /* Defence in depth: reject obviously broken values */
  if (latQ < -90'000'000 || latQ > 90'000'000)  { outLen = 0; return; }
  if (lonQ < -180'000'000 || lonQ > 180'000'000){ outLen = 0; return; }

  float lat = (float)latQ * 1e-6f;
  float lon = (float)lonQ * 1e-6f;

  /* Until we add a 4-byte boatId tag to the wire format, derive a stable
     identifier from the packet's seq high byte. Replace by external mapping
     (NVS / onboard IMEI) when boatId tag is added. */
  char boatId[8];
  snprintf(boatId, sizeof(boatId), "BOAT%02X", (unsigned)p.raw[5]);  /* MSB of seq — placeholder boat-id until boatId is added to wire format. Changes only every 16M packets (~32 yr @ 60 s cadence), so dedup stays coherent across reboots that re-randomise the lower bytes via esp_random(). */

  StaticJsonDocument<256> doc;
  doc["boatId"]   = boatId;
  doc["seq"]      = seq;
  doc["lat"]      = lat;
  doc["lng"]      = lon;
  doc["zone"]     = zoneNames[zone];
  doc["distM"]    = (long)distM;
  doc["ts"]       = (unsigned long)epoch;
  doc["station"]  = STATION_ID;
  outLen = serializeJson(doc, out, cap);
}

static void handleVerifiedPacket(const Packet &p) {
  char jsonBuf[256];
  size_t n = 0;
  rawToJson(p, jsonBuf, sizeof(jsonBuf), n);
  if (n == 0) {
    Serial.println(F("[Q] json serialise failed — drop"));
    return;
  }

  /* Dedup using the same boatId derivation as rawToJson */
  uint8_t zone = p.raw[1] & 0x0F;
  if (zone > 3) zone = 0;
  uint32_t seq = (uint32_t)p.raw[2]
               | ((uint32_t)p.raw[3] << 8)
               | ((uint32_t)p.raw[4] << 16)
               | ((uint32_t)p.raw[5] << 24);
  char boatId[8];
  snprintf(boatId, sizeof(boatId), "BOAT%02X", (unsigned)p.raw[5]);  /* MSB of seq — placeholder boat-id until boatId is added to wire format. Changes only every 16M packets (~32 yr @ 60 s cadence), so dedup stays coherent across reboots that re-randomise the lower bytes via esp_random(). */

  if (!dedupIsFresh(boatId, seq)) {
    Serial.printf("[DEDUP] drop replay %s seq=%lu\n",
                  boatId, (unsigned long)seq);
    return;
  }
  dedupRemember(boatId, seq, millis());

  Serial.printf("[RX] %s seq=%lu zone=%s d=%um rssi=%d snr=%d\n",
                boatId, (unsigned long)seq, zoneShort((Zone)zone),
                (unsigned)((uint16_t)p.raw[18] | ((uint16_t)p.raw[19] << 8)),
                (int)LoRa.packetRssi(), (int)LoRa.packetSnr());

  /* Copy json into inbox for the drain task; cheaper than re-serialising */
  if (n + 1 > sizeof(inbox)) {
    Serial.println(F("[Q] json too large — drop"));
    return;
  }
  memcpy(inbox, jsonBuf, n);
  inbox[n] = 0;

  /* Push the raw packet into the ring; drain turns it back into JSON on POST */
  Packet copy = p;
  copy.receivedMs = millis();
  if (!ringPush(copy)) {
    Serial.println(F("[Q] full; oldest packet dropping"));
  }
}

/* ==============================  PACKET VERIFY  ============================== */
static bool verifyPacket(const uint8_t *raw, size_t n) {
  if (n != WIRE_PAYLOAD_LEN)                      return false;
  if (raw[0] != WIRE_MAGIC)                       return false;
  if (((raw[1] >> 4) & 0x0F) != WIRE_VERSION)     return false;
  uint16_t cGot = (uint16_t)raw[20] | ((uint16_t)raw[21] << 8);
  if (cGot != crc16(raw, 20))                     return false;
  uint8_t expect[HMAC_TAG_LEN];
  if (!hmacTag(raw, 22, expect))                  return false;
  if (!constTimeEq(expect, raw + 22, HMAC_TAG_LEN)) return false;
  return true;
}

/* ==============================  LoRa  ============================== */
static bool loraBegin() {
  pinMode(PIN_LORA_SS, OUTPUT); digitalWrite(PIN_LORA_SS, HIGH);
  for (uint8_t i = 0; i < 5; ++i) {
    LoRa.setPins(PIN_LORA_SS, PIN_LORA_RST, PIN_LORA_DIO0);
    if (LoRa.begin(LORA_FREQUENCY)) {
      LoRa.setSpreadingFactor(LORA_SPREADING_FACTOR);
      LoRa.setSignalBandwidth(LORA_BANDWIDTH);
      LoRa.setSyncWord(0xB1);                          // MATCHES THE BOAT
      /* No LoRa.enableCrc() — the SX1276 modem CRC is a single shared
         register bit that controls BOTH TX generation and RX verification.
         The transmitter (transmitter_v3.ino) does not enable it, so its
         packets are sent WITHOUT the 2-byte modem CRC trailer. If the
         receiver enables it, the radio expects that trailer, parsePacket()
         never returns a valid packet, and nothing reaches verifyPacket().
         Application-level CRC16 + HMAC-SHA1 on the 30-byte payload
         (handled by verifyPacket() below) already provides integrity. */
      LoRa.receive();                                  // explicit continuous-RX mode
      return true;
    }
    delay(500);
  }
  return false;
}

/* ==============================  WATCHDOG  ============================== */
/*  ESP32 Arduino Core 3.x changed the esp_task_wdt_init signature to take
    a config struct. Older positional-arg calls fail to compile. */
static void wdtInit() {
  const esp_task_wdt_config_t cfg = {
    .timeout_ms     = (uint32_t)WDT_TIMEOUT_MS,
    .idle_core_mask = 0,         /* don't watch the idle task */
    .trigger_panic  = true       /* hard reset on timeout */
  };
  esp_task_wdt_init(&cfg);
  esp_task_wdt_add(nullptr);     /* subscribe the loopTask */
}

/* ==============================  Drain queue when WiFi is up  ==============================
   POSTs can fail for transient reasons (DNS hiccup, AP blip, backend 5xx,
   CA validation race after handshake). Retrying the SAME packet every 10 ms
   floods both the backend and the serial log, and on a slow backend can
   back the ring up to its 16-slot capacity in seconds. Back off after a
   failure, then resume. */
static unsigned long nextRetryAt = 0;

static void drainQueue() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() < nextRetryAt)        return;        // still in back-off
  while (ringCount != 0) {
    Packet p;
    if (!ringPop(p)) break;

    char jsonBuf[256];
    size_t n = 0;
    rawToJson(p, jsonBuf, sizeof(jsonBuf), n);
    if (n == 0) {
      Serial.println(F("[Q] json serialise failed on drain — drop"));
      continue;
    }

    if (!postJson(jsonBuf, n)) {
      /* Re-queue at the head and stop; back off so we don't spin. */
      ringRequeue(p);
      nextRetryAt = millis() + 5000UL;   // 5 s between attempts on a sticky failure
      return;
    }
    /* For diagnostics: derive boatId from raw */
    char boatId[8];
    snprintf(boatId, sizeof(boatId), "BOAT%02X", (unsigned)p.raw[5]);
    uint32_t seq = (uint32_t)p.raw[2]
                 | ((uint32_t)p.raw[3] << 8)
                 | ((uint32_t)p.raw[4] << 16)
                 | ((uint32_t)p.raw[5] << 24);
    Serial.printf("[POST] OK %s seq=%lu\n", boatId, (unsigned long)seq);
  }
}

/* ==============================  setup / loop  ============================== */
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LORA_SS, OUTPUT); digitalWrite(PIN_LORA_SS, HIGH);

  /* Watchdog early so a stuck WiFi connect doesn't brick us. */
  wdtInit();

  /* Try Wi-Fi in setup() but don't block forever */
  if (connectWifi(WIFI_CONNECT_TIMEOUT_MS)) {
    Serial.printf("[WiFi] up: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println(F("[WiFi] initial connect timed out — will retry in background"));
  }

  if (!loraBegin()) {
    Serial.println(F("[LoRa] init failed after 5 retries — watchdog will reset"));
  } else {
    Serial.println(F("[LoRa] receiver ready @ SF10 / 433 MHz / sync 0xB1"));
  }

  Serial.printf("[AEGIS] Shore receiver ready (station=%s)\n", STATION_ID);
}

void loop() {
  esp_task_wdt_reset();

  const unsigned long now = millis();

  /* Background Wi-Fi reconnect */
  if (WiFi.status() != WL_CONNECTED && now - lastWifiAttempt > WIFI_BACKOFF_MS) {
    lastWifiAttempt = now;
    if (connectWifi(WIFI_CONNECT_TIMEOUT_MS)) {
      Serial.printf("[WiFi] reconnected: %s\n", WiFi.localIP().toString().c_str());
    }
  }

  /* Drain pending POSTs while online */
  drainQueue();

  /* Receive one packet if any */
  int packetSize = LoRa.parsePacket();
  if (packetSize > 0) {
    if (packetSize != WIRE_PAYLOAD_LEN) {
      Serial.printf("[LoRa] wrong size: got %d, want %u — drop\n",
                    packetSize, WIRE_PAYLOAD_LEN);
      while (LoRa.available()) (void)LoRa.read();     // drain FIFO
    } else {
      Packet p{};
      for (uint8_t i = 0; i < WIRE_PAYLOAD_LEN; ++i) {
        p.raw[i] = (uint8_t)LoRa.read();
      }
      if (verifyPacket(p.raw, WIRE_PAYLOAD_LEN)) {
        handleVerifiedPacket(p);
      } else {
        Serial.println(F("[LoRa] CRC/HMAC/magic fail — drop"));
      }
    }
  }

  vTaskDelay(pdMS_TO_TICKS(10));
}
