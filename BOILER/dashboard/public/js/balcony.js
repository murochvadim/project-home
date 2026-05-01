// Balcony Agent — page logic
(function () {
  function showTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
  }
  window.showTab = showTab;

  function refreshPage() {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
  }
  window.refreshPage = refreshPage;

  // ─── HASP Balcony status card ──────────────────────────────────────────────
  // Browser subscribes to mosquitto over WebSocket (port 9001) as `dashboard_browser`.
  // Mirrors the Awtrix tab pattern (see living-room.js Awtrix section).
  // Required ACL on LXC 107 (one-time):
  //   read hasp/balcony/state/#
  //   read hasp/balcony/LWT
  const HP_BROKER_HOST = '192.168.1.189';
  const HP_BROKER_PORT = 9001;
  const HP_USER        = 'dashboard_browser';
  const HP_PLATE       = 'balcony';

  let _hpInited = false;
  let _hpMqtt   = null;

  function hpSetOnline(connected, label) {
    const dot  = document.getElementById('hp-online-dot');
    const text = document.getElementById('hp-online-text');
    if (dot)  dot.style.color = connected ? '#3a7d44' : '#c0392b';
    if (text) text.textContent = label || (connected ? 'connected' : 'offline');
  }

  function hpFmtUptime(sec) {
    if (sec == null || isNaN(sec)) return '—';
    sec = Math.floor(Number(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d} d ${h} h`;
    if (h > 0) return `${h} h ${m} m`;
    return `${m} m`;
  }

  function hpUpdateStatus(s) {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('hp-uptime', hpFmtUptime(s.uptime));
    set('hp-rssi',   s.rssi ?? '—');
    const page = s.page ?? null;
    const num  = s.numPages ?? null;
    set('hp-page', page != null ? (num != null ? `${page} / ${num}` : `${page}`) : '—');
  }

  async function hpInit() {
    if (_hpInited) return;
    _hpInited = true;
    if (typeof mqtt === 'undefined') { hpSetOnline(false, 'mqtt.js missing'); return; }

    let pass;
    try {
      const r = await fetch('/api/dashboard-settings/_mqtt_browser_pass').then(r => r.json());
      pass = r.value;
    } catch (e) { hpSetOnline(false, 'broker pass fetch failed'); return; }
    if (!pass) { hpSetOnline(false, 'MQTT_BROWSER_PASS not set'); return; }

    _hpMqtt = mqtt.connect(`ws://${HP_BROKER_HOST}:${HP_BROKER_PORT}`, {
      username: HP_USER, password: pass,
      clientId: 'hasp-balcony-tab-' + Math.random().toString(36).slice(2, 10),
      reconnectPeriod: 5000, connectTimeout: 8000,
    });
    _hpMqtt.on('connect', () => {
      hpSetOnline(false, 'broker connected, awaiting panel…');
      _hpMqtt.subscribe(`hasp/${HP_PLATE}/state/statusupdate`, { qos: 0 });
      _hpMqtt.subscribe(`hasp/${HP_PLATE}/LWT`, { qos: 0 });
    });
    _hpMqtt.on('reconnect', () => hpSetOnline(false, 'reconnecting…'));
    _hpMqtt.on('close',     () => hpSetOnline(false));
    _hpMqtt.on('error',     (e) => { console.error('HASP MQTT error:', e); hpSetOnline(false, 'broker error'); });
    _hpMqtt.on('message', (topic, payload) => {
      if (topic === `hasp/${HP_PLATE}/LWT`) {
        hpSetOnline(payload.toString() === 'online');
      } else if (topic === `hasp/${HP_PLATE}/state/statusupdate`) {
        try { hpUpdateStatus(JSON.parse(payload.toString())); } catch (_) {}
      }
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    refreshPage();
    hpInit();
  });
})();
