#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <LoRa.h>
#include <WiFiClientSecure.h> // needed for Render HTTPS

// --- UPDATE THESE WITH YOUR DETAILS ---
// TODO before sharing this repo publicly: move these into a secrets header
// or use WiFiManager instead of hardcoding credentials.
const char* WIFI_SSID     = "OnePlus 11 5G FD58";
const char* WIFI_PASSWORD = "pranes2007";

const char* SERVER_URL = "https://aegis-backend-3w2p.onrender.com/api/location";
// --------------------------------------

// LoRa Pins
#define SS    5
#define RST   14
#define DIO0  2

// FIXED: was an infinite while() loop with no timeout — a wrong password or
// out-of-range AP would hang the device forever at boot.
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;

String currentZone = "SAFE"; // SAFE, WARNING, DANGER, or NO_FIX — kept for
                              // logging/serial output only, no hardware tied to it

// FIXED: was dropping any reading whose cloud POST failed. Now a single
// failed payload is queued and retried on the next loop instead of lost.
// (Single-slot queue — for multi-boat / high-frequency use, upgrade this
// to a small ring buffer so a burst of failures doesn't overwrite itself.)
String pendingPayload = "";
bool hasPending = false;

// Connect to WiFi with a timeout instead of blocking forever.
bool connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.disconnect();

  IPAddress googleDNS(8, 8, 8, 8);
  WiFi.config(INADDR_NONE, INADDR_NONE, INADDR_NONE, googleDNS);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
    return true;
  } else {
    Serial.println("\nWiFi connect timed out — will keep retrying in the background.");
    return false;
  }
}

// Send one JSON payload to the cloud. Returns true on success (HTTP 2xx).
bool sendToCloud(const String &jsonPayload) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure(); // NOTE: skips TLS certificate validation — fine for
                        // testing, but replace with setCACert(...) before
                        // any real deployment; right now this connection
                        // can be intercepted.
  HTTPClient http;
  http.setTimeout(5000); // FIXED: no timeout before — a slow/cold Render
                          // instance could block the loop (and LoRa
                          // reception) indefinitely.

  http.begin(client, SERVER_URL);
  http.addHeader("Content-Type", "application/json");

  int httpResponseCode = http.POST(jsonPayload);
  http.end();

  if (httpResponseCode > 0) {
    Serial.printf("Cloud HTTP Response: %d\n", httpResponseCode);
    return httpResponseCode >= 200 && httpResponseCode < 300;
  } else {
    Serial.printf("Cloud HTTP Error: %d\n", httpResponseCode);
    return false;
  }
}

void setup() {
  Serial.begin(115200);

  connectWiFi();

  LoRa.setPins(SS, RST, DIO0);
  if (!LoRa.begin(433E6)) {
    Serial.println("LoRa init failed. Check wiring!");
    while (1);
  }
  Serial.println("LoRa Receiver Ready! Waiting for boat data...");
}

void loop() {
  // FIXED: background reconnect instead of a one-shot connect at boot.
  // Doesn't block LoRa reception while retrying.
  static unsigned long lastReconnectAttempt = 0;
  if (WiFi.status() != WL_CONNECTED && millis() - lastReconnectAttempt > 10000) {
    lastReconnectAttempt = millis();
    connectWiFi();
  }

  // Retry the last failed upload before handling any new packet.
  if (hasPending && WiFi.status() == WL_CONNECTED) {
    if (sendToCloud(pendingPayload)) {
      hasPending = false;
    }
  }

  int packetSize = LoRa.parsePacket();

  if (packetSize) {
    String incoming = "";
    while (LoRa.available()) {
      incoming += (char)LoRa.read();
    }

    Serial.print("\nReceived LoRa packet: ");
    Serial.println(incoming);
    // Format from boat: BOAT1,9.3000,80.5000,25.00,SAFE

    int firstComma  = incoming.indexOf(',');
    int secondComma = incoming.indexOf(',', firstComma + 1);
    int thirdComma  = incoming.indexOf(',', secondComma + 1);
    int fourthComma = incoming.indexOf(',', thirdComma + 1);

    if (firstComma > 0 && fourthComma > 0) {
      String boatId = incoming.substring(0, firstComma);
      String lat  = incoming.substring(firstComma + 1, secondComma);
      String lon  = incoming.substring(secondComma + 1, thirdComma);
      String dist = incoming.substring(thirdComma + 1, fourthComma);
      String zone = incoming.substring(fourthComma + 1);
      zone.trim();

      currentZone = zone;
      Serial.println("Zone: " + currentZone);

      String jsonPayload = "{\"boatId\":\"" + boatId + "\",\"lat\":" + lat +
                            ",\"lon\":" + lon + ",\"distance\":" + dist +
                            ",\"zone\":\"" + zone + "\"}";
      Serial.println("Sending to Cloud: " + jsonPayload);

      if (!sendToCloud(jsonPayload)) {
        pendingPayload = jsonPayload;
        hasPending = true;
        Serial.println("Cloud send failed — queued for retry.");
      }
    }
  }
}
