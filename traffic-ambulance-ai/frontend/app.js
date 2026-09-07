
/* ============================================================
   TrafficVision AI — front-end console
   Runs a bounded random-walk simulation of the perception
   pipeline output so every panel is genuinely interactive.
   connectBackend() swaps this for a real WebSocket feed using
   the same render*() functions — see backend/ for the FastAPI
   + YOLOv11 + ByteTrack service this is designed to sit on.
   ============================================================ */

const CLASS_LIST = ['car','bike','bus','truck','auto','bicycle','pedestrian'];
const SPEED_LIMIT = 60;

const state = {
  mode: 'simulation', // 'simulation' | 'live'
  counts: { car:24, bike:14, bus:2, truck:5, auto:8, bicycle:3, pedestrian:6 },
  total: 0,
  density: 'Low',
  avgSpeed: 32, maxSpeed: 48, minSpeed: 12,
  ambulance: null,
  corridorActive: false,
  corridorStep: -1,
  accident: null,
  history: { t: [], total: [], speed: [], density: [], classSnap: [] },
  events: [],
  decisions: [],
  corridorsToday: 0,
  ambulancesCleared: 0,
  signalHistory: [[],[],[],[]],
  ws: null,
};

function fmtTime(){ return new Date().toLocaleTimeString('en-IN',{hour12:false}); }

function pushEvent(text, tone='info'){
  state.events.unshift({ text, tone, time: fmtTime() });
  state.events = state.events.slice(0, 24);
  renderEvents();
}
function pushDecision(text){
  state.decisions.unshift({ text, time: fmtTime() });
  state.decisions = state.decisions.slice(0, 24);
  renderDecisions();
}

/* ---------------- Simulation tick ---------------- */
function tick(){
  if (state.mode !== 'simulation') return;

  // vehicle counts random walk
  let total = 0;
  CLASS_LIST.forEach(c=>{
    const delta = Math.round((Math.random()-0.48) * 3);
    state.counts[c] = Math.max(0, state.counts[c] + delta);
    total += state.counts[c];
  });
  state.total = total;

  // density
  let densityScore = Math.min(100, Math.round(total / 0.7));
  let density = 'Low';
  if (total > 70) density = 'Critical';
  else if (total > 50) density = 'High';
  else if (total > 30) density = 'Medium';
  const prevDensity = state.density;
  state.density = density;
  if (density !== prevDensity && Math.random() < 0.9) {
    pushDecision(`Density reclassified ${prevDensity} → ${density} (${total} vehicles in frame). ${density==='High'||density==='Critical' ? 'Congestion warning raised for downstream signal.' : 'No action required.'}`);
  }

  // speed
  state.avgSpeed = Math.max(8, Math.min(65, Math.round(state.avgSpeed + (Math.random()-0.5)*6)));
  state.maxSpeed = Math.max(state.avgSpeed+5, Math.round(state.avgSpeed + Math.random()*22));
  state.minSpeed = Math.max(4, Math.round(state.avgSpeed - Math.random()*18));

  // history
  state.history.t.push(fmtTime());
  state.history.total.push(total);
  state.history.speed.push(state.avgSpeed);
  state.history.density.push(densityScore);
  state.history.classSnap.push({car:state.counts.car, bike:state.counts.bike, bus:state.counts.bus, truck:state.counts.truck});
  const CAP = 20;
  if (state.history.t.length > CAP) { state.history.t.shift(); state.history.total.shift(); state.history.speed.shift(); state.history.density.shift(); state.history.classSnap.shift(); }

  // ambulance lifecycle
  if (!state.ambulance && Math.random() < 0.05) startAmbulance();
  else if (state.ambulance) progressAmbulance();

  // signal history snapshot (drives the route-page Gantt timeline)
  for (let i=0; i<4; i++){
    let color = 'red';
    if (state.corridorActive){
      if (i === state.corridorStep) color = 'green';
      else if (i < state.corridorStep) color = 'passed';
    }
    state.signalHistory[i].push(color);
    if (state.signalHistory[i].length > 40) state.signalHistory[i].shift();
  }

  // accident lifecycle
  if (!state.accident && Math.random() < 0.02) startAccident();
  else if (state.accident) progressAccident();

  renderAll();
}

/* ---------------- Ambulance / Green corridor ---------------- */
const HOSPITALS = ['Apollo Hospital, Jubilee Hills','Yashoda Hospital, Somajiguda','Continental Hospitals, Gachibowli'];
const HOSPITAL_COORDS = [
  { name:'Apollo Hospital, Jubilee Hills', lat:17.4132, lng:78.4415 },
  { name:'Yashoda Hospital, Somajiguda', lat:17.4189, lng:78.4577 },
  { name:'Continental Hospitals, Gachibowli', lat:17.4144, lng:78.3489 },
];
const LANES = ['Lane A — NH-65','Lane B — Ring Road','Lane C — Banjara Main','Lane D — Tank Bund'];

function startAmbulance(){
  state.ambulance = {
    id: 'AMB-' + Math.floor(1000+Math.random()*8999),
    confidence: (92 + Math.random()*7.5).toFixed(1),
    speed: 38 + Math.round(Math.random()*20),
    lane: LANES[Math.floor(Math.random()*LANES.length)],
    location: 'Approaching Signal 1',
    hospital: HOSPITALS[Math.floor(Math.random()*HOSPITALS.length)],
    etaSeconds: 95,
  };
  state.corridorActive = true;
  state.corridorStep = 0;
  pushEvent(`🚑 Ambulance ${state.ambulance.id} detected on ${state.ambulance.lane} — confidence ${state.ambulance.confidence}%`, 'critical');
  pushDecision(`Ambulance confirmed (conf. ${state.ambulance.confidence}%) → initiating green corridor across 4 signals. Priority overrides normal cycle.`);
}

function progressAmbulance(){
  const a = state.ambulance;
  a.etaSeconds = Math.max(0, a.etaSeconds - 3);
  a.speed = Math.max(20, Math.min(70, a.speed + Math.round((Math.random()-0.5)*6)));

  // advance corridor roughly every ~7 ticks per signal
  if (state.corridorActive) {
    const stepDuration = 7;
    const elapsed = 95 - a.etaSeconds;
    const targetStep = Math.min(3, Math.floor(elapsed / (95/4)));
    if (targetStep > state.corridorStep) {
      state.corridorStep = targetStep;
      pushDecision(`Signal ${targetStep+1} switched to GREEN — corridor sweep for ${a.id}.`);
    }
    a.location = `Clearing Signal ${Math.min(4, state.corridorStep+1)}`;
  }

  if (a.etaSeconds <= 0) {
    pushEvent(`✅ ${a.id} cleared all 4 signals — arrived ${a.hospital}`, 'success');
    state.ambulancesCleared += 1;
    state.corridorsToday += 1;
    state.corridorActive = false;
    state.corridorStep = -1;
    state.ambulance = null;
  }
}

function forceTriggerAmbulance(){
  if (state.ambulance) return;
  startAmbulance();
  renderAll();
}

/* ---------------- Accident lifecycle ---------------- */
const ACCIDENT_TYPES = ['Sudden stop detected','Possible collision','Vehicle overturned','Road blockage','Wrong-side driving','Long stationary vehicle'];
function startAccident(){
  state.accident = {
    type: ACCIDENT_TYPES[Math.floor(Math.random()*ACCIDENT_TYPES.length)],
    location: LANES[Math.floor(Math.random()*LANES.length)],
    severity: Math.random() < 0.4 ? 'CRITICAL' : 'HIGH',
    ttl: 14,
    time: fmtTime(),
  };
  pushEvent(`⚠️ ${state.accident.type} — ${state.accident.location}`, 'critical');
  pushDecision(`Incident classified "${state.accident.type}" (${state.accident.severity}) → alternate route suggested, downstream signals notified.`);
  updateRoutePanel(true);
}
function progressAccident(){
  state.accident.ttl -= 1;
  if (state.accident.ttl <= 0) {
    pushEvent(`Incident cleared — lanes reopened at ${state.accident.location}`, 'success');
    state.accident = null;
    updateRoutePanel(false);
  }
}

/* ---------------- Render ---------------- */
function renderAll(){
  renderHero();
  renderOverview();
  renderTopbarAlert();
  renderEmergency();
  renderAccidents();
  renderRouteTimeline();
  renderDetectionOverview();
  updateCharts();
  if (document.getElementById('chart-mon-left')) renderMonitoringCharts(currentMonTab);
  if (window._mapInit) updateMapTraffic();
}

function renderHero(){
  const inlineStat = document.getElementById('stat-vehicles-inline');
  if (inlineStat) inlineStat.textContent = state.total.toLocaleString();

  const pill = document.getElementById('hero-corridor-pill');
  const text = document.getElementById('hero-corridor-text');
  const icon = document.getElementById('hero-ambulance-icon');
  for (let i=1;i<=4;i++){
    const housing = document.getElementById('hero-sig-'+i);
    const lamps = housing.querySelectorAll('.signal-lamp');
    lamps.forEach(l=>l.className='signal-lamp');
    const isGreen = state.corridorActive && (i-1) === state.corridorStep;
    if (isGreen) lamps[2].classList.add('on-green');
    else if (state.corridorActive && (i-1) < state.corridorStep) lamps[1].classList.add('on-amber');
    else lamps[0].classList.add('on-red');
  }
  if (state.corridorActive){
    pill.textContent = 'GREEN CORRIDOR ACTIVE';
    pill.className = 'text-[11px] font-mono px-2 py-1 rounded-full bg-go/20 text-go-glow';
    text.textContent = `Clearing path for ${state.ambulance.id} — ETA ${state.ambulance.etaSeconds}s`;
    icon.classList.remove('text-white/20'); icon.classList.add('text-go-glow');
  } else {
    pill.textContent = 'MONITORING';
    pill.className = 'text-[11px] font-mono px-2 py-1 rounded-full bg-white/10 text-white/60';
    text.textContent = 'Awaiting emergency vehicle detection…';
    icon.classList.add('text-white/20'); icon.classList.remove('text-go-glow');
  }
}

function renderOverview(){
  // Signal Status card
  const totalSignals = 4;
  const priorityActive = state.corridorActive ? 1 : 0;
  document.getElementById('ov-signal-count').textContent = totalSignals;
  const greenPct = priorityActive ? 75 : 100;
  document.getElementById('ov-signal-bar-green').style.width = greenPct + '%';
  document.getElementById('ov-signal-bar-amber').style.width = (100-greenPct) + '%';
  document.getElementById('ov-signal-green-n').textContent = totalSignals - priorityActive;
  document.getElementById('ov-signal-amber-n').textContent = priorityActive;

  // Detection Status card
  document.getElementById('ov-detect-count').textContent = state.total;
  const flaggedCount = (state.accident?1:0) + (state.ambulance?1:0);
  const trackedCount = Math.max(0, state.total - flaggedCount);
  const flaggedPct = state.total ? Math.min(100, Math.round(flaggedCount/state.total*100)) : 0;
  document.getElementById('ov-detect-bar-green').style.width = (100-flaggedPct)+'%';
  document.getElementById('ov-detect-bar-red').style.width = flaggedPct+'%';
  document.getElementById('ov-detect-tracked-n').textContent = trackedCount;
  document.getElementById('ov-detect-flagged-n').textContent = flaggedCount;

  // Newest Alert card
  const alertsBox = document.getElementById('ov-newest-alerts');
  const latest = state.events.slice(0,3);
  alertsBox.innerHTML = latest.length ? latest.map(e=>`
    <div class="flex items-start justify-between gap-2 text-xs border-b border-[#F5F6F8] pb-2 last:border-0 last:pb-0">
      <span class="text-ink leading-snug flex-1">${e.text}</span>
      <span class="text-mute font-mono shrink-0">${e.time}</span>
    </div>`).join('') : '<p class="text-xs text-mute font-mono">No alerts yet.</p>';

  const dr = document.getElementById('ov-mon-daterange');
  if (dr) dr.textContent = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
}

