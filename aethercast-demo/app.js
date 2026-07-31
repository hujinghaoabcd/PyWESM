
  (() => {
    'use strict';
    const DATA = {
      temp: './air_temperature_2m.wxt',
      wind: './wind_10m_uv.wxt',
      bounds: [[72, 17], [136, 54]]
    };
    const state = { temp: null, wind: null, mode: 'temperature', opacity: .68, particles: [], particleCount: 1800, speed: 1, lastTime: performance.now(), moving: false };
    const fieldCanvas = document.getElementById('fieldCanvas');
    const fieldCtx = fieldCanvas.getContext('2d', { alpha: true });
    const windCanvas = document.getElementById('windCanvas');
    const windCtx = windCanvas.getContext('2d');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    function readAscii(bytes, start, length) {
      return String.fromCharCode(...bytes.slice(start, start + length)).replace(/\0+$/, '');
    }
    async function loadWxt(url) {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      if (readAscii(bytes, 0, 4) !== 'WXT1') throw new Error(`${url}: WXT magic 错误`);
      const width = view.getUint16(8, true);
      const height = view.getUint16(10, true);
      const channels = bytes[7];
      const count = width * height;
      const values = new Uint16Array(buffer, 128, count * channels);
      const decodeChannel = (channel) => {
        const scale = view.getFloat32(channel === 0 ? 16 : 32, true);
        const offset = view.getFloat32(channel === 0 ? 20 : 36, true);
        const min = view.getFloat32(channel === 0 ? 24 : 40, true);
        const max = view.getFloat32(channel === 0 ? 28 : 44, true);
        const out = new Float32Array(count);
        const base = channel * count;
        for (let i = 0; i < count; i++) {
          const code = values[base + i];
          out[i] = code === 0 ? NaN : code * scale + offset;
        }
        return { values: out, scale, offset, min, max };
      };
      return {
        width, height, channels,
        west: view.getFloat64(48, true), south: view.getFloat64(56, true), east: view.getFloat64(64, true), north: view.getFloat64(72, true),
        runEpoch: Number(view.getBigInt64(80, true)), validEpoch: Number(view.getBigInt64(88, true)), forecastHour: view.getUint32(96, true),
        label: readAscii(bytes, 112, 16), channel0: decodeChannel(0), channel1: channels > 1 ? decodeChannel(1) : null
      };
    }

    const map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [104, 35], zoom: 3.1, minZoom: 2.1, maxZoom: 10,
      attributionControl: true,
      hash: false
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');

    function fitChina() { map.fitBounds(DATA.bounds, { padding: { top: 70, right: 42, bottom: 60, left: 270 }, duration: 900, maxZoom: 4.4 }); }
    if (map.isStyleLoaded()) fitChina(); else map.once('style.load', fitChina);

    const tempStops = [
      [-25,[65,42,151]],[-15,[48,70,181]],[-5,[36,113,202]],[5,[37,169,205]],
      [15,[54,199,155]],[25,[218,219,77]],[35,[245,148,63]],[45,[217,60,69]]
    ];
    const windStops = [
      [0,[23,60,101]],[3,[34,109,157]],[6,[42,176,189]],[10,[85,213,164]],
      [15,[214,221,85]],[22,[247,154,69]],[30,[214,58,77]]
    ];
    function ramp(value, stops) {
      if (value <= stops[0][0]) return stops[0][1];
      for (let i=1;i<stops.length;i++) {
        if (value <= stops[i][0]) {
          const [a,ca]=stops[i-1], [b,cb]=stops[i]; const t=(value-a)/(b-a);
          return ca.map((v,j)=>Math.round(v+(cb[j]-v)*t));
        }
      }
      return stops[stops.length-1][1];
    }
    function sample(field, lon, lat) {
      if (!field || lon < field.west || lon > field.east || lat < field.south || lat > field.north) return NaN;
      const x = (lon-field.west)/(field.east-field.west)*(field.width-1);
      const y = (lat-field.south)/(field.north-field.south)*(field.height-1);
      const x0=Math.floor(x), y0=Math.floor(y), x1=Math.min(x0+1,field.width-1), y1=Math.min(y0+1,field.height-1);
      const tx=x-x0, ty=y-y0, v=field.channel0.values;
      const v00=v[y0*field.width+x0], v10=v[y0*field.width+x1], v01=v[y1*field.width+x0], v11=v[y1*field.width+x1];
      return (v00*(1-tx)+v10*tx)*(1-ty)+(v01*(1-tx)+v11*tx)*ty;
    }
    function sampleWind(lon, lat) {
      const f=state.wind; if (!f || lon<f.west||lon>f.east||lat<f.south||lat>f.north) return null;
      const x=(lon-f.west)/(f.east-f.west)*(f.width-1), y=(lat-f.south)/(f.north-f.south)*(f.height-1);
      const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(x0+1,f.width-1),y1=Math.min(y0+1,f.height-1),tx=x-x0,ty=y-y0;
      const interp=(arr)=>{const a=arr[y0*f.width+x0]*(1-tx)+arr[y0*f.width+x1]*tx;const b=arr[y1*f.width+x0]*(1-tx)+arr[y1*f.width+x1]*tx;return a*(1-ty)+b*ty;};
      return {u:interp(f.channel0.values),v:interp(f.channel1.values)};
    }
    function renderField() {
      if (!state.temp || !state.wind) return;
      const mode=state.mode;
      const image=fieldCtx.createImageData(512,512), d=image.data;
      for (let py=0;py<512;py++) {
        const srcY=511-py;
        for (let px=0;px<512;px++) {
          const idx=srcY*512+px, out=(py*512+px)*4;
          let color, alpha=190;
          if (mode==='wind') {
            const u=state.wind.channel0.values[idx],v=state.wind.channel1.values[idx];
            color=ramp(Math.hypot(u,v),windStops);
          } else {
            color=ramp(state.temp.channel0.values[idx]-273.15,tempStops);
          }
          d[out]=color[0];d[out+1]=color[1];d[out+2]=color[2];d[out+3]=alpha;
        }
      }
      fieldCtx.putImageData(image,0,0);
      const visible=mode!=='basemap';
      if (map.getLayer('weather-field')) map.setLayoutProperty('weather-field','visibility',visible?'visible':'none');
      map.triggerRepaint();
      const legend=document.querySelector('.legend'); legend.style.display=visible?'block':'none';
      const lg=document.getElementById('legendGradient');
      if(mode==='wind'){document.getElementById('legendTitle').textContent='10 m 风速';document.getElementById('legendUnit').textContent='m/s';document.getElementById('legendMin').textContent='0';document.getElementById('legendMid').textContent='15';document.getElementById('legendMax').textContent='30+';lg.classList.add('wind');}
      else{document.getElementById('legendTitle').textContent='2 m 气温';document.getElementById('legendUnit').textContent='°C';document.getElementById('legendMin').textContent='−25';document.getElementById('legendMid').textContent='10';document.getElementById('legendMax').textContent='45';lg.classList.remove('wind');}
    }

    function resizeWindCanvas() {
      const dpr=Math.min(devicePixelRatio||1,2), rect=map.getContainer().getBoundingClientRect();
      windCanvas.width=Math.round(rect.width*dpr); windCanvas.height=Math.round(rect.height*dpr);
      windCtx.setTransform(dpr,0,0,dpr,0,0); windCtx.clearRect(0,0,rect.width,rect.height);
    }
    function resetParticle(p, randomAge=true) {
      p.lon=72+Math.random()*64; p.lat=17+Math.random()*37; p.age=randomAge?Math.random()*120:0; p.maxAge=70+Math.random()*130;
    }
    function resetParticles() { state.particles=Array.from({length:state.particleCount},()=>{const p={};resetParticle(p,true);return p;}); windCtx.clearRect(0,0,windCanvas.clientWidth,windCanvas.clientHeight); }
    function shouldShowParticles(){return state.mode==='temperature'||state.mode==='wind';}
    function animate(now) {
      requestAnimationFrame(animate);
      if(!state.wind||!shouldShowParticles()||state.moving)return;
      const dt=Math.min((now-state.lastTime)/1000,.05);state.lastTime=now;
      const w=windCanvas.clientWidth,h=windCanvas.clientHeight;
      windCtx.globalCompositeOperation='destination-in';windCtx.fillStyle='rgba(0,0,0,.91)';windCtx.fillRect(0,0,w,h);
      windCtx.globalCompositeOperation='source-over';windCtx.beginPath();
      const simSeconds=14000*dt*state.speed;
      for(const p of state.particles){
        const wind=sampleWind(p.lon,p.lat);if(!wind||!Number.isFinite(wind.u)||p.age++>p.maxAge){resetParticle(p,false);continue;}
        const from=map.project([p.lon,p.lat]);const cos=Math.max(.25,Math.cos(p.lat*Math.PI/180));
        p.lon+=wind.u*simSeconds/(111320*cos);p.lat+=wind.v*simSeconds/110540;
        if(p.lon<72||p.lon>136||p.lat<17||p.lat>54){resetParticle(p,false);continue;}
        const to=map.project([p.lon,p.lat]);const dist=Math.hypot(to.x-from.x,to.y-from.y);
        if(dist<55&&to.x>-20&&to.x<w+20&&to.y>-20&&to.y<h+20){windCtx.moveTo(from.x,from.y);windCtx.lineTo(to.x,to.y);}
      }
      windCtx.strokeStyle='rgba(229,250,255,.68)';windCtx.lineWidth=1;windCtx.stroke();
    }

    function directionName(u,v){
      let deg=(Math.atan2(-u,-v)*180/Math.PI+360)%360;
      const names=['北','东北','东','东南','南','西南','西','西北'];
      return `${names[Math.round(deg/45)%8]}风 ${deg.toFixed(0)}°`;
    }
    map.on('mousemove',(e)=>{
      if(!state.temp||!state.wind)return;const lon=e.lngLat.lng,lat=e.lngLat.lat;
      document.getElementById('rLocation').textContent=`${lon.toFixed(2)}°, ${lat.toFixed(2)}°`;
      const t=sample(state.temp,lon,lat),wv=sampleWind(lon,lat);
      if(Number.isFinite(t)){document.getElementById('rTemp').textContent=`${(t-273.15).toFixed(1)} °C`;}
      else document.getElementById('rTemp').textContent='范围外';
      if(wv){document.getElementById('rWind').textContent=`${Math.hypot(wv.u,wv.v).toFixed(1)} m/s`;document.getElementById('rDirection').textContent=directionName(wv.u,wv.v);}
      else{document.getElementById('rWind').textContent='范围外';document.getElementById('rDirection').textContent='—';}
    });

    document.getElementById('layerMode').addEventListener('change',(e)=>{state.mode=e.target.value;renderField();if(!shouldShowParticles())windCtx.clearRect(0,0,windCanvas.clientWidth,windCanvas.clientHeight);});
    document.getElementById('opacityRange').addEventListener('input',(e)=>{state.opacity=Number(e.target.value)/100;document.getElementById('opacityOutput').textContent=`${e.target.value}%`;if(map.getLayer('weather-field'))map.setPaintProperty('weather-field','raster-opacity',state.opacity);});
    document.getElementById('densityRange').addEventListener('input',(e)=>{state.particleCount=Number(e.target.value);document.getElementById('densityOutput').textContent=e.target.value;resetParticles();});
    document.getElementById('speedRange').addEventListener('input',(e)=>{state.speed=Number(e.target.value);document.getElementById('speedOutput').textContent=`${state.speed.toFixed(1)}×`;});
    document.getElementById('resetView').addEventListener('click',fitChina);
    map.on('movestart',()=>{state.moving=true;windCtx.clearRect(0,0,windCanvas.clientWidth,windCanvas.clientHeight);});
    map.on('moveend',()=>{state.moving=false;resetParticles();state.lastTime=performance.now();});
    map.on('resize',()=>{resizeWindCanvas();resetParticles();});

    function waitForMapStyle() {
      if (map.isStyleLoaded()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          if (map.getStyle() && Array.isArray(map.getStyle().layers)) finish();
          else reject(new Error('MapLibre 底图样式加载超时'));
        }, 20000);
        map.once('style.load', finish);
        map.once('load', finish);
      });
    }

    Promise.all([loadWxt(DATA.temp), loadWxt(DATA.wind), waitForMapStyle()])
      .then(([temp,wind])=>{
        state.temp=temp;state.wind=wind;
        map.addSource('weather-canvas',{type:'canvas',canvas:'fieldCanvas',animate:true,coordinates:[[temp.west,temp.north],[temp.east,temp.north],[temp.east,temp.south],[temp.west,temp.south]]});
        map.addLayer({id:'weather-field',type:'raster',source:'weather-canvas',paint:{'raster-opacity':state.opacity,'raster-resampling':'linear','raster-fade-duration':0}});
        renderField();resizeWindCanvas();resetParticles();requestAnimationFrame(animate);
        statusDot.classList.add('ready');statusText.textContent='全中国 WXT 已加载';
        document.getElementById('loadingText').textContent='加载完成';document.getElementById('loadingCover').classList.add('hide');
      })
      .catch((error)=>{console.error(error);statusDot.classList.add('error');statusText.textContent='加载失败';document.getElementById('loadingText').textContent=`加载失败：${error.message}`;});
  })();
  