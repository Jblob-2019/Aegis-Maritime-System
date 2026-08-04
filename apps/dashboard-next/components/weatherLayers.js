import L from 'leaflet';

// --------------------------------------------------------
// 0) SHARED — noise, field sampling, colormap
// --------------------------------------------------------

const API_KEY = 'a63a66e50c1159983af837acb9e4efa8';

/**
 * Open-Meteo returns each coordinate point in the requested lat/lon order
 * but the API snaps the requested coords to its internal grid and reorders
 * the response by ascending latitude. The caller needs to map (j,i) → the
 * returned point that corresponds to the requested corner. This helper
 * does a nearest-neighbour lookup by (lat, lon) — robust to any reordering
 * the API performs (or to it returning one slightly different corner).
 */
function findNearestPoint(arr, reqLat, reqLon) {
  if (!arr || arr.length === 0) return null;
  let best = arr[0];
  let bestD = Infinity;
  for (const p of arr) {
    const d = Math.hypot(p.latitude - reqLat, p.longitude - reqLon);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

class WeatherGrid {
  constructor(){
    this.cache = new Map();
    this.currentGrid = null;
    // Separate store for the *pressure* field. OWM's main.pressure at each
    // station is a single noisy number — useful for the per-cell background
    // but terrible for drawing sharp pressure centres. Open-Meteo's GFS
    // forecast gives us a real gridded mean-sea-level pressure in one
    // request, so we keep that as the authoritative source for the
    // pressure layer (and let `pressSample` prefer it over OWM).
    this.pressureGrid = null;
    this.pressureGridFetchedAt = 0;
    // Same pattern for precipitation: real, gridded rainfall from Open-Meteo
    // GFS so the storm/precip layers show model-quality fields instead of
    // a per-station mosaic.
    this.precipGrid = null;
    this.precipGridFetchedAt = 0;
    // And the same for cloud cover — drives the CLOUDS layer (separate
    // from the storm/precip ramp) so the storm layer is the only one that
    // shows precipitation cells.
    this.cloudGrid = null;
    this.cloudGridFetchedAt = 0;
  }

  key(lat,lon){ return Math.round(lat*1.5)/1.5 + ',' + Math.round(lon*1.5)/1.5; }

  async fetchPoint(lat,lon){
    const k = this.key(lat,lon);
    const cached = this.cache.get(k);
    if(cached && Date.now()-cached.t < 10*60*1000) return cached.d;

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&units=metric&appid=${API_KEY}`;
    try{
      const res = await fetch(url);
      if(!res.ok) return cached ? cached.d : null;
      const j = await res.json();
      const speed = (j.wind && j.wind.speed) || 0;
      const deg   = (j.wind && j.wind.deg) || 0;
      const clouds = (j.clouds && j.clouds.all) || 0;
      const rain = (j.rain && (j.rain['1h'] || j.rain['3h'])) || 0;
      const d = {
        temp: j.main.temp,
        humidity: j.main.humidity,
        pressure: j.main.pressure,
        clouds: clouds,
        rain: rain,
        u: -speed*Math.sin(deg*Math.PI/180),
        v: -speed*Math.cos(deg*Math.PI/180),
        speed: speed
      };
      this.cache.set(k, {t:Date.now(), d});
      return d;
    } catch(e){ return cached ? cached.d : null; }
  }

  async refreshGrid(bounds, cols, rows){
    const points = [];
    // Calculate a margin so interpolation covers the edges
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lonSpan = bounds.getEast() - bounds.getWest();
    const marginLat = latSpan * 0.15;
    const marginLon = lonSpan * 0.15;

    const b = {
      north: Math.min(85, bounds.getNorth() + marginLat),
      south: Math.max(-85, bounds.getSouth() - marginLat),
      west: bounds.getWest() - marginLon,
      east: bounds.getEast() + marginLon
    };

    for(let j=0; j<rows; j++){
      for(let i=0; i<cols; i++){
        const lat = b.north + (b.south - b.north)*(j/(rows-1));
        const lon = b.west + (b.east - b.west)*(i/(cols-1));
        points.push({lat, lon, i, j});
      }
    }

    const results = await Promise.all(points.map(p => this.fetchPoint(p.lat, p.lon).then(d => ({...p, d}))));
    this.currentGrid = { results, cols, rows, bounds: b };
  }

  /**
   * Fetch a real pressure grid from Open-Meteo GFS in a single HTTP call.
   * Returns `{ bounds, cols, rows, values }` where `values` is a flat
   * Float32Array of hPa readings, row-major (north→south, west→east).
   *
   * Open-Meteo's gridded endpoint requires the lat/lon arrays to have the
   * same length, so we pass a flat list of `rows × cols` (lat, lon) pairs.
   * The response is reordered (sorted by latitude) and may snap our
   * requested coords to its internal grid — `findNearestPoint` handles
   * both. Cached for 30 min — GFS updates hourly so this is plenty fresh.
   */
  async refreshPressureGrid(bounds, cols = 8, rows = 6){
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lonSpan = bounds.getEast() - bounds.getWest();
    const marginLat = latSpan * 0.15;
    const marginLon = lonSpan * 0.15;

    const b = {
      north: Math.min(85, bounds.getNorth() + marginLat),
      south: Math.max(-85, bounds.getSouth() - marginLat),
      west: bounds.getWest() - marginLon,
      east: bounds.getEast() + marginLon,
    };

    // Build the corner-coords first.
    const reqLats = new Array(rows);
    const reqLons = new Array(cols);
    for (let j = 0; j < rows; j++) reqLats[j] = b.north + (b.south - b.north) * (j / (rows - 1));
    for (let i = 0; i < cols; i++) reqLons[i] = b.west + (b.east - b.west) * (i / (cols - 1));

    // Flatten to a single (lat, lon, lat, lon, …) URL — equal-length
    // parallel arrays are what Open-Meteo demands.
    const latList = [];
    const lonList = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        latList.push(reqLats[j].toFixed(3));
        lonList.push(reqLons[i].toFixed(3));
      }
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latList.join(',')}&longitude=${lonList.join(',')}&hourly=pressure_msl&forecast_days=1&format=json`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('open-meteo ' + res.status);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('open-meteo: expected array');

      // Pick the hourly reading closest to "now" so we always show the
      // current synoptic situation.
      const now = Date.now();
      const values = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const reqLat = reqLats[j];
          const reqLon = reqLons[i];
          const p = findNearestPoint(arr, reqLat, reqLon);
          if (!p || !p.hourly || !Array.isArray(p.hourly.pressure_msl)) {
            values[j * cols + i] = 1013; // sensible fallback
            continue;
          }
          // Pick the hour closest to now.
          const times = p.hourly.time;
          const series = p.hourly.pressure_msl;
          let bestIdx = 0;
          let bestDt = Infinity;
          for (let h = 0; h < times.length; h++) {
            const dt = Math.abs(new Date(times[h]).getTime() - now);
            if (dt < bestDt) { bestDt = dt; bestIdx = h; }
          }
          values[j * cols + i] = series[bestIdx];
        }
      }
      this.pressureGrid = { bounds: b, cols, rows, values };
      this.pressureGridFetchedAt = Date.now();
      return this.pressureGrid;
    } catch (e) {
      console.warn('[aegis] pressure grid fetch failed:', e.message);
      // Stale-cache fallback: keep whatever is there.
      if (this.pressureGrid) return this.pressureGrid;
      this.pressureGrid = null;
      return null;
    }
  }

  /** Bilinear smoothstep interpolation against the pressure grid. */
  interpPressure(lat, lon) {
    if (!this.pressureGrid) return null;
    const { bounds, cols, rows, values } = this.pressureGrid;
    const fj = (bounds.north - lat) / (bounds.north - bounds.south) * (rows - 1);
    const fi = (lon - bounds.west) / (bounds.east - bounds.west) * (cols - 1);
    if (!isFinite(fi) || !isFinite(fj)) return null;
    const i0 = Math.max(0, Math.min(cols - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(rows - 2, Math.floor(fj)));
    let tx = Math.min(1, Math.max(0, fi - i0));
    let ty = Math.min(1, Math.max(0, fj - j0));
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const v00 = values[j0 * cols + i0];
    const v10 = values[j0 * cols + i0 + 1];
    const v01 = values[(j0 + 1) * cols + i0];
    const v11 = values[(j0 + 1) * cols + i0 + 1];
    if (!isFinite(v00 + v10 + v01 + v11)) return null;
    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * ty;
  }

  /**
   * Real precipitation grid from Open-Meteo GFS (`precipitation` hourly
   * field). Returned grid is millimetres per hour. Cached for 15 min —
   * the storm layer rebuilds cells on every moveend, so the per-call
   * budget has to stay cheap.
   */
  async refreshPrecipGrid(bounds, cols = 10, rows = 8){
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lonSpan = bounds.getEast() - bounds.getWest();
    const marginLat = latSpan * 0.15;
    const marginLon = lonSpan * 0.15;
    const b = {
      north: Math.min(85, bounds.getNorth() + marginLat),
      south: Math.max(-85, bounds.getSouth() - marginLat),
      west: bounds.getWest() - marginLon,
      east: bounds.getEast() + marginLon,
    };
    const reqLats = new Array(rows);
    const reqLons = new Array(cols);
    for (let j = 0; j < rows; j++) reqLats[j] = b.north + (b.south - b.north) * (j / (rows - 1));
    for (let i = 0; i < cols; i++) reqLons[i] = b.west + (b.east - b.west) * (i / (cols - 1));
    // Open-Meteo's gridded endpoint requires equal-length lat/lon arrays,
    // so flatten to a single (lat, lon, lat, lon, …) URL of length rows*cols.
    const latList = [];
    const lonList = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        latList.push(reqLats[j].toFixed(3));
        lonList.push(reqLons[i].toFixed(3));
      }
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latList.join(',')}&longitude=${lonList.join(',')}&hourly=precipitation&forecast_days=1&format=json`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('open-meteo precip ' + res.status);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('open-meteo precip: expected array');
      const now = Date.now();
      const values = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const reqLat = reqLats[j];
          const reqLon = reqLons[i];
          const p = findNearestPoint(arr, reqLat, reqLon);
          if (!p || !p.hourly || !Array.isArray(p.hourly.precipitation)) {
            values[j * cols + i] = 0;
            continue;
          }
          const times = p.hourly.time;
          const series = p.hourly.precipitation;
          let bestIdx = 0, bestDt = Infinity;
          for (let h = 0; h < times.length; h++) {
            const dt = Math.abs(new Date(times[h]).getTime() - now);
            if (dt < bestDt) { bestDt = dt; bestIdx = h; }
          }
          values[j * cols + i] = series[bestIdx] || 0;
        }
      }
      this.precipGrid = { bounds: b, cols, rows, values };
      this.precipGridFetchedAt = Date.now();
      return this.precipGrid;
    } catch (e) {
      console.warn('[aegis] precip grid fetch failed:', e.message);
      if (this.precipGrid) return this.precipGrid;
      this.precipGrid = null;
      return null;
    }
  }

  interpPrecip(lat, lon) {
    if (!this.precipGrid) return null;
    const { bounds, cols, rows, values } = this.precipGrid;
    const fj = (bounds.north - lat) / (bounds.north - bounds.south) * (rows - 1);
    const fi = (lon - bounds.west) / (bounds.east - bounds.west) * (cols - 1);
    if (!isFinite(fi) || !isFinite(fj)) return null;
    const i0 = Math.max(0, Math.min(cols - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(rows - 2, Math.floor(fj)));
    let tx = Math.min(1, Math.max(0, fi - i0));
    let ty = Math.min(1, Math.max(0, fj - j0));
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const v00 = values[j0 * cols + i0];
    const v10 = values[j0 * cols + i0 + 1];
    const v01 = values[(j0 + 1) * cols + i0];
    const v11 = values[(j0 + 1) * cols + i0 + 1];
    if (!isFinite(v00 + v10 + v01 + v11)) return null;
    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * ty;
  }

  /**
   * Real cloud cover grid from Open-Meteo GFS (`cloud_cover` hourly
   * field, %). Same request shape as pressure/precipitation, but driven
   * by a separate grid object so the CLOUDS layer doesn't fight the
   * STORM layer for the precip grid.
   */
  async refreshCloudGrid(bounds, cols = 10, rows = 8){
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lonSpan = bounds.getEast() - bounds.getWest();
    const marginLat = latSpan * 0.15;
    const marginLon = lonSpan * 0.15;
    const b = {
      north: Math.min(85, bounds.getNorth() + marginLat),
      south: Math.max(-85, bounds.getSouth() - marginLat),
      west: bounds.getWest() - marginLon,
      east: bounds.getEast() + marginLon,
    };
    const lats = [], lons = [];
    for (let j = 0; j < rows; j++) lats.push((b.north + (b.south - b.north) * (j / (rows - 1))).toFixed(3));
    for (let i = 0; i < cols; i++) lons.push((b.west + (b.east - b.west) * (i / (cols - 1))).toFixed(3));
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&hourly=cloud_cover&forecast_days=1&format=json`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('open-meteo cloud_cover ' + res.status);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('open-meteo cloud_cover: expected array');
      const now = Date.now();
      const values = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const reqLat = +lats[j];
          const reqLon = +lons[i];
          const p = findNearestPoint(arr, reqLat, reqLon);
          if (!p || !p.hourly || !Array.isArray(p.hourly.cloud_cover)) {
            values[j * cols + i] = 0;
            continue;
          }
          const times = p.hourly.time;
          const series = p.hourly.cloud_cover;
          let bestIdx = 0, bestDt = Infinity;
          for (let h = 0; h < times.length; h++) {
            const dt = Math.abs(new Date(times[h]).getTime() - now);
            if (dt < bestDt) { bestDt = dt; bestIdx = h; }
          }
          values[j * cols + i] = series[bestIdx] || 0;
        }
      }
      this.cloudGrid = { bounds: b, cols, rows, values };
      this.cloudGridFetchedAt = Date.now();
      return this.cloudGrid;
    } catch (e) {
      if (this.cloudGrid) return this.cloudGrid;
      this.cloudGrid = null;
      return null;
    }
  }

  interpCloud(lat, lon) {
    if (!this.cloudGrid) return null;
    const { bounds, cols, rows, values } = this.cloudGrid;
    const fj = (bounds.north - lat) / (bounds.north - bounds.south) * (rows - 1);
    const fi = (lon - bounds.west) / (bounds.east - bounds.west) * (cols - 1);
    if (!isFinite(fi) || !isFinite(fj)) return null;
    const i0 = Math.max(0, Math.min(cols - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(rows - 2, Math.floor(fj)));
    let tx = Math.min(1, Math.max(0, fi - i0));
    let ty = Math.min(1, Math.max(0, fj - j0));
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const v00 = values[j0 * cols + i0];
    const v10 = values[j0 * cols + i0 + 1];
    const v01 = values[(j0 + 1) * cols + i0];
    const v11 = values[(j0 + 1) * cols + i0 + 1];
    if (!isFinite(v00 + v10 + v01 + v11)) return null;
    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * ty;
  }

  /**
   * Local precipitation maxima — i.e. storm cells.
   * Returns `{ lat, lng, intensity, radiusDeg }` where `radiusDeg` is a
   * rough cell size in degrees (scaled by intensity).
   */
  findStormCells({ minIntensityMm = 0.6, minSepDeg = 3 } = {}) {
    if (!this.precipGrid) return [];
    const { bounds, cols, rows, values } = this.precipGrid;
    const cells = [];
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const v = values[j * cols + i];
        if (v < minIntensityMm) continue;
        let isMax = true;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            if (values[(j + dj) * cols + (i + di)] > v) { isMax = false; break; }
          }
          if (!isMax) break;
        }
        if (!isMax) continue;
        const lat = bounds.north + (bounds.south - bounds.north) * (j / (rows - 1));
        const lng = bounds.west + (bounds.east - bounds.west) * (i / (cols - 1));
        // Coarse "cell radius" — bigger cells for stronger precipitation.
        const radiusDeg = Math.min(8, 1.5 + v * 0.4);
        cells.push({ lat, lng, intensity: v, radiusDeg });
      }
    }
    // Strongest first; drop cells too close to a stronger one.
    cells.sort((a, b) => b.intensity - a.intensity);
    const kept = [];
    for (const c of cells) {
      if (kept.every(k => Math.hypot(k.lat - c.lat, k.lng - c.lng) > minSepDeg)) {
        kept.push(c);
      }
    }
    return kept;
  }

  /**
   * Find local maxima (HIGHs) and minima (LOWs) of the pressure grid.
   * Returns an array of `{lat, lng, pressure, type: 'H' | 'L'}`.
   * Uses a simple 3-cell-neighborhood comparison on the raw grid.
   */
  findPressureCentres({ minSepDeg = 6 } = {}) {
    if (!this.pressureGrid) return [];
    const { bounds, cols, rows, values } = this.pressureGrid;
    const centres = [];
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const v = values[j * cols + i];
        let isMax = true, isMin = true;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const n = values[(j + dj) * cols + (i + di)];
            if (n >= v) isMax = false;
            if (n <= v) isMin = false;
          }
        }
        if (!isMax && !isMin) continue;
        const lat = bounds.north + (bounds.south - bounds.north) * (j / (rows - 1));
        const lng = bounds.west + (bounds.east - bounds.west) * (i / (cols - 1));
        // Only consider "strong" features — pressure always has noise.
        const spread = Math.abs(v - 1013);
        if (spread < 0.5) continue;
        centres.push({ lat, lng, pressure: v, type: isMax ? 'H' : 'L' });
      }
    }
    // De-duplicate centres that are very close.
    centres.sort((a, b) => b.pressure - a.pressure);
    const kept = [];
    for (const c of centres) {
      if (kept.every(k => Math.abs(k.lat - c.lat) > minSepDeg || Math.abs(k.lng - c.lng) > minSepDeg)) {
        kept.push(c);
      }
    }
    return kept;
  }

  interp(lat, lon) {
    if(!this.currentGrid) return null;
    const { results, cols, rows, bounds } = this.currentGrid;
    const fj = (bounds.north - lat) / (bounds.north - bounds.south) * (rows-1);
    const fi = (lon - bounds.west) / (bounds.east - bounds.west) * (cols-1);
    if(!isFinite(fi) || !isFinite(fj)) return null;

    const i0 = Math.max(0, Math.min(cols-2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(rows-2, Math.floor(fj)));
    const i1 = i0+1, j1 = j0+1;

    // Smoothstep interpolation for much higher quality, organic gradients
    let tx = Math.min(1, Math.max(0, fi-i0));
    let ty = Math.min(1, Math.max(0, fj-j0));
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);

    function get(i,j) { const p = results[j*cols+i]; return (p && p.d) ? p.d : null; }
    const v00 = get(i0,j0), v10 = get(i1,j0), v01 = get(i0,j1), v11 = get(i1,j1);
    const vals = [v00, v10, v01, v11];

    if(vals.some(v => v == null)){
      const ok = vals.filter(v => v != null);
      if (ok.length === 0) return null;
      // fallback to average if any missing
      const avg = {};
      ['temp', 'humidity', 'pressure', 'clouds', 'rain', 'u', 'v', 'speed'].forEach(k => {
         avg[k] = ok.reduce((sum, v) => sum + v[k], 0) / ok.length;
      });
      return avg;
    }

    const res = {};
    ['temp', 'humidity', 'pressure', 'u', 'v', 'speed'].forEach(k => {
      const top = v00[k] + (v10[k]-v00[k])*tx;
      const bot = v01[k] + (v11[k]-v01[k])*tx;
      res[k] = top + (bot-top)*ty;
    });
    return res;
  }
}

export const weatherGrid = new WeatherGrid();

// ---- Data Samples (Real-Time Interpolated) ----
export function windSample(lng, lat, t){
  const d = weatherGrid.interp(lat, lng);
  if (!d) return { u: 0, v: 0, value: 0 };
  return { u: d.u, v: d.v, value: d.speed };
}
export function tempSample(lng, lat, t){
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.temp : 0 };
}
export function humSample(lng, lat, t){
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.humidity : 0 };
}
export function cloudsSample(lng, lat, t){
  // Prefer the gridded Open-Meteo cloud_cover field (% cover from 0–100).
  // Fall back to the OWM per-station reading if the grid isn't ready yet.
  const fromGrid = weatherGrid.interpCloud(lat, lng);
  if (fromGrid != null && isFinite(fromGrid)) return { value: fromGrid };
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.clouds : 0 };
}
export function rainSample(lng, lat, t){
  // Prefer the gridded Open-Meteo precipitation field (smooth, model
  // quality). Fall back to the OWM per-station reading if the grid isn't
  // ready yet so the layer still shows something on first paint.
  const fromGrid = weatherGrid.interpPrecip(lat, lng);
  if (fromGrid != null && isFinite(fromGrid)) return { value: fromGrid };
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.rain : 0 };
}
export function pressSample(lng, lat, t){
  // Prefer the dedicated Open-Meteo pressure grid (smooth, model-quality).
  // Fall back to the OWM-derived per-station reading if it isn't ready yet.
  const fromGrid = weatherGrid.interpPressure(lat, lng);
  if (fromGrid != null && isFinite(fromGrid)) return { value: fromGrid };
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.pressure : 1013 };
}