function renderTopbarAlert(){
  const alertPill = document.getElementById('alert-pill');
  const alertText = document.getElementById('alert-pill-text');
  if (state.accident) {
    alertPill.classList.remove('hidden'); alertPill.classList.add('flex');
    alertText.textContent = 'Active Incident';
  } else if (state.ambulance) {
    alertPill.classList.remove('hidden'); alertPill.classList.add('flex');
    alertText.textContent = 'Ambulance Priority';
  } else {
    alertPill.classList.add('hidden'); alertPill.classList.remove('flex');
  }
}

function renderEmergency(){
  const pill = document.getElementById('amb-status-pill');
  const empty = document.getElementById('amb-empty');
  const detail = document.getElementById('amb-detail');
  if (state.ambulance){
    pill.textContent = 'ACTIVE UNIT'; pill.className='text-[11px] font-mono px-2 py-1 rounded-full bg-stop/10 text-stop';
    empty.classList.add('hidden'); detail.classList.remove('hidden');
    document.getElementById('amb-id').textContent = state.ambulance.id;
    document.getElementById('amb-conf').textContent = state.ambulance.confidence + '%';
    document.getElementById('amb-lane').textContent = state.ambulance.lane;
    document.getElementById('amb-speed').textContent = state.ambulance.speed + ' km/h';
    document.getElementById('amb-location').textContent = state.ambulance.location;
    document.getElementById('amb-hospital').textContent = state.ambulance.hospital;
    document.getElementById('amb-eta').textContent = state.ambulance.etaSeconds + 's';
  } else {
    pill.textContent = 'NO ACTIVE UNIT'; pill.className='text-[11px] font-mono px-2 py-1 rounded-full bg-[#F2F3F6] text-mute';
    empty.classList.remove('hidden'); detail.classList.add('hidden');
  }

  const cpill = document.getElementById('corridor-pill');
  cpill.textContent = state.corridorActive ? 'SWEEPING' : 'STANDBY';
  cpill.className = state.corridorActive ? 'text-[11px] font-mono px-2 py-1 rounded-full bg-go/10 text-go' : 'text-[11px] font-mono px-2 py-1 rounded-full bg-[#F2F3F6] text-mute';

  document.querySelectorAll('.corridor-row').forEach((row,i)=>{
    const fill = row.querySelector('.corridor-fill');
    const stateLabel = row.querySelector('.corridor-state');
    if (state.corridorActive && i === state.corridorStep){
      fill.style.width='100%'; fill.className='corridor-fill h-full bg-go rounded-full transition-all duration-700';
      stateLabel.textContent='GREEN'; stateLabel.className='corridor-state text-[11px] font-mono w-10 text-right text-go font-semibold';
    } else if (state.corridorActive && i < state.corridorStep){
      fill.style.width='100%'; fill.className='corridor-fill h-full bg-mute/40 rounded-full transition-all duration-700';
      stateLabel.textContent='PASSED'; stateLabel.className='corridor-state text-[11px] font-mono w-10 text-right text-mute';
    } else {
      fill.style.width='0%';
      stateLabel.textContent='RED'; stateLabel.className='corridor-state text-[11px] font-mono w-10 text-right text-mute';
    }
  });

  renderEmergencyHero();
}

const DISPATCH_TYPES = [
  { key:'corridor', label:'Green Corridor Runs', color:'#3730A3' },
  { key:'accident', label:'Accident Response', color:'#DC2626' },
  { key:'routine', label:'Routine Escort', color:'#16A34A' },
  { key:'transfer', label:'Inter-hospital Transfer', color:'#D97706' },
];
function renderEmergencyHero(){
  const greetEl = document.getElementById('em-greeting');
  if (greetEl){
    const h = new Date().getHours();
    greetEl.textContent = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
  }
  const dateEl = document.getElementById('em-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});

  const dispatchesToday = state.ambulancesCleared * 3 + (state.ambulance?1:0) + 12; // baseline + session activity
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('em-stat-dispatches', dispatchesToday);
  setText('em-stat-active', state.ambulance ? 1 : 0);
  setText('em-stat-corridor', (state.corridorActive ? 1 : 0) + ' / 4');
  setText('em-stat-response', state.ambulancesCleared ? '41%' : '—');
  setText('em-perf-count', state.corridorsToday + ' Runs');

  // Dispatch breakdown — corridor/accident counts are real session tallies;
  // routine/transfer are baseline figures to keep the list populated like a live ops board.
  const accidentCount = state.events.filter(e => e.tone==='critical' && e.text.includes('⚠️')).length;
  const values = { corridor: state.corridorsToday, accident: accidentCount, routine: 8, transfer: 3 };
  const dispatchBox = document.getElementById('em-dispatch-list');
  if (dispatchBox){
    const maxVal = Math.max(1, ...Object.values(values));
    dispatchBox.innerHTML = DISPATCH_TYPES.map(d => `
      <div class="flex items-center justify-between gap-3 text-xs">
        <span class="text-mute">${d.label}</span>
        <span class="flex-1 mx-2 border-b border-dotted border-[#D8DBE3] translate-y-[-3px]"></span>
        <span class="font-mono font-semibold text-ink w-6 text-right">${values[d.key]}</span>
      </div>`).join('');
  }

  // Live Units — current active unit (if any) plus recent cleared units from the event log
  const liveBox = document.getElementById('em-live-units');
  if (liveBox){
    const rows = [];
    if (state.ambulance) rows.push({ id: state.ambulance.id, status: 'En route · ' + state.ambulance.lane, live: true });
    state.events.filter(e => e.tone==='success' && e.text.includes('cleared')).slice(0,3).forEach(e=>{
      const m = e.text.match(/AMB-\d+/);
      rows.push({ id: m ? m[0] : 'AMB-????', status: 'Completed · ' + e.time, live: false });
    });
    liveBox.innerHTML = rows.length ? rows.map(r => `
      <div class="flex items-center justify-between gap-2 text-xs border-b border-[#F5F6F8] pb-2 last:border-0 last:pb-0">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${r.live ? 'bg-stop pulse-stop' : 'bg-[#D8DBE3]'}"></span>
          <span class="font-mono font-semibold text-ink">${r.id}</span>
        </div>
        <span class="text-mute">${r.status}</span>
      </div>`).join('') : '<p class="text-xs text-mute font-mono">No dispatches yet this session.</p>';
  }

  updateAmbulanceMarkers();
}

function renderAccidents(){
  const banner = document.getElementById('accident-banner');
  const clear = document.getElementById('accident-clear');
  if (state.accident){
    banner.classList.remove('hidden'); banner.classList.add('flex');
    clear.classList.add('hidden');
    document.getElementById('accident-title').textContent = state.accident.type;
    document.getElementById('accident-meta').textContent = `${state.accident.location} · detected ${state.accident.time}`;
    const sev = document.getElementById('accident-severity');
    sev.textContent = state.accident.severity;
  } else {
    banner.classList.add('hidden'); banner.classList.remove('flex');
    clear.classList.remove('hidden');
  }
  const log = document.getElementById('accident-log');
  const incidents = state.events.filter(e=>e.tone==='critical' && (e.text.includes('detected')||e.text.includes('⚠️')));
  log.innerHTML = incidents.length ? incidents.slice(0,8).map(e=>`<div class="flex justify-between border-b border-[#F2F3F6] pb-2"><span>${e.text}</span><span class="text-mute">${e.time}</span></div>`).join('') : 'No incidents logged this session.';
}

function renderEvents(){
  const el = document.getElementById('events-log');
  if (!el) return;
  el.innerHTML = state.events.slice(0,10).map(e=>`
    <div class="flex items-start gap-2.5 text-xs fade-in">
      <span class="mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${e.tone==='critical'?'bg-stop':e.tone==='success'?'bg-go':'bg-brand'}"></span>
      <div class="flex-1"><p class="text-ink leading-snug">${e.text}</p><p class="text-mute font-mono mt-0.5">${e.time}</p></div>
    </div>`).join('') || '<p class="text-xs text-mute font-mono">No events yet.</p>';
}
function renderDecisions(){
  const el = document.getElementById('decision-log');
  if (!el) return;
  el.innerHTML = state.decisions.slice(0,10).map(d=>`
    <div class="flex items-start gap-2.5 text-xs fade-in border-l-2 border-brand/30 pl-3">
      <div class="flex-1"><p class="text-ink leading-snug">${d.text}</p><p class="text-mute font-mono mt-0.5">${d.time}</p></div>
    </div>`).join('') || '<p class="text-xs text-mute font-mono">No decisions logged yet.</p>';
}

function updateRoutePanel(blocked){
  document.getElementById('route-current').textContent = blocked ? 'Rerouting' : 'Clear';
  document.getElementById('route-current').className = 'font-mono font-semibold ' + (blocked ? 'text-caution' : 'text-go');
  document.getElementById('route-blocked').textContent = blocked ? (state.accident ? state.accident.location : 'Signal 2 — Ring Road') : 'None';
  document.getElementById('route-alt').textContent = blocked ? 'Banjara Main → Tank Bund' : 'Standby';
  document.getElementById('route-distance').textContent = blocked ? '5.6 km' : '4.2 km';
  document.getElementById('route-time').textContent = blocked ? '11 min' : '7 min';
  const altStep = document.getElementById('route-step-alt');
  if (altStep) altStep.className = blocked ? 'flex items-center gap-2 text-caution' : 'flex items-center gap-2 text-mute';
  if (altStep) altStep.querySelector('span').textContent = blocked ? '✓' : '○';
  if (window._mapLayers) drawMapRoutes(blocked);
}

function renderRouteTimeline(){
  const container = document.getElementById('route-timeline');
  if (!container) return;
  const colorMap = { red:'#EF4444', green:'#22C55E', passed:'#D8DBE3' };
  container.innerHTML = state.signalHistory.map((hist, i) => `
    <div class="flex items-center gap-2">
      <span class="w-16 text-[11px] font-mono text-mute shrink-0">Signal ${i+1}</span>
      <div class="flex-1 flex gap-[2px] h-4">
        ${hist.map(c => `<span class="flex-1 rounded-sm" style="background:${colorMap[c]}"></span>`).join('')}
      </div>
    </div>`).join('');

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('rt-stat-speed', state.avgSpeed);
  set('rt-stat-vehicles', state.total);
  set('rt-stat-corridors', state.corridorsToday);
  set('rt-stat-cleared', state.corridorsToday * 4);
}

function regenerateRoute(){
  pushEvent('Route regenerated — recalculating current and alternate paths.', 'info');
  updateRoutePanel(!!state.accident);
  if (window._leafletMap) window._leafletMap.setView([17.385 + (Math.random()-0.5)*0.01, 78.487 + (Math.random()-0.5)*0.01], 13);
}

function downloadGeoJSON(){
  const geojson = {
    type: 'FeatureCollection',
    features: [
      ...LANE_ROUTES.map(r => ({
        type: 'Feature',
        properties: { name: r.lane, color: r.color },
        geometry: { type: 'LineString', coordinates: r.path.map(([lat,lng]) => [lng,lat]) },
      })),
      ...HOSPITAL_COORDS.map(h => ({
        type: 'Feature',
        properties: { name: h.name, kind: 'hospital' },
        geometry: { type: 'Point', coordinates: [h.lng, h.lat] },
      })),
    ],
  };
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type:'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'trafficvision_routes.geojson'; a.click();
  pushEvent('Routes exported as GeoJSON.', 'info');
}

/* ---------------- Charts ---------------- */
let charts = {};
function makeLineChart(ctx, label, color){
  return new Chart(ctx, {
    type:'line',
    data:{ labels:[], datasets:[{ label, data:[], borderColor:color, backgroundColor:color+'22', tension:.35, fill:true, pointRadius:0, borderWidth:2 }]},
    options:{ responsive:true, plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{grid:{color:'#F0F1F4'}}}, animation:{duration:300} }
  });
}
function safeChart(factory, label){
  try { return factory(); }
  catch (e) { console.warn(`Chart init failed (${label}):`, e); return null; }
}
function makeRingChart(canvasId){
  const el = document.getElementById(canvasId);
  if (!el) return null;
  return safeChart(() => new Chart(el, {
    type: 'doughnut',
    data: { datasets: [{ data: [0, 100], backgroundColor: ['#4F46E5', '#F0F1F4'], borderWidth: 0 }] },
    options: { cutout: '76%', plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 400 } },
  }), canvasId);
}
function setRingValue(canvasId, pctElId, pct, color){
  const chart = charts[canvasId];
  if (!chart) return;
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  chart.data.datasets[0].data = [clamped, 100 - clamped];
  if (color) chart.data.datasets[0].backgroundColor = [color, '#F0F1F4'];
  chart.update('none');
  const label = document.getElementById(pctElId);
  if (label) label.textContent = clamped + '%';
}
const VI_BREAKDOWN_COLORS = { car:'#4F46E5', truck:'#F59E0B', bus:'#16A34A', bike:'#DB2777', bicycle:'#0891B2', pedestrian:'#6B7280', ambulance:'#DC2626' };
const vi_recentAlerts = [];
function renderDetectionOverview(){
  const counts = state.counts || {};
  const total = Object.values(counts).reduce((a,b)=>a+b, 0);
  const vehicles = (counts.car||0)+(counts.truck||0)+(counts.bus||0)+(counts.bike||0)+(counts.bicycle||0)+(counts.ambulance||0);
  const people = counts.pedestrian || 0;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('vi-stat-total', total);
  set('vi-stat-vehicles', vehicles);
  set('vi-stat-people', people);
  set('vi-stat-alerts', vi_recentAlerts.length);
  set('vi-donut-total', total);

  const timelineChart = charts['chart-vi-timeline'];
  if (timelineChart && state.history){
    timelineChart.data.labels = state.history.t.slice(-20);
    timelineChart.data.datasets[0].data = state.history.total.slice(-20);
    timelineChart.update('none');
  }

  const chart = charts['chart-vi-breakdown'];
  if (chart){
    const labels = Object.keys(counts).filter(k => counts[k] > 0);
    chart.data.labels = labels;
    chart.data.datasets[0].data = labels.map(k => counts[k]);
    chart.data.datasets[0].backgroundColor = labels.map(k => VI_BREAKDOWN_COLORS[k] || '#9CA3AF');
    chart.update('none');
  }
  const legend = document.getElementById('vi-breakdown-legend');
  if (legend){
    const entries = Object.entries(counts).filter(([,v]) => v > 0).sort((a,b)=>b[1]-a[1]);
    legend.innerHTML = entries.length ? entries.map(([k,v]) => `
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${VI_BREAKDOWN_COLORS[k]||'#9CA3AF'}"></span>
        <span class="capitalize flex-1">${k}</span>
        <span class="font-mono font-semibold">${v}</span>
      </div>`).join('') : `<p class="text-mute font-mono">No detections yet.</p>`;
  }
}
function pushViAlert(description, severity){
  vi_recentAlerts.unshift({ description, severity, time: fmtTime() });
  vi_recentAlerts.length = Math.min(vi_recentAlerts.length, 20);
  const list = document.getElementById('vi-alerts-list');
  if (!list) return;
  const toneClass = { critical:'text-stop', warning:'text-caution', high:'text-caution', info:'text-mute' };
  list.innerHTML = vi_recentAlerts.map(a => `
    <div class="flex items-start gap-2">
      <span class="font-mono text-[10px] text-mute shrink-0 mt-0.5">${a.time}</span>
      <span class="${toneClass[a.severity]||'text-mute'}">${a.description}</span>
    </div>`).join('');
  document.getElementById('vi-stat-alerts') && (document.getElementById('vi-stat-alerts').textContent = vi_recentAlerts.length);
}

function initCharts(){
  charts['chart-vi-breakdown'] = safeChart(() => new Chart(document.getElementById('chart-vi-breakdown'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 0 }] },
    options: { cutout: '72%', plugins: { legend: { display: false } }, animation: { duration: 300 } },
  }), 'chart-vi-breakdown');

  charts['chart-vi-timeline'] = safeChart(() => new Chart(document.getElementById('chart-vi-timeline'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label:'Detections', data: [], borderColor:'#4F46E5', backgroundColor:'#4F46E522', tension:.35, fill:true, pointRadius:0, borderWidth:2 },
    ]},
    options: { responsive:true, plugins:{legend:{display:false}}, scales:{x:{grid:{display:false}}, y:{grid:{color:'#F0F1F4'}, beginAtZero:true}}, animation:{duration:300} }
  }), 'chart-vi-timeline');

  charts['ring-traffic-load'] = makeRingChart('ring-traffic-load');
  charts['ring-speed-compliance'] = makeRingChart('ring-speed-compliance');
  charts['ring-corridor-activity'] = makeRingChart('ring-corridor-activity');
  charts['ring-system-health'] = makeRingChart('ring-system-health');

  charts.gauge = safeChart(() => new Chart(document.getElementById('chart-gauge'), {
    type: 'doughnut',
    data: { datasets: [{ data: [0, 100], backgroundColor: ['#16A34A', '#F0F1F4'], borderWidth: 0 }] },
    options: {
      rotation: -90, circumference: 180, cutout: '75%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 400 },
    },
  }), 'gauge');

  charts.dailyActivity = safeChart(() => new Chart(document.getElementById('chart-daily-activity'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: '#4F46E5', borderRadius: 6, barThickness: 14 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { grid: { color: '#F0F1F4' }, beginAtZero: true } } },
  }), 'dailyActivity');

  charts.aVehicles = safeChart(() => makeLineChart(document.getElementById('chart-a-vehicles'), 'Vehicles', '#4F46E5'), 'aVehicles');
  charts.aCongestion = safeChart(() => makeLineChart(document.getElementById('chart-a-congestion'), 'Density score', '#F59E0B'), 'aCongestion');
  charts.aSpeed = safeChart(() => new Chart(document.getElementById('chart-a-speed'), {
    type:'bar',
    data:{ labels:['0-20','20-40','40-60','60-80','80+'], datasets:[{ data:[2,6,9,4,1], backgroundColor:'#0EA5E9', borderRadius:6 }]},
    options:{ plugins:{legend:{display:false}}, scales:{y:{grid:{color:'#F0F1F4'}}} }
  }), 'aSpeed');
  charts.aEvents = safeChart(() => new Chart(document.getElementById('chart-a-events'), {
    type:'bar',
    data:{ labels:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets:[{ label:'Ambulance', data:[3,2,4,1,3,5,2], backgroundColor:'#DC2626', borderRadius:6},{label:'Accidents', data:[1,0,2,1,0,1,1], backgroundColor:'#F59E0B', borderRadius:6}]},
    options:{ plugins:{legend:{position:'bottom', labels:{boxWidth:8,font:{size:10}}}}, scales:{y:{grid:{color:'#F0F1F4'}}} }
  }), 'aEvents');
  charts.emAnalytic = safeChart(() => new Chart(document.getElementById('chart-em-analytic'), {
    type:'bar',
    data:{ labels:['Corridor','Accident','Routine'], datasets:[{ data:[0,0,8], backgroundColor:['#3730A3','#DC2626','#16A34A'], borderRadius:6 }]},
    options:{ plugins:{legend:{display:false}}, scales:{y:{grid:{color:'#F0F1F4'}}} }
  }), 'emAnalytic');
}
function updateOverviewRings(){
  const trafficLoadPct = Math.min(100, (state.total / 80) * 100);
  setRingValue('ring-traffic-load', 'ring-traffic-load-pct', trafficLoadPct, trafficLoadPct > 80 ? '#DC2626' : trafficLoadPct > 50 ? '#F59E0B' : '#16A34A');

  const speedCompliancePct = state.avgSpeed <= SPEED_LIMIT ? 100 : Math.max(0, 100 - (state.avgSpeed - SPEED_LIMIT) * 3);
  setRingValue('ring-speed-compliance', 'ring-speed-compliance-pct', speedCompliancePct, '#4F46E5');

  const corridorPct = state.corridorActive ? ((state.corridorStep + 1) / 4) * 100 : 0;
  setRingValue('ring-corridor-activity', 'ring-corridor-activity-pct', corridorPct, '#16A34A');

  let healthPct = 100;
  if (state.accident) healthPct -= 30;
  if (state.density === 'Critical') healthPct -= 20;
  else if (state.density === 'High') healthPct -= 10;
  setRingValue('ring-system-health', 'ring-system-health-pct', Math.max(0, healthPct), healthPct < 60 ? '#DC2626' : healthPct < 85 ? '#F59E0B' : '#16A34A');

  if (charts.gauge){
    const densityScore = { Low: 25, Medium: 50, High: 75, Critical: 95 }[state.density] ?? 25;
    const color = state.density === 'Critical' ? '#DC2626' : state.density === 'High' ? '#F97316' : state.density === 'Medium' ? '#F59E0B' : '#16A34A';
    charts.gauge.data.datasets[0].data = [densityScore, 100 - densityScore];
    charts.gauge.data.datasets[0].backgroundColor = [color, '#F0F1F4'];
    charts.gauge.update('none');
  }
  const gaugeLabel = document.getElementById('gauge-label');
  if (gaugeLabel) gaugeLabel.textContent = state.density;

  const ambEl = document.getElementById('activity-ambulances');
  const corrEl = document.getElementById('activity-corridors');
  if (ambEl) ambEl.textContent = state.ambulancesCleared;
  if (corrEl) corrEl.textContent = state.corridorsToday;

  if (charts.dailyActivity){
    charts.dailyActivity.data.labels = state.history.t.slice(-8);
    charts.dailyActivity.data.datasets[0].data = state.history.total.slice(-8);
    charts.dailyActivity.update('none');
  }
}
function updateCharts(){
  updateOverviewRings();
  if (charts.aVehicles){ charts.aVehicles.data.labels = state.history.t; charts.aVehicles.data.datasets[0].data = state.history.total; charts.aVehicles.update('none'); }
  if (charts.aCongestion){ charts.aCongestion.data.labels = state.history.t; charts.aCongestion.data.datasets[0].data = state.history.density; charts.aCongestion.update('none'); }
  if (charts.emAnalytic){
    const accidentCount = state.events.filter(e => e.tone==='critical' && e.text.includes('⚠️')).length;
    charts.emAnalytic.data.datasets[0].data = [state.corridorsToday, accidentCount, 8];
    charts.emAnalytic.update('none');
  }

  const tbody = document.getElementById('report-table-body');
  if (tbody){
    const rows = state.history.t.slice(-12).map((t,i)=>{
      const idx = state.history.t.length-12+i;
      return `<tr class="border-b border-[#F6F7F9]"><td class="py-1.5">${t}</td><td>${state.history.total[idx]||'—'}</td><td>${state.density}</td><td>${state.history.speed[idx]||'—'} km/h</td><td>${state.ambulance? state.ambulance.id : '—'}</td></tr>`;
    }).reverse();
    tbody.innerHTML = rows.join('');
  }
}

/* ---------------- Overview: Monitoring tab charts ---------------- */
let currentMonTab = 'density';
function renderMonitoringCharts(tab){
  currentMonTab = tab;
  const leftCanvas = document.getElementById('chart-mon-left');
  const rightCanvas = document.getElementById('chart-mon-right');
  if (!leftCanvas || !rightCanvas) return;

  document.querySelectorAll('.mon-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (charts.monLeft) { charts.monLeft.destroy(); charts.monLeft = null; }
  if (charts.monRight) { charts.monRight.destroy(); charts.monRight = null; }

  const leftTitle = document.getElementById('ov-mon-left-title');
  const rightTitle = document.getElementById('ov-mon-right-title');
  const leftCallout = document.getElementById('ov-mon-left-callout');
  const rightCallout = document.getElementById('ov-mon-right-callout');
  const stackedOpts = { responsive:true, animation:false, plugins:{legend:{position:'bottom', labels:{boxWidth:8, font:{size:10}}}}, scales:{x:{stacked:true, grid:{display:false}}, y:{stacked:true, grid:{color:'#F0F1F4'}}} };
  const plainOpts = { responsive:true, animation:false, plugins:{legend:{display:false}}, scales:{y:{grid:{color:'#F0F1F4'}}} };

  if (tab === 'density'){
    leftTitle.textContent = 'Vehicle Density Over Time';
    rightTitle.textContent = 'Class Breakdown (live)';
    const snap = state.history.classSnap.slice(-8);
    const labels = state.history.t.slice(-8);
    leftCallout.textContent = `${state.density} density · ${state.total} vehicles in frame`;
    charts.monLeft = safeChart(() => new Chart(leftCanvas, {
      type:'bar',
      data:{ labels, datasets:[
        { label:'Car', data:snap.map(s=>s.car), backgroundColor:'#4F46E5' },
        { label:'Bike', data:snap.map(s=>s.bike), backgroundColor:'#22C55E' },
        { label:'Bus', data:snap.map(s=>s.bus), backgroundColor:'#F59E0B' },
        { label:'Truck', data:snap.map(s=>s.truck), backgroundColor:'#EF4444' },
      ]},
      options: stackedOpts
    }), 'monLeft-density');
    rightCallout.textContent = '';
    charts.monRight = safeChart(() => new Chart(rightCanvas, {
      type:'bar',
      data:{ labels: CLASS_LIST, datasets:[{ data: CLASS_LIST.map(c=>state.counts[c]), backgroundColor:'#4F46E5', borderRadius:6 }]},
      options: plainOpts
    }), 'monRight-density');

  } else if (tab === 'speed'){
    leftTitle.textContent = 'Average Speed Over Time';
    rightTitle.textContent = 'Speed by Lane (est.)';
    const labels = state.history.t.slice(-8);
    const speeds = state.history.speed.slice(-8);
    leftCallout.textContent = `${state.avgSpeed} km/h avg · ${state.maxSpeed} km/h peak`;
    charts.monLeft = safeChart(() => new Chart(leftCanvas, {
      type:'bar',
      data:{ labels, datasets:[{ data:speeds, backgroundColor:'#0EA5E9', borderRadius:6 }]},
      options: plainOpts
    }), 'monLeft-speed');
    const laneSpeeds = LANES.map((l,i)=> Math.max(5, Math.round(state.avgSpeed + (i-1.5)*4)));
    rightCallout.textContent = '';
    charts.monRight = safeChart(() => new Chart(rightCanvas, {
      type:'bar',
      data:{ labels: LANES.map(l=>l.split(' — ')[0]), datasets:[{ data: laneSpeeds, backgroundColor:'#A855F7', borderRadius:6 }]},
      options: plainOpts
    }), 'monRight-speed');

  } else { // emergency
    leftTitle.textContent = 'Session Decision Tally';
    rightTitle.textContent = 'Emergency Counters';
    const tally = { Corridor:0, Congestion:0, Reroute:0 };
    state.decisions.forEach(d=>{
      const t = d.text.toLowerCase();
      if (t.includes('corridor')) tally.Corridor++;
      else if (t.includes('density')) tally.Congestion++;
      else if (t.includes('reroute')) tally.Reroute++;
    });
    leftCallout.textContent = `${state.decisions.length} decisions logged this session`;
    charts.monLeft = safeChart(() => new Chart(leftCanvas, {
      type:'bar',
      data:{ labels: Object.keys(tally), datasets:[{ data: Object.values(tally), backgroundColor:['#3730A3','#F59E0B','#0EA5E9'], borderRadius:6 }]},
      options: plainOpts
    }), 'monLeft-emergency');
    const accidentCount = state.events.filter(e => e.tone==='critical' && e.text.includes('⚠️')).length;
    rightCallout.textContent = '';
    charts.monRight = safeChart(() => new Chart(rightCanvas, {
      type:'bar',
      data:{ labels:['Cleared','Corridors','Accidents'], datasets:[{ data:[state.ambulancesCleared, state.corridorsToday, accidentCount], backgroundColor:['#16A34A','#3730A3','#DC2626'], borderRadius:6 }]},
      options: plainOpts
    }), 'monRight-emergency');
  }
}
document.getElementById('ov-mon-tabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.mon-tab');
  if (btn) renderMonitoringCharts(btn.dataset.tab);
});

/* ---------------- Nav / app shell ---------------- */
function enterApp(){
  document.getElementById('landing').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  if (!window._mapInit) initMap();
}
function exitApp(){
  document.getElementById('app').classList.add('hidden');
  document.getElementById('landing').classList.remove('hidden');
  window.scrollTo({top:0});
}
function openSidebar(){
  document.getElementById('app-sidebar').classList.remove('-translate-x-full');
  document.getElementById('app-sidebar').classList.add('translate-x-0');
  document.getElementById('sidebar-backdrop').classList.remove('hidden');
}
function closeSidebar(){
  document.getElementById('app-sidebar').classList.add('-translate-x-full');
  document.getElementById('app-sidebar').classList.remove('translate-x-0');
  document.getElementById('sidebar-backdrop').classList.add('hidden');
}
function toggleSidebar(){
  const open = document.getElementById('app-sidebar').classList.contains('translate-x-0');
  if (open) closeSidebar(); else openSidebar();
}
document.getElementById('sidebar-nav').addEventListener('click', (e)=>{
  const item = e.target.closest('.nav-item');
  if (!item) return;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  item.classList.add('active');
  const page = item.dataset.page;
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active', p.dataset.page===page));
  const titles = { overview:['Overview','Command center · live simulation'], upload:['Video Intelligence','Upload & detection pipeline'], cctv:['Live CCTV Grid','Multi-camera monitoring wall'], emergency:['Ambulance & Corridor','Priority routing engine'], accidents:['Accident Alerts','Incident detection feed'], analytics:['Analytics & Reports','Charts, trends & exports'], routes:['Routes & Map','Leaflet + OpenStreetMap'], assistant:['AI Assistant','Ask the traffic console'], admin:['Admin Panel','Users, cameras & signal config'] };
  document.getElementById('page-title').textContent = titles[page][0];
  document.getElementById('page-sub').textContent = titles[page][1];
  if (page==='routes' && window._mapInit) setTimeout(()=>window._leafletMap.invalidateSize(), 50);
  if (page==='cctv' && !window._cctvInit) { window._cctvInit = true; renderCctvGrid(4); }
  if (page==='emergency'){
    if (!window._emMapInit) { initEmergencyMap(); updateAmbulanceMarkers(); }
    else setTimeout(()=>window._emMap.invalidateSize(), 50);
  }
  closeSidebar(); // no-op on desktop (md:translate-x-0 always wins there); closes the mobile drawer
});

/* ---------------- Backend connection ---------------- */
function connectBackend(){
  const url = document.getElementById('ws-url').value.trim();
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!url){ pushEvent('Enter a backend WebSocket URL to connect live.', 'info'); return; }
  try {
    const ws = new WebSocket(url);
    label.textContent = 'Connecting…'; dot.className='w-1.5 h-1.5 rounded-full bg-caution-glow';
    ws.onopen = ()=>{ state.mode='live'; state.ws=ws; label.textContent='Live'; dot.className='w-1.5 h-1.5 rounded-full bg-go-glow pulse-go'; pushEvent('Connected to live backend — switching off simulation.', 'success'); };
    ws.onmessage = (msg)=>{
      try {
        const data = JSON.parse(msg.data);

        // Live preview frames go to the matching upload card, not into `state`
        // (a multi-KB base64 string has no business living in app state).
        if (data.frame_jpeg && data.video_id){
          const card = document.querySelector(`[data-backend-id="${data.video_id}"]`);
          const img = card && card.querySelector('[data-live-frame]');
          if (img) img.src = 'data:image/jpeg;base64,' + data.frame_jpeg;

          // Mirror the same frame into the hero panel if this is the video
          // currently promoted there — real annotated frames from YOLO, not
          // the client-side simulated overlay, take over automatically.
          if (heroCardEl && heroCardEl.dataset.backendId === data.video_id){
            const heroPreview = document.getElementById('vi-hero-preview');
            const heroImg = heroPreview.querySelector('[data-hero-live-frame]');
            const heroVideo = heroPreview.querySelector('[data-hero-video]');
            const heroCanvas = heroPreview.querySelector('[data-hero-canvas]');
            const heroDot = document.getElementById('vi-hero-dot');
            const heroLabelTag = heroPreview.querySelector('[data-hero-preview-label]');
            heroImg.src = 'data:image/jpeg;base64,' + data.frame_jpeg;
            heroImg.classList.remove('hidden');
            heroVideo.classList.add('hidden');
            heroCanvas.classList.add('hidden');
            heroLabelTag.textContent = 'LIVE — YOLOv11 + ByteTrack';
            heroDot.className = 'w-2 h-2 rounded-full bg-go-glow pulse-go';
          }
        }

        // Backend sends snake_case fields and a nested `corridor` object
        // (see schemas.LiveFrameStats / video_processor.py's broadcast payload) —
        // translate onto this file's camelCase/flat state shape rather than
        // blindly Object.assign-ing, which would silently create parallel
        // dead fields (state.avg_speed) alongside the real ones (state.avgSpeed).
        if ('total' in data) state.total = data.total;
        if (data.counts) Object.assign(state.counts, data.counts);
        if (data.counts) renderDetectionOverview();
        if ('density' in data) state.density = data.density;
        if ('avg_speed' in data) state.avgSpeed = data.avg_speed;
        if ('max_speed' in data) state.maxSpeed = data.max_speed;
        if ('min_speed' in data) state.minSpeed = data.min_speed;
        if (data.corridor){
          state.corridorActive = data.corridor.active;
          state.corridorStep = data.corridor.current_step;
        }
        // Real alerts from the decision engine (congestion/ambulance/accident/
        // reroute) — see the fixed video_processor.py broadcast. These feed
        // the same pushEvent() feed used everywhere else in the app, and also
        // the Video Intelligence page's own live alerts panel.
        if (Array.isArray(data.events)){
          data.events.forEach(ev => {
            const tone = { critical:'critical', warning:'critical', high:'critical', info:'info' }[ev.severity] || 'info';
            pushEvent(`${ev.description}`, tone);
            pushViAlert(ev.description, ev.severity);
          });
          renderDetectionOverview();
        }
        if (data.status === 'completed' || data.status === 'failed'){
          pushEvent(`Backend: video ${data.video_id} ${data.status}.`, data.status === 'completed' ? 'success' : 'critical');
        }

        renderAll();
      } catch(e){}
    };
    ws.onerror = ()=>{ pushEvent('Backend connection failed — staying in simulation mode.', 'critical'); };
    ws.onclose = ()=>{ if(state.mode==='live'){ state.mode='simulation'; label.textContent='Simulation'; dot.className='w-1.5 h-1.5 rounded-full bg-caution-glow'; pushEvent('Backend disconnected — resumed simulation.', 'info'); } };
  } catch(e){ pushEvent('Invalid WebSocket URL.', 'critical'); }
}

/* ---------------- Theme (light / dark) ---------------- */
function applyTheme(theme){
  document.documentElement.dataset.theme = theme;
  // Two toggle switches share this state: one in the landing nav, one in
  // the app sidebar. Keep both knobs in sync regardless of which one
  // triggered the change (or neither, e.g. on initial load).
  document.querySelectorAll('.theme-toggle .knob').forEach(knob => {
    knob.textContent = theme === 'dark' ? '🌙' : '☀️';
  });
  try { localStorage.setItem('tv-theme', theme); } catch(e){}
}
function toggleTheme(){
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}
(function initTheme(){
  let saved = 'light';
  try { saved = localStorage.getItem('tv-theme') || 'light'; } catch(e){}
  applyTheme(saved);
})();

