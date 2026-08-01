import L from 'leaflet';

const API_KEY = 'a63a66e50c1159983af837acb9e4efa8';

/* =========================================================
   LIVE DATA — OpenWeatherMap current-weather grid
========================================================= */
class WeatherGrid {
  constructor(){ this.cache = new Map(); }
  key(lat,lon){ return Math.round(lat*2)/2 + ',' + Math.round(lon*2)/2; }
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
      const gust  = (j.wind && j.wind.gust) || speed*1.3;
      const deg   = (j.wind && j.wind.deg) || 0;
      const d = {
        temp: j.main.temp,
        feels: j.main.feels_like,
        humidity: j.main.humidity,
        pressure: j.main.pressure,
        u: -speed*Math.sin(deg*Math.PI/180),
        v: -speed*Math.cos(deg*Math.PI/180),
        ug: -gust*Math.sin(deg*Math.PI/180),
        vg: -gust*Math.cos(deg*Math.PI/180),
        t: Date.now()
      };
      this.cache.set(k, {t:Date.now(), d});
      return d;
    }catch(e){ return cached ? cached.d : null; }
  }
  async refreshGrid(bounds, cols, rows){
    const points = [];
    for(let j=0;j<rows;j++){
      for(let i=0;i<cols;i++){
        const lat = bounds.north + (bounds.south-bounds.north)*(j/(rows-1));
        const lon = bounds.west + (bounds.east-bounds.west)*(i/(cols-1));
        points.push({lat,lon,i,j});
      }
    }
    const results = await Promise.all(points.map(p => this.fetchPoint(p.lat,p.lon).then(d => ({...p, d}))));
    return { results, cols, rows, bounds };
  }
}

const LAYERS = {
  wind:        { stops:[[0,[35,70,170]],[3,[35,150,185]],[5,[70,185,120]],[7,[190,215,80]],[9,[230,180,60]],[10,[230,120,50]],[11,[210,70,50]],[12,[150,30,40]]], min:0, max:12 },
  temperature: { stops:[[-30,[90,40,150]],[-10,[40,80,190]],[0,[50,170,190]],[10,[110,190,110]],[20,[230,210,80]],[30,[230,150,60]],[40,[200,70,50]],[50,[120,20,20]]], min:-30, max:50 },
  humidity:    { stops:[[0,[140,90,40]],[25,[210,150,70]],[50,[220,210,140]],[75,[80,170,180]],[100,[30,80,150]]], min:0, max:100 },
  pressure:    { stops:[[970,[40,60,150]],[985,[70,110,190]],[1000,[140,180,210]],[1015,[225,220,200]],[1030,[220,150,90]],[1045,[190,70,50]]], min:970, max:1045 }
};

function knotsToBft(k){
  const table=[1,3,6,10,16,21,27,33,40,47,55,63];
  for(let i=0;i<table.length;i++) if(k<table[i]) return i;
  return 12;
}
function colorForValue(value, stops){
  if(value<=stops[0][0]) return stops[0][1];
  for(let i=0;i<stops.length-1;i++){
    const [v0,c0]=stops[i], [v1,c1]=stops[i+1];
    if(value>=v0 && value<=v1){
      const f=(value-v0)/(v1-v0);
      return [Math.round(c0[0]+(c1[0]-c0[0])*f), Math.round(c0[1]+(c1[1]-c0[1])*f), Math.round(c0[2]+(c1[2]-c0[2])*f)];
    }
  }
  return stops[stops.length-1][1];
}