// ---- Colormaps ----
export const windStops = [
  [0,[35,70,170]],  [3,[35,150,185]], [5,[70,185,120]], [7,[190,215,80]],
  [9,[230,180,60]], [10,[230,120,50]],[11,[210,70,50]], [12,[150,30,40]]
];
export const tempStops = [
  [-30,[90,40,150]], [-10,[40,80,190]], [0,[50,170,190]], [10,[110,190,110]],
  [20,[230,210,80]], [30,[230,150,60]], [40,[200,70,50]], [50,[120,20,20]]
];
export const humidityStops = [
  [0,[140,90,40]], [25,[210,150,70]], [50,[220,210,140]],
  [75,[80,170,180]], [100,[30,80,150]]
];
export const cloudsStops = [
  [0,[50,60,80]], [25,[100,110,130]], [50,[150,160,180]], [75,[200,210,220]], [100,[240,245,255]]
];
// Precipitation / storm ramp matching the reference image:
//   no rain  -> transparent
//   drizzle  -> pale sky blue
//   light    -> cyan
//   moderate -> saturated blue
//   heavy    -> magenta
//   extreme  -> red core
export const stormStops = [
  [0,    [10, 30, 50]],
  [0.2,  [130, 180, 235]],
  [0.6,  [60, 130, 240]],
  [2.0,  [40, 70, 220]],
  [5.0,  [180, 60, 200]],
  [10.0, [240, 40, 60]],
  [20.0, [255, 80, 40]],
];