// REST API base for real video uploads, e.g. http://localhost:8000/api/v1
// (matches backend/app/main.py's settings.API_V1_PREFIX). Kept in memory
// only — reset on reload, same as the rest of this demo's state.
const DEFAULT_API_BASE = 'http://localhost:8000/api/v1';
let apiBaseUrl = '';
function saveApiUrl(){
  apiBaseUrl = document.getElementById('api-url').value.trim().replace(/\/$/, '');
  pushEvent(apiBaseUrl ? `Backend API set to ${apiBaseUrl} — uploads will POST there.` : 'Backend API cleared — uploads will run in simulation mode.', 'info');
}

// Auto-detect a locally running backend on page load so uploads hit real
// FastAPI + YOLO by default, instead of silently staying in simulation
// mode until someone manually pastes the URL in and clicks Save.
(function autoDetectBackend(){
  const input = document.getElementById('api-url');
  input.value = DEFAULT_API_BASE;
  const healthUrl = DEFAULT_API_BASE.replace(/\/api\/v1$/, '') + '/health';
  fetch(healthUrl, { method: 'GET' })
    .then(res => { if (!res.ok) throw new Error('not ok'); return res.json(); })
    .then(() => {
      apiBaseUrl = DEFAULT_API_BASE;
      pushEvent(`Backend detected at ${DEFAULT_API_BASE} — uploads will run real YOLO detection automatically.`, 'success');
    })
    .catch(() => {
      pushEvent('No local backend detected at localhost:8000 — uploads will run in simulation mode until you connect one.', 'info');
    });
})();

/* ---------------- Video upload pipeline ---------------- */
const STAGES = ['Queued','Uploading','Processing','AI Detection','Tracking','Analysis','Completed'];
let uploadCount = 0;
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
dropZone.addEventListener('click', ()=>fileInput.click());
dropZone.addEventListener('dragover', e=>{ e.preventDefault(); dropZone.classList.add('border-brand'); });
dropZone.addEventListener('dragleave', ()=> dropZone.classList.remove('border-brand'));
dropZone.addEventListener('drop', e=>{ e.preventDefault(); dropZone.classList.remove('border-brand'); handleFiles(e.dataTransfer.files); });
fileInput.addEventListener('change', e=> handleFiles(e.target.files));

function handleFiles(files){
  const list = document.getElementById('upload-list');
  const existing = list.children.length;
  Array.from(files).slice(0, Math.max(0,4-existing)).forEach(file=>{
    if (!file.type.startsWith('video/')) return;
    uploadCount++;
    const id = 'up-'+uploadCount;
    const url = URL.createObjectURL(file);
    const card = document.createElement('div');
    card.className = 'card p-5 fade-in';
    card.id = id;
    card.innerHTML = `
      <div class="flex gap-4">
        <video src="${url}" class="w-40 h-24 object-cover rounded-xl bg-black shrink-0" autoplay muted loop></video>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <p class="font-semibold text-sm truncate">${file.name}</p>
            <span class="text-[11px] font-mono text-mute shrink-0">${(file.size/1024/1024).toFixed(1)} MB</span>
          </div>
          <p class="text-[11px] text-mute font-mono mt-0.5" data-meta>reading metadata…</p>
          <div class="h-1.5 rounded-full bg-[#EEF0F3] mt-3 overflow-hidden"><div data-bar class="h-full bg-brand-light rounded-full transition-all duration-500" style="width:0%"></div></div>
          <div class="flex items-center justify-between mt-2">
            <span data-status class="text-[11px] font-semibold text-brand">Queued</span>
            <div class="flex gap-2">
              <button data-pause class="text-[11px] font-medium text-mute hover:text-ink">Pause</button>
              <button data-cancel class="text-[11px] font-medium text-stop hover:text-stop/70">Cancel</button>
            </div>
          </div>
        </div>
      </div>
      <div data-preview class="hidden mt-4 relative rounded-xl overflow-hidden bg-black">
        <video data-video src="${url}" class="w-full max-h-64 object-contain" controls autoplay muted loop></video>
        <canvas data-canvas class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
        <img data-live-frame class="hidden w-full max-h-64 object-contain" />
        <span data-preview-label class="absolute top-2 left-2 text-[10px] font-mono bg-black/60 text-white px-2 py-0.5 rounded">SIMULATED OVERLAY</span>
      </div>`;
    list.prepend(card);

    const vid = card.querySelector('[data-video]');
    vid.addEventListener('loadedmetadata', ()=>{
      const mins = Math.floor(vid.duration/60), secs = Math.floor(vid.duration%60);
      card.querySelector('[data-meta]').textContent = `${vid.videoWidth}×${vid.videoHeight} · ${mins}:${secs.toString().padStart(2,'0')}`;
    });

    if (apiBaseUrl) uploadToBackend(card, file);
    else runPipelineSimulated(card);

    promoteToHero(card, file.name, url);

    card.querySelector('[data-cancel]').onclick = ()=>{ card.remove(); };
    card.querySelector('[data-pause]').onclick = (e)=>{
      card.dataset.paused = card.dataset.paused === '1' ? '0' : '1';
      e.target.textContent = card.dataset.paused==='1' ? 'Resume' : 'Pause';
    };
  });
  fileInput.value = '';
}

/* Real backend upload — POSTs to <apiBaseUrl>/videos/upload (see
   backend/app/routers/upload.py), then polls GET /videos/{id} for
   status until it reaches 'completed' or 'failed'. Falls back to the
   client-side simulation if the backend is unreachable at any point,
   so the page never gets stuck. */
function uploadToBackend(card, file){
  const bar = card.querySelector('[data-bar]');
  const status = card.querySelector('[data-status]');
  status.textContent = 'Uploading';

  const formData = new FormData();
  formData.append('files', file);
  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e)=>{
    if (e.lengthComputable) bar.style.width = Math.round((e.loaded/e.total)*35) + '%'; // upload = first 35% of bar
  });
  xhr.addEventListener('load', ()=>{
    if (xhr.status >= 200 && xhr.status < 300){
      try {
        const result = JSON.parse(xhr.responseText);
        const record = Array.isArray(result) ? result[0] : result;
        card.dataset.backendId = record.id;
        pushEvent(`Uploaded to backend — video id ${record.id}`, 'success');
        pollBackendStatus(card, record.id);
      } catch(e){
        pushEvent('Backend returned an unexpected response — falling back to simulation.', 'critical');
        runPipelineSimulated(card);
      }
    } else {
      pushEvent(`Backend upload failed (HTTP ${xhr.status}) — falling back to simulation.`, 'critical');
      runPipelineSimulated(card);
    }
  });
  xhr.addEventListener('error', ()=>{
    pushEvent(`Could not reach backend at ${apiBaseUrl} — falling back to simulation.`, 'critical');
    runPipelineSimulated(card);
  });
  xhr.open('POST', apiBaseUrl + '/videos/upload');
  xhr.send(formData);
}

const BACKEND_STAGE_PCT = { queued:10, uploading:35, processing:45, detecting:60, tracking:75, analyzing:90, completed:100, failed:100 };
function pollBackendStatus(card, videoId){
  if (!document.body.contains(card)) return; // cancelled by the user
  const bar = card.querySelector('[data-bar]');
  const status = card.querySelector('[data-status]');

  fetch(`${apiBaseUrl}/videos/${videoId}`)
    .then(res => { if (!res.ok) throw new Error('HTTP '+res.status); return res.json(); })
    .then(data => {
      bar.style.width = (BACKEND_STAGE_PCT[data.status] ?? 50) + '%';
      status.textContent = data.status.charAt(0).toUpperCase() + data.status.slice(1);

      const preview = card.querySelector('[data-preview]');
      const liveFrame = card.querySelector('[data-live-frame]');
      const label = card.querySelector('[data-preview-label]');

      if (['detecting','tracking','analyzing'].includes(data.status) && state.mode === 'live'){
        // real frames will only arrive here if the WS is actually connected —
        // otherwise there's nothing to show yet, so leave the card on its progress bar
        preview.classList.remove('hidden');
        liveFrame.classList.remove('hidden');
        card.querySelector('[data-video]').classList.add('hidden');
        card.querySelector('[data-canvas]').classList.add('hidden');
        label.textContent = 'LIVE BACKEND DETECTION';
      }

      if (data.status === 'completed'){
        status.className = 'text-[11px] font-semibold text-go';
        preview.classList.remove('hidden');
        liveFrame.classList.add('hidden');
        card.querySelector('[data-video]').classList.remove('hidden');
        card.querySelector('[data-canvas]').classList.add('hidden');
        label.textContent = 'LIVE BACKEND RESULT';
        card.querySelector('[data-video]').src = `${apiBaseUrl}/videos/${videoId}/download`; // real annotated output, not the client overlay
        pushEvent(`Backend finished processing video ${videoId}.`, 'success');
      } else if (data.status === 'failed'){
        status.className = 'text-[11px] font-semibold text-stop';
        pushEvent(`Backend processing failed for video ${videoId}: ${data.error_message || 'unknown error'}`, 'critical');
      } else {
        setTimeout(()=>pollBackendStatus(card, videoId), 2000);
      }
    })
    .catch(err => {
      pushEvent(`Lost contact with backend while checking video ${videoId} (${err.message}) — falling back to simulation.`, 'critical');
      runPipelineSimulated(card);
    });
}

function runPipelineSimulated(card){
  let stageIdx = 0;
  const bar = card.querySelector('[data-bar]');
  const status = card.querySelector('[data-status]');
  const stepInterval = setInterval(()=>{
    if (card.dataset.paused === '1' || !document.body.contains(card)) { if(!document.body.contains(card)) clearInterval(stepInterval); return; }
    stageIdx++;
    const pct = Math.round((stageIdx/(STAGES.length-1))*100);
    bar.style.width = pct+'%';
    status.textContent = STAGES[stageIdx];
    if (stageIdx >= STAGES.length-1){
      clearInterval(stepInterval);
      status.className = 'text-[11px] font-semibold text-go';
      const preview = card.querySelector('[data-preview]');
      preview.classList.remove('hidden');
      startDetectionOverlay(card);
      pushEvent(`Processing complete for ${card.querySelector('.font-semibold').textContent}`, 'success');
    }
  }, 900);
}

let heroCardEl = null;
function promoteToHero(card, filename, url){
  heroCardEl = card;
  const empty = document.getElementById('vi-hero-empty');
  const preview = document.getElementById('vi-hero-preview');
  const label = document.getElementById('vi-hero-label');
  const dot = document.getElementById('vi-hero-dot');
  if (!preview) return;
  empty.classList.add('hidden');
  preview.classList.remove('hidden');
  label.textContent = filename;
  dot.className = 'w-2 h-2 rounded-full bg-caution-glow';

  const heroVideo = preview.querySelector('[data-hero-video]');
  const heroCanvas = preview.querySelector('[data-hero-canvas]');
  const heroImg = preview.querySelector('[data-hero-live-frame]');
  const heroLabelTag = preview.querySelector('[data-hero-preview-label]');
  heroVideo.src = url;
  heroVideo.classList.remove('hidden');
  heroCanvas.classList.remove('hidden');
  heroImg.classList.add('hidden');
  heroLabelTag.textContent = 'SIMULATED OVERLAY';
  startDetectionOverlay(preview);
}

