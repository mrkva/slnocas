'use strict';

/* Slnočas: sunrise 0, solar noon +1, sunset 0, solar midnight −1.
   The day half of the wave is stretched over the real daylight, the night half over the night. */

/* ---------- Sun ---------- */

const DEG = Math.PI / 180;
const HOUR = 36e5;
const DAY = 864e5;
const HORIZON = -0.833 * DEG; // upper limb of the Sun on the horizon, with refraction

// Declination and equation of time (minutes) at a moment, low-precision NOAA formulas.
function solarPosition(ms) {
  const n = ms / DAY + 2440587.5 - 2451545;
  const meanLon = (280.460 + 0.9856474 * n) % 360;
  const anomaly = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const eclLon = (meanLon + 1.915 * Math.sin(anomaly) + 0.020 * Math.sin(2 * anomaly)) * DEG;
  const obliquity = (23.439 - 4e-7 * n) * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclLon));
  const ra = (Math.atan2(Math.cos(obliquity) * Math.sin(eclLon), Math.cos(eclLon)) / DEG + 360) % 360;
  const eqTime = ((((meanLon - ra + 180) % 360) + 360) % 360 - 180) * 4;
  return { declination, eqTime };
}

// Solar noon, sunrise and sunset for the calendar day of `date` at a place.
function sunDay(date, { lat, lon }) {
  const utcMidnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let noon = utcMidnight + (12 - lon / 15) * HOUR;
  let sun;
  for (let i = 0; i < 2; i++) {
    sun = solarPosition(noon);
    noon = utcMidnight + (12 - lon / 15 - sun.eqTime / 60) * HOUR;
  }
  const phi = lat * DEG;
  const cosH = (Math.sin(HORIZON) - Math.sin(phi) * Math.sin(sun.declination))
             / (Math.cos(phi) * Math.cos(sun.declination));
  const halfDay = Math.acos(clamp(cosH, -0.9986, 0.9986)) / DEG / 15; // hours; clamp keeps polar days finite
  return {
    noon,
    halfDay,
    rise: noon - halfDay * HOUR,
    set: noon + halfDay * HOUR,
    midnight: noon + 12 * HOUR,
    daylight: 2 * halfDay,
  };
}

// Slnočas value at moment t for a given sun day.
function slnocas(t, day) {
  const fromNoon = wrap((t - day.noon) / HOUR, 24); // hours, −12…+12
  const distance = Math.abs(fromNoon);
  const isDay = distance <= day.halfDay;
  const value = isDay
    ? Math.cos(Math.PI * fromNoon / (2 * day.halfDay))
    : -Math.sin(Math.PI * (distance - day.halfDay) / (24 - 2 * day.halfDay));
  return { value, isDay, rising: fromNoon < 0, fromNoon };
}

// Which of the 12 equal parts of the current half, counted from its start (1-based, fractional).
function partOfHalf(t, day, s) {
  if (s.isDay) return (s.fromNoon + day.halfDay) / (2 * day.halfDay) * 12;
  const sinceSunset = wrap((t - day.set) / HOUR, 24, 0);
  return sinceSunset / (24 - 2 * day.halfDay) * 12;
}

function nextEvent(t, day, s) {
  const candidates = s.isDay
    ? (s.rising ? [['+1 at solar noon', day.noon]] : [['0 at sunset', day.set]])
    : (s.rising ? [['0 at sunrise', day.rise], ['0 at sunrise', day.rise + DAY]]
                : [['−1 at solar midnight', day.midnight - DAY], ['−1 at solar midnight', day.midnight]]);
  return candidates.find(([, ms]) => ms > t) || candidates[candidates.length - 1];
}

/* ---------- Helpers ---------- */

const $ = id => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const wrap = (x, period, from = -period / 2) => ((((x - from) % period) + period) % period) + from;
const pad = n => String(n).padStart(2, '0');

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIsoDate = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(+m[1], m[2] - 1, +m[3]) : null;
};

