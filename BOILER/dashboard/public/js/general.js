const HOURLY_CACHE = '_general_hourly_tbody';
const DAILY_CACHE  = '_general_daily_tbody';

// Restore cached tbodys instantly — prevents height jump on page load
try { const c = localStorage.getItem(HOURLY_CACHE); if (c) document.getElementById('hourly-body').innerHTML = c; } catch(e) {}
try { const c = localStorage.getItem(DAILY_CACHE);  if (c) document.getElementById('daily-body').innerHTML  = c; } catch(e) {}

function setHTML(el, html) {
  el.innerHTML = html;
}

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
function solarLabel(s, isForecast, nextSunrise) {
  const quality = s >= 8 ? 'Excellent' : s >= 6 ? 'Good' : s >= 4 ? 'Fair' : 'Poor';
  if (isForecast) {
    const at = nextSunrise ? ` at ${nextSunrise}` : '';
    return `Tomorrow${at} — ${quality} (forecast)`;
  }
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
    document.getElementById('score-solar-label').textContent = solarLabel(solar, s.is_forecast, s.next_sunrise);
    document.getElementById('score-rain').textContent = rain;
    document.getElementById('score-rain').style.color = rainColor(rain);
    document.getElementById('score-rain-label').textContent = rainLabel(rain);
    const sunLabel = document.getElementById('sun-time-label');
    const sunValue = document.getElementById('sun-time-value');
    const sunSub   = document.getElementById('sun-time-sub');
    const sunDesc  = document.getElementById('sun-time-desc');
    if (sunLabel && sunValue) {
      const isoKey  = s.is_forecast ? s.next_rising_iso : s.next_setting_iso;
      const timeStr = s.is_forecast ? s.next_sunrise : s.next_sunset;
      const color   = '#b84f00';
      sunLabel.textContent   = s.is_forecast ? 'Sunrise At :' : 'Sunset At :';
      sunValue.textContent   = timeStr || '—';
      sunValue.style.color   = color;
      // "in Xh Xm" or "today" / "tomorrow"
      if (isoKey) {
        const diffMs  = new Date(isoKey) - Date.now();
        const diffMin = Math.round(diffMs / 60000);
        if (diffMin > 0) {
          const h = Math.floor(diffMin / 60);
          const m = diffMin % 60;
          sunSub.textContent = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
        } else {
          sunSub.textContent = '';
        }
      } else {
        sunSub.textContent = '';
      }
      sunDesc.textContent  = s.is_forecast ? 'tomorrow' : 'today';
      sunDesc.style.color  = color;
    }
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
    if (!rows.length) {
      setHTML(tbody, '');
      empty.style.display = '';
      try { localStorage.removeItem(HOURLY_CACHE); } catch(e) {}
      return;
    }
    empty.style.display = 'none';
    const html = rows.map(r => `
      <tr>
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
      </tr>
    `).join('');
    setHTML(tbody, html);
    try { localStorage.setItem(HOURLY_CACHE, html); } catch(e) {}
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
    if (!rows.length) {
      setHTML(tbody, '');
      empty.style.display = '';
      try { localStorage.removeItem(DAILY_CACHE); } catch(e) {}
      return;
    }
    empty.style.display = 'none';
    const html = rows.map(r => `
      <tr>
        <td>${fmtTs(r.ts)}</td>
        <td>${fmtDate(r.forecast_date)}</td>
        <td>${fmt(r.condition)}</td>
        <td>${fmt(r.temp_high, '°C')}</td>
        <td>${fmt(r.temp_low, '°C')}</td>
        <td>${fmt(r.precipitation_mm, 'mm')}</td>
      </tr>
    `).join('');
    setHTML(tbody, html);
    try { localStorage.setItem(DAILY_CACHE, html); } catch(e) {}
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