function startDetectionOverlay(container){
  const video = container.querySelector('[data-video], [data-hero-video]');
  const canvas = container.querySelector('[data-canvas], [data-hero-canvas]');
  const ctx = canvas.getContext('2d');
  let boxes = [];
  function seedBoxes(){
    const n = 3 + Math.floor(Math.random()*3);
    boxes = Array.from({length:n}).map(()=>({
      x: Math.random()*0.7, y: Math.random()*0.6, w: 0.12+Math.random()*0.12, h: 0.12+Math.random()*0.1,
      vx: (Math.random()-0.5)*0.004, vy:(Math.random()-0.5)*0.002,
      cls: CLASS_LIST[Math.floor(Math.random()*CLASS_LIST.length)], conf: (78+Math.random()*20).toFixed(0), id: Math.floor(Math.random()*900+100)
    }));
  }
  seedBoxes();
  video.addEventListener('play', ()=>{
    function draw(){
      if (video.paused || video.ended) return;
      canvas.width = video.clientWidth; canvas.height = video.clientHeight;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      boxes.forEach(b=>{
        b.x += b.vx; b.y += b.vy;
        if (b.x<0||b.x>1-b.w) b.vx*=-1;
        if (b.y<0||b.y>1-b.h) b.vy*=-1;
        const px=b.x*canvas.width, py=b.y*canvas.height, pw=b.w*canvas.width, ph=b.h*canvas.height;
        ctx.strokeStyle = b.cls==='pedestrian' ? '#F59E0B' : '#22C55E';
        ctx.lineWidth = 2; ctx.strokeRect(px,py,pw,ph);
        ctx.fillStyle = ctx.strokeStyle; ctx.font = '10px monospace';
        ctx.fillRect(px, py-14, ctx.measureText(`${b.cls} ${b.conf}% #${b.id}`).width+8, 14);
        ctx.fillStyle = '#0B1220';
        ctx.fillText(`${b.cls} ${b.conf}% #${b.id}`, px+4, py-3);
      });
      requestAnimationFrame(draw);
    }
    draw();
  });
  // The `autoplay` attribute usually covers this (muted autoplay is allowed
  // by every browser's policy), but it can silently no-op if metadata isn't
  // ready yet or the tab was backgrounded on upload — explicitly requesting
  // play() here is what actually guarantees the overlay starts moving
  // without the user having to find and click the native play button on
  // what otherwise looks like a dead black box.
  const tryPlay = () => video.play().catch(()=>{});
  if (video.readyState >= 2) tryPlay();
  else video.addEventListener('loadeddata', tryPlay, { once: true });
}

/* ---------------- Live CCTV Grid ---------------- */
const CCTV_LOCATIONS = ['NH-65 Junction','Ring Road','Banjara Main','Tank Bund','Gachibowli','Hitech City',
  'Jubilee Hills','Begumpet','Kukatpally','Miyapur','LB Nagar','Dilsukhnagar','Uppal','Secunderabad','Ameerpet','Madhapur'];
const cctvState = { size: 4, overlay: true, feeds: [] };

function makeVehicleSeed(){
  const n = 3 + Math.floor(Math.random()*4);
  return Array.from({length:n}).map(()=>({
    x: Math.random(), y: Math.random()*0.7+0.15,
    vx: (Math.random()-0.5)*0.005, vy:(Math.random()-0.5)*0.0015,
    w: 0.07+Math.random()*0.05, h: 0.05+Math.random()*0.035,
    cls: CLASS_LIST[Math.floor(Math.random()*CLASS_LIST.length)],
    conf: (75+Math.random()*22).toFixed(0),
  }));
}