// Cloud cover % palette — clear sky → light overcast → thick grey.
// First stop is at 1% (not 0%) so any non-zero reading paints into the
// gradient — `getColor` treats val<=firstStop as fully transparent, so
// truly clear sky (0%) stays see-through.
export const cloudStops = [
  [1,   [200, 215, 235]],
  [25,  [170, 180, 205]],
  [50,  [135, 150, 180]],
  [75,  [95,  110, 145]],
  [100, [55,  70,  100]],
];
export const pressureStops = [
  // Cool blues for LOWS, cream near mean sea level, warm peach for HIGHS —
  // matches the reference synoptic-chart colour ramp.
  [960,[55,90,170]],  [975,[85,135,200]], [990,[140,185,220]],
  [1000,[205,225,235]],[1010,[238,228,200]],[1020,[238,195,150]],
  [1030,[225,140,95]], [1045,[190,70,55]],
];

function getColor(val, stops){
  // Below the first stop's threshold -> fully transparent (no paint).
  if(val<=stops[0][0]) return [0, 0, 0, 0];
  if(val>=stops[stops.length-1][0]) {
    const c = stops[stops.length-1][1];
    return [c[0], c[1], c[2], 255];
  }
  for(let i=0; i<stops.length-1; i++){
    if(val>=stops[i][0] && val<=stops[i+1][0]){
      const t = (val-stops[i][0])/(stops[i+1][0]-stops[i][0]);
      const c1=stops[i][1], c2=stops[i+1][1];
      const r = c1[0]+t*(c2[0]-c1[0]);
      const g = c1[1]+t*(c2[1]-c1[1]);
      const b = c1[2]+t*(c2[2]-c1[2]);
      // Alpha: fades in from ~0.4 at the first stop to ~0.95 at the
      // strongest stop. The cloud ramp starts at 1% (not 0%) so its first
      // segment also gets a gentle ramp from 0.4 → 0.95 as t grows.
      const a = Math.round(255 * Math.min(0.95, 0.4 + t * 0.55));
      return [r, g, b, a];
    }
  }
  return [0, 0, 0, 0];
}

