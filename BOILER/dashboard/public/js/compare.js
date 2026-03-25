async function loadVersions() {
  try {
    const versions = await fetch('/api/versions').then(r => r.json());
    const selA = document.getElementById('version-a');
    const selB = document.getElementById('version-b');

    selA.innerHTML = '';
    selB.innerHTML = '';

    versions.forEach((v, i) => {
      const label = v.version.slice(0, 7) + ' (' +
        new Date(v.first_seen).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' }) + ')';
      const optA = new Option(label, v.version);
      const optB = new Option(label, v.version);
      selA.appendChild(optA);
      selB.appendChild(optB);
    });

    // Default: A = first (latest), B = second
    if (versions.length >= 2) selB.selectedIndex = 1;
  } catch (e) {
    console.error('loadVersions error:', e);
  }
}

async function loadCompare() {
  const vA = document.getElementById('version-a').value;
  const vB = document.getElementById('version-b').value;
  const errEl = document.getElementById('compare-error');
  const resultEl = document.getElementById('compare-result');

  errEl.textContent = '';
  resultEl.style.display = 'none';

  if (!vA || !vB) {
    errEl.textContent = 'Please select both versions.';
    return;
  }
  if (vA === vB) {
    errEl.textContent = 'Please select two different versions.';
    return;
  }

  try {
    const data = await fetch(`/api/compare?versionA=${encodeURIComponent(vA)}&versionB=${encodeURIComponent(vB)}`).then(r => r.json());
    const { a, b } = data;

    document.getElementById('head-a').textContent = vA.slice(0, 7);
    document.getElementById('head-b').textContent = vB.slice(0, 7);

    const fmt = v => (v !== null && v !== undefined) ? v : '—';

    const rows = [
      ['Avg Boiler Temp (°C)',  fmt(a.avg_boiler_temp),  fmt(b.avg_boiler_temp)],
      ['Max Boiler Temp (°C)',  fmt(a.max_boiler_temp),  fmt(b.max_boiler_temp)],
      ['Valve ON count',        fmt(a.valve_on_count),   fmt(b.valve_on_count)],
      ['Valve OFF count',       fmt(a.valve_off_count),  fmt(b.valve_off_count)],
      ['% Time ON (keep+hold)', fmt(a.pct_time_on) + '%', fmt(b.pct_time_on) + '%'],
    ];

    document.getElementById('compare-body').innerHTML = rows.map(([label, va, vb]) => `
      <tr>
        <td>${label}</td>
        <td>${va}</td>
        <td>${vb}</td>
      </tr>
    `).join('');

    resultEl.style.display = 'block';
  } catch (e) {
    errEl.textContent = 'Error: ' + e.message;
    console.error('loadCompare error:', e);
  }
}

loadVersions();
