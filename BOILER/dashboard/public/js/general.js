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

async function loadCurrent() {
  try {
    const [ims, balcony] = await Promise.all([
      fetch('/api/weather/current').then(r => r.json()),
      fetch('/api/weather/balcony').then(r => r.json()),
    ]);
    document.getElementById('w-condition').textContent      = fmt(ims.condition);
    document.getElementById('w-temp-ims').textContent       = fmt(ims.temp_ims, '°C');
    document.getElementById('w-humidity-ims').textContent   = fmt(ims.humidity_ims, '%');
    document.getElementById('w-uv-ims').textContent         = fmt(ims.uv_index_ims);
    document.getElementById('w-wind').textContent           = fmt(ims.wind_speed, 'km/h');
    document.getElementById('w-temp-balcony').textContent   = fmt(balcony.temp_balcony, '°C');
    document.getElementById('w-uv-balcony').textContent     = fmt(balcony.uv_index_balcony);
    document.getElementById('w-illuminance').textContent    = fmt(balcony.illuminance_balcony, 'lx');
    document.getElementById('w-humidity-balcony').textContent = fmt(balcony.humidity_balcony, '%');
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
        <td>${fmt(r.precipitation_prob, '%')}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('loadDaily error:', e);
  }
}

async function refreshAll() {
  await Promise.all([loadCurrent(), loadHourly(), loadDaily()]);
  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
}

refreshAll();