function drawFeedFrame(canvas, camName, vehicles, recording){
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width = canvas.clientWidth;
  const h = canvas.height = canvas.clientHeight;
  if (!w || !h) return;

  // road backdrop
  const grad = ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,'#1a2130'); grad.addColorStop(1,'#0d1119');
  ctx.fillStyle = grad; ctx.fillRect(0,0,w,h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2; ctx.setLineDash([10,10]);
  for (let ly=0.35; ly<0.9; ly+=0.22){ ctx.beginPath(); ctx.moveTo(0,h*ly); ctx.lineTo(w,h*ly); ctx.stroke(); }
  ctx.setLineDash([]);

  vehicles.forEach(v=>{
    v.x += v.vx; v.y += v.vy;
    if (v.x<-0.1) v.x = 1.05; if (v.x>1.05) v.x = -0.1;
    if (v.y<0.15||v.y>0.85) v.vy *= -1;
    const px=v.x*w, py=v.y*h, pw=v.w*w, ph=v.h*h;
    ctx.fillStyle = v.cls==='pedestrian' ? '#F59E0B' : '#4F46E5';
    ctx.fillRect(px, py, pw, ph);
    if (cctvState.overlay){
      ctx.strokeStyle = '#22C55E'; ctx.lineWidth = 1.5; ctx.strokeRect(px, py, pw, ph);
      ctx.font = '9px monospace'; ctx.fillStyle = '#22C55E';
      ctx.fillText(`${v.cls} ${v.conf}%`, px, py-3);
    }
  });

  // OSD overlay
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0,0,w,20);
  ctx.fillStyle = '#fff'; ctx.font = '10px monospace';
  ctx.fillText(camName, 6, 14);
  const t = new Date().toLocaleTimeString('en-IN',{hour12:false});
  ctx.fillText(t, w-58, 14);
  ctx.beginPath(); ctx.arc(w-70, 10, 3, 0, Math.PI*2); ctx.fillStyle = '#22C55E'; ctx.fill();

  if (recording){
    ctx.fillStyle = '#EF4444'; ctx.beginPath(); ctx.arc(14, h-14, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText('REC', 22, h-10);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.font = '10px monospace';
  const countText = `${vehicles.length} vehicles`;
  const tw = ctx.measureText(countText).width;
  ctx.fillRect(w-tw-14, h-24, tw+10, 16);
  ctx.fillStyle = '#22C55E'; ctx.fillText(countText, w-tw-9, h-12);
}

function createFeed(canvas, camName){
  const vehicles = makeVehicleSeed();
  const feed = { canvas, camName, vehicles, rafId:null, recording:false, recorder:null, chunks:[], lastClipUrl:null };
  function loop(){
    drawFeedFrame(canvas, camName, vehicles, feed.recording);
    feed.rafId = requestAnimationFrame(loop);
  }
  loop();
  return feed;
}
function stopFeed(feed){ if (feed.rafId) cancelAnimationFrame(feed.rafId); if (feed.recorder && feed.recording) feed.recorder.stop(); }

function renderCctvGrid(size){
  cctvState.size = size;
  cctvState.feeds.forEach(stopFeed);
  cctvState.feeds = [];

  document.querySelectorAll('.grid-size-btn').forEach(b=>{
    const active = parseInt(b.dataset.size) === size;
    b.className = 'grid-size-btn text-xs font-semibold px-3.5 py-1.5 rounded-full transition ' +
      (active ? 'bg-white text-ink' : 'bg-white/10 text-white/70 hover:bg-white/15');
  });
  const note = document.getElementById('cctv-backend-note');
  if (note) note.textContent = apiBaseUrl
    ? `Connected to ${apiBaseUrl} — uploaded clips run real YOLOv11 detection on the backend.`
    : 'Simulation mode — set the backend API URL (top right) to run real YOLOv11 detection on uploaded clips.';

  const grid = document.getElementById('cctv-grid');
  const cols = size===4 ? 'grid-cols-2' : size===9 ? 'grid-cols-3' : 'grid-cols-4';
  grid.className = 'grid gap-2 ' + cols;
  grid.innerHTML = '';
  const listBox = document.getElementById('cctv-camera-list');
  if (listBox) listBox.innerHTML = '';

  for (let i=0;i<size;i++){
    const camName = `CAM-${String(i+1).padStart(2,'0')} · ${CCTV_LOCATIONS[i % CCTV_LOCATIONS.length]}`;
    const tile = document.createElement('div');
    tile.className = 'relative rounded-xl overflow-hidden bg-black aspect-video group';
    tile.dataset.slot = i;
    tile.innerHTML = `
      <canvas class="w-full h-full block"></canvas>
      <input type="file" accept="video/mp4,video/quicktime,video/x-matroska" class="hidden" data-fileinput />
      <div class="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition">
        <button data-act="upload" class="w-6 h-6 rounded bg-black/60 hover:bg-black/80 text-white flex items-center justify-center" title="Upload video">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>
        </button>
        <button data-act="zoom" class="w-6 h-6 rounded bg-black/60 hover:bg-black/80 text-white flex items-center justify-center" title="Zoom">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        </button>
        <button data-act="fullscreen" class="w-6 h-6 rounded bg-black/60 hover:bg-black/80 text-white flex items-center justify-center" title="Fullscreen">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3"/></svg>
        </button>
        <button data-act="snapshot" class="w-6 h-6 rounded bg-black/60 hover:bg-black/80 text-white flex items-center justify-center" title="Snapshot">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
        <button data-act="record" class="w-6 h-6 rounded bg-black/60 hover:bg-black/80 text-white flex items-center justify-center" title="Record">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>
        </button>
      </div>
      <button data-act="replay" class="hidden absolute bottom-1.5 left-1.5 text-[10px] font-mono bg-black/60 hover:bg-black/80 text-white px-2 py-1 rounded">▶ Replay last clip</button>
      <span data-source-badge class="absolute bottom-1.5 right-1.5 text-[9px] font-mono bg-black/60 text-white/70 px-1.5 py-0.5 rounded">SYNTHETIC</span>
    `;
    grid.appendChild(tile);
    const canvas = tile.querySelector('canvas');
    let feed;
    try {
      feed = createFeed(canvas, camName);
      feed.tile = tile;
      cctvState.feeds.push(feed);
    } catch (e) {
      console.warn(`Feed init failed for ${camName}:`, e);
      continue; // don't let one bad tile take down the rest of the grid
    }

    tile.querySelector('[data-act="upload"]').onclick = ()=> tile.querySelector('[data-fileinput]').click();
    tile.querySelector('[data-fileinput]').addEventListener('change', (e)=>{
      const file = e.target.files[0];
      if (file) loadVideoIntoTile(tile, feed, file, camName);
    });
    tile.querySelector('[data-act="zoom"]').onclick = ()=> openCctvModal(camName);
    tile.querySelector('[data-act="fullscreen"]').onclick = ()=> {
      if (tile.requestFullscreen) tile.requestFullscreen().catch(()=>pushEvent('Fullscreen blocked by browser — try clicking directly on the tile.', 'info'));
    };
    tile.querySelector('[data-act="snapshot"]').onclick = ()=> {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${camName.split(' · ')[0]}_snapshot_${Date.now()}.png`;
      a.click();
      pushEvent(`Snapshot saved from ${camName}.`, 'info');
    };
    tile.querySelector('[data-act="record"]').onclick = (e)=> toggleRecord(feed, tile, e.currentTarget);
    tile.querySelector('[data-act="replay"]').onclick = ()=> {
      if (feed.lastClipUrl) openCctvModal(camName, feed.lastClipUrl);
    };

    if (listBox){
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 transition text-white/70';
      row.innerHTML = `
        <span class="flex items-center gap-1.5 text-[11px] truncate"><span class="w-1.5 h-1.5 rounded-full bg-go-glow shrink-0"></span>${camName.split(' · ')[0]}</span>
        <button class="text-[10px] font-mono text-brand-light hover:text-white shrink-0">Upload</button>`;
      row.querySelector('button').onclick = ()=> tile.querySelector('[data-fileinput]').click();
      listBox.appendChild(row);
    }
  }
}

/* Swap a synthetic tile for a real uploaded clip. Runs the same
   client-side overlay as the Video Intelligence page; if a backend
   API URL is configured (top-right panel), also POSTs the file for
   real YOLOv11 detection and swaps in the backend's annotated result
   once processing completes — same pattern as uploadToBackend(). */
function loadVideoIntoTile(tile, feed, file, camName){
  stopFeed(feed);
  const url = URL.createObjectURL(file);
  const canvas = tile.querySelector('canvas');
  const badge = tile.querySelector('[data-source-badge]');
  badge.textContent = 'UPLOADED';

  const video = document.createElement('video');
  video.src = url; video.className = 'w-full h-full object-cover block'; video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
  tile.insertBefore(video, canvas);
  canvas.className = 'absolute inset-0 w-full h-full pointer-events-none';

  const pseudoCard = { querySelector: (sel) => sel === '[data-video]' ? video : sel === '[data-canvas]' ? canvas : null };
  startDetectionOverlay(pseudoCard);
  pushEvent(`${camName} — local clip loaded (${file.name}).`, 'info');

  if (apiBaseUrl){
    badge.textContent = 'UPLOADING…';
    const formData = new FormData();
    formData.append('files', file);
    fetch(`${apiBaseUrl}/videos/upload`, { method:'POST', body: formData })
      .then(res => { if (!res.ok) throw new Error('HTTP '+res.status); return res.json(); })
      .then(result => {
        const record = Array.isArray(result) ? result[0] : result;
        badge.textContent = 'BACKEND: ' + record.status.toUpperCase();
        pollTileBackendStatus(tile, video, badge, record.id, camName);
      })
      .catch(err => {
        badge.textContent = 'LOCAL ONLY';
        pushEvent(`Backend upload failed for ${camName} (${err.message}) — showing local preview only.`, 'critical');
      });
  }
}
function pollTileBackendStatus(tile, video, badge, videoId, camName){
  if (!document.body.contains(tile)) return;
  fetch(`${apiBaseUrl}/videos/${videoId}`)
    .then(res => { if (!res.ok) throw new Error('HTTP '+res.status); return res.json(); })
    .then(data => {
      badge.textContent = 'BACKEND: ' + data.status.toUpperCase();
      if (data.status === 'completed'){
        video.src = `${apiBaseUrl}/videos/${videoId}/download`;
        badge.textContent = 'BACKEND RESULT';
        pushEvent(`${camName} — backend detection complete.`, 'success');
      } else if (data.status === 'failed'){
        badge.textContent = 'BACKEND FAILED';
      } else {
        setTimeout(()=>pollTileBackendStatus(tile, video, badge, videoId, camName), 2000);
      }
    })
    .catch(()=>{ badge.textContent = 'LOCAL ONLY'; });
}

function toggleRecord(feed, tile, btn){
  if (!feed.recording){
    try{
      const stream = feed.canvas.captureStream(25);
      feed.recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      feed.chunks = [];
      feed.recorder.ondataavailable = e => { if (e.data.size) feed.chunks.push(e.data); };
      feed.recorder.onstop = () => {
        const blob = new Blob(feed.chunks, { type:'video/webm' });
        feed.lastClipUrl = URL.createObjectURL(blob);
        tile.querySelector('[data-act="replay"]').classList.remove('hidden');
        pushEvent(`Recording saved for ${feed.camName}.`, 'success');
      };
      feed.recorder.start();
      feed.recording = true;
      btn.classList.add('bg-stop');
      pushEvent(`Recording started on ${feed.camName}.`, 'info');
    } catch(e){
      pushEvent('MediaRecorder not supported in this browser.', 'critical');
    }
  } else {
    feed.recording = false;
    if (feed.recorder) feed.recorder.stop();
    btn.classList.remove('bg-stop');
  }
}

let _modalFeed = null;
function openCctvModal(camName, clipUrl){
  const modal = document.getElementById('cctv-modal');
  document.getElementById('cctv-modal-title').textContent = camName;
  modal.classList.remove('hidden'); modal.classList.add('flex');
  const canvas = document.getElementById('cctv-modal-canvas');

  const existingVideo = document.getElementById('cctv-modal-video');
  if (existingVideo) existingVideo.remove();

  if (clipUrl){
    canvas.classList.add('hidden');
    const video = document.createElement('video');
    video.id = 'cctv-modal-video'; video.src = clipUrl; video.controls = true; video.autoplay = true;
    video.className = 'w-full h-full object-contain';
    canvas.parentElement.appendChild(video);
  } else {
    canvas.classList.remove('hidden');
    if (_modalFeed) stopFeed(_modalFeed);
    try { _modalFeed = createFeed(canvas, camName); }
    catch (e) { console.warn('Modal feed init failed:', e); _modalFeed = null; }
  }
}
function closeCctvModal(){
  const modal = document.getElementById('cctv-modal');
  modal.classList.add('hidden'); modal.classList.remove('flex');
  if (_modalFeed) { stopFeed(_modalFeed); _modalFeed = null; }
  const existingVideo = document.getElementById('cctv-modal-video');
  if (existingVideo) existingVideo.remove();
}
function toggleAllOverlays(){
  cctvState.overlay = !cctvState.overlay;
  const btn = document.getElementById('overlay-toggle-btn');
  btn.textContent = 'AI Overlay: ' + (cctvState.overlay ? 'On' : 'Off');
}
document.querySelectorAll('.grid-size-btn').forEach(b=> b.addEventListener('click', ()=> renderCctvGrid(parseInt(b.dataset.size))));

/* ---------------- Map ---------------- */
// One fixed, specific colour per lane — not a traffic-congestion colour, so a
// lane keeps its identity on the map regardless of how busy it is. Traffic
// level shows separately as the small badge marker along each line.
const LANE_ROUTES = [
  { lane: LANES[0], color: '#4F46E5', path: [[17.385,78.487],[17.398,78.470],[17.4132,78.4415]] }, // NH-65 -> Apollo
  { lane: LANES[1], color: '#16A34A', path: [[17.385,78.487],[17.395,78.475],[17.4189,78.4577]] }, // Ring Road -> Yashoda
  { lane: LANES[2], color: '#F59E0B', path: [[17.385,78.487],[17.400,78.420],[17.4144,78.3489]] }, // Banjara Main -> Continental
  { lane: LANES[3], color: '#DB2777', path: [[17.385,78.487],[17.400,78.487],[17.4132,78.4841]] }, // Tank Bund
];
function trafficDivIcon(level){
  const color = level==='Critical' ? '#DC2626' : level==='High' ? '#F97316' : level==='Medium' ? '#F59E0B' : '#16A34A';
  return L.divIcon({ className:'', iconSize:[14,14], iconAnchor:[7,7], html:
    `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4);"></div>` });
}
function initMap(){
  window._mapInit = true;
  const map = L.map('map', { zoomControl:true }).setView([17.398, 78.46], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OpenStreetMap contributors', maxZoom:19 }).addTo(map);
  window._leafletMap = map;

  const signalPts = [[17.385,78.487],[17.392,78.481],[17.379,78.478],[17.388,78.473]];
  signalPts.forEach((p,i)=> L.circleMarker(p, { radius:7, color:'#DC2626', fillColor:'#EF4444', fillOpacity:0.9 }).addTo(map).bindPopup(`Signal ${i+1}`));

  HOSPITAL_COORDS.forEach(h => {
    L.marker([h.lat, h.lng], { icon: hospitalDivIcon() }).addTo(map).bindPopup(`<b>${h.name}</b>`);
  });

  window._mapLayers = { lanes: {} };
  LANE_ROUTES.forEach(r => {
    const line = L.polyline(r.path, { color: r.color, weight: 4 }).addTo(map);
    const mid = r.path[Math.floor(r.path.length / 2)];
    const badge = L.marker(mid, { icon: trafficDivIcon(state.density) })
      .addTo(map)
      .bindPopup(`<b>${r.lane}</b><br>Traffic: ${state.density}`);
    window._mapLayers.lanes[r.lane] = { line, badge, baseColor: r.color };
  });
}
function updateMapTraffic(){
  if (!window._mapLayers || !window._mapLayers.lanes) return;
  const levels = ['Low','Medium','High','Critical'];
  const baseIdx = levels.indexOf(state.density);
  Object.entries(window._mapLayers.lanes).forEach(([laneName, l], i) => {
    // vary slightly per lane so the map doesn't show four identical badges —
    // the ambulance's own lane always reflects the true global density.
    const isAmbLane = state.ambulance && state.ambulance.lane === laneName;
    const idx = isAmbLane ? baseIdx : Math.max(0, Math.min(3, baseIdx + (i % 2 === 0 ? 0 : -1)));
    const level = levels[idx] ?? state.density;
    l.badge.setIcon(trafficDivIcon(level));
    l.badge.setPopupContent(`<b>${laneName}</b><br>Traffic: ${level}`);
  });
}
function drawMapRoutes(blocked){
  if (!window._mapLayers || !window._mapLayers.lanes) return;
  const blockedLane = state.accident ? state.accident.location : null;
  Object.entries(window._mapLayers.lanes).forEach(([laneName, l]) => {
    const isBlocked = blocked && laneName === blockedLane;
    l.line.setStyle({ color: isBlocked ? '#EF4444' : l.baseColor, dashArray: isBlocked ? '4,6' : null, weight: isBlocked ? 5 : 4 });
  });
}

/* ---------------- Emergency page: live ambulance map ----------------
   Same L.marker(...).addTo(map).bindPopup(...) pattern you're already
   using — this just wraps it in a divIcon (so it renders as a red
   ambulance dot instead of Leaflet's default pin, with no external
   image files needed) and a redraw function you can call with real
   data. To wire in your own API: replace the body of
   getAmbulancePositions() with your fetch/poll call, e.g.

     async function getAmbulancePositions(){
       const res = await fetch('https://your-api/ambulances/live');
       return await res.json(); // [{id, lat, lng, status}, ...]
     }

   updateAmbulanceMarkers() already clears and redraws every marker
   each time it's called, so polling it on an interval is enough. */
function ambulanceDivIcon(active){
  return L.divIcon({
    className: '',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${active?'#DC2626':'#5B6472'};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.35);border:2px solid white;">
             <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4"><path d="M3 17h1a2 2 0 004 0h6a2 2 0 004 0h1a1 1 0 001-1v-3.5a1 1 0 00-.3-.7l-2.5-2.5a1 1 0 00-.7-.3H15V7a1 1 0 00-1-1H4a1 1 0 00-1 1v9a1 1 0 001 1z"/></svg>
           </div>`,
    iconSize: [26,26], iconAnchor: [13,13],
  });
}
function hospitalDivIcon(){
  return L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:6px;background:#3730A3;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.35);border:2px solid white;font-size:11px;">🏥</div>`,
    iconSize: [22,22], iconAnchor: [11,11],
  });
}

function initEmergencyMap(){
  window._emMapInit = true;
  const map = L.map('emergency-map', { zoomControl:true }).setView([17.4065, 78.4772], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OpenStreetMap contributors', maxZoom:19 }).addTo(map);
  window._emMap = map;
  window._emAmbulanceLayer = L.layerGroup().addTo(map);

  HOSPITAL_COORDS.forEach(h => {
    L.marker([h.lat, h.lng], { icon: hospitalDivIcon() }).addTo(map).bindPopup(h.name);
  });
}

// Swap this out for a real API call — see comment block above.
function getAmbulancePositions(){
  if (state.ambulance){
    // nudge a simulated position along a fixed patrol route so the marker visibly moves
    const t = (Date.now() / 4000) % 1;
    const route = [[17.385,78.487],[17.392,78.481],[17.4132,78.4415]];
    const seg = Math.floor(t * (route.length - 1));
    const [a, b] = [route[seg], route[Math.min(route.length-1, seg+1)]];
    const localT = (t * (route.length - 1)) - seg;
    const lat = a[0] + (b[0]-a[0]) * localT;
    const lng = a[1] + (b[1]-a[1]) * localT;
    return [{ id: state.ambulance.id, lat, lng, status: state.ambulance.location, active: true }];
  }
  // idle/standby depots — keeps the map populated like a real ops board when nothing's active
  return [
    { id: 'AMB-STANDBY-1', lat: 17.412, lng: 78.448, status: 'Standby', active: false },
    { id: 'AMB-STANDBY-2', lat: 17.398, lng: 78.505, status: 'Standby', active: false },
  ];
}

function updateAmbulanceMarkers(){
  if (!window._emAmbulanceLayer) return;
  window._emAmbulanceLayer.clearLayers();
  getAmbulancePositions().forEach(a => {
    L.marker([a.lat, a.lng], { icon: ambulanceDivIcon(a.active) })
      .addTo(window._emAmbulanceLayer)
      .bindPopup(`<b>${a.id}</b><br>${a.status}`);
  });
}

/* ---------------- AI Assistant ---------------- */
const assistantState = {
  threads: [],            // {title, time, messages:[{from,text,imageDataUrl}]}
  currentMessages: [],
  attachedImage: null,    // {base64, dataUrl}
  autoSpeak: false,
  recognizing: false,
};
let speechRecognizer = null;

function stripHtml(html){
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

function showChatLog(){
  document.getElementById('assistant-empty-state').classList.add('hidden');
  document.getElementById('chat-log').classList.remove('hidden');
}

function addChatBubble(text, from, imageDataUrl){
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = from==='user' ? 'flex justify-end fade-in' : 'flex justify-start fade-in';
  const imageHtml = imageDataUrl ? `<img src="${imageDataUrl}" class="w-32 h-32 object-cover rounded-lg mb-1.5" />` : '';
  const speakBtn = from==='bot' ? `<button onclick="speak(this.parentElement.dataset.raw)" class="mt-1 text-mute hover:text-ink" title="Read aloud">
      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/></svg>
    </button>` : '';
  div.innerHTML = `<div data-raw="${from==='bot' ? stripHtml(text).replace(/"/g,'&quot;') : ''}" class="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${from==='user' ? 'bg-ink text-white rounded-br-sm' : 'bg-[#F2F3F6] text-ink rounded-bl-sm'}">${imageHtml}${text}${speakBtn}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  assistantState.currentMessages.push({ from, text, imageDataUrl });
}

function answerQuestion(q){
  const s = q.toLowerCase();
  if (s.includes('ambulance') && (s.includes('where')||s.includes('locat'))){
    return state.ambulance ? `${state.ambulance.id} is on ${state.ambulance.lane}, ${state.ambulance.location.toLowerCase()}, doing ${state.ambulance.speed} km/h. ETA to ${state.ambulance.hospital} is ${state.ambulance.etaSeconds}s.` : 'No ambulance is currently active in the frame.';
  }
  if (s.includes('signal') && s.includes('chang')){
    return state.decisions[0] ? state.decisions[0].text : 'No signal changes have been logged yet this session.';
  }
  if (s.includes('congest') || s.includes('highest') || s.includes('density')){
    return `Current density is classified <b>${state.density}</b> with ${state.total} vehicles in frame. ${LANES[Math.floor(Math.random()*LANES.length)]} is showing the heaviest load right now.`;
  }
  if (s.includes('report') || s.includes('summary') || s.includes('today')){
    return `Session so far: ${state.total} vehicles currently tracked, ${state.ambulancesCleared} ambulance(s) cleared, ${state.corridorsToday} green corridor(s) run. Use the Export CSV button on Analytics for the full log.`;
  }
  if (s.includes('accident') || s.includes('incident')){
    return state.accident ? `${state.accident.type} at ${state.accident.location}, severity ${state.accident.severity}, logged at ${state.accident.time}.` : 'No incidents are active — all lanes are flowing normally.';
  }
  return `I can answer questions about ambulance location, signal decisions, congestion, incidents, or session reports — try one of the suggestions below.`;
}

async function sendChat(){
  const input = document.getElementById('chat-input');
  const q = input.value.trim();
  if (!q) return;

  const wasEmpty = assistantState.currentMessages.length === 0;
  showChatLog();
  addChatBubble(q, 'user', assistantState.attachedImage ? assistantState.attachedImage.dataUrl : null);
  const attachedBase64 = assistantState.attachedImage ? assistantState.attachedImage.base64 : null;
  input.value = '';
  removeAttachedImage();

  if (wasEmpty){
    assistantState.threads.unshift({ title: q.slice(0, 40), time: fmtTime(), messages: assistantState.currentMessages });
    renderThreadHistory();
  }

  let answer;
  if (typeof apiBaseUrl !== 'undefined' && apiBaseUrl){
    try {
      const res = await fetch(`${apiBaseUrl}/assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, image_base64: attachedBase64 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      answer = data.answer;
    } catch (e){
      answer = `(backend unreachable — ${e.message}, falling back to local) ` + answerQuestion(q);
    }
  } else {
    await new Promise(r => setTimeout(r, 350));
    answer = answerQuestion(q);
  }

  addChatBubble(answer, 'bot');
  if (assistantState.autoSpeak) speak(stripHtml(answer));
}

function newAssistantThread(){
  document.getElementById('chat-log').innerHTML = '';
  document.getElementById('chat-log').classList.add('hidden');
  document.getElementById('assistant-empty-state').classList.remove('hidden');
  assistantState.currentMessages = [];
  removeAttachedImage();
  document.getElementById('chat-input').value = '';
}

function renderThreadHistory(){
  const box = document.getElementById('assistant-thread-history');
  if (!assistantState.threads.length){
    box.innerHTML = '<p class="text-[11px] text-mute font-mono px-2 py-4 text-center">No previous threads yet</p>';
    return;
  }
  box.innerHTML = assistantState.threads.map((t, i) => `
    <button onclick="loadAssistantThread(${i})" class="w-full text-left text-xs px-2.5 py-2 rounded-lg hover:bg-[#EEF0F3] transition truncate" title="${t.title}">
      <div class="truncate text-ink">${t.title}</div>
      <div class="text-[10px] text-mute font-mono">${t.time}</div>
    </button>`).join('');
}
function loadAssistantThread(i){
  const thread = assistantState.threads[i];
  if (!thread) return;
  showChatLog();
  document.getElementById('chat-log').innerHTML = '';
  assistantState.currentMessages = [];
  thread.messages.forEach(m => addChatBubble(m.text, m.from, m.imageDataUrl));
}

/* ---- Voice output (Text-to-Speech) ---- */
function speak(text){
  if (!('speechSynthesis' in window)){
    pushEvent('Speech synthesis is not supported in this browser.', 'info');
    return;
  }
  window.speechSynthesis.cancel(); // don't stack overlapping utterances
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  window.speechSynthesis.speak(utter);
}
function toggleAutoSpeak(){
  assistantState.autoSpeak = !assistantState.autoSpeak;
  const btn = document.getElementById('autospeak-toggle');
  btn.lastChild.textContent = ' Auto-speak: ' + (assistantState.autoSpeak ? 'On' : 'Off');
  btn.className = 'flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded-full border transition ' +
    (assistantState.autoSpeak ? 'bg-brand-dim border-brand text-brand' : 'border-[#EBECF1] hover:border-ink');
}

/* ---- Voice input (Speech-to-Text) ---- */
function toggleVoiceInput(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR){
    pushEvent('Voice input is not supported in this browser — try Chrome or Edge.', 'info');
    return;
  }
  const micBtn = document.getElementById('mic-btn');
  if (assistantState.recognizing){
    speechRecognizer && speechRecognizer.stop();
    return;
  }
  speechRecognizer = new SR();
  speechRecognizer.lang = 'en-US';
  speechRecognizer.interimResults = false;
  speechRecognizer.maxAlternatives = 1;

  speechRecognizer.onstart = () => {
    assistantState.recognizing = true;
    micBtn.classList.add('bg-stop', 'text-white', 'pulse-stop');
  };
  speechRecognizer.onend = () => {
    assistantState.recognizing = false;
    micBtn.classList.remove('bg-stop', 'text-white', 'pulse-stop');
  };
  speechRecognizer.onerror = (e) => {
    pushEvent(`Voice input error: ${e.error}`, 'info');
  };
  speechRecognizer.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    document.getElementById('chat-input').value = transcript;
    sendChat();
  };
  speechRecognizer.start();
}

