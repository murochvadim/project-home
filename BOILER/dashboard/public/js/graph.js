let chart = null;

async function loadGraph() {
  const range      = document.getElementById('range').value;
  const resolution = document.getElementById('resolution').value;

  document.getElementById('last-refresh').textContent =
    'Refreshed: ' + new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });

  try {
    const rows = await fetch(`/api/graph?range=${range}&resolution=${resolution}`).then(r => r.json());

    const labels      = rows.map(r => new Date(r.t).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' }));
    const boilerTemps = rows.map(r => r.boiler_temp !== null ? parseFloat(r.boiler_temp) : null);
    const panelTemps  = rows.map(r => r.panel_temp  !== null ? parseFloat(r.panel_temp)  : null);
    const valveOn     = rows.map(r => r.valve_state);

    // Valve ON bands as background plugin
    const valveBands = [];
    let bandStart = null;
    for (let i = 0; i < valveOn.length; i++) {
      if (valveOn[i] && bandStart === null) bandStart = i;
      if (!valveOn[i] && bandStart !== null) {
        valveBands.push({ from: bandStart, to: i - 1 });
        bandStart = null;
      }
    }
    if (bandStart !== null) valveBands.push({ from: bandStart, to: valveOn.length - 1 });

    const valveBandPlugin = {
      id: 'valveBand',
      beforeDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea) return;
        ctx.save();
        valveBands.forEach(({ from, to }) => {
          const x1 = scales.x.getPixelForValue(from);
          const x2 = scales.x.getPixelForValue(to);
          ctx.fillStyle = 'rgba(46,204,113,0.15)';
          ctx.fillRect(x1, chartArea.top, x2 - x1 + (scales.x.getPixelForValue(1) - scales.x.getPixelForValue(0)), chartArea.height);
        });
        ctx.restore();
      }
    };

    const data = {
      labels,
      datasets: [
        {
          label: 'Boiler Temp (°C)',
          data: boilerTemps,
          borderColor: '#4a9eff',
          backgroundColor: 'transparent',
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: 'Panel Temp (°C)',
          data: panelTemps,
          borderColor: '#e67e22',
          backgroundColor: 'transparent',
          tension: 0.3,
          pointRadius: 2,
        },
      ],
    };

    if (chart) {
      chart.destroy();
    }

    chart = new Chart(document.getElementById('tempChart'), {
      type: 'line',
      data,
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            ticks: { maxTicksLimit: 12, font: { size: 11 } },
          },
          y: {
            title: { display: true, text: 'Temperature (°C)', font: { size: 11 } },
            ticks: { font: { size: 11 } },
          },
        },
        plugins: {
          legend: { labels: { font: { size: 12 } } },
          tooltip: {
            callbacks: {
              afterBody(items) {
                const idx = items[0]?.dataIndex;
                if (idx !== undefined) {
                  return 'Valve: ' + (valveOn[idx] ? 'ON' : 'OFF');
                }
              }
            }
          }
        },
      },
      plugins: [valveBandPlugin],
    });
  } catch (e) {
    console.error('loadGraph error:', e);
  }
}

document.getElementById('range').addEventListener('change', loadGraph);
document.getElementById('resolution').addEventListener('change', loadGraph);

loadGraph();