const fmtClock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtHours = h => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${pad(m % 60)}m`; };
// Truncate rather than round, so ±1 only appears at the exact peak.
const fmtValue = (v, digits = 3) => {
  const f = 10 ** digits;
  return (v < 0 ? '−' : '+') + (Math.floor(Math.abs(v) * f + 1e-9) / f).toFixed(digits);
};
const fmtCoords = ({ lat, lon }) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

async function getJSON(url, timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const storage = {
  key: 'slnocas.place',
  load() { try { return JSON.parse(localStorage.getItem(this.key)); } catch { return null; } },
  save(place) { try { localStorage.setItem(this.key, JSON.stringify(place)); } catch { /* private mode */ } },
};

/* ---------- State ---------- */

const state = {
  place: null,        // { lat, lon, name }
  placeChosen: false, // the visitor picked a place, so the IP guess must not override it
  mode: 'now',        // 'now' | 'convert'
  followToday: true,  // in 'now' mode, the date rolls over with the clock
};

// The moment the page is showing.
function selection() {
  const now = new Date();
  if (state.mode === 'now' && state.followToday) return { date: now, t: now.getTime() };
  const date = parseIsoDate($('dateInput').value) || now;
  if (state.mode === 'now') {
    const t = new Date(date.getFullYear(), date.getMonth(), date.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
    return { date, t: t.getTime() };
  }
  const [h, m] = ($('timeInput').value || '12:00').split(':').map(Number);
  return { date, t: new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m).getTime() };
}

/* ---------- Canvas ---------- */

const ink = () => {
  const cs = getComputedStyle(document.documentElement);
  return { fg: cs.getPropertyValue('--fg').trim(), bg: cs.getPropertyValue('--bg').trim(), font: cs.getPropertyValue('--font').trim() };
};

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function hatchPattern(ctx, color) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 6;
  const t = tile.getContext('2d');
  t.strokeStyle = color;
  t.beginPath(); t.moveTo(0, 6); t.lineTo(6, 0); t.stroke();
  return ctx.createPattern(tile, 'repeat');
}

function tracePath(ctx, points) {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
}

function drawWave(date, day, t) {
  const { ctx, width, height } = setupCanvas($('wave'));
  const { fg, bg, font } = ink();
  const box = { left: 26, right: 2, top: 22, bottom: 22 };
  const w = width - box.left - box.right, h = height - box.top - box.bottom;
  const dayStart = startOfDay(date).getTime();
  const X = ms => box.left + (ms - dayStart) / DAY * w;
  const Y = v => box.top + (1 - v) / 2 * h;

  ctx.font = `11px ${font}`;
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineWidth = 1;
  ctx.strokeRect(box.left + .5, box.top + .5, w - 1, h - 1);
  ctx.beginPath(); ctx.moveTo(box.left, Y(0) + .5); ctx.lineTo(box.left + w, Y(0) + .5); ctx.stroke();

  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  [[1, '+1'], [0, '0'], [-1, '−1']].forEach(([v, label]) => ctx.fillText(label, box.left - 5, Y(v)));

  ctx.textBaseline = 'top';
  const step = width < 480 ? 6 : 3;
  for (let hr = 0; hr <= 24; hr += step) {
    const x = box.left + hr / 24 * w;
    ctx.textAlign = hr === 0 ? 'left' : hr === 24 ? 'right' : 'center';
    ctx.fillText(pad(hr), x, box.top + h + 6);
  }

  const samples = 360;
  const curve = Array.from({ length: samples + 1 }, (_, i) => {
    const ms = dayStart + i / samples * DAY;
    return [X(ms), slnocas(ms, day).value];
  });

  // day half solid, night half hatched
  for (const [sign, fill] of [[1, fg], [-1, hatchPattern(ctx, fg)]]) {
    tracePath(ctx, [[curve[0][0], Y(0)], ...curve.map(([x, v]) => [x, Y(sign > 0 ? Math.max(v, 0) : Math.min(v, 0))]), [curve[samples][0], Y(0)]]);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  tracePath(ctx, curve.map(([x, v]) => [x, Y(v)]));
  ctx.lineWidth = 1.5; ctx.stroke();

  // reference: an ordinary day with 12 equal hours, dashed in both inks so it reads over fill and ground
  const reference = Array.from({ length: samples + 1 }, (_, i) => {
    const ms = dayStart + i / samples * DAY;
    return [X(ms), Y(Math.cos(Math.PI * (ms - day.noon) / HOUR / 12))];
  });
  ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.strokeStyle = bg; tracePath(ctx, reference); ctx.lineDashOffset = 0; ctx.stroke();
  ctx.strokeStyle = fg; tracePath(ctx, reference); ctx.lineDashOffset = 3; ctx.stroke();
  ctx.setLineDash([]); ctx.lineDashOffset = 0;

  ctx.fillStyle = fg; ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';  ctx.fillText('↑' + fmtClock(day.rise), X(day.rise) - 4, Y(0) - 4);
  ctx.textAlign = 'center'; ctx.fillText(fmtClock(day.noon), X(day.noon), box.top - 5);
  ctx.textAlign = 'left';   ctx.fillText(fmtClock(day.set) + '↓', X(day.set) + 4, Y(0) - 4);

  // current moment
  const x = X(t), y = Y(slnocas(t, day).value);
  ctx.fillStyle = bg; ctx.fillRect(x - 1, box.top, 3, h);
  ctx.fillStyle = fg; ctx.fillRect(x, box.top, 1, h);
  ctx.fillStyle = bg; ctx.fillRect(x - 5, y - 5, 10, 10);
  ctx.lineWidth = 1.5; ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
}

// Minutes in one daylight "hour" (1/12 of the daylight) for each day of the year.
const yearCache = { key: '', minutes: [] };
function daylightHoursOfYear(year, place) {
  const key = `${year}|${place.lat}|${place.lon}`;
  if (yearCache.key !== key) {
    const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY;
    yearCache.minutes = Array.from({ length: days }, (_, i) => sunDay(new Date(year, 0, 1 + i), place).daylight * 5);
    yearCache.key = key;
  }
  return yearCache.minutes;
}

const YEAR_PAD = { left: 26, right: 2, top: 6, bottom: 22 };
function drawYear(date) {
  const { ctx, width, height } = setupCanvas($('year'));
  const { fg, font } = ink();
  const p = YEAR_PAD, w = width - p.left - p.right, h = height - p.top - p.bottom;
  const year = date.getFullYear();
  const minutes = daylightHoursOfYear(year, state.place);
  const X = i => p.left + i / (minutes.length - 1) * w;
  const Y = m => p.top + (1 - (clamp(m, 20, 100) - 20) / 80) * h;

  ctx.font = `11px ${font}`;
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineWidth = 1;
  ctx.strokeRect(p.left + .5, p.top + .5, w - 1, h - 1);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('60', p.left - 5, Y(60));
  ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(p.left, Y(60) + .5); ctx.lineTo(p.left + w, Y(60) + .5); ctx.stroke(); ctx.setLineDash([]);

  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  'JFMAMJJASOND'.split('').forEach((letter, m) => {
    ctx.fillText(letter, X((new Date(year, m, 15) - new Date(year, 0, 1)) / DAY), p.top + h + 6);
  });

  ctx.lineWidth = 1.5;
  tracePath(ctx, minutes.map((m, i) => [X(i), Y(m)])); ctx.stroke();
  ctx.setLineDash([4, 3]);
  tracePath(ctx, minutes.map((m, i) => [X(i), Y(120 - m)])); ctx.stroke();
  ctx.setLineDash([]);

  const i = clamp(Math.round((startOfDay(date) - new Date(year, 0, 1)) / DAY), 0, minutes.length - 1);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(i) + .5, p.top); ctx.lineTo(X(i) + .5, p.top + h); ctx.stroke();
  [minutes[i], 120 - minutes[i]].forEach(m => ctx.fillRect(X(i) - 3, Y(m) - 3, 7, 7));
}

/* ---------- Render ---------- */

// Cheap update for the ticking parts. Returns true when the page flipped between day and night.
function renderReading() {
  const { date, t } = selection();
  const day = sunDay(date, state.place);
  const s = slnocas(t, day);

  const sun = s.value >= 0 ? 'day' : 'night';
  const flipped = document.documentElement.dataset.sun !== sun;
  if (flipped) {
    document.documentElement.dataset.sun = sun;
    document.querySelector('meta[name="theme-color"]').content = sun === 'day' ? '#ffffff' : '#000000';
  }

  const dateText = date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const timeText = new Date(t).toLocaleTimeString([], state.mode === 'now'
    ? { hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false });
  $('clock').textContent = `${dateText} · ${timeText}`;
  $('value').innerHTML = `<span class="arrow">${s.rising ? '↑' : '↓'}</span>${fmtValue(s.value)}`;
  $('phase').textContent = s.isDay
    ? (s.rising ? 'Day, rising toward noon' : 'Day, falling toward sunset')
    : (s.rising ? 'Night, rising toward sunrise' : 'Night, falling toward midnight');

  const [label, at] = nextEvent(t, day, s);
  $('nextEvent').textContent = `${label} ${fmtClock(at)}, in ${fmtHours(Math.max(0, at - t) / HOUR)}`;
  return flipped;
}

function renderDayTable(date, day) {
  const sameDay = startOfDay(new Date(day.midnight)).getTime() === startOfDay(date).getTime();
  const rows = [
    ['Sunrise · 0', fmtClock(day.rise)],
    ['Solar noon · +1', fmtClock(day.noon)],
    ['Sunset · 0', fmtClock(day.set)],
    ['Solar midnight · −1', fmtClock(day.midnight) + (sameDay ? '' : ' (next day)')],
    ['Daylight', fmtHours(day.daylight)],
    ['Night', fmtHours(24 - day.daylight)],
    ['Daylight hour', `${(day.daylight * 5).toFixed(1)} min`],
    ['Night hour', `${((24 - day.daylight) * 5).toFixed(1)} min`],
  ];
  const perRow = window.innerWidth >= 640 ? 2 : 1;
  let html = '';
  for (let i = 0; i < rows.length; i += perRow) {
    html += '<tr>' + rows.slice(i, i + perRow).map(([k, v]) => `<th>${k}</th><td>${v}</td>`).join('') + '</tr>';
  }
  $('dayTable').innerHTML = html;
}

function renderConvertTable(t, day) {
  const s = slnocas(t, day);
  const part = partOfHalf(t, day, s);
  $('convertTable').innerHTML = `
    <tr><th>Slnočas</th><td>${s.rising ? '↑' : '↓'} ${fmtValue(s.value, 4)}</td></tr>
    <tr><th>Half</th><td>${s.isDay ? 'Day, positive' : 'Night, negative'}</td></tr>
    <tr><th>${s.isDay ? 'Day' : 'Night'} hour</th><td>${Math.min(12, Math.floor(part) + 1)} of 12, ${Math.floor(part % 1 * 100)}% through</td></tr>`;
}

function renderHourTable(date, day, highlightHour) {
  const dayStart = startOfDay(date).getTime();
  let html = '<tr><th>Hour</th><th class="num">Slnočas</th><th></th><th style="width:45%">−1 · 0 · +1</th></tr>';
  for (let hr = 0; hr < 24; hr++) {
    const s = slnocas(dayStart + hr * HOUR, day);
    const width = Math.abs(s.value) * 50;
    const bar = s.value >= 0
      ? `<i style="left:50%;width:${width}%"></i>`
      : `<i class="night" style="left:${50 - width}%;width:${width}%"></i>`;
    html += `<tr${hr === highlightHour ? ' class="current"' : ''}>
      <td>${pad(hr)}:00</td><td class="num">${fmtValue(s.value)}</td><td>${s.rising ? '↑' : '↓'}</td><td><div class="bar">${bar}</div></td></tr>`;
  }
  $('hourTable').innerHTML = html;
}

function render() {
  document.body.classList.toggle('no-place', !state.place);
  if (!state.place) return;

  const { date, t } = selection();
  const day = sunDay(date, state.place);
  const isToday = startOfDay(date).getTime() === startOfDay(new Date()).getTime();

  renderReading();
  $('waveLabel').textContent = `${isToday ? 'Today' : date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })} · dashed: equal 12-hour day`;
  renderDayTable(date, day);
  if (state.mode === 'convert') renderConvertTable(t, day);
  renderHourTable(date, day, isToday || state.mode === 'convert' ? new Date(t).getHours() : -1);
  drawWave(date, day, t);
  drawYear(date);
}

/* ---------- Place ---------- */

function setPlace(place, { chosen = false } = {}) {
  state.place = { lat: clamp(place.lat, -65, 65), lon: wrap(place.lon, 360), name: place.name || 'Custom location' };
  if (chosen) {
    state.placeChosen = true;
    storage.save(state.place);
  }
  $('placeName').textContent = state.place.name;
  $('placeCoords').textContent = fmtCoords(state.place);
  $('latInput').value = state.place.lat.toFixed(4);
  $('lonInput').value = state.place.lon.toFixed(4);
  render();
}

function showPlaceMessage(text) { $('placeMessage').textContent = text; }

function togglePlacePanel(open = $('placePanel').hidden) {
  $('placePanel').hidden = !open;
  $('placeButton').setAttribute('aria-expanded', String(open));
  if (open) $('searchInput').focus({ preventScroll: true });
}

// Approximate location from the visitor's IP address, used only until they pick a place.
async function guessPlaceFromIP() {
  const services = [
    ['https://get.geojs.io/v1/ip/geo.json', d => ({ lat: +d.latitude, lon: +d.longitude, name: d.city || d.region || d.country })],
    ['https://ipapi.co/json/', d => ({ lat: +d.latitude, lon: +d.longitude, name: d.city || d.region || d.country_name })],
  ];
  for (const [url, read] of services) {
    try {
      const guess = read(await getJSON(url, 4000));
      if (!Number.isFinite(guess.lat) || !Number.isFinite(guess.lon)) continue;
      if (!state.placeChosen) setPlace({ ...guess, name: `${guess.name || 'Your area'} (approx.)` });
      return;
    } catch { /* try the next service */ }
  }
  if (!state.place) {
    $('placeName').textContent = 'Choose a place';
    showPlaceMessage('Your location could not be guessed. Search for a place or type its coordinates.');
    togglePlacePanel(true);
  }
}

async function searchPlaces(query) {
  const table = $('searchResults');
  table.hidden = true;
  showPlaceMessage('Searching…');
  try {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=' + encodeURIComponent(query);
    const results = (await getJSON(url)).results || [];
    if (!results.length) {
      showPlaceMessage(`No place called “${query}” found. Try another spelling, or type the coordinates.`);
      return;
    }
    showPlaceMessage('');
    table.innerHTML = results.map((r, i) => `
      <tr><td><button type="button" data-index="${i}">${[r.name, r.admin1, r.country].filter(Boolean).join(', ')}</button></td>
      <td class="num">${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}</td></tr>`).join('');
    table.hidden = false;
    table.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      const r = results[+btn.dataset.index];
      setPlace({ lat: r.latitude, lon: r.longitude, name: r.name }, { chosen: true });
      table.hidden = true;
      $('searchInput').value = '';
      togglePlacePanel(false);
    }));
  } catch {
    showPlaceMessage('Search is not available right now. Type the coordinates instead.');
  }
}

function usePreciseLocation() {
  if (!navigator.geolocation) {
    showPlaceMessage('Location is not available here. Type the coordinates instead.');
    return;
  }
  showPlaceMessage('Finding you…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      showPlaceMessage('');
      setPlace({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'My location' }, { chosen: true });
      togglePlacePanel(false);
    },
    () => showPlaceMessage('Location was not shared. Type the coordinates instead.'),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 6e5 },
  );
}

/* ---------- Date and mode ---------- */

function setMode(mode) {
  state.mode = mode;
  $('tabNow').setAttribute('aria-selected', String(mode === 'now'));
  $('tabConvert').setAttribute('aria-selected', String(mode === 'convert'));
  $('timeField').hidden = mode !== 'convert';
  $('convertBox').hidden = mode !== 'convert';
  $('resetTime').textContent = mode === 'now' ? 'Today' : 'Now';
  if (mode === 'convert' && state.followToday) setTimeInputToNow();
  render();
}

function setTimeInputToNow() {
  const now = new Date();
  $('timeInput').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function setDate(date) {
  $('dateInput').value = isoDate(date);
  state.followToday = state.mode === 'now' && isoDate(date) === isoDate(new Date());
  render();
}

function shiftDay(days) {
  const date = parseIsoDate($('dateInput').value) || new Date();
  date.setDate(date.getDate() + days);
  setDate(date);
}

// Tap or drag horizontally along the year chart to pick a day.
function bindYearScrub() {
  const canvas = $('year');
  let dragging = false;
  const pick = e => {
    const rect = canvas.getBoundingClientRect();
    const year = (parseIsoDate($('dateInput').value) || new Date()).getFullYear();
    const lastIndex = (new Date(year, 11, 31) - new Date(year, 0, 1)) / DAY;
    const fraction = (e.clientX - rect.left - YEAR_PAD.left) / (rect.width - YEAR_PAD.left - YEAR_PAD.right);
    const date = new Date(year, 0, 1 + clamp(Math.round(fraction * lastIndex), 0, lastIndex));
    if (isoDate(date) !== $('dateInput').value) setDate(date);
  };
  canvas.addEventListener('pointerdown', e => { dragging = true; pick(e); });
  canvas.addEventListener('pointermove', e => { if (dragging) pick(e); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => canvas.addEventListener(type, () => { dragging = false; }));
}

/* ---------- Start ---------- */

function bindEvents() {
  $('placeButton').addEventListener('click', () => togglePlacePanel());
  $('choosePlace').addEventListener('click', () => togglePlacePanel(true));
  $('closePlace').addEventListener('click', () => togglePlacePanel(false));
  $('gpsButton').addEventListener('click', usePreciseLocation);
  $('searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const query = $('searchInput').value.trim();
    if (query) searchPlaces(query);
  });
  $('coordsForm').addEventListener('submit', e => {
    e.preventDefault();
    const lat = parseFloat($('latInput').value), lon = parseFloat($('lonInput').value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      setPlace({ lat, lon, name: 'Custom location' }, { chosen: true });
      togglePlacePanel(false);
    } else {
      showPlaceMessage('Enter both latitude and longitude as numbers, for example 40.7128 and −74.0060.');
    }
  });

  $('tabNow').addEventListener('click', () => setMode('now'));
  $('tabConvert').addEventListener('click', () => setMode('convert'));
  $('dateInput').addEventListener('change', () => setDate(parseIsoDate($('dateInput').value) || new Date()));
  $('timeInput').addEventListener('input', () => { state.followToday = false; render(); });
  $('prevDay').addEventListener('click', () => shiftDay(-1));
  $('nextDay').addEventListener('click', () => shiftDay(1));
  $('resetTime').addEventListener('click', () => { setTimeInputToNow(); setDate(new Date()); state.followToday = true; render(); });
  bindYearScrub();

  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return; // ignore mobile toolbar height changes
    lastWidth = window.innerWidth;
    render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  document.fonts?.ready.then(render);
}

// The number ticks every second; everything else redraws once a minute.
function startClock() {
  let lastMinute = new Date().getMinutes();
  setInterval(() => {
    if (!state.place || state.mode !== 'now' || document.hidden) return;
    const minute = new Date().getMinutes();
    if (minute !== lastMinute) { lastMinute = minute; render(); return; }
    if (state.followToday) $('dateInput').value = isoDate(new Date());
    if (renderReading()) render();
  }, 1000);
}

function start() {
  $('dateInput').value = isoDate(new Date());
  bindEvents();
  const saved = storage.load();
  if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) {
    state.placeChosen = true;
    setPlace(saved);
  } else {
    render();
    guessPlaceFromIP();
  }
  startClock();
}

start();