/* ---- Image attach ---- */
document.getElementById('chat-image-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    assistantState.attachedImage = { dataUrl, base64: dataUrl.split(',')[1] };
    document.getElementById('chat-image-thumb').src = dataUrl;
    document.getElementById('chat-image-preview').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});
function removeAttachedImage(){
  assistantState.attachedImage = null;
  document.getElementById('chat-image-preview').classList.add('hidden');
  document.getElementById('chat-image-thumb').src = '';
}

document.getElementById('chat-input').addEventListener('keydown', e=>{ if(e.key==='Enter') sendChat(); });
document.querySelectorAll('.chat-suggest').forEach(btn=> btn.addEventListener('click', ()=>{ document.getElementById('chat-input').value = btn.textContent.replace(/^→\s*/, ''); sendChat(); }));

/* ---------------- Reports ---------------- */
function exportCSV(){
  const rows = [['timestamp','total_vehicles','density','avg_speed_kmh']];
  state.history.t.forEach((t,i)=> rows.push([t, state.history.total[i], state.density, state.history.speed[i]]));
  const csv = rows.map(r=>r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'trafficvision_session_report.csv'; a.click();
  pushEvent('Session CSV report exported.', 'info');
}
function printReport(){ window.print(); }

/* ---------------- Admin ---------------- */
const demoUsers = [
  { name:'Zuha (Admin)', email:'admin@trafficvision.ai', role:'Admin', dept:'Operations', status:'Active' },
  { name:'Traffic Control', email:'control@trafficvision.ai', role:'Manager', dept:'Signal Ops', status:'Active' },
  { name:'Hospital Liaison', email:'liaison@apollo.local', role:'Viewer', dept:'Emergency', status:'Active' },
];
function renderAdminUsers(){
  document.getElementById('admin-users-body').innerHTML = demoUsers.map(u=>`
    <tr class="border-b border-[#F6F7F9]">
      <td class="py-2 font-medium">${u.name}</td><td class="py-2 text-mute">${u.email}</td><td class="py-2">${u.role}</td>
      <td class="py-2"><span class="text-[11px] font-semibold px-2 py-0.5 rounded-full badge-low">${u.status}</span></td>
      <td class="py-2"><button class="text-brand text-xs font-medium mr-3">Edit</button><button class="text-stop text-xs font-medium">Deactivate</button></td>
    </tr>`).join('');
}
function addDemoUser(){
  demoUsers.push({ name:'New User', email:'user'+(demoUsers.length+1)+'@trafficvision.ai', role:'Viewer', dept:'—', status:'Active' });
  renderAdminUsers();
}
function renderAdminCameras(){
  const cams = [['CAM-01','Signal 1 · NH-65','Online'],['CAM-02','Signal 2 · Ring Road','Online'],['CAM-03','Signal 3 · Banjara Main','Offline'],['CAM-04','Signal 4 · Tank Bund','Online']];
  document.getElementById('admin-cameras').innerHTML = cams.map(c=>`
    <div class="flex items-center justify-between">
      <div><p class="font-medium">${c[0]}</p><p class="text-xs text-mute">${c[1]}</p></div>
      <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full ${c[2]==='Online'?'badge-low':'badge-critical'}">${c[2]}</span>
    </div>`).join('');
}
function renderAdminSignals(){
  const sigs = [['Signal 1',30],['Signal 2',35],['Signal 3',28],['Signal 4',32]];
  document.getElementById('admin-signals').innerHTML = sigs.map(([name,val],i)=>`
    <div>
      <div class="flex justify-between text-xs mb-1.5"><span class="text-mute">${name}</span><span class="font-mono" id="sig-val-${i}">${val}s</span></div>
      <input type="range" min="15" max="60" value="${val}" class="w-full" oninput="document.getElementById('sig-val-${i}').textContent=this.value+'s'">
    </div>`).join('');
}

/* ---------------- Init ---------------- */
initCharts();
renderAdminUsers();
renderAdminCameras();
renderAdminSignals();
renderAll();
setInterval(tick, 1400);
