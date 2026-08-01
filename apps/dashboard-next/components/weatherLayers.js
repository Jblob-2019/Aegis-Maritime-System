import L from 'leaflet';

// --------------------------------------------------------
// 0) SHARED — noise, field sampling, colormap
// --------------------------------------------------------

const API_KEY = 'a63a66e50c1159983af837acb9e4efa8';

class WeatherGrid {
  constructor(){ 
    this.cache = new Map(); 
    this.currentGrid = null;
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
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.clouds : 0 };
}
export function rainSample(lng, lat, t){
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.rain : 0 };
}
export function pressSample(lng, lat, t){
  const d = weatherGrid.interp(lat, lng);
  return { value: d ? d.pressure : 1000 };
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
export const stormStops = [
  [0,[10,30,50]], [0.5,[100,150,250]], [2.0,[50,100,220]], [5.0,[20,50,180]], [10.0,[150,50,150]], [20.0,[255,0,0]]
];
export const pressureStops = [
  [970,[40,60,150]], [985,[70,110,190]], [1000,[140,180,210]],
  [1015,[225,220,200]], [1030,[220,150,90]], [1045,[190,70,50]]
];

function getColor(val, stops){
  if(val<=stops[0][0]) return stops[0][1];
  if(val>=stops[stops.length-1][0]) return stops[stops.length-1][1];
  for(let i=0; i<stops.length-1; i++){
    if(val>=stops[i][0] && val<=stops[i+1][0]){
      const t = (val-stops[i][0])/(stops[i+1][0]-stops[i][0]);
      const c1=stops[i][1], c2=stops[i+1][1];
      return [
        c1[0]+t*(c2[0]-c1[0]),
        c1[1]+t*(c2[1]-c1[1]),
        c1[2]+t*(c2[2]-c1[2])
      ];
    }
  }
  return [0,0,0];
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
    map.on('movestart', this._pause, this);
    map.on('moveend', this._reset, this);
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
    map.off('movestart', this._pause, this);
    map.off('moveend', this._reset, this);
  },

  setTime(t){ this._t = t; },

  _pause(){
    this._paused = true;
  },

  _reset(){
    this._paused = false;
    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._layerTopLeft = this._map.containerPointToLayerPoint([0,0]);
    L.DomUtil.setPosition(this._canvas, this._layerTopLeft);
    
    // Completely reset canvas since it was resized/moved
    this._ctx.fillStyle = 'rgba(0,0,0,0)';
    this._ctx.fillRect(0,0, size.x, size.y);
  },

  _bounds(){ return this._map.getBounds().pad(0.2); },

  _spawn(p){
    const b = this._bounds();
    p.lat = b.getSouth() + Math.random()*(b.getNorth()-b.getSouth());
    p.lng = b.getWest()  + Math.random()*(b.getEast()-b.getWest());
    p.age = 0;
    p.life = 0.6 + Math.random()*1.0;
    p.hasPrev = false;
    
    // calculate layerPoint on spawn
    const lp = this._map.latLngToLayerPoint([p.lat, p.lng]);
    p.x = lp.x;
    p.y = lp.y;
  },

  _initParticles(){
    this._particles = [];
    for(let i=0;i<this.options.particleCount;i++){
      const p = {};
      this._spawn(p);
      p.age = Math.random()*p.life;
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
    
    // zFactor: 1.0 when zoomed OUT (zoom <= 3), 0.0 when zoomed IN (zoom >= 10)
    const zFactor = Math.max(0, Math.min(1, (10 - zoom) / 7));
    
    // A very fast fade to leave a tiny, comet-like trail (Zoom Earth style)
    const fadeAlpha = 0.70 + 0.15 * zFactor;
    this._ctx.fillStyle = `rgba(0,0,0,${fadeAlpha.toFixed(2)})`; 
    this._ctx.globalCompositeOperation = 'destination-in';
    this._ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
    this._ctx.globalCompositeOperation = 'source-over';
    
    // Dynamic line width: much thinner when zoomed in (e.g. 0.5px) to prevent clutter
    this._ctx.lineWidth = 0.5 + 1.2 * zFactor;
    this._ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 + 0.2 * zFactor})`;
    this._ctx.beginPath();
    
    const b = this._bounds();
    
    // Dynamically scale particle count: Increase when zoomed IN to show local details
    // Zoomed out (zFactor=1) -> density ~0.66 (e.g. 1200 out of 1800 particles).
    // Zoomed in (zFactor=0) -> density 1.00 (e.g. 1800 out of 1800 particles).
    const densityFactor = 0.66 + 0.34 * (1 - zFactor);
    const activeCount = Math.floor(this._particles.length * densityFactor);
    
    for(let i=0; i<activeCount; i++){
      const p = this._particles[i];
      p.age += dt;
      
      // Calculate drawing coords relative to canvas
      const cx = p.x - this._layerTopLeft.x;
      const cy = p.y - this._layerTopLeft.y;
      
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
      
      // Convert geographic wind velocity (u,v) to screen pixel velocity
      // Remove the exponential zoom scale to prevent particles flying at lightspeed when zoomed in!
      // Instead, use a gentle visual scaling so they move slightly faster when zoomed out.
      const visualSpeedScale = 1.0 + 1.5 * zFactor; 
      
      p.x += s.u * this.options.speedFactor * visualSpeedScale * dt * 10;
      p.y -= s.v * this.options.speedFactor * visualSpeedScale * dt * 10;
      
      // Re-spawn if dead or out of bounds
      if(p.age > p.life || !b.contains([ll.lat, ll.lng])) {
          this._spawn(p);
      }
    }
    this._ctx.stroke();
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
        d32[idx] = (255<<24) | (c[2]<<16) | (c[1]<<8) | c[0];
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
    this._ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    this._ctx.lineWidth = 1;
    this._ctx.beginPath();
    
    for(let j=0; j<rows-1; j++){
      for(let i=0; i<cols-1; i++){
        const idx = j*cols + i;
        const v00 = values[idx], v10 = values[idx+1];
        const v01 = values[idx+cols], v11 = values[idx+cols+1];
        
        for(let lv of levels){
          const p = [];
          if((v00<lv && v10>=lv) || (v00>=lv && v10<lv)) p.push([i + (lv-v00)/(v10-v00), j]);
          if((v10<lv && v11>=lv) || (v10>=lv && v11<lv)) p.push([i+1, j + (lv-v10)/(v11-v10)]);
          if((v01<lv && v11>=lv) || (v01>=lv && v11<lv)) p.push([i + (lv-v01)/(v11-v01), j+1]);
          if((v00<lv && v01>=lv) || (v00>=lv && v01<lv)) p.push([i, j + (lv-v00)/(v01-v00)]);
          
          if(p.length===2){
            this._ctx.moveTo(p[0][0]*CELL, p[0][1]*CELL);
            this._ctx.lineTo(p[1][0]*CELL, p[1][1]*CELL);
          }
        }
      }
    }
    this._ctx.stroke();
  }
});
