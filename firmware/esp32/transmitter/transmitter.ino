#include <TinyGPS++.h>
#include <HardwareSerial.h>
#include <SPI.h>
#include <LoRa.h>
#include <math.h>

// 1. SET DEMO MODE HERE (true for indoor testing, false for real GPS outside)
#define DEMO_MODE true

// --- PIN DEFINITIONS ---
// LoRa
#define SS    5
#define RST   14
#define DIO0  2

// Alerts
#define LED_PIN    4
#define BUZZER_PIN 15

// --- ZONE THRESHOLDS (distance TO the boundary, in km) ---
// FIXED: previously SAFE/WARNING were swapped, so being close to the
// boundary read as SAFE. Now: far from the boundary = SAFE, near/past it = DANGER.
const float DANGER_KM = 10.0; // distance <= this  -> DANGER
const float SAFE_KM   = 20.0; // distance >  this  -> SAFE ; between -> WARNING

// GPS fix quality gate (TinyGPS++ hdop.value() returns HDOP * 100)
const unsigned long MAX_HDOP_VALUE = 500; // HDOP > 5.0 treated as unreliable

// IMBL boundary coordinates (Palk Strait) — matches dashboard
float boundaryLats[] = {9.00, 9.17, 9.35, 9.52, 9.72, 9.95, 10.22, 10.47};
float boundaryLons[] = {79.35, 79.43, 79.49, 79.57, 79.67, 79.82, 79.97, 80.12};
int numPoints = 8;

// Simulated route — stays in open Palk Strait water (west of IMBL)
float simLats[] = {
  9.80, 9.77, 9.73, 9.70, 9.65,
  9.60, 9.55, 9.50, 9.46, 9.42,
  9.39, 9.38, 9.42, 9.50, 9.60
};
float simLons[] = {
  79.30, 79.32, 79.33, 79.35, 79.37,
  79.40, 79.42, 79.44, 79.46, 79.48,
  79.50, 79.51, 79.47, 79.42, 79.36
};
int simStep = 0;

TinyGPSPlus gps;
HardwareSerial gpsSerial(2);

unsigned long lastBlinkTime = 0;
bool ledState = false;
String currentZone = "SAFE"; // SAFE, WARNING, DANGER, or NO_FIX

// --- Convert a lat/lon into local flat-earth km coords relative to a reference point ---
void toLocalXY(float lat, float lon, float refLat, float refLon, float &x, float &y) {
  const float R = 6371.0;
  x = radians(lon - refLon) * cos(radians(refLat)) * R;
  y = radians(lat - refLat) * R;
}

// --- Shortest distance from point P to line segment AB (local km coords) ---
float pointToSegmentDistance(float px, float py, float ax, float ay, float bx, float by) {
  float abx = bx - ax, aby = by - ay;
  float apx = px - ax, apy = py - ay;
  float abLenSq = abx * abx + aby * aby;
  float t = 0.0;
  if (abLenSq > 0.0001) {
    t = (apx * abx + apy * aby) / abLenSq;
    t = constrain(t, 0.0, 1.0);
  }
  float cx = ax + t * abx;
  float cy = ay + t * aby;
  float dx = px - cx, dy = py - cy;
  return sqrt(dx * dx + dy * dy);
}

// FIXED: previously measured distance to the nearest boundary POINT only
// (8 discrete points), which overestimates distance when the boat is
// between two points. Now measures distance to the nearest boundary LINE
// SEGMENT, matching how the boundary is actually drawn on the dashboard.
float distanceToBoundary(float curLat, float curLon) {
  float minDist = 99999.0;
  for (int i = 0; i < numPoints - 1; i++) {
    float ax, ay, bx, by;
    toLocalXY(boundaryLats[i],     boundaryLons[i],     curLat, curLon, ax, ay);
    toLocalXY(boundaryLats[i + 1], boundaryLons[i + 1], curLat, curLon, bx, by);
    float d = pointToSegmentDistance(0.0, 0.0, ax, ay, bx, by); // boat sits at local (0,0)
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// Hardware alerts — matches receiver, plus a distinct NO_FIX pattern so a
// GPS problem is never confused with an actual boundary alert.
void updateAlert() {
  unsigned long now = millis();

  if (currentZone == "DANGER") {
    digitalWrite(LED_PIN, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);
    ledState = true;

  } else if (currentZone == "WARNING") {
    digitalWrite(BUZZER_PIN, LOW);
    if (now - lastBlinkTime >= 500) {
      lastBlinkTime = now;
      ledState = !ledState;
      digitalWrite(LED_PIN, ledState ? HIGH : LOW);
    }

  } else if (currentZone == "NO_FIX") {
    // Fast blink, no buzzer — FIXED: previously the code just returned on a
    // bad GPS fix, freezing the LED/buzzer on whatever zone was last valid,
    // which could give false confidence.
    digitalWrite(BUZZER_PIN, LOW);
    if (now - lastBlinkTime >= 150) {
      lastBlinkTime = now;
      ledState = !ledState;
      digitalWrite(LED_PIN, ledState ? HIGH : LOW);
    }

  } else {
    digitalWrite(LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
    ledState = false;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  gpsSerial.begin(9600, SERIAL_8N1, 16, 17);

  LoRa.setPins(SS, RST, DIO0);
  if (!LoRa.begin(433E6)) {
    Serial.println("LoRa init failed! Check Boat wiring.");
    while (1);
  }
  Serial.println("AEGIS Boat Device Ready! Broadcasting...");
}

void loop() {
  float currentLat, currentLon;
  static unsigned long lastWaitPrint = 0;

  if (DEMO_MODE) {
    currentLat = simLats[simStep];
    currentLon = simLons[simStep];
    simStep = (simStep + 1) % 15;

  } else {
    while (gpsSerial.available() > 0) {
      gps.encode(gpsSerial.read());
    }

    // FIXED: now also checks fix quality (HDOP), not just presence of a fix.
    bool fixOk = gps.location.isValid() &&
                 gps.hdop.isValid() &&
                 gps.hdop.value() <= MAX_HDOP_VALUE;

    if (!fixOk) {
      currentZone = "NO_FIX";
      updateAlert(); // keep the alert pattern running instead of freezing it

      if (millis() - lastWaitPrint > 2000) {
        Serial.println("Waiting for reliable GPS fix...");
        lastWaitPrint = millis();
      }
      return;
    }

    currentLat = gps.location.lat();
    currentLon = gps.location.lng();
  }

  // FIXED: zone logic direction corrected (see thresholds above).
  float dist = distanceToBoundary(currentLat, currentLon);
  if (dist > SAFE_KM) {
    currentZone = "SAFE";
  } else if (dist > DANGER_KM) {
    currentZone = "WARNING";
  } else {
    currentZone = "DANGER";
  }
  updateAlert();

  Serial.printf("Lat: %.4f | Lon: %.4f | Dist: %.2fkm | Zone: %s\n",
                currentLat, currentLon, dist, currentZone.c_str());

  LoRa.beginPacket();
  LoRa.printf("BOAT1,%.4f,%.4f,%.2f,%s", currentLat, currentLon, dist, currentZone.c_str());
  LoRa.endPacket();

  unsigned long waitStart = millis();
  while (millis() - waitStart < 3000) {
    updateAlert();
    while (gpsSerial.available() > 0) {
      gps.encode(gpsSerial.read());
    }
    delay(10);
  }
}