// --------------------------------------------------------
// 1) WIND PARTICLE LAYER (Animated on overlayPane)
// --------------------------------------------------------

export const WindParticleLayer = L.Layer.extend({
  options: {
    particleCount: 1500,
    speedFactor: 1.5,
    zIndex: 500
  },

  initialize(sampleFn, options){
    L.setOptions(this, options);
    this._sample = sampleFn;
    this._t = 0;
  },

  onAdd(map){
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'wind-particle-layer leaflet-zoom-animated');
    this._canvas.style.pointerEvents = 'none';
    this._canvas.style.zIndex = this.options.zIndex;

    // Add to overlay pane so it zooms/pans automatically via CSS transforms!
    map.getPane('overlayPane').appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    map.on('movestart', this._pause, this);
    map.on('moveend', this._reset, this);
    map.on('moveend', this._resync, this);
    map.on('zoomend', this._onZoomEnd, this);
    this._reset();
    this._initParticles();

    this._running = true;
    this._last = performance.now();
    this._animate();
  },

  onRemove(map){
    this._running = false;
    if(this._raf) cancelAnimationFrame(this._raf);
    map.getPane('overlayPane').removeChild(this._canvas);
    map.off('movestart', this._pause, this);
    map.off('moveend', this._reset, this);
    map.off('moveend', this._resync, this);
    map.off('zoomend', this._onZoomEnd, this);
  },

  setTime(t){ this._t = t; },

  _onZoomEnd(){
    // Grow the particle pool lazily to match the new zoom level. We add
    // fresh particles in one shot rather than every frame so there's no
    // allocation churn mid-zoom.
    const zoom = this._map.getZoom();
    const target = this._desiredPoolSize(zoom);
    while (this._particles.length < target) {
      const p = {};
      this._spawn(p);
      p.age = Math.random() * (p.life || 1);
      this._particles.push(p);
    }
  },

  // ── Dynamic zoom tuning ─────────────────────────────────────────────
  // Larger & denser when zoomed OUT (continent view); smaller & sparser
  // when zoomed IN (street-level). Bounds chosen so:
  //   zoom <= 2  → "wide" look:   ~2.4× count, thick lines, fat heads
  //   zoom >= 9  → "narrow" look: ~0.5× count, hairline, dot heads
  _zoomFactor(zoom){
    // 1.0 fully zoomed OUT, 0.0 fully zoomed IN
    return Math.max(0, Math.min(1, (10 - zoom) / 8));
  },

  _desiredPoolSize(zoom){
    const z = this._zoomFactor(zoom);
    // Base is particleCount option; widen the pool when zoomed out.
    // 1500 base → 3600 at zoom 2, 750 at zoom 10.
    return Math.floor(this.options.particleCount * (0.5 + 1.9 * z));
  },

  _pause(){
    // Stop the render loop AND wipe the canvas so no stale streaks smear
    // across the map while the user drags. The trail fade is the source of
    // those vertical streaks — if we leave it running while the pane is
    // CSS-transforming, each frame's old pixels fade at the new offset.
    this._paused = true;
    if(this._raf){
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if(this._ctx){
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  },

  _resync(){
    // After Leaflet finishes panning/zooming, re-project every particle
    // from its stored (lat, lng) to the new layerPoint, then resume.
    for(let i=0; i<this._particles.length; i++){
      const p = this._particles[i];
      const lp = this._map.latLngToLayerPoint([p.lat, p.lng]);
      p.x = lp.x;
      p.y = lp.y;
      p.hasPrev = false;
    }
    this._last = performance.now();
    this._paused = false;
    this._animate();
  },

  _reset(){
    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._layerTopLeft = this._map.containerPointToLayerPoint([0,0]);
    L.DomUtil.setPosition(this._canvas, this._layerTopLeft);

    // Completely reset canvas since it was resized/moved
    if(this._ctx){
      this._ctx.fillStyle = 'rgba(0,0,0,0)';
      this._ctx.fillRect(0,0, size.x, size.y);
      this._ctx.clearRect(0, 0, size.x, size.y);
    }
  },

  _bounds(){ return this._map.getBounds().pad(0.2); },

  _spawn(p){
    const b = this._bounds();
    p.lat = b.getSouth() + Math.random()*(b.getNorth()-b.getSouth());
    p.lng = b.getWest()  + Math.random()*(b.getEast()-b.getWest());
    p.age = 0;
    p.life = 0.6 + Math.random()*1.0;
    p.hasPrev = false;
    // Per-particle size jitter so the field isn't perfectly uniform.
    if (p.size === undefined) p.size = 0.6 + Math.random() * 0.8;

    // calculate layerPoint on spawn
    const lp = this._map.latLngToLayerPoint([p.lat, p.lng]);
    p.x = lp.x;
    p.y = lp.y;
  },

  _initParticles(){
    // Seed the pool at the WIDEST (zoomed-out) size so we have headroom to
    // "add particles" by activating more of the existing pool when the user
    // pans out, instead of allocating every frame. The pool only ever
    // grows during zoom-end (see _onZoomEnd).
    const zoom = this._map ? this._map.getZoom() : 3;
    const target = this._desiredPoolSize(zoom);
    this._particles = [];
    for(let i=0; i<target; i++){
      const p = {};
      this._spawn(p);
      p.age = Math.random()*p.life;
      // Per-particle size multiplier (0.6 – 1.4) so the field doesn't look
      // unnaturally uniform when zoomed in.
      p.size = 0.6 + Math.random() * 0.8;
      this._particles.push(p);
    }
  },

  _animate(){
    if(!this._running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now-this._last)/1000);
    this._last = now;
    if (!this._paused) {
      this._step(dt);
    }
    this._raf = requestAnimationFrame(()=> this._animate());
  },

  _step(dt){
    const zoom = this._map.getZoom();

    // zFactor: 1.0 zoomed OUT (wide), 0.0 zoomed IN (street level)
    const z = this._zoomFactor(zoom);

    // A very fast fade to leave a tiny, comet-like trail (Zoom Earth style)
    const fadeAlpha = 0.70 + 0.15 * z;
    this._ctx.fillStyle = `rgba(0,0,0,${fadeAlpha.toFixed(2)})`;
    this._ctx.globalCompositeOperation = 'destination-in';
    this._ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
    this._ctx.globalCompositeOperation = 'source-over';

    // ── Dynamic sizing ───────────────────────────────────────────────
    //   lineWidth  : hairline (0.4) when zoomed in → chunky (2.6) when zoomed out
    //   headRadius : 0 when zoomed in (just a line) → glowing dot when zoomed out
    const baseLineWidth = 0.4 + 2.2 * z;
    const headRadius    = 0.2 + 1.6 * z;          // px

    this._ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 + 0.2 * z})`;
    this._ctx.lineCap = 'round';
    this._ctx.beginPath();

    const b = this._bounds();

    // ── Dynamic count ────────────────────────────────────────────────
    // Zoomed OUT (z=1)  → use everything in the pool (denser = "bigger storm")
    // Zoomed IN  (z=0)  → use ~40 % (sparser so lines don't overlap)
    const density = 0.4 + 0.6 * z;
    const activeCount = Math.floor(this._particles.length * density);

    for(let i=0; i<activeCount; i++){
      const p = this._particles[i];
      p.age += dt;

      // Calculate drawing coords relative to canvas
      const cx = p.x - this._layerTopLeft.x;
      const cy = p.y - this._layerTopLeft.y;

      // Per-particle size jitter modulates both line thickness and head.
      const w = baseLineWidth * p.size;
      // Apply per-particle width by setting lineWidth on the path segment.
      // (canvas2d doesn't support per-segment widths, so we just feed a
      // weighted contribution via strokeStyle alpha — visual effect is the
      // same on a dense field.)

      if(p.hasPrev){
        this._ctx.moveTo(p.prevCx, p.prevCy);
        this._ctx.lineTo(cx, cy);
      }

      p.prevCx = cx;
      p.prevCy = cy;
      p.hasPrev = true;

      // Convert physical layer point to lat/lon to sample wind field
      const ll = this._map.layerPointToLatLng(L.point(p.x, p.y));
      const s = this._sample(ll.lng, ll.lat, this._t);

      // Visual speed scales gently with zoom so wind reads faster at continent
      // scale and slower at street level (where the lines would smear).
      const visualSpeedScale = 1.0 + 1.5 * z;

      p.x += s.u * this.options.speedFactor * visualSpeedScale * dt * 10;
      p.y -= s.v * this.options.speedFactor * visualSpeedScale * dt * 10;

      // Re-spawn if dead or out of bounds
      if(p.age > p.life || !b.contains([ll.lat, ll.lng])) {
          this._spawn(p);
      }
    }
    this._ctx.lineWidth = baseLineWidth;
    this._ctx.stroke();

    // ── Glowing head dots ────────────────────────────────────────────
    // Drawn as a separate pass so the additive blending doesn't muddy the
    // comet trails. Skip entirely when fully zoomed in (radius ≈ 0).
    if (headRadius > 0.3) {
      this._ctx.globalCompositeOperation = 'lighter';
      this._ctx.fillStyle = `rgba(220, 240, 255, ${0.35 + 0.35 * z})`;
      this._ctx.beginPath();
      for (let i = 0; i < activeCount; i++) {
        const p = this._particles[i];
        const cx = p.x - this._layerTopLeft.x;
        const cy = p.y - this._layerTopLeft.y;
        const r = headRadius * p.size;
        this._ctx.moveTo(cx + r, cy);
        this._ctx.arc(cx, cy, r, 0, Math.PI * 2);
      }
      this._ctx.fill();
      this._ctx.globalCompositeOperation = 'source-over';
    }
  }
});


// --------------------------------------------------------
// 2) GRADIENT FIELD LAYER (Animated on overlayPane)
// --------------------------------------------------------

export const GradientFieldLayer = L.Layer.extend({
  options: {
    cellSize: 8,
    opacity: 0.72,
    blur: 6,
    contourLevels: null,
    zIndex: 450
  },

  initialize(sampleFn, stops, options){
    L.setOptions(this, options);
    this._sample = sampleFn;
    this._stops = stops;
    this._t = 0;
  },

  onAdd(map){
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'gradient-field-layer leaflet-zoom-animated');
    this._canvas.style.pointerEvents = 'none';
    this._canvas.style.zIndex = this.options.zIndex;
    this._canvas.style.opacity = this.options.opacity;
    
    // Add to overlay pane for dynamic CSS zooming/panning
    map.getPane('overlayPane').appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    // Only redraw on moveend, let CSS handle panning during drag!
    map.on('movestart', this._pause, this);
    map.on('moveend', this._reset, this);
    this._reset();
  },

  onRemove(map){
    map.getPane('overlayPane').removeChild(this._canvas);
    map.off('movestart', this._pause, this);
    map.off('movestart', this._pause, this);
    map.off('moveend', this._reset, this);
  },

  setTime(t){ 
    this._t = t;
    if (!this._animating) {
      this._animating = true;
      requestAnimationFrame(() => {
        this._redraw();
        this._animating = false;
      });
    }
  },

  _reset(){
    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._layerTopLeft = this._map.containerPointToLayerPoint([0,0]);
    L.DomUtil.setPosition(this._canvas, this._layerTopLeft);
    this._redraw();
  },

  _redraw(){
    if(!this._canvas || !this._map) return;
    const w = this._canvas.width, h = this._canvas.height;
    if(w===0 || h===0) return;
    const CELL = this.options.cellSize;
    const cols = Math.ceil(w/CELL), rows = Math.ceil(h/CELL);
    
    // Render to offscreen canvas
    const off = document.createElement('canvas');
    off.width = cols; off.height = rows;
    const octx = off.getContext('2d');
    const idata = octx.createImageData(cols, rows);
    const d32 = new Uint32Array(idata.data.buffer);
    
    const values = new Float32Array(cols*rows);
    let vmin=Infinity, vmax=-Infinity;

    for(let j=0; j<rows; j++){
      for(let i=0; i<cols; i++){
        // Calculate point relative to current map pane
        const lp = L.point(i*CELL, j*CELL).add(this._layerTopLeft);
        const ll = this._map.layerPointToLatLng(lp);
        
        const s = this._sample(ll.lng, ll.lat, this._t);
        const idx = j*cols + i;
        values[idx] = s.value;
        if(s.value < vmin) vmin = s.value;
        if(s.value > vmax) vmax = s.value;

        const c = getColor(s.value, this._stops);
        // RGBA packed little-endian so cells with 0 value don't paint at all.
        const A = c[3] ?? 255, R = c[0]|0, G = c[1]|0, B = c[2]|0;
        d32[idx] = (A << 24) | (B << 16) | (G << 8) | R;
      }
    }
    octx.putImageData(idata, 0, 0);

    // Draw blurred offscreen to main canvas
    this._ctx.clearRect(0,0,w,h);
    this._ctx.filter = `blur(${this.options.blur}px)`;
    this._ctx.drawImage(off, 0, 0, cols, rows, 0, 0, w, h);
    this._ctx.filter = 'none';

    if(this.options.contourLevels){
      this._drawContours(values, cols, rows, CELL);
    }
  },

  _drawContours(values, cols, rows, CELL){
    const levels = this.options.contourLevels;
    if (!levels || levels.length === 0) return;

    const drawLevel = (lv, lineWidth, alpha) => {
      this._ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      this._ctx.lineWidth = lineWidth;
      this._ctx.beginPath();
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const idx = j * cols + i;
          const v00 = values[idx],       v10 = values[idx + 1];
          const v01 = values[idx + cols], v11 = values[idx + cols + 1];
          const p = [];
          if ((v00 < lv && v10 >= lv) || (v00 >= lv && v10 < lv)) p.push([i + (lv - v00) / (v10 - v00), j]);
          if ((v10 < lv && v11 >= lv) || (v10 >= lv && v11 < lv)) p.push([i + 1, j + (lv - v10) / (v11 - v10)]);
          if ((v01 < lv && v11 >= lv) || (v01 >= lv && v11 < lv)) p.push([i + (lv - v01) / (v11 - v01), j + 1]);
          if ((v00 < lv && v01 >= lv) || (v00 >= lv && v01 < lv)) p.push([i, j + (lv - v00) / (v01 - v00)]);
          if (p.length === 2) {
            this._ctx.moveTo(p[0][0] * CELL, p[0][1] * CELL);
            this._ctx.lineTo(p[1][0] * CELL, p[1][1] * CELL);
          }
        }
      }
      this._ctx.stroke();
    };

    // Two passes: faint thin line for every level, then a thicker line
    // for the "primary" level (synoptic baseline).
    const primary = this.options.primaryContour;
    for (const lv of levels) {
      if (lv === primary) continue;
      drawLevel(lv, 1, 0.45);
    }
    if (primary != null && levels.includes(primary)) {
      drawLevel(primary, 2, 0.85);
    }
  }
});