export const WeatherCanvasLayer = L.Layer.extend({
  initialize: function (options) {
    L.Util.setOptions(this, options);
    this.weatherGrid = new WeatherGrid();
    this.currentGrid = null;
    this.weatherMode = options.weatherMode || 'wind';
    this.particles = [];
    this.bgCanvas = document.createElement('canvas');
    this.bgCtx = this.bgCanvas.getContext('2d', { willReadFrequently: true });
    
    // Create elements
    this.container = L.DomUtil.create('div', 'leaflet-layer');
    this.fieldCv = L.DomUtil.create('canvas', 'leaflet-zoom-animated', this.container);
    this.partCv = L.DomUtil.create('canvas', 'leaflet-zoom-animated', this.container);
    this.contCv = L.DomUtil.create('canvas', 'leaflet-zoom-animated', this.container);
    
    Object.assign(this.fieldCv.style, { position: 'absolute', pointerEvents: 'none' });
    Object.assign(this.partCv.style, { position: 'absolute', pointerEvents: 'none' });
    Object.assign(this.contCv.style, { position: 'absolute', pointerEvents: 'none' });
    
    this.fctx = this.fieldCv.getContext('2d');
    this.pctx = this.partCv.getContext('2d');
    this.cctx = this.contCv.getContext('2d');
  },

  onAdd: function (map) {
    this._map = map;
    map.getPanes().overlayPane.appendChild(this.container);
    
        map.on('moveend', this._onMoveEnd, this);
    map.on('resize', this._reset, this);

    this._reset();
    this._onMoveEnd();
    
    this.initParticles();
    this._animId = requestAnimationFrame((now) => this._loop(now));
  },

  onRemove: function (map) {
        map.off('moveend', this._onMoveEnd, this);
    map.off('resize', this._reset, this);
    
    L.DomUtil.remove(this.container);
    cancelAnimationFrame(this._animId);
    clearTimeout(this._fetchTimeout);
  },
  
  setWeatherMode: function(mode) {
    this.weatherMode = mode;
    this.pctx.clearRect(0,0,this.W,this.H);
    this.cctx.clearRect(0,0,this.W,this.H);
  },

  _reset: function () {
    const size = this._map.getSize();
    const bounds = this._map.getBounds();
    const topLeft = this._map.latLngToLayerPoint(bounds.getNorthWest());
    
    this.W = size.x;
    this.H = size.y;
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    
    this._layerTopLeft = topLeft;
    L.DomUtil.setPosition(this.container, topLeft);
    
    [this.fieldCv, this.partCv, this.contCv].forEach(cv => {
      cv.width = this.W * this.DPR;
      cv.height = this.H * this.DPR;
      cv.style.width = this.W + 'px';
      cv.style.height = this.H + 'px';
    });
    
    this.fctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.pctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
    this.cctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
  },

  _onMoveEnd: function () {
    this._reset();
    clearTimeout(this._fetchTimeout);
    this._fetchTimeout = setTimeout(() => this._refreshGrid(), 300);
  },

  boundsFromMap: function() {
    const b = this._map.getBounds();
    const marginLat = (b.getNorth()-b.getSouth())*0.15;
    const marginLon = (b.getEast()-b.getWest())*0.15;
    return {
      north: Math.min(85, b.getNorth()+marginLat),
      south: Math.max(-85, b.getSouth()-marginLat),
      west: b.getWest()-marginLon,
      east: b.getEast()+marginLon
    };
  },

  _refreshGrid: async function () {
    if(!this._map) return;
    const bounds = this.boundsFromMap();
    this.currentGrid = await this.weatherGrid.refreshGrid(bounds, 8, 6);
  },

  interpField: function(lat, lon, field) {
    if(!this.currentGrid) return null;
    const { results, cols, rows, bounds } = this.currentGrid;
    const fj = (bounds.north - lat) / (bounds.north - bounds.south) * (rows-1);
    const fi = (lon - bounds.west) / (bounds.east - bounds.west) * (cols-1);
    if(!isFinite(fi) || !isFinite(fj)) return null;
    const i0 = Math.max(0, Math.min(cols-2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(rows-2, Math.floor(fj)));
    const i1=i0+1, j1=j0+1;
    const tx = Math.min(1,Math.max(0, fi-i0)), ty = Math.min(1,Math.max(0, fj-j0));
    function get(i,j){ const p = results[j*cols+i]; return (p && p.d) ? p.d[field] : null; }
    const v00=get(i0,j0), v10=get(i1,j0), v01=get(i0,j1), v11=get(i1,j1);
    const vals=[v00,v10,v01,v11];
    if(vals.some(v=>v==null)){
      const ok = vals.filter(v=>v!=null);
      return ok.length ? ok.reduce((a,b)=>a+b,0)/ok.length : null;
    }
    const top = v00 + (v10-v00)*tx;
    const bot = v01 + (v11-v01)*tx;
    return top + (bot-top)*ty;
  },

  sampleAt: function(lat, lon) {
    if (this.weatherMode === 'wind') {
      const u = this.interpField(lat,lon,'u'), v = this.interpField(lat,lon,'v');
      if(u==null || v==null) return null;
      const speedMs = Math.hypot(u,v);
      const knots = speedMs*1.94384;
      const angle = Math.atan2(-v,u); // screen-space angle
      return { knots, angle, value: knotsToBft(knots) };
    }
    if (this.weatherMode === 'temperature') {
      const val = this.interpField(lat,lon,'temp');
      return val==null ? null : { value: val };
    }
    if (this.weatherMode === 'humidity') {
      const val = this.interpField(lat,lon,'humidity');
      return val==null ? null : { value: val };
    }
    if (this.weatherMode === 'pressure') {
      const val = this.interpField(lat,lon,'pressure');
      return val==null ? null : { value: val };
    }
    return null;
  },

  drawField: function() {
    const CELL = 9;
    const layer = LAYERS[this.weatherMode] || LAYERS['wind'];
    const cols = Math.ceil(this.W/CELL)+1, rows = Math.ceil(this.H/CELL)+1;
    this.bgCanvas.width=cols; this.bgCanvas.height=rows;
    const img = this.bgCtx.createImageData(cols,rows);
    const grid = new Float32Array(cols*rows);
    let any=false;
    
    // Bounds of the current screen map view
    const mapBounds = this._map.getBounds();
    const mapTopLeft = this._map.latLngToContainerPoint(mapBounds.getNorthWest());
    
    for(let j=0;j<rows;j++){
      for(let i=0;i<cols;i++){
        // Convert canvas pixel to lat/lon
        const sx=i*CELL, sy=j*CELL;
        const layerPoint = L.point(sx, sy).add(this._layerTopLeft);
        const ll = this._map.layerPointToLatLng(layerPoint);
        const s = this.sampleAt(ll.lat, ll.lng);
        const idx=(j*cols+i)*4;
        if(!s){ grid[j*cols+i]=NaN; img.data[idx+3]=0; continue; }
        any=true;
        grid[j*cols+i] = s.value;
        const col = colorForValue(s.value, layer.stops);
        img.data[idx]=col[0]; img.data[idx+1]=col[1]; img.data[idx+2]=col[2]; img.data[idx+3]=150;
      }
    }
    this.bgCtx.putImageData(img,0,0);
    this.fctx.clearRect(0,0,this.W,this.H);
    if(any){
      this.fctx.save();
      this.fctx.setTransform(1,0,0,1,0,0);
      this.fctx.imageSmoothingEnabled = true;
      this.fctx.filter = 'blur(6px)';
      this.fctx.drawImage(this.bgCanvas, 0, 0, cols, rows, -CELL, -CELL, cols*CELL, rows*CELL);
      this.fctx.filter = 'none';
      this.fctx.restore();
    }
    
    if(this.weatherMode==='pressure' && any) this.drawContours(grid, cols, rows, CELL); 
    else this.cctx.clearRect(0,0,this.W,this.H);
  },

  drawContours: function(grid, cols, rows, CELL) {
    this.cctx.save();
    this.cctx.setTransform(this.DPR,0,0,this.DPR,0,0);
    this.cctx.clearRect(0,0,this.W,this.H);
    this.cctx.strokeStyle = 'rgba(255,255,255,0.55)';
    this.cctx.lineWidth = 1;
    const levels = [975,985,995,1005,1015,1025,1035,1045];
    function val(i,j){ return grid[j*cols+i]; }
    function lerp(v0,v1,level){ return v1===v0 ? 0.5 : (level-v0)/(v1-v0); }
    for(const level of levels){
      this.cctx.beginPath();
      for(let j=0;j<rows-1;j++){
        for(let i=0;i<cols-1;i++){
          const tl=val(i,j), tr=val(i+1,j), br=val(i+1,j+1), bl=val(i,j+1);
          if([tl,tr,br,bl].some(v=>isNaN(v))) continue;
          let idx=0;
          if(tl>level) idx|=8; if(tr>level) idx|=4; if(br>level) idx|=2; if(bl>level) idx|=1;
          if(idx===0||idx===15) continue;
          const x0=i*CELL-CELL, y0=j*CELL-CELL, x1=(i+1)*CELL-CELL, y1=(j+1)*CELL-CELL;
          const top=[x0+lerp(tl,tr,level)*(x1-x0), y0];
          const right=[x1, y0+lerp(tr,br,level)*(y1-y0)];
          const bottom=[x0+lerp(bl,br,level)*(x1-x0), y1];
          const left=[x0, y0+lerp(tl,bl,level)*(y1-y0)];
          const table={1:[[left,bottom]],2:[[bottom,right]],3:[[left,right]],4:[[top,right]],
            5:[[top,left],[bottom,right]],6:[[top,bottom]],7:[[top,left]],8:[[top,left]],
            9:[[top,bottom]],10:[[top,right],[bottom,left]],11:[[top,right]],12:[[left,right]],
            13:[[bottom,right]],14:[[left,bottom]]};
          const lines = table[idx];
          if(lines) for(const [a,b] of lines){ this.cctx.moveTo(a[0],a[1]); this.cctx.lineTo(b[0],b[1]); }
        }
      }
      this.cctx.stroke();
    }
    this.cctx.restore();
  },

  initParticles: function() {
    this.particles = [];
    for(let i=0;i<700;i++){ 
      const p={}; 
      this.spawn(p); 
      p.age=Math.random()*p.life; 
      this.particles.push(p); 
    }
  },
  
  visibleScreenBounds: function(margin) {
    return { x0:-margin, y0:-margin, x1:this.W+margin, y1:this.H+margin };
  },
  
  spawn: function(p) {
    const b = this.visibleScreenBounds(40);
    p.sx = b.x0+Math.random()*(b.x1-b.x0);
    p.sy = b.y0+Math.random()*(b.y1-b.y0);
    p.age=0; p.life=1.2+Math.random()*1.8; p.hasPrev=false;
  },

  stepParticles: function(dt) {
    const K = 2.6; // px per (knot*second)
    this.pctx.save(); 
    this.pctx.setTransform(this.DPR,0,0,this.DPR,0,0);
    this.pctx.globalCompositeOperation='destination-out';
    this.pctx.fillStyle='rgba(0,0,0,0.14)';
    this.pctx.fillRect(0,0,this.W,this.H);
    this.pctx.globalCompositeOperation='source-over';
    
    const b = this.visibleScreenBounds(60);
    for(const p of this.particles){
      const layerPoint = L.point(p.sx, p.sy).add(this._layerTopLeft);
      const ll = this._map.layerPointToLatLng(layerPoint);
      const f = this.sampleAt(ll.lat, ll.lng);
      if(!f){ p.age = p.life+1; continue; }
      const prevx=p.sx, prevy=p.sy;
      p.sx += Math.cos(f.angle)*f.knots*K*dt*0.06;
      p.sy += Math.sin(f.angle)*f.knots*K*dt*0.06;
      p.age += dt;
      if(p.hasPrev && p.age<p.life){
        const alpha = Math.min(1,(p.life-p.age)/p.life+0.15)*0.7;
        this.pctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        this.pctx.lineWidth = 1.3;
        this.pctx.beginPath(); this.pctx.moveTo(prevx,prevy); this.pctx.lineTo(p.sx,p.sy); this.pctx.stroke();
      }
      p.hasPrev=true;
      if(p.age>p.life || p.sx<b.x0 || p.sx>b.x1 || p.sy<b.y0 || p.sy>b.y1) this.spawn(p);
    }
    this.pctx.restore();
  },

  _loop: function(now) {
    if(!this._last) this._last = now;
    const dt = Math.min(0.05, (now - this._last) / 1000); 
    this._last = now;
    
    this._bgFrame = (this._bgFrame || 0) + 1;
    if(this._bgFrame % 2 === 0) this.drawField();
    
    if(this.weatherMode === 'wind') {
      this.stepParticles(dt);
    }
    
    this._animId = requestAnimationFrame((n) => this._loop(n));
  }
});
