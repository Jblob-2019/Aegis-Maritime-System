'use client';

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { WindParticleLayer, GradientFieldLayer, windSample, tempSample, humSample, cloudsSample, cloudStops, rainSample, pressSample, tempStops, humidityStops, pressureStops, stormStops, windStops, weatherGrid } from './weatherLayers';
import { io, Socket } from 'socket.io-client';
import * as turf from '@turf/turf';

import { getRuntimeEnv } from '@/lib/env';

// ─── Tamil Nadu Coastline + Distance Zones ─────────────────────────────────
// Coordinates are [lat, lng]
const TN_COASTLINE_FALLBACK = [
  [13.47, 80.3],
  [13.32, 80.3],
  [13.2, 80.3],
  [13.08, 80.29],
  [12.95, 80.27],
  [12.82, 80.23],
  [12.7, 80.2],
  [12.57, 80.18],
  [12.45, 80.14],
  [12.32, 80.1],
  [12.2, 80.06],
  [12.08, 80.0],
  [11.96, 79.86],
  [11.84, 79.79],
  [11.72, 79.77],
  [11.6, 79.77],
  [11.48, 79.77],
  [11.36, 79.78],
  [11.24, 79.8],
  [11.12, 79.81],
  [11.0, 79.82],
  [10.88, 79.83],
  [10.76, 79.84],
  [10.64, 79.84],
  [10.52, 79.85],
  [10.4, 79.85],
  [10.28, 79.84],
  [10.16, 79.81],
  [10.04, 79.79],
  [9.92, 79.66],
  [9.8, 79.53],
  [9.68, 79.4],
  [9.56, 79.27],
  [9.44, 79.24],
  [9.32, 79.3],
  [9.2, 79.16],
  [9.08, 78.94],
  [8.96, 78.7],
  [8.84, 78.48],
  [8.72, 78.21],
  [8.6, 77.95],
  [8.48, 77.84],
  [8.36, 77.74],
  [8.24, 77.64],
  [8.12, 77.57],
  [8.02, 77.52],
];

const BUFFER_ZONE_KM = {
  DANGER: 5,
  WARNING: 12,
  ALERT: 20,
};

let coastlineSegments = [];
let imblSegments = [];

const IMBL_OFFSET_DIRECTION = -1;
const IMBL_OFFSET_CONFIG = [
  { name: 'Danger Line', distanceKm: -5, color: '#ea580c' },
  { name: 'Warning Line', distanceKm: -12, color: '#eab308' },
  { name: 'Safe Line', distanceKm: -20, color: '#22c55e' },
];

function initCoastlineSegments(coastlineCoords) {
  coastlineSegments = [];
  for (let i = 0; i < coastlineCoords.length - 1; i++) {
    coastlineSegments.push({
      start: coastlineCoords[i],
      end: coastlineCoords[i + 1],
    });
  }
}

// Haversine formula for accurate distance calculation
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Calculate distance from point to line segment
function pointToSegmentDistance(pLat, pLng, lat1, lng1, lat2, lng2) {
  const d1 = haversineDistance(pLat, pLng, lat1, lng1);
  const d2 = haversineDistance(pLat, pLng, lat2, lng2);
  const segmentLength = haversineDistance(lat1, lng1, lat2, lng2);

  if (segmentLength < 0.001) return Math.min(d1, d2);

  const midLat = (lat1 + lat2 + pLat) / 3;
  const cosLat = Math.cos((midLat * Math.PI) / 180);

  const x = pLng * cosLat;
  const y = pLat;
  const x1 = lng1 * cosLat;
  const y1 = lat1;
  const x2 = lng2 * cosLat;
  const y2 = lat2;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq));
  }

  const projLat = lat1 + t * (lat2 - lat1);
  const projLng = lng1 + t * (lng2 - lng1);

  return haversineDistance(pLat, pLng, projLat, projLng);
}

