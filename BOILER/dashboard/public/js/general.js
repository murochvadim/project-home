function fmt(v, unit) {
  if (v === undefined || v === null) return '—';
  return unit ? v + ' ' + unit : v;
}

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

function getSeason() {
  const m = new Date().getMonth() + 1; // 1-12
  if ([6,7,8,9].includes(m))  return { name: 'Summer', icon: '☀️',  color: '#c8822a', label: 'Jun–Sep — peak solar heating' };
  if ([3,4,5].includes(m))    return { name: 'Spring', icon: '🌿',  color: '#7a9f5a', label: 'Mar–May — good solar conditions' };
  if ([10,11].includes(m))    return { name: 'Autumn', icon: '🍂',  color: '#b5763a', label: 'Oct–Nov — decreasing solar gain' };
  return                               { name: 'Winter', icon: '❄️',  color: '#5577aa', label: 'Dec–Feb — minimal solar heating' };
}

function renderSeason(iconId, labelId) {
  const s = getSeason();
  const iconEl  = document.getElementById(iconId);
  const labelEl = document.getElementById(labelId);
  if (iconEl)  { iconEl.textContent = `${s.icon} ${s.name}`; iconEl.style.color = s.color; }
  if (labelEl) { labelEl.textContent = s.label; }
}

function solarColor(s) {
  if (s >= 8) return '#7a9f5a';
  if (s >= 5) return '#b5a040';
  return '#a07050';
}
function rainColor(r) {
  if (r >= 7) return '#5577aa';
  if (r >= 4) return '#7799bb';
  return '#8a9f78';
}
function solarLabel(s) {
  if (s >= 8) return '☀️ Excellent — panels will heat well';
  if (s >= 6) return '🌤 Good — partial heating expected';
  if (s >= 4) return '⛅ Fair — limited solar gain';
  return '☁️ Poor — minimal heating today';
}
function rainLabel(r) {
  if (r >= 8) return '🌧 High — rain likely today';
  if (r >= 5) return '🌦 Moderate — possible showers';
  if (r >= 3) return '🌥 Low — unlikely but possible';
  return '☀️ Very low — dry conditions';
}

async function loadScores() {
  try {
    const s = await fetch('/api/weather/scores').then(r => r.json());
    if (s.error) return;
    const solar = s.solar_score;
    const rain  = s.rain_score;
    document.getElementById('score-solar').textContent = solar;
    document.getElementById('score-solar').style.color = solarColor(solar);
    document.getElementById('score-solar-label').textContent = solarLabel(solar);
    document.getElementById('score-rain').textContent = rain;
    document.getElementById('score-rain').style.color = rainColor(rain);
    document.getElementById('score-rain-label').textContent = rainLabel(rain);
  } catch (e) { console.error('loadScores error:', e); }
}

async function loadCurrent() {
  try {
    const r = await fetch('/api/weather/latest').then(r => r.json());
    document.getElementById('w-condition').textContent        = fmt(r.condition);
    document.getElementById('w-temp-ims').textContent         = fmt(r.temp_ims, '°C');
    document.getElementById('w-humidity-ims').textContent     = fmt(r.humidity_ims, '%');
    document.getElementById('w-uv-ims').textContent           = fmt(r.uv_index_ims);
    document.getElementById('w-wind').textContent             = fmt(r.wind_speed, 'km/h');
    document.getElementById('w-temp-balcony').textContent     = fmt(r.temp_balcony, '°C');
    document.getElementById('w-uv-balcony').textContent       = fmt(r.uv_index_balcony);
    document.getElementById('w-illuminance').textContent      = fmt(r.illuminance_balcony, 'lx');
    document.getElementById('w-humidity-balcony').textContent = fmt(r.humidity_balcony, '%');
  } catch (e) {
    console.error('loadCurrent error:', e);
  }
}

async function loadHourly() {
  const limit = document.getElementById('hourly-limit').value;
  try {
    const rows = await fetch(`/api/weather/hourly?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('hourly-body');
    const empty = document.getElementById('hourly-empty');
    tbody.innerHTML = '';
    if (!rows.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtTs(r.ts)}</td>
        <td>${fmt(r.condition)}</td>
        <td>${fmt(r.temp_ims, '°C')}</td>
        <td>${fmt(r.humidity_ims, '%')}</td>
        <td>${fmt(r.uv_index_ims)}</td>
        <td>${fmt(r.wind_speed, 'km/h')}</td>
        <td>${fmt(r.temp_balcony, '°C')}</td>
        <td>${fmt(r.uv_index_balcony)}</td>
        <td>${fmt(r.illuminance_balcony, 'lx')}</td>
        <td>${fmt(r.humidity_balcony, '%')}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('loadHourly error:', e);
  }
}

async function loadDaily() {
  const limit = document.getElementById('daily-limit').value;
  try {
    const rows = await fetch(`/api/weather/daily?limit=${limit}`).then(r => r.json());
    const tbody = document.getElementById('daily-body');
    const empty = document.getElementById('daily-empty');
    tbody.innerHTML = '';
    if (!rows.length) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtTs(r.ts)}</td>
        <td>${fmtDate(r.forecast_date)}</td>
        <td>${fmt(r.condition)}</td>
        <td>${fmt(r.temp_high, '°C')}</td>
        <td>${fmt(r.temp_low, '°C')}</td>
        <td>${fmt(r.precipitation_mm, 'mm')}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('loadDaily error:', e);
  }
}

async function refreshAll() {
  renderSeason('season-badge-w', 'season-label-w');
  await Promise.all([loadScores(), loadCurrent(), loadHourly(), loadDaily()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

refreshAll();