function calculateBearing(fromLat, fromLon, toLat, toLon) {
  const phi1 = (fromLat * Math.PI) / 180;
  const phi2 = (toLat * Math.PI) / 180;
  const deltaLambda = ((toLon - fromLon) * Math.PI) / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

function calculateDistanceToBoundary(lat, lng) {
  if (coastlineSegments.length === 0)
    initCoastlineSegments(TN_COASTLINE_FALLBACK);

  let minDistance = Infinity;
  for (const segment of coastlineSegments) {
    const distance = pointToSegmentDistance(
      lat,
      lng,
      segment.start[0],
      segment.start[1],
      segment.end[0],
      segment.end[1]
    );
    if (distance < minDistance) minDistance = distance;
  }
  return minDistance === Infinity ? 999 : minDistance;
}

function extractImblSegments(data) {
  const segments = [];
  const featureCollection = data;

  if (
    featureCollection?.type !== 'FeatureCollection' ||
    !Array.isArray(featureCollection.features)
  )
    return segments;

  const pushLineSegments = (line) => {
    if (!Array.isArray(line)) return;
    const points = line
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map(([lng, lat]) => [Number(lat), Number(lng)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    for (let i = 0; i < points.length - 1; i++) {
      segments.push({ start: points[i], end: points[i + 1] });
    }
  };

  for (const feature of featureCollection.features) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    if (geometry.type === 'LineString') pushLineSegments(geometry.coordinates);
    if (
      geometry.type === 'MultiLineString' &&
      Array.isArray(geometry.coordinates)
    ) {
      for (const line of geometry.coordinates) pushLineSegments(line);
    }
  }

  return segments;
}

function calculateDistanceToImblBoundary(lat, lng) {
  if (imblSegments.length === 0) return calculateDistanceToBoundary(lat, lng);
  let minDistance = Infinity;
  for (const segment of imblSegments) {
    const distance = pointToSegmentDistance(
      lat,
      lng,
      segment.start[0],
      segment.start[1],
      segment.end[0],
      segment.end[1]
    );
    if (distance < minDistance) minDistance = distance;
  }
  return minDistance === Infinity ? 999 : minDistance;
}

function findNearestBoundary(lat, lng) {
  const distance = calculateDistanceToImblBoundary(lat, lng);
  if (distance <= BUFFER_ZONE_KM.DANGER)
    return `DANGER Zone (${BUFFER_ZONE_KM.DANGER} km)`;
  if (distance <= BUFFER_ZONE_KM.WARNING)
    return `WARNING Zone (${BUFFER_ZONE_KM.WARNING} km)`;
  if (distance <= BUFFER_ZONE_KM.ALERT)
    return `ALERT Zone (${BUFFER_ZONE_KM.ALERT} km)`;
  return 'Deep Indian Waters. You are safe.';
}

function parseCoastlineFromGeoJson(data) {
  if (!data || typeof data !== 'object') return null;
  const featureCollection = data;

  if (
    featureCollection.type !== 'FeatureCollection' ||
    !Array.isArray(featureCollection.features)
  )
    return null;

  const latLngs = [];
  for (const feature of featureCollection.features) {
    if (feature?.geometry?.type !== 'LineString') continue;
    const coords = feature.geometry.coordinates;
    if (!Array.isArray(coords)) continue;

    const segment = coords
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map(([lng, lat]) => [Number(lat), Number(lng)])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

    if (segment.length === 0) continue;

    if (latLngs.length > 0) {
      const [prevLat, prevLng] = latLngs[latLngs.length - 1];
      const [nextLat, nextLng] = segment[0];
      if (
        Math.abs(prevLat - nextLat) < 1e-6 &&
        Math.abs(prevLng - nextLng) < 1e-6
      ) {
        latLngs.push(...segment.slice(1));
      } else {
        latLngs.push(...segment);
      }
    } else {
      latLngs.push(...segment);
    }
  }

  return latLngs.length > 1 ? latLngs : null;
}

function extractImblLineFeature(data) {
  if (!data || typeof data !== 'object') return null;

  const maybeFeature = data;
  if (
    maybeFeature.type === 'Feature' &&
    (maybeFeature.geometry?.type === 'LineString' ||
      maybeFeature.geometry?.type === 'MultiLineString')
  ) {
    return maybeFeature;
  }

  const featureCollection = data;
  if (
    featureCollection.type !== 'FeatureCollection' ||
    !Array.isArray(featureCollection.features)
  )
    return null;

  const lineFeature = featureCollection.features.find(
    (feature) =>
      feature?.geometry?.type === 'LineString' ||
      feature?.geometry?.type === 'MultiLineString'
  );

  return lineFeature ?? null;
}

function normalizeLineStringCoordinates(coords) {
  if (!Array.isArray(coords)) return [];
  return coords
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map(([lng, lat]) => [Number(lat), Number(lng)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}

function getLineStringsFromFeature(feature) {
  if (!feature || !feature.geometry) return [];

  const geometry = feature.geometry;
  if (geometry.type === 'LineString') {
    const line = normalizeLineStringCoordinates(geometry.coordinates);
    return line.length > 1 ? [line] : [];
  }

  if (
    geometry.type === 'MultiLineString' &&
    Array.isArray(geometry.coordinates)
  ) {
    return geometry.coordinates
      .map(normalizeLineStringCoordinates)
      .filter((line) => line.length > 1);
  }

  return [];
}

function buildImblOffsetFeatures(data) {
  const sourceLine = extractImblLineFeature(data);
  if (!sourceLine) return [];

  return IMBL_OFFSET_CONFIG.map((config) => {
    try {
      const feature = turf.lineOffset(
        sourceLine,
        IMBL_OFFSET_DIRECTION * config.distanceKm,
        {
          units: 'kilometers',
        }
      );

      const lines = getLineStringsFromFeature(feature);
      if (lines.length === 0) {
        console.warn('Skipping invalid IMBL offset feature geometry', {
          config,
        });
        return null;
      }

      return {
        name: config.name,
        color: config.color,
        distanceKm: config.distanceKm,
        feature,
      };
    } catch (error) {
      console.warn('Failed to create IMBL offset feature', {
        config,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }).filter(Boolean);
}

function getMidpointLatLngFromFeature(feature) {
  const geometry = feature.geometry;
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates;
    if (!Array.isArray(coords) || coords.length === 0) return null;
    const mid = coords[Math.floor(coords.length / 2)];
    if (!Array.isArray(mid) || mid.length < 2) return null;
    return [Number(mid[1]), Number(mid[0])];
  }

  if (
    geometry.type === 'MultiLineString' &&
    Array.isArray(geometry.coordinates)
  ) {
    const line = geometry.coordinates.find(
      (segment) => Array.isArray(segment) && segment.length > 0
    );
    if (!line || !Array.isArray(line)) return null;
    const mid = line[Math.floor(line.length / 2)];
    if (!Array.isArray(mid) || mid.length < 2) return null;
    return [Number(mid[1]), Number(mid[0])];
  }

  return null;
}

// ─── Demo Mode Route (SAFE near coast → WARNING → DANGER farther offshore → back) ──
const DEMO_WAYPOINTS = [
  { lat: 9.8, lon: 79.1 },
  { lat: 9.7, lon: 79.15 },
  { lat: 9.6, lon: 79.22 },
  { lat: 9.5, lon: 79.32 },
  { lat: 9.4, lon: 79.4 },
  { lat: 9.3, lon: 79.48 },
  { lat: 9.22, lon: 79.53 },
  { lat: 9.3, lon: 79.48 }, // Turning back
  { lat: 9.4, lon: 79.4 }, // WARNING again
  { lat: 9.5, lon: 79.32 },
  { lat: 9.6, lon: 79.22 }, // Back to SAFE
  { lat: 9.7, lon: 79.15 },
];

// Interpolate many small steps between each waypoint for smooth movement
function buildDemoRoute(waypoints, stepsPerSegment) {
  const result = [];
  for (let i = 0; i < waypoints.length; i++) {
    const from = waypoints[i];
    const to = waypoints[(i + 1) % waypoints.length];
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      result.push({
        lat: from.lat + (to.lat - from.lat) * t,
        lon: from.lon + (to.lon - from.lon) * t,
      });
    }
  }
  return result;
}

const DEMO_ROUTE = buildDemoRoute(DEMO_WAYPOINTS, 40);

export default function LeafletMap({
  onLocationUpdate,
  onProximityUpdate,
  onSpeedUpdate,
  onStatusUpdate,
  onEEZUpdate,
  onZoneUpdate,
  onBoatSelect,
  onBoatsUpdate,
  selectedBoatId,
  demoMode = false,
  weatherLayer = null,
  realWeather = null,
  cloudsTileOn = false,
  // Gate the hover inspector — only true while the user is on the
  // Weather tab. Defaults to true so it works as a drop-in, but the
  // dashboard flips it false whenever Weather isn't the active view.
  enableHoverInspector = true,
}) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markerByBoatRef = useRef(new Map());
  const boatDataByIdRef = useRef(new Map());
  const pathPolylineRef = useRef(null);
  const pathRef = useRef([]);
  const socketRef = useRef(null);
  const [isTracking, setIsTracking] = useState(false);
  const [boundaryCount, setBoundaryCount] = useState(0);
  const lastPositionByBoatRef = useRef(new Map());
  const headingByBoatRef = useRef(new Map());
  const markerStateRef = useRef(new Map());
  const demoIntervalRef = useRef(null);
  const demoIndexRef = useRef(0);
  const followVesselRef = useRef(true);
  const selectedBoatIdRef = useRef(selectedBoatId ?? null);
  const primaryPathBoatIdRef = useRef(selectedBoatId ?? null);
  const [followVessel, setFollowVessel] = useState(true);
  const styleElRef = useRef(null);
  const zoneBoundaryRefs = useRef({
    safe: null,
    warning: null,
    danger: null,
  });
  const trajectoryPolylineRef = useRef(null);
  const bathymetryLayerRef = useRef(null);
  const [showBathymetry, setShowBathymetry] = useState(false);

  // ── Weather hover inspector ────────────────────────────────────────────
  // Shows a small callout next to the cursor with the live weather value
  // at that lat/lng for the currently active layer (wind/clouds/…).
  const [inspector, setInspector] = useState(null); // { x, y, lat, lng, primary, secondary, palette }
  const lastInspectorMoveRef = useRef(0);
  // Ref so the map-level mousemove handler always sees the latest
  // weatherLayer value even though the map-creation effect runs once.
  const weatherLayerRef = useRef(weatherLayer);
  useEffect(() => {
    weatherLayerRef.current = weatherLayer;
    // When the layer changes, clear any stale callout so the user isn't
    // seeing leftover text for the previous layer.
    setInspector(null);
  }, [weatherLayer]);
  // Same for the inspector gate (Weather tab is active or not).
  const inspectorEnabledRef = useRef(enableHoverInspector);
  useEffect(() => {
    inspectorEnabledRef.current = enableHoverInspector;
    // Drop any visible callout the moment we leave the Weather tab so it
    // doesn't linger into the next view.
    if (!enableHoverInspector) setInspector(null);
  }, [enableHoverInspector]);

  // Format a wind speed (m/s) into a Beaufort description + compass heading.
  const bftDescribe = (mps) => {
    const kts = mps * 1.94384;
    const bft = Math.min(12, Math.max(0, Math.round(
      mps < 0.3 ? 0 :
      mps < 1.5 ? 1 :
      mps < 3.3 ? 2 :
      mps < 5.4 ? 3 :
      mps < 7.9 ? 4 :
      mps < 10.7 ? 5 :
      mps < 13.8 ? 6 :
      mps < 17.1 ? 7 :
      mps < 20.7 ? 8 :
      mps < 24.4 ? 9 :
      mps < 28.4 ? 10 :
      mps < 32.6 ? 11 : 12
    )));
    const names = [
      'Calm', 'Light Air', 'Light Breeze', 'Gentle Breeze',
      'Moderate Breeze', 'Fresh Breeze', 'Strong Breeze', 'Near Gale',
      'Gale', 'Strong Gale', 'Storm', 'Violent Storm', 'Hurricane Force',
    ];
    return { bft, name: names[bft], kts };
  };

  const compassArrow = (deg) => {
    if (deg == null || Number.isNaN(deg)) return '↑';
    const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
    return arrows[Math.round(((deg % 360) / 45)) % 8];
  };

  // Convert a Beaufort number to the 8-bit windStops colour.
  const windPaletteFor = (bft) => {
    const stops = [
      [35,70,170],[35,150,185],[70,185,120],[190,215,80],
      [230,180,60],[230,120,50],[210,70,50],[150,30,40],
    ];
    if (bft <= 1) return stops[0];
    if (bft <= 4) return stops[2];
    if (bft <= 6) return stops[4];
    return stops[6];
  };

  const normalizeZone = (zone) => {
    if (zone === 'SAFE' || zone === 'WARNING' || zone === 'DANGER') return zone;
    return 'UNKNOWN';
  };

  const vesselIcon = (zone, selected, headingDeg) => {
    const ringColor =
      zone === 'DANGER'
        ? '#ff4a4a'
        : zone === 'WARNING'
          ? '#fde047'
          : zone === 'SAFE'
            ? '#5effa8'
            : '#38bdf8';
    return L.divIcon({
      className: `vessel-marker ${selected ? 'selected' : ''}`,
      html: `<div style="width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; position: relative; transform: rotate(${headingDeg}deg);"><div class="pulse-ring" style="--pulse-color: ${ringColor};"></div><img src="/icons/boat-1.png" style="width: 32px; height: 32px; position: relative; z-index: 10; filter: drop-shadow(0 0 8px ${ringColor}); transform: rotate(${-headingDeg}deg);"/></div>`,
      iconSize: [60, 60],
      iconAnchor: [30, 30],
      tooltipAnchor: [0, -35],
      popupAnchor: [0, -35],
    });
  };

  const getZoneFromDistance = (distanceKm) => {
    if (distanceKm <= BUFFER_ZONE_KM.DANGER) return 'DANGER';
    if (distanceKm <= BUFFER_ZONE_KM.WARNING) return 'WARNING';
    if (distanceKm <= BUFFER_ZONE_KM.ALERT) return 'ALERT';
    return 'CLEAR';
  };

  const geofenceZoneToBoatZone = (zone) => {
    if (zone === 'DANGER') return 'DANGER';
    if (zone === 'WARNING') return 'WARNING';
    if (zone === 'ALERT') return 'ALERT';
    return 'SAFE';
  };

  const updateBoundaryStyles = (zone) => {
    const safeLine = zoneBoundaryRefs.current.safe;
    const warningLine = zoneBoundaryRefs.current.warning;
    const dangerLine = zoneBoundaryRefs.current.danger;

    if (safeLine) {
      safeLine.setStyle({
        color: zone === 'ALERT' || zone === 'CLEAR' ? '#22c55e' : '#16a34a',
        weight: zone === 'ALERT' || zone === 'CLEAR' ? 3.2 : 2.5,
        opacity: zone === 'ALERT' || zone === 'CLEAR' ? 1 : 0.85,
      });
    }

    if (warningLine) {
      warningLine.setStyle({
        color: zone === 'WARNING' || zone === 'DANGER' ? '#fde047' : '#f59e0b',
        weight: zone === 'WARNING' || zone === 'DANGER' ? 4 : 2.5,
        opacity: zone === 'WARNING' || zone === 'DANGER' ? 1 : 0.9,
      });
    }

    if (dangerLine) {
      dangerLine.setStyle({
        color: zone === 'DANGER' ? '#ef4444' : '#f97316',
        weight: zone === 'DANGER' ? 4.5 : 2.5,
        opacity: zone === 'DANGER' ? 1 : 0.95,
      });
    }
  };

  const processGeofenceState = (lat, lng) => {
    const distance = calculateDistanceToImblBoundary(lat, lng);
    const zone = getZoneFromDistance(distance);
    onProximityUpdate(distance);
    onZoneUpdate?.(zone);
    onEEZUpdate?.(findNearestBoundary(lat, lng));
    updateBoundaryStyles(zone);
    return zone;
  };

  const getZoneColor = (zone) =>
    zone === 'DANGER'
      ? '#ff4a4a'
      : zone === 'WARNING'
        ? '#fde047'
        : zone === 'SAFE'
          ? '#5effa8'
          : '#38bdf8';

  const updateMarkerAppearance = (marker, boat, selected) => {
    const heading = headingByBoatRef.current.get(boat.boatId) ?? 0;
    const cached = markerStateRef.current.get(boat.boatId);

    // Only recreate icon if zone or selection changed (NOT on heading change)
    if (!cached || cached.zone !== boat.zone || cached.selected !== selected) {
      marker.setIcon(vesselIcon(boat.zone, selected, heading));
      markerStateRef.current.set(boat.boatId, {
        zone: boat.zone,
        selected,
        heading,
      });
    } else if (cached.heading !== heading) {
      // Just update heading rotation without recreating icon
      const element = marker.getElement();
      if (element) {
        const innerDiv = element.firstChild;
        if (innerDiv) {
          innerDiv.style.transform = `rotate(${heading}deg)`;
          // Also update boat image rotation to keep it pointing down
          const boatImg = innerDiv.querySelector('img');
          if (boatImg) {
            boatImg.style.transform = `rotate(${-heading}deg)`;
          }
        }
      }
      markerStateRef.current.set(boat.boatId, {
        zone: boat.zone,
        selected,
        heading,
      });
    }
  };

  const emitBoats = () => {
    const boats = Array.from(boatDataByIdRef.current.values()).sort((a, b) =>
      a.boatId.localeCompare(b.boatId)
    );
    onBoatsUpdate?.(boats);
  };

  const refreshMarkerStyles = () => {
    const selected = selectedBoatIdRef.current;
    for (const [id, marker] of markerByBoatRef.current.entries()) {
      const boat = boatDataByIdRef.current.get(id);
      if (!boat) continue;
      updateMarkerAppearance(marker, boat, selected === id);
      marker.setTooltipContent(`<b>${boat.boatId}</b><br>Status: ${boat.zone}`);
    }
  };

  const updateSelectedBoatState = (boat, currentTime, directSpeed) => {
    onLocationUpdate(boat.lat, boat.lon);
    processGeofenceState(boat.lat, boat.lon);

    const prev = lastPositionByBoatRef.current.get(boat.boatId);
    let speedKnots = 0;
    if (
      typeof directSpeed === 'number' &&
      Number.isFinite(directSpeed) &&
      directSpeed >= 0
    ) {
      speedKnots = Math.min(directSpeed, 120);
      onSpeedUpdate(speedKnots);
    } else if (prev) {
      const timeDiff = (currentTime - prev.time) / 1000 / 3600;
      if (timeDiff > 0) {
        const distKm = haversineDistance(
          boat.lat,
          boat.lon,
          prev.lat,
          prev.lng
        );
        speedKnots = (distKm / timeDiff) * 0.539957;
        if (Number.isFinite(speedKnots) && speedKnots >= 0) {
          speedKnots = Math.min(speedKnots, 120);
          onSpeedUpdate(speedKnots);
        }
      }
    } else {
      onSpeedUpdate(0);
    }

    // Calculate and update predictive trajectory for selected boat
    if (primaryPathBoatIdRef.current === boat.boatId && speedKnots > 0) {
      const heading = headingByBoatRef.current.get(boat.boatId) ?? 0;
      const speedKmh = speedKnots * 1.852; // Convert knots to km/h
      const timeHours = 5 / 60; // 5 minutes in hours
      const distanceKm = speedKmh * timeHours;

      try {
        const currentPoint = turf.point([boat.lon, boat.lat]);
        const projectedPoint = turf.destination(
          currentPoint,
          distanceKm,
          heading,
          {
            units: 'kilometers',
          }
        );
        const projectedCoords = projectedPoint.geometry.coordinates; // [lng, lat]
        const trajectoryCoords = [
          [boat.lat, boat.lon],
          [projectedCoords[1], projectedCoords[0]],
        ];

        if (!trajectoryPolylineRef.current) {
          trajectoryPolylineRef.current = L.polyline(trajectoryCoords, {
            color: '#22d3ee',
            weight: 3,
            opacity: 0.8,
            dashArray: '5, 10',
          }).addTo(mapInstanceRef.current);
        } else {
          trajectoryPolylineRef.current.setLatLngs(trajectoryCoords);
        }
      } catch (error) {
        console.warn('Failed to calculate predictive trajectory', {
          boatId: boat.boatId,
          error,
        });
        if (trajectoryPolylineRef.current) {
          trajectoryPolylineRef.current.remove();
          trajectoryPolylineRef.current = null;
        }
      }
    } else {
      // Remove trajectory if not selected or no speed
      if (trajectoryPolylineRef.current) {
        trajectoryPolylineRef.current.remove();
        trajectoryPolylineRef.current = null;
      }
    }

    if (primaryPathBoatIdRef.current === boat.boatId) {
      pathRef.current.push([boat.lat, boat.lon]);
      if (pathRef.current.length > 200) pathRef.current.shift();
      pathPolylineRef.current?.setLatLngs(pathRef.current);
    }

    lastPositionByBoatRef.current.set(boat.boatId, {
      lat: boat.lat,
      lng: boat.lon,
      time: currentTime,
    });
  };

  const upsertBoat = (boat, opts) => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const selectedId = selectedBoatIdRef.current;
    const existing = markerByBoatRef.current.get(boat.boatId);

    const previous = lastPositionByBoatRef.current.get(boat.boatId);
    if (previous) {
      const heading = calculateBearing(
        previous.lat,
        previous.lng,
        boat.lat,
        boat.lon
      );
      if (Number.isFinite(heading))
        headingByBoatRef.current.set(boat.boatId, heading);
    } else if (!headingByBoatRef.current.has(boat.boatId)) {
      headingByBoatRef.current.set(boat.boatId, 0);
    }

    const heading = headingByBoatRef.current.get(boat.boatId) ?? 0;
    if (existing) {
      existing.setLatLng([boat.lat, boat.lon]);
      existing.setZIndexOffset(1000);
      updateMarkerAppearance(existing, boat, selectedId === boat.boatId);
      existing.setTooltipContent(
        `<b>${boat.boatId}</b><br>Status: ${boat.zone}`
      );
      existing.setPopupContent(
        `<b>${boat.boatId}</b><br>Lat: ${boat.lat.toFixed(4)}<br>Lon: ${boat.lon.toFixed(4)}<br>Zone: ${boat.zone}`
      );
    } else {
      const marker = L.marker([boat.lat, boat.lon], {
        icon: vesselIcon(boat.zone, selectedId === boat.boatId, heading),
        zIndexOffset: 1000,
      }).addTo(map);

      marker.bindTooltip(`<b>${boat.boatId}</b><br>Status: ${boat.zone}`, {
        direction: 'top',
        offset: [0, -18],
        className: 'eez-tooltip',
      });
      marker.bindPopup(
        `<b>${boat.boatId}</b><br>Lat: ${boat.lat.toFixed(4)}<br>Lon: ${boat.lon.toFixed(4)}<br>Zone: ${boat.zone}`
      );
      marker.on('click', () => {
        selectedBoatIdRef.current = boat.boatId;
        primaryPathBoatIdRef.current = boat.boatId;
        pathRef.current = [[boat.lat, boat.lon]];
        pathPolylineRef.current?.setLatLngs(pathRef.current);
        refreshMarkerStyles();
        onBoatSelect?.(boat);
        updateSelectedBoatState(boat, Date.now());
        map.setView([boat.lat, boat.lon], Math.max(map.getZoom(), 10), {
          animate: true,
        });
      });
      markerByBoatRef.current.set(boat.boatId, marker);
    }

    boatDataByIdRef.current.set(boat.boatId, boat);
    refreshMarkerStyles();

    if (!selectedBoatIdRef.current) {
      selectedBoatIdRef.current = boat.boatId;
      primaryPathBoatIdRef.current = boat.boatId;
      onBoatSelect?.(boat);
    }

    if (selectedBoatIdRef.current === boat.boatId) {
      updateSelectedBoatState(boat, Date.now(), opts?.directSpeed);
      if (opts?.shouldPan && followVesselRef.current) {
        map.panTo([boat.lat, boat.lon]);
      }
      if (opts?.zoomOnSelect) {
        map.setView([boat.lat, boat.lon], Math.max(map.getZoom(), 10), {
          animate: true,
        });
      }
    }

    emitBoats();
  };

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    // Initialize map — centred on Tamil Nadu coast
    mapInstanceRef.current = L.map(mapRef.current, {
      center: [10.5, 79.5],
      zoom: 7,
      zoomControl: false,
      attributionControl: false,
      minZoom: 4.5,
      maxZoom: 18,
      worldCopyJump: true,
      scrollWheelZoom: true,
      wheelDebounceTime: 80,
      wheelPxPerZoomLevel: 120,
    });
    const map = mapInstanceRef.current;
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Add satellite/ocean tile layer
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Tiles &copy; Esri | EEZ Data &copy; Marine Regions',
        maxZoom: 19,
      }
    ).addTo(mapInstanceRef.current);

    // Add a labels layer with larger, clearer place names on satellite view
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: '',
        maxZoom: 19,
        pane: 'overlayPane',
        opacity: 0.95,
      }
    ).addTo(mapInstanceRef.current);

    // Add GEBCO Color Bathymetry WMS Layer
    bathymetryLayerRef.current = L.tileLayer.wms('https://wms.gebco.net/mapserv?', {
      layers: 'GEBCO_Latest_2',
      format: 'image/png',
      transparent: true,
      opacity: 0.65,
      attribution: '&copy; GEBCO',
    });
    if (showBathymetry) {
      bathymetryLayerRef.current.addTo(mapInstanceRef.current);
    }

    const renderZoneBoundaries = (
      coastlineCoords,
      _coastlineGeoJson,
      imblGeoJson
    ) => {
      if (!map._container) {
        console.warn('Map container not ready, skipping boundary rendering');
        return;
      }

      const safeAddLayer = (layerName, layer, details) => {
        if (
          !map ||
          !map._container ||
          typeof map._container.appendChild !== 'function'
        ) {
          console.warn('Map not ready for layer addition', {
            layer: layerName,
          });
          return null;
        }
        try {
          layer.addTo(map);
          return layer;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn('Skipping invalid map layer', {
            layer: layerName,
            ...details,
            error: message,
          });
          return null;
        }
      };

      const geoJsonOptions = {
        coordsToLatLng: (coords) => L.latLng(coords[1], coords[0]),
      };

      initCoastlineSegments(coastlineCoords);
      let visibleLimitCount = 0;

      const safeCoastline = coastlineCoords.filter(
        ([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)
      );
      const validCoastline =
        safeCoastline.length > 1 &&
        safeCoastline.every(
          (point) => Array.isArray(point) && point.length === 2
        );
      if (validCoastline) {
        try {
          const coastlineLayer = safeAddLayer(
            'coastline',
            L.polyline(safeCoastline, {
              color: '#2563eb',
              weight: 3,
              opacity: 0.8,
              interactive: false,
            }),
            { points: safeCoastline.length }
          );
          if (coastlineLayer) {
            coastlineLayer.bringToBack();
            visibleLimitCount += 1;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn('Invalid coastline geometry', {
            points: safeCoastline.length,
            error: message,
          });
        }
      } else {
        console.warn(
          'Skipping coastline layer due to invalid coordinate data',
          { points: safeCoastline.length }
        );
      }

      const imblFeature = extractImblLineFeature(imblGeoJson);
      if (imblFeature) {
        imblSegments = extractImblSegments(imblGeoJson);
        const imblLines = getLineStringsFromFeature(imblFeature);
        if (imblLines.length > 0) {
          try {
            const imblLayer = safeAddLayer(
              'imbl-main',
              L.featureGroup(
                imblLines.map((line) =>
                  L.polyline(line, {
                    color: '#dc2626',
                    weight: 3,
                    dashArray: '10, 10',
                    interactive: false,
                  })
                )
              ),
              { segments: imblSegments.length }
            );
            if (imblLayer) visibleLimitCount += 1;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn('Invalid IMBL line geometry', { error: message });
          }
        }

        const offsetFeatures = buildImblOffsetFeatures(imblGeoJson);
        offsetFeatures.forEach((offset) => {
          const offsetLines = getLineStringsFromFeature(offset.feature);
          if (offsetLines.length === 0) {
            console.warn('Skipping invalid IMBL offset feature', {
              name: offset.name,
              distanceKm: offset.distanceKm,
            });
            return;
          }

          try {
            const offsetLayer = safeAddLayer(
              'imbl-offset',
              L.featureGroup(
                offsetLines.map((line) =>
                  L.polyline(line, {
                    color: offset.color,
                    weight: 2,
                    dashArray: '5, 5',
                    interactive: false,
                  })
                )
              ),
              {
                name: offset.name,
                distanceKm: offset.distanceKm,
              }
            );
            if (offsetLayer) visibleLimitCount += 1;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn('Invalid IMBL offset geometry', {
              name: offset.name,
              distanceKm: offset.distanceKm,
              error: message,
            });
          }

          const mid = getMidpointLatLngFromFeature(offset.feature);
          if (!mid || !mid.every(Number.isFinite)) {
            console.warn('Skipping invalid IMBL offset label', {
              name: offset.name,
              distanceKm: offset.distanceKm,
              mid,
            });
            return;
          }

          try {
            L.marker(mid, {
              icon: L.divIcon({
                className: 'eez-label',
                html: `<div style="background:${offset.color};color:#fff;padding:4px 9px;border-radius:7px;font-size:12px;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,0.45);font-weight:700;border:1px solid rgba(255,255,255,0.3);">${offset.name} (${offset.distanceKm} km)</div>`,
                iconSize: [180, 28],
                iconAnchor: [90, 14],
              }),
            }).addTo(map);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            console.warn('[browser] Invalid IMBL offset label', {
              name: offset.name,
              distanceKm: offset.distanceKm,
              error: message,
            });
          }
        });
      }
      if (!imblGeoJson) {
        imblSegments = [];
      }

      zoneBoundaryRefs.current.safe = null;
      zoneBoundaryRefs.current.warning = null;
      zoneBoundaryRefs.current.danger = null;
      setBoundaryCount(visibleLimitCount);
    };

    Promise.all([
      fetch('/data/tn_coastline.json').then((response) =>
        response.ok ? response.json() : null
      ),
      fetch('/data/imbl_boundary.json').then((response) =>
        response.ok ? response.json() : null
      ),
    ])
      .then(([coastGeoJson, imblGeoJson]) => {
        const coastline =
          parseCoastlineFromGeoJson(coastGeoJson) || TN_COASTLINE_FALLBACK;
        setTimeout(() => {
          renderZoneBoundaries(
            coastline,
            coastGeoJson ?? {
              type: 'FeatureCollection',
              features: [],
            },
            imblGeoJson
          );
        }, 100);
      })
      .catch(() => {
        const fallbackGeoJson = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: TN_COASTLINE_FALLBACK.map(([lat, lng]) => [
                  lng,
                  lat,
                ]),
              },
            },
          ],
        };
        setTimeout(() => {
          renderZoneBoundaries(TN_COASTLINE_FALLBACK, fallbackGeoJson, null);
        }, 100);
      });

    // Initial selected vessel fallback
    const initialBoat = {
      boatId: selectedBoatIdRef.current || 'BOAT1',
      lat: 9.8,
      lon: 79.1,
      zone: 'SAFE',
    };

    // Path trail polyline
    const pathPolyline = L.polyline([], {
      color: '#38bdf8',
      weight: 3,
      opacity: 0.7,
      pane: 'overlayPane',
      interactive: false,
    }).addTo(map);
    pathPolyline.bringToBack();
    pathPolylineRef.current = pathPolyline;

    mapInstanceRef.current = map;

    // Now upsert the initial boat after map is ready
    upsertBoat(initialBoat, { shouldPan: false });

    // ── Weather hover inspector ────────────────────────────────────────
    // Read the active weather value at the cursor's lat/lng and show a
    // small callout. Throttled to ~30 fps so we don't sample the wind grid
    // on every pixel of mouse movement.
    const inspectorMove = (e) => {
      // Bail early when the Weather tab isn't active — keeps the rest of
      // the dashboard (Fleet / Sensors / Threats / etc.) free of the
      // floating callout.
      if (!inspectorEnabledRef.current) {
        setInspector(null);
        return;
      }
      const now = performance.now();
      if (now - lastInspectorMoveRef.current < 33) return;
      lastInspectorMoveRef.current = now;

      const { lat, lng } = e.latlng;
      const layer = weatherLayerRef.current;
      const t = performance.now() / 1000;

      let primary = '';
      let secondary = '';
      let palette = [220, 240, 255];
      let sub = `${lat.toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${lng.toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;

      if (layer === 'wind') {
        const s = windSample(lng, lat, t);
        const { bft, name, kts } = bftDescribe(s.value);
        const bearing = (Math.atan2(s.u, -s.v) * 180) / Math.PI; // direction wind blows TOWARD
        const fromBearing = (bearing + 180) % 360;                // meteorological "from"
        primary = `${name}`;
        secondary = `${bft} Bft  ${compassArrow(fromBearing)} ${Math.round(fromBearing)}°`;
        palette = windPaletteFor(bft);
        sub = `${kts.toFixed(1)} kts · ${sub}`;
      } else if (layer === 'clouds') {
        const s = rainSample(lng, lat, t);
        primary = `${s.value.toFixed(1)} mm/h`;
        secondary = 'Precipitation';
        palette = s.value > 10 ? [200,50,150] : s.value > 2 ? [50,150,250] : [100,200,250];
      } else if (layer === 'storm') {
        const s = rainSample(lng, lat, t);
        primary = `${s.value.toFixed(1)} mm/h`;
        secondary = s.value >= 10 ? 'Heavy' : s.value >= 2 ? 'Moderate' : s.value > 0 ? 'Light' : 'None';
        palette = s.value >= 10 ? [255,0,0] : s.value >= 2 ? [50,100,220] : s.value > 0 ? [100,150,250] : [10,30,50];
      } else if (layer === 'pressure') {
        const s = pressSample(lng, lat, t);
        primary = `${Math.round(s.value)} hPa`;
        secondary = s.value < 1000 ? 'Low' : s.value > 1020 ? 'High' : 'Normal';
        palette = s.value < 1000 ? [40,60,150] : s.value > 1020 ? [190,70,50] : [140,180,210];
      } else {
        // No weather layer active — just show coordinates.
        primary = '—';
        secondary = 'Select a weather layer';
        palette = [100, 200, 255];
      }

      // Position: offset to the right of the cursor, flip to the left if
      // near the right edge so the callout never gets clipped.
      const w = mapRef.current?.clientWidth || 0;
      const flipX = e.containerPoint.x > w - 180;
      const x = flipX ? e.containerPoint.x - 14 : e.containerPoint.x + 14;
      const y = e.containerPoint.y + 14;

      setInspector({ x, y, lat, lng, primary, secondary, palette, sub });
    };

    const inspectorOut = () => setInspector(null);

    mapRef.current.addEventListener('mouseleave', inspectorOut);
    // L.Leaflet fires 'mousemove' with .latlng and .containerPoint on
    // every cursor move — that's all we need, so don't double-bind the DOM
    // mousemove (which would deliver a plain MouseEvent without latlng).
    map.on('mousemove', inspectorMove);
    map.on('mouseout', inspectorOut);

    // Leaflet needs invalidateSize after flex layout settles.
    // Stop auto-following when user manually pans or zooms.
    const handleDragStart = () => {
      followVesselRef.current = false;
      setFollowVessel(false);
    };
    map.on('dragstart', handleDragStart);

    const safeInvalidateSize = () => {
      if (!mapInstanceRef.current) return;
      try {
        map.invalidateSize();
      } catch {
        // Ignore late invalidation calls during unmount/teardown.
      }
    };

    const invalidateTimeoutShort = window.setTimeout(safeInvalidateSize, 50);
    const invalidateTimeoutLong = window.setTimeout(safeInvalidateSize, 300);

    // Also revalidate whenever the container is resized
    const ro = new ResizeObserver(safeInvalidateSize);
    if (mapRef.current) ro.observe(mapRef.current);

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;500;700&display=swap');
      @keyframes smoothPulse {
        0% { 
          border-width: 2px; 
          opacity: 0.8; 
          transform: scale(1);
        }
        50% { 
          border-width: 2px; 
          opacity: 0.4; 
          transform: scale(1.15);
        }
        100% { 
          border-width: 2px; 
          opacity: 0.8; 
          transform: scale(1);
        }
      }
      .pulse-ring {
        position: absolute;
        width: 48px;
        height: 48px;
        border: 2px solid var(--pulse-color);
        border-radius: 50%;
        animation: smoothPulse 2s ease-in-out infinite;
      }
      .leaflet-container {
        background: radial-gradient(circle at top, rgba(12, 34, 58, 0.96), rgba(3, 9, 19, 1));
        font-family: 'Roboto Mono', 'Courier New', monospace;
      }
      .leaflet-control-zoom a {
        background: rgba(4, 20, 41, 0.92) !important;
        color: #7dd3fc !important;
        border: 1px solid rgba(56, 189, 248, 0.24) !important;
        box-shadow: 0 0 18px rgba(56, 189, 248, 0.18) !important;
      }
      .leaflet-control-zoom a:hover {
        background: rgba(9, 34, 60, 0.98) !important;
      }
      .leaflet-control-attribution {
        background: rgba(6, 15, 28, 0.78) !important;
        color: #94a3b8 !important;
        font-size: 10px !important;
        border: 1px solid rgba(56, 189, 248, 0.16) !important;
        backdrop-filter: blur(12px);
      }
        /* Add these inside your style.textContent template literal */

      .vessel-core {
        width: 14px;
        height: 14px;
        border-radius: 50% 50% 0 50%;
        border: 2px solid #ffffff;
        transform: rotate(45deg);
        box-shadow: 0 0 12px var(--ring-color);
        position: relative;
        z-index: 2;
      }

      .boat-marker-wrapper {
        position: relative;
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }

      .boat-marker-wrapper.selected .boat-marker-icon {
        filter: drop-shadow(0 0 16px rgba(56, 189, 248, 0.85));
      }

      .boat-marker-radar {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }

      .boat-radar-ring {
        position: absolute;
        width: 42px;
        height: 42px;
        border: 2px solid var(--ring-color);
        border-radius: 9999px;
        opacity: 0.55;
        animation: radarPulse 1.8s ease-out infinite;
        box-sizing: border-box;
      }

      .boat-radar-ring--delay {
        animation-delay: 0.6s;
      }

      .boat-marker-icon {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 3;
      }

      .vessel-marker {
        width: 48px !important;
        height: 48px !important;
        display: flex !important;
        align-items: center;
        justify-content: center;
      }

      .leaflet-control-attribution a {
        color: #67e8f9 !important;
      }
      .hud-panel {
        backdrop-filter: blur(18px);
        background: rgba(4, 12, 24, 0.72);
        border: 1px solid rgba(56, 189, 248, 0.18);
        box-shadow: 0 18px 60px rgba(0, 0, 0, 0.32);
        border-radius: 1rem;
        color: #e2e8f0;
      }
      .hud-panel.hud-status-panel {
        border-color: rgba(34, 211, 238, 0.28);
      }
      .hud-panel.hud-button {
        border-color: rgba(56, 189, 248, 0.25);
      }
      .hud-panel.hud-counter {
        border-color: rgba(59, 130, 246, 0.22);
      }
      .hud-panel .hud-label {
        color: #cbd5e1;
      }
      .hud-panel .hud-value,
      .leaflet-popup-content-wrapper,
      .eez-tooltip,
      .leaflet-control-attribution {
        font-family: 'Roboto Mono', 'Courier New', monospace !important;
      }
      .leaflet-popup-content-wrapper {
        background: rgba(6, 15, 30, 0.88) !important;
        border: 1px solid rgba(56, 189, 248, 0.16) !important;
        color: #f8fafc !important;
        border-radius: 1rem !important;
        box-shadow: 0 20px 70px rgba(0, 0, 0, 0.5) !important;
        backdrop-filter: blur(18px) !important;
      }
      .leaflet-popup-tip {
        background: rgba(6, 15, 30, 0.88) !important;
      }
      .leaflet-popup-close-button {
        color: #7dd3fc !important;
      }
      .eez-tooltip {
        background: rgba(4, 12, 24, 0.96) !important;
        color: #e2e8f0 !important;
        border: 1px solid rgba(34, 211, 238, 0.25) !important;
        border-radius: 0.75rem !important;
        padding: 8px 11px !important;
        font-size: 12px !important;
        box-shadow: 0 8px 30px rgba(0,0,0,0.35) !important;
      }
      .hud-status-pill {
        min-width: 5px;
        min-height: 5px;
        border-radius: 9999px;
      }
      .status-safe { background: #5effa8 !important; box-shadow: 0 0 14px #5effa8; }
      .status-warning { background: #fff55b !important; box-shadow: 0 0 18px #fff55b; }
      .status-danger { background: #ff4a4a !important; box-shadow: 0 0 18px #ff4a4a; }
      .status-unknown { background: #38bdf8 !important; box-shadow: 0 0 14px #38bdf8; }
    `;
    document.head.appendChild(style);
    styleElRef.current = style;

    return () => {
      window.clearTimeout(invalidateTimeoutShort);
      window.clearTimeout(invalidateTimeoutLong);
      ro.disconnect();
      // Inspector listeners — Leaflet handles mousemove; DOM owns mouseleave.
      if (mapRef.current) {
        mapRef.current.removeEventListener('mouseleave', inspectorOut);
      }
      map.off('mousemove', inspectorMove);
      map.off('mouseout', inspectorOut);
      map.off('dragstart', handleDragStart);
      if (trajectoryPolylineRef.current) {
        trajectoryPolylineRef.current.remove();
        trajectoryPolylineRef.current = null;
      }
      if (styleElRef.current) {
        styleElRef.current.remove();
        styleElRef.current = null;
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
      markerStateRef.current.clear();
    };
  }, [
    onLocationUpdate,
    onProximityUpdate,
    onSpeedUpdate,
    onEEZUpdate,
    onZoneUpdate,
    onBoatSelect,
    onBoatsUpdate,
  ]);

  useEffect(() => {
    if (!selectedBoatId || !mapInstanceRef.current) return;
    // Remove old trajectory when switching boats
    if (trajectoryPolylineRef.current) {
      trajectoryPolylineRef.current.remove();
      trajectoryPolylineRef.current = null;
    }
    selectedBoatIdRef.current = selectedBoatId;
    primaryPathBoatIdRef.current = selectedBoatId;
    const boat = boatDataByIdRef.current.get(selectedBoatId);
    if (!boat) return;
    pathRef.current = [[boat.lat, boat.lon]];
    pathPolylineRef.current?.setLatLngs(pathRef.current);
    updateSelectedBoatState(boat, Date.now());
    refreshMarkerStyles();
    mapInstanceRef.current.setView(
      [boat.lat, boat.lon],
      Math.max(mapInstanceRef.current.getZoom(), 10),
      { animate: true }
    );
  }, [selectedBoatId]);

  // Socket.io real-time connection + initial REST fetch
  useEffect(() => {
    if (!mapInstanceRef.current) return;

    const BACKEND_URL =
      getRuntimeEnv().NEXT_PUBLIC_BACKEND_URL || 'http://localhost:4000';

    // Initial REST fetch — load latest snapshot for all boats
    fetch(`${BACKEND_URL}/api/location/latest`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        const normalizedRows = Array.isArray(rows) ? rows : [];
        if (normalizedRows.length === 0)
          return fetch(`${BACKEND_URL}/api/location`)
            .then((r) => (r.ok ? r.json() : null))
            .then((single) => (single ? [single] : []));
        return normalizedRows;
      })
      .then((rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return;
        for (const row of rows) {
          const lat = Number(row.lat);
          const lon = Number(row.lon);

          // Validate coordinates
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            console.warn('Invalid coordinates from REST API', {
              lat,
              lon,
              boatId: row.boatId,
            });
            continue;
          }

          // Validate lat/lon ranges
          if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            console.warn('Coordinates out of valid range from REST API', {
              lat,
              lon,
              boatId: row.boatId,
            });
            continue;
          }

          const boat = {
            boatId: row.boatId || 'BOAT1',
            lat,
            lon,
            zone: normalizeZone(row.zone),
            distance: row.distance,
            timestamp: row.timestamp,
          };
          console.log('Initial boat loaded:', boat);
          upsertBoat(boat, { shouldPan: false });
        }
        setIsTracking(true);
        onStatusUpdate?.('Backend Connected');
      })
      .catch(() => onStatusUpdate?.('Backend Offline'));

    // Socket.io for real-time push from ESP32
    const socket = io(BACKEND_URL);

    socket.on('connect', () => {
      setIsTracking(true);
      onStatusUpdate?.('Backend Connected');
    });

    socket.on('connect_error', () => {
      setIsTracking(false);
      onStatusUpdate?.('Backend Offline');
    });

    socket.on('disconnect', () => {
      setIsTracking(false);
      onStatusUpdate?.('Backend Offline');
    });

    socket.on('locationUpdate', (data) => {
      if (demoMode) return;
      const lat = Number(data.lat);
      const lng = Number(data.lon);

      // Validate coordinates
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.warn('Invalid coordinates from ESP32', {
          lat,
          lng,
          rawData: data,
        });
        return;
      }

      // Validate lat/lon ranges
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        console.warn('Coordinates out of valid range', { lat, lng });
        return;
      }

      const boat = {
        boatId: data.boatId || 'BOAT1',
        lat,
        lon: lng,
        zone: normalizeZone(data.zone),
        distance: data.distance,
        timestamp: data.timestamp,
      };
      console.log('Location update received:', boat);
      upsertBoat(boat, {
        shouldPan: true,
        directSpeed:
          typeof data.speed === 'number' ? Number(data.speed) : undefined,
      });
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, [
    demoMode,
    onLocationUpdate,
    onProximityUpdate,
    onSpeedUpdate,
    onStatusUpdate,
    onEEZUpdate,
    onZoneUpdate,
    onBoatSelect,
    onBoatsUpdate,
  ]);

  // ─── Demo Mode ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!demoMode) {
      if (demoIntervalRef.current) {
        clearInterval(demoIntervalRef.current);
        demoIntervalRef.current = null;
      }
      return;
    }
    // Reset path for fresh demo run
    pathRef.current = [];
    pathPolylineRef.current?.setLatLngs([]);
    demoIndexRef.current = 0;
    setIsTracking(true);
    onStatusUpdate?.('Demo Mode Active');

    demoIntervalRef.current = setInterval(() => {
      if (!mapInstanceRef.current) return;
      const point = DEMO_ROUTE[demoIndexRef.current];
      const lat = point.lat;
      const lng = point.lon;
      const demoBoatId = 'DEMO-BOAT1';
      selectedBoatIdRef.current = demoBoatId;
      primaryPathBoatIdRef.current = demoBoatId;
      const demoZone = getZoneFromDistance(
        calculateDistanceToImblBoundary(lat, lng)
      );
      upsertBoat(
        {
          boatId: demoBoatId,
          lat,
          lon: lng,
          zone: geofenceZoneToBoatZone(demoZone),
        },
        { shouldPan: true }
      );
      demoIndexRef.current = (demoIndexRef.current + 1) % DEMO_ROUTE.length;
    }, 250);

    return () => {
      if (demoIntervalRef.current) {
        clearInterval(demoIntervalRef.current);
        demoIntervalRef.current = null;
      }
    };
  }, [
    demoMode,
    onLocationUpdate,
    onProximityUpdate,
    onSpeedUpdate,
    onStatusUpdate,
    onEEZUpdate,
    onZoneUpdate,
    onBoatSelect,
    onBoatsUpdate,
  ]);

  const weatherLayerInstanceRef = useRef(null);
  const rafRef = useRef(null);
  const weatherGridRefreshRef = useRef(null);
  // H/L centre markers — drawn only while the pressure layer is active.
  const pressureMarkersRef = useRef([]);
  const pressureRefreshTimerRef = useRef(null);
  // Storm-cell overlay (circles + halos + lightning icons + track polylines).
  const stormCellLayersRef = useRef([]);
  const stormRefreshTimerRef = useRef(null);
  const cloudsTileLayerRef = useRef(null);

  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;
    
    if (cloudsTileOn) {
      if (!cloudsTileLayerRef.current) {
        cloudsTileLayerRef.current = L.tileLayer('https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=a63a66e50c1159983af837acb9e4efa8', {
          maxZoom: 18,
          opacity: 0.6,
          attribution: '&copy; OpenWeatherMap'
        });
      }
      if (!map.hasLayer(cloudsTileLayerRef.current)) {
        cloudsTileLayerRef.current.addTo(map);
      }
    } else {
      if (cloudsTileLayerRef.current && map.hasLayer(cloudsTileLayerRef.current)) {
        map.removeLayer(cloudsTileLayerRef.current);
      }
    }
  }, [cloudsTileOn]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (weatherLayerInstanceRef.current) {
      const currentLayers = Array.isArray(weatherLayerInstanceRef.current) ? weatherLayerInstanceRef.current : [weatherLayerInstanceRef.current];
      currentLayers.forEach(l => map.removeLayer(l));
      weatherLayerInstanceRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // Drop any pressure H/L markers left over from a previous view.
    for (const m of pressureMarkersRef.current) {
      try { map.removeLayer(m); } catch (_) {}
    }
    pressureMarkersRef.current = [];
    if (pressureRefreshTimerRef.current) {
      clearInterval(pressureRefreshTimerRef.current);
      pressureRefreshTimerRef.current = null;
    }

    // Custom Leaflet div-icon for an H / L centre — black rounded box,
    // white text, with a tiny downward arrow so it reads as a label rather
    // than a marker. Mirrors the reference synoptic-chart pins.
    const buildPressureIcon = (type, pressure) => {
      const label = `${Math.round(pressure)} hPa`;
      const html = `
        <div style="display:flex;flex-direction:column;align-items:center;pointer-events:none;">
          <div style="background:#0b1117;color:#fff;font:600 11px/1 'JetBrains Mono',monospace;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.18);box-shadow:0 2px 6px rgba(0,0,0,0.45);white-space:nowrap;letter-spacing:0.04em;">
            <span style="opacity:0.85;margin-right:4px;">${type}</span>${label}
          </div>
          <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid #0b1117;margin-top:-1px;"></div>
        </div>`;
      return L.divIcon({
        html,
        className: 'pressure-centre-icon',
        iconSize: [70, 28],
        iconAnchor: [35, 28],
      });
    };

    const renderPressureCentres = () => {
      // Remove existing markers first so we don't pile up across moveends.
      for (const m of pressureMarkersRef.current) {
        try { map.removeLayer(m); } catch (_) {}
      }
      pressureMarkersRef.current = [];

      const centres = weatherGrid.findPressureCentres();
      for (const c of centres) {
        const m = L.marker([c.lat, c.lng], { icon: buildPressureIcon(c.type, c.pressure), interactive: false });
        m.addTo(map);
        pressureMarkersRef.current.push(m);
      }
    };

    // ── Storm cells ───────────────────────────────────────────────────
    // For each local precipitation maximum, render a coloured halo circle,
    // a forecast-track polyline (orange dots), and a couple of lightning
    // bolt icons inside the cell. Sizes scale with map zoom so the markers
    // stay readable as you pan / zoom.
    const cellColour = (mm) => {
      if (mm >= 10) return '#ff2810';
      if (mm >= 5)  return '#d83cb0';
      if (mm >= 2)  return '#5a46dc';
      if (mm >= 0.6) return '#2b80f0';
      return '#7eb6ee';
    };
    const buildLightningIcon = () => L.divIcon({
      html: '<div style="font: 700 14px/1 sans-serif; color: #fff7c0; text-shadow: 0 0 4px #ffae00, 0 0 1px #000; transform: translate(-50%, -100%); pointer-events: none;">⚡</div>',
      className: 'storm-lightning-icon',
      iconSize: [16, 16],
      iconAnchor: [8, 16],
    });

    const renderStormCells = () => {
      // Tear down previous layer
      for (const obj of stormCellLayersRef.current) {
        try { map.removeLayer(obj); } catch (_) {}
      }
      stormCellLayersRef.current = [];

      const cells = weatherGrid.findStormCells();
      const zoom = map.getZoom();
      // Size grows at low zoom (so cells stay visible at country scale)
      // and shrinks at high zoom (so they don't blot out a city).
      const zoomFactor = Math.max(0, Math.min(1, (8 - zoom) / 6));
      const baseRadius = 12000 + zoomFactor * 22000; // metres

      for (const c of cells) {
        const r = baseRadius * (0.7 + Math.min(1.6, c.intensity / 6));
        const colour = cellColour(c.intensity);

        // Halo circle.
        const halo = L.circle([c.lat, c.lng], {
          radius: r,
          color: colour,
          weight: 2,
          opacity: 0.85,
          fillColor: colour,
          fillOpacity: 0.18,
          interactive: false,
        });
        halo.addTo(map);
        stormCellLayersRef.current.push(halo);

        // Forecast track — simple westward drift (good enough for a demo,
        // and matches how tropical cells in the Indian Ocean typically move).
        // Each cell gets a 7-step polyline showing the next ~6h.
        const trackPoints = [];
        for (let k = 0; k < 7; k++) {
          trackPoints.push([c.lat + (Math.random() - 0.5) * 0.4, c.lng - k * 0.6 - 0.1]);
        }
        const track = L.polyline(trackPoints, {
          color: '#ffae00',
          weight: 2.5,
          opacity: 0.9,
          dashArray: '2,4',
          interactive: false,
        });
        track.addTo(map);
        stormCellLayersRef.current.push(track);

        // Coloured dots on the track.
        for (const p of trackPoints) {
          const dot = L.circleMarker(p, {
            radius: 3 + Math.min(3, c.intensity / 4),
            color: '#ff7a1a',
            weight: 1,
            fillColor: '#ffae00',
            fillOpacity: 1,
            interactive: false,
          });
          dot.addTo(map);
          stormCellLayersRef.current.push(dot);
        }

        // A couple of lightning bolts inside the cell.
        const boltCount = Math.min(4, 1 + Math.floor(c.intensity / 2));
        for (let b = 0; b < boltCount; b++) {
          // Random offset in degrees, scaled by radius
          const dLat = (Math.random() - 0.5) * (r / 110000);
          const dLng = (Math.random() - 0.5) * (r / 90000);
          const bolt = L.marker([c.lat + dLat, c.lng + dLng], {
            icon: buildLightningIcon(),
            interactive: false,
          });
          bolt.addTo(map);
          stormCellLayersRef.current.push(bolt);
        }
      }
    };

    let gridTimeout = null;
    const refreshWeather = () => {
      clearTimeout(gridTimeout);
      gridTimeout = setTimeout(async () => {
        if(!mapInstanceRef.current) return;
        await weatherGrid.refreshGrid(mapInstanceRef.current.getBounds(), 8, 6);
        // Pressure: refresh the GFS grid + redraw the colour gradient
        // field and the H/L centre markers.
        if (weatherLayer === 'pressure') {
          await weatherGrid.refreshPressureGrid(mapInstanceRef.current.getBounds(), 8, 6);
          renderPressureCentres();
        }
        // Clouds: refresh the cloud_cover grid (no cells, just the field).
        if (weatherLayer === 'clouds') {
          await weatherGrid.refreshCloudGrid(mapInstanceRef.current.getBounds(), 10, 8);
        }
        // Storm: refresh the precipitation grid + rebuild storm cells
        // (the only place rain cells + halos are drawn).
        if (weatherLayer === 'storm') {
          await weatherGrid.refreshPrecipGrid(mapInstanceRef.current.getBounds(), 10, 8);
          renderStormCells();
        }
        const layers = weatherLayerInstanceRef.current;
        if(layers){
           const arr = Array.isArray(layers) ? layers : [layers];
           arr.forEach(l => { if(l._redraw) l._redraw(); });
        }
      }, 300);
    };
    weatherGridRefreshRef.current = refreshWeather;
    map.on('moveend', refreshWeather);


    if (weatherLayer) {
      let layers = [];
      if (weatherLayer === 'wind') {
        layers.push(new WindParticleLayer(windSample, { particleCount: 1800, speedFactor: 1.2 }));
      } else if (weatherLayer === 'clouds') {
        // CLOUDS tab: cloud cover (%) from Open-Meteo GFS — separate from
        // the storm ramp so precipitation stays exclusive to STORM.
        layers.push(new GradientFieldLayer(cloudsSample, cloudStops, { opacity: 0.75, cellSize: 4, blur: 5 }));
      } else if (weatherLayer === 'storm') {
        // STORM tab: precipitation field (mm/h) + storm cells, drawn from
        // the precip grid. Only place the user sees rain intensity.
        layers.push(new GradientFieldLayer(rainSample, stormStops, { opacity: 0.8, cellSize: 4, blur: 4 }));
      } else if (weatherLayer === 'pressure') {
        // PRESSURE: a thin colour gradient so the synoptic pattern reads
        // at a glance, plus the H/L pin markers. No isobars, no labels on
        // the field itself — the pins carry the labelled highs/lows.
        layers.push(new GradientFieldLayer(pressSample, pressureStops, {
          opacity: 0.55, cellSize: 4, blur: 6
        }));
        // Auto-refresh the pressure grid every 30 min — Open-Meteo GFS
        // updates hourly, so half that is plenty fresh.
        pressureRefreshTimerRef.current = setInterval(() => {
          if (!mapInstanceRef.current) return;
          weatherGrid.refreshPressureGrid(mapInstanceRef.current.getBounds(), 8, 6).then(() => {
            renderPressureCentres();
          });
        }, 30 * 60 * 1000);
        // Auto-refresh storm cells every 15 minutes so the storm layer
        // tracks live GFS updates without the user panning.
        stormRefreshTimerRef.current = setInterval(() => {
          if (!mapInstanceRef.current) return;
          weatherGrid.refreshPrecipGrid(mapInstanceRef.current.getBounds(), 10, 8).then(() => {
            renderStormCells();
            const arr = Array.isArray(weatherLayerInstanceRef.current) ? weatherLayerInstanceRef.current : [weatherLayerInstanceRef.current];
            arr.forEach(l => { if (l._redraw) l._redraw(); });
          });
        }, 15 * 60 * 1000);
        // Re-render storm cells on zoom so the radius/halo scale correctly.
        map.on('zoomend', renderStormCells);
      }

      if (layers.length > 0) {
        weatherLayerInstanceRef.current = layers;
        layers.forEach(l => map.addLayer(l));

        // Initial fetch
        if (weatherGridRefreshRef.current) weatherGridRefreshRef.current();

        let t = 0;
        let last = performance.now();
        const tick = (now) => {
          const dt = Math.min(0.05, (now - last) / 1000);
          last = now;
          t += dt;
          layers.forEach(l => {
            if (l.setTime) l.setTime(t);
          });
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    return () => {
      map.off('moveend', refreshWeather);
      clearTimeout(gridTimeout);
      if (weatherLayerInstanceRef.current) {
        const currentLayers = Array.isArray(weatherLayerInstanceRef.current) ? weatherLayerInstanceRef.current : [weatherLayerInstanceRef.current];
        currentLayers.forEach(l => map.removeLayer(l));
        weatherLayerInstanceRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      for (const m of pressureMarkersRef.current) {
        try { map.removeLayer(m); } catch (_) {}
      }
      pressureMarkersRef.current = [];
      if (pressureRefreshTimerRef.current) {
        clearInterval(pressureRefreshTimerRef.current);
        pressureRefreshTimerRef.current = null;
      }
      for (const layer of stormCellLayersRef.current) {
        try { map.removeLayer(layer); } catch (_) {}
      }
      stormCellLayersRef.current = [];
      if (stormRefreshTimerRef.current) {
        clearInterval(stormRefreshTimerRef.current);
        stormRefreshTimerRef.current = null;
      }
      map.off('zoomend', renderStormCells);
    }
  }, [weatherLayer]);

  // Dedicated unmount cleanup
  useEffect(() => {
    return () => {
      if (weatherLayerInstanceRef.current && mapInstanceRef.current) {
        const currentLayers = Array.isArray(weatherLayerInstanceRef.current) ? weatherLayerInstanceRef.current : [weatherLayerInstanceRef.current];
        currentLayers.forEach(l => mapInstanceRef.current.removeLayer(l));
        weatherLayerInstanceRef.current = null;
      }
      if (cloudsTileLayerRef.current && mapInstanceRef.current) {
        mapInstanceRef.current.removeLayer(cloudsTileLayerRef.current);
        cloudsTileLayerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapInstanceRef.current || !bathymetryLayerRef.current) return;
    if (showBathymetry) {
      bathymetryLayerRef.current.addTo(mapInstanceRef.current);
    } else {
      bathymetryLayerRef.current.remove();
    }
  }, [showBathymetry]);

  return (
    <div className="relative w-full h-full" style={{ minHeight: '520px' }}>
      <div
        ref={mapRef}
        className="w-full h-full"
        style={{
          minHeight: '520px',
          borderRadius: '1rem',
          // Crosshair cursor when hovering a weather layer makes the
          // "this spot has a value" affordance obvious — only while the
          // Weather tab is the active view.
          cursor: enableHoverInspector && weatherLayer ? 'crosshair' : undefined,
        }}
      />

      {/* ── Weather hover inspector callout ───────────────────────────── */}
      {inspector && (
        <div
          className="absolute pointer-events-none z-[1100]"
          style={{
            left: inspector.x,
            top: inspector.y,
            transform: 'translate(0, 0)',
            willChange: 'transform',
          }}
        >
          <div
            className="rounded-md px-2.5 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.55)] backdrop-blur-md border border-white/15 min-w-[140px]"
            style={{
              background: `linear-gradient(180deg, rgba(8,14,22,0.92), rgba(8,14,22,0.82))`,
              borderTop: `2px solid rgb(${inspector.palette.join(',')})`,
            }}
          >
            {/* Top row: layer name (primary) */}
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: `rgb(${inspector.palette.join(',')})`, boxShadow: `0 0 6px rgb(${inspector.palette.join(',')})` }}
              />
              <span className="text-[12px] font-bold tracking-wide text-white whitespace-nowrap">
                {inspector.primary}
              </span>
            </div>
            {/* Sub-row: secondary (Bft + arrow, % etc) */}
            {inspector.secondary && (
              <div className="text-[11px] text-white/80 mt-0.5 font-mono whitespace-nowrap">
                {inspector.secondary}
              </div>
            )}
            {/* Lat/Lng */}
            <div className="text-[10px] text-white/55 mt-1 font-mono whitespace-nowrap">
              {inspector.sub}
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-[90px] right-[10px] z-[1000]">
        <div className="flex flex-col items-center gap-2">
          {/* RE-CENTER / FOLLOWING */}
          {!followVessel ? (
            <button
              onClick={() => {
                followVesselRef.current = true;
                setFollowVessel(true);
                if (mapInstanceRef.current && selectedBoatIdRef.current) {
                  const selectedMarker = markerByBoatRef.current.get(selectedBoatIdRef.current);
                  if (selectedMarker) mapInstanceRef.current.panTo(selectedMarker.getLatLng());
                }
              }}
              className="hud-panel hud-button flex items-center justify-center w-8 h-8 rounded-xl bg-[rgba(10,14,26,0.85)] hover:bg-[rgba(20,28,31,0.95)] border border-[rgba(255,255,255,0.08)] shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all backdrop-blur-md"
              title="Re-center"
            >
              <svg className="w-4 h-4 text-[#c3f5ff]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => {
                followVesselRef.current = false;
                setFollowVessel(false);
              }}
              className="hud-panel flex items-center justify-center w-8 h-8 rounded-xl bg-[rgba(10,14,26,0.85)] hover:bg-[rgba(20,28,31,0.95)] border border-[rgba(255,255,255,0.08)] shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all backdrop-blur-md cursor-pointer"
              title="Following Vessel (Click to unfollow)"
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#00ff95] shadow-[0_0_8px_#00ff95] animate-pulse" />
            </button>
          )}
          
          {/* ZONES */}
          <div className="hud-panel flex flex-col items-center justify-center w-8 h-8 rounded-xl bg-[rgba(10,14,26,0.85)] border border-[rgba(255,255,255,0.08)] shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-md" title="Zones">
            <span className="text-[#c3f5ff] font-bold text-[11px] leading-none">{boundaryCount}</span>
            <span className="text-[#8a96ad] font-bold text-[6px] leading-none uppercase mt-[1px]">Zones</span>
          </div>

          {/* BATHYMETRY TOGGLE */}
          <button
            onClick={() => setShowBathymetry(prev => !prev)}
            className="hud-panel flex items-center justify-center w-8 h-8 rounded-xl bg-[rgba(10,14,26,0.85)] hover:bg-[rgba(20,28,31,0.95)] border border-[rgba(255,255,255,0.08)] shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all backdrop-blur-md cursor-pointer"
            title="Toggle Bathymetry"
          >
            <svg className={`w-4 h-4 ${showBathymetry ? 'text-[#00daf3]' : 'text-[#5a6478]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </button>

          {/* LIVE/OFFLINE */}
          <div className="hud-panel flex items-center justify-center w-8 h-8 rounded-xl bg-[rgba(10,14,26,0.85)] border border-[rgba(255,255,255,0.08)] shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-md" title={isTracking ? 'Live Feed' : 'Offline'}>
            <div className={`w-2.5 h-2.5 rounded-full ${isTracking ? 'bg-[#00daf3] shadow-[0_0_8px_#00daf3] animate-pulse' : 'bg-[#ef4444] shadow-[0_0_8px_#ef4444]'}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
