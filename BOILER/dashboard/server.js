const express = require('express');
const { Pool } = require('pg');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const { exec } = require('child_process');
const net = require('net');
const https = require('https');
const http  = require('http');
const _anthropic = require('@anthropic-ai/sdk');
const Anthropic = _anthropic.default || _anthropic;
const multer = require('multer');
const fs = require('fs');


const os = require('os');
const mqtt = require('mqtt');
const voiceUploadDir = path.join(os.tmpdir(), 'voice-uploads');
if (!fs.existsSync(voiceUploadDir)) fs.mkdirSync(voiceUploadDir, { recursive: true });
// 25 MB cap — typical Whisper audio clip is ≤ 1-2 MB; cap prevents any LAN
// device from filling C:\ tmpdir with an unbounded blob (DoS).
const upload = multer({ dest: voiceUploadDir, limits: { fileSize: 25 * 1024 * 1024 } });

// Power bill PDF upload — hoisted here so the /api/power/bills/upload
// route (defined ~line 1336, well before the ESP OTA's multer at line 3800)
// can resolve the const at module-load time. 8 MB cap is plenty for an
// IEC bill PDF (typically 100-200 KB).
const billPdfUpload = multer({ dest: path.join(os.tmpdir(), 'power-bills'), limits: { fileSize: 8 * 1024 * 1024 } });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders: (res, filePath) => {
    // HTML files carry inline <script> blocks that change with every code
    // edit. `no-cache` (alone) lets the browser serve from disk on
    // back/forward nav or restored tabs without revalidating, so users
    // sometimes run stale inline JS for hours. `no-store` forces a fresh
    // fetch every time. Static assets (js/css/images) still get the
    // weaker `no-cache` so they're fast but never poisonously stale.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));

// PostgreSQL connection to LXC 102
const db = new Pool({
  host: '192.168.1.219',
  database: 'home_data',
  user: 'postgres',
  port: 5432,
});

// MQTT client for rule engine commands (test, reload).
// Fail-loud guard — if MQTT_RULE_PASS isn't in the env, the dashboard will
// silently retry "Not authorized" forever and every button click that publishes
// MQTT will look like a success on the API but never reach the broker. We've
// been bitten by this twice. If it's missing, abort startup with a clear
// pointer to .env / ecosystem.config.js / pm2 restart so the cause is obvious
// in pm2 logs instead of buried in mqtt retry noise.
if (!process.env.MQTT_RULE_PASS) {
  console.error('FATAL: MQTT_RULE_PASS not set in environment.');
  console.error('  Fix: ensure MQTT_RULE_PASS=<pass> is in BOILER/dashboard/.env,');
  console.error('       then `pm2 delete boiler-dashboard && pm2 start ecosystem.config.js`');
  console.error('       (`pm2 restart` caches old env — always delete + start).');
  process.exit(1);
}

// MQTT client + auto-heal. Background — mqtt-js v5 has been observed to get
// stuck in an "Not authorized" reconnect loop after a keepalive timeout (the
// broker disconnects for inactivity, mqtt-js retries every 5 s but every
// retry is rejected even though credentials never changed). Python paho
// clients hitting the same broker never reproduce this. Auto-heal: after 3
// consecutive auth failures (15 s), tear the stuck client down and create a
// fresh one. Hard cap of one heal per 30 s prevents a runaway loop in the
// (unlikely) case the credentials really ARE wrong.
const MQTT_URL  = 'mqtt://192.168.1.189:1883';
const MQTT_OPTS = {
  username:        'rule_engine',
  password:        process.env.MQTT_RULE_PASS,
  clientId:        'dashboard-' + process.pid,
  reconnectPeriod: 5000,
};
let mqttClient = null;
let _mqttAuthFails  = 0;
let _mqttHealing    = false;
let _mqttLastHealAt = 0;

function _attachMqttHandlers(c) {
  c.on('error', (e) => {
    const msg = e.message || String(e);
    console.error('MQTT error:', msg);
    if (!/Not authorized/i.test(msg)) return;
    _mqttAuthFails++;
    if (_mqttAuthFails === 3) {
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('  MQTT broker rejected dashboard credentials 3 times in a row.');
      console.error('  Likely cause #1 (transient): mqtt-js stuck after keepalive timeout — auto-healing.');
      console.error('  Likely cause #2 (real bug):  MQTT_RULE_PASS no longer matches LXC 107.');
      console.error('  Check #2 by running: ssh root@192.168.1.189 mosquitto_pub -u rule_engine -P "$PASS" -t test -m x');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }
    if (_mqttAuthFails >= 3) _maybeHeal();
  });
  c.on('connect', () => {
    if (_mqttAuthFails > 0) console.log(`MQTT recovered after ${_mqttAuthFails} failed attempts`);
    _mqttAuthFails = 0;
    console.log('MQTT connected to 192.168.1.189:1883 as rule_engine');
  });
}

function _maybeHeal() {
  if (_mqttHealing) return;
  const now = Date.now();
  if (now - _mqttLastHealAt < 30000) return;   // throttle: at most one heal per 30 s
  _mqttHealing    = true;
  _mqttLastHealAt = now;
  const stale = mqttClient;
  console.error('MQTT auto-heal: ending stuck client + creating fresh one');
  try { stale.removeAllListeners('error'); stale.removeAllListeners('connect'); } catch (e) {}
  try { stale.end(true, {}, () => {}); } catch (e) {}
  // setImmediate so the close completes before we make a new connection
  setImmediate(() => {
    mqttClient = mqtt.connect(MQTT_URL, MQTT_OPTS);
    _attachMqttHandlers(mqttClient);
    _mqttHealing = false;
  });
}

mqttClient = mqtt.connect(MQTT_URL, MQTT_OPTS);
_attachMqttHandlers(mqttClient);

// HA config
const HA_URL = 'http://192.168.1.110:8123';
// HA_TOKEN is read from .env with a 5-minute TTL cache. This means a token
// update in .env takes effect within 5 min without restarting pm2.
let _haTokenCache = { value: process.env.HA_TOKEN || '', ts: Date.now() };
const HA_TOKEN_TTL = 5 * 60 * 1000; // 5 min
function getHaToken() {
  if (Date.now() - _haTokenCache.ts < HA_TOKEN_TTL) return _haTokenCache.value;
  try {
    const lines = require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n');
    for (const line of lines) {
      const [k, ...v] = line.trim().split('=');
      if (k === 'HA_TOKEN') { _haTokenCache = { value: v.join('='), ts: Date.now() }; return _haTokenCache.value; }
    }
  } catch (_) {}
  _haTokenCache.ts = Date.now(); // don't retry for 5 min on read failure
  return _haTokenCache.value;
}

const SSH_USER    = 'root';
const SSH_KEY     = process.env.SSH_KEY_PATH || require('os').homedir() + '/.ssh/id_ed25519';
const MEDIA_LXC_IP   = '192.168.1.138';
const PLAYER_API_URL = `http://${MEDIA_LXC_IP}:8766`; // player service
const INGEST_API_URL = `http://${MEDIA_LXC_IP}:8767`; // ingest service

// ─── Proxmox VE ───────────────────────────────────────────────
const PVE_HOST  = '192.168.1.101';
const PVE_PORT  = 8006;
const PVE_TOKEN = process.env.PROXMOX_TOKEN || '';

function pveGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: PVE_HOST, port: PVE_PORT, path, method: 'GET',
        headers: { Authorization: `PVEAPIToken=${PVE_TOKEN}` },
        rejectUnauthorized: false },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('PVE parse error: ' + raw.slice(0, 120))); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('PVE timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Settings ────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM agent_settings LIMIT 1');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
  const { run_interval_min, sync_poll_interval_sec,
          panel_temp_valid_after_on, panel_temp_valid_after_off,
          trend_runs, temp_debounce, probe_interval_min,
          consumption_temp_delta, consumption_time_delta,
          consumption_descent_trigger_c,
          probe_max_boiler_temp, probe_max_delta,
          glitch_drop_threshold_c, glitch_bounce_recovery_c,
          wf96c_temp_delta_c, wf96c_heartbeat_sec } = req.body;
  try {
    await db.query(`
      UPDATE agent_settings SET
        run_interval_min              = $1,
        sync_poll_interval_sec        = $2,
        panel_temp_valid_after_on     = $3,
        panel_temp_valid_after_off    = $4,
        trend_runs                    = $5,
        temp_debounce                 = $6,
        probe_interval_min            = $7,
        consumption_temp_delta        = $8,
        consumption_time_delta        = $9,
        consumption_descent_trigger_c = $10,
        probe_max_boiler_temp         = $11,
        probe_max_delta               = $12,
        glitch_drop_threshold_c       = $13,
        glitch_bounce_recovery_c      = $14,
        wf96c_temp_delta_c            = $15,
        wf96c_heartbeat_sec           = $16
    `, [run_interval_min, sync_poll_interval_sec,
        panel_temp_valid_after_on, panel_temp_valid_after_off,
        trend_runs, temp_debounce, probe_interval_min,
        consumption_temp_delta, consumption_time_delta,
        consumption_descent_trigger_c,
        probe_max_boiler_temp, probe_max_delta,
        glitch_drop_threshold_c, glitch_bounce_recovery_c,
        wf96c_temp_delta_c, wf96c_heartbeat_sec]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Agent toggle ─────────────────────────────────────────────
app.post('/api/agent/toggle', async (req, res) => {
  try {
    const r = await db.query('SELECT agent_enabled FROM agent_settings LIMIT 1');
    const current = r.rows[0].agent_enabled;
    await db.query('UPDATE agent_settings SET agent_enabled = $1', [!current]);
    res.json({ agent_enabled: !current });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Last report ──────────────────────────────────────────────
app.get('/api/last-report', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM agent_boiler_data ORDER BY ts DESC LIMIT 1');
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Raw data table ───────────────────────────────────────────
app.get('/api/raw-data', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 500);
  try {
    const r = await db.query('SELECT * FROM raw_data ORDER BY ts DESC LIMIT $1', [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Agent data table ─────────────────────────────────────────
app.get('/api/agent-data', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 500);
  try {
    const r = await db.query('SELECT * FROM agent_boiler_data ORDER BY ts DESC LIMIT $1', [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Graph data ───────────────────────────────────────────────
app.get('/api/graph', async (req, res) => {
  const range      = req.query.range || '6h';
  const resolution = req.query.resolution || '15m';
  const fromTs     = req.query.from || null;
  const toTs       = req.query.to   || null;

  const rangeMap = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours' };
  const resMap   = { '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '6h': '6 hours', '1d': '1 day' };

  const interval = rangeMap[range] || '6 hours';
  const bucket   = resMap[resolution] || '15 minutes';

  const bucketSeconds = {
    '5 minutes': 300, '15 minutes': 900, '1 hour': 3600, '6 hours': 21600, '1 day': 86400
  }[bucket] || 900;

  try {
    const r = (fromTs && toTs)
      ? await db.query(`
          SELECT
            to_timestamp(floor(extract(epoch from ts) / $1) * $1) AS t,
            AVG(boiler_temp) AS boiler_temp,
            AVG(panel_temp)  AS panel_temp,
            BOOL_OR(valve_state) AS valve_state
          FROM raw_data
          WHERE ts >= $2 AND ts < $3
          GROUP BY t
          ORDER BY t ASC
        `, [bucketSeconds, fromTs, toTs])
      : await db.query(`
          SELECT
            to_timestamp(floor(extract(epoch from ts) / $1) * $1) AS t,
            AVG(boiler_temp) AS boiler_temp,
            AVG(panel_temp)  AS panel_temp,
            BOOL_OR(valve_state) AS valve_state
          FROM raw_data
          WHERE ts >= NOW() - $2::interval
          GROUP BY t
          ORDER BY t ASC
        `, [bucketSeconds, interval]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Next probe time ──────────────────────────────────────────
app.get('/api/next-probe', async (req, res) => {
  try {
    const s = await db.query('SELECT probe_interval_min, agent_enabled, panel_temp_valid_after_on, trend_runs, run_interval_min FROM agent_settings LIMIT 1');
    const probeMin           = s.rows[0]?.probe_interval_min ?? 60;
    const agentEnabled       = s.rows[0]?.agent_enabled ?? false;
    const panelValidAfterOn  = s.rows[0]?.panel_temp_valid_after_on ?? 4;
    const trendRuns          = s.rows[0]?.trend_runs ?? 3;
    const runIntervalMin     = s.rows[0]?.run_interval_min ?? 5;
    const probeCostMin       = panelValidAfterOn + (trendRuns + 1) * runIntervalMin;

    // Compute minutes to 19:00 Jerusalem time.
    // Use Intl.DateTimeFormat to extract Jerusalem hour/minute directly — avoids
    // the re-parsing bug where new Date(localeString) uses the local machine TZ.
    const now = new Date();
    const jFmt = field => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', [field]: 'numeric', hour12: false }).format(now), 10);
    const jMinutesNow  = jFmt('hour') * 60 + jFmt('minute');
    const minutesToEnd = Math.max(0, 19 * 60 - jMinutesNow);

    // Find last ON→OFF valve transition in raw_data
    const r = await db.query(`
      SELECT ts FROM (
        SELECT ts, valve_state,
               LAG(valve_state) OVER (ORDER BY ts) AS prev_state
        FROM raw_data
        ORDER BY ts DESC
        LIMIT 500
      ) t
      WHERE valve_state = false AND prev_state = true
      ORDER BY ts DESC
      LIMIT 1
    `);

    // Find last turn_on origin (probe or normal) + its timestamp
    const o = await db.query(`
      SELECT ts, why_decision FROM agent_boiler_data
      WHERE decision = 'turn_on'
      ORDER BY ts DESC LIMIT 1
    `);
    const why = o.rows[0]?.why_decision || '';
    const lastTurnOnOrigin = why.startsWith('Probe:') ? 'probe' : why ? 'normal' : null;
    const lastTurnOnTs     = o.rows[0]?.ts || null;

    // Current valve state from raw_data
    const v = await db.query('SELECT valve_state FROM raw_data ORDER BY ts DESC LIMIT 1');
    const valveIsOn = v.rows[0]?.valve_state ?? false;

    if (!r.rows[0]) {
      const probeFeasible = minutesToEnd >= probeCostMin;
      return res.json({ next_probe: null, last_turn_on_origin: lastTurnOnOrigin,
                        last_turn_on_ts: lastTurnOnTs, valve_is_on: valveIsOn,
                        agent_enabled: agentEnabled,
                        probe_feasible: probeFeasible, probe_cost_min: probeCostMin,
                        minutes_to_end: Math.round(minutesToEnd) });
    }

    const lastClose          = new Date(r.rows[0].ts);
    const nextProbe          = new Date(lastClose.getTime() + probeMin * 60 * 1000);
    const minutesUntilFire   = Math.max(0, (nextProbe - new Date()) / 60000);
    const minutesToEndAtFire = Math.max(0, minutesToEnd - minutesUntilFire);
    const probeFeasible      = minutesToEndAtFire >= probeCostMin;
    res.json({ next_probe: nextProbe.toISOString(), last_turn_on_origin: lastTurnOnOrigin,
               last_turn_on_ts: lastTurnOnTs, valve_is_on: valveIsOn,
               agent_enabled: agentEnabled,
               probe_feasible: probeFeasible, probe_cost_min: probeCostMin,
               minutes_to_end: Math.round(minutesToEnd) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── Agents list ─────────────────────────────────────────────
app.get('/api/agents', async (req, res) => {
  try {
    const r = await db.query('SELECT name, description, lxc_ip, service_name, deploy_path, git_branch, enabled FROM agents ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Deploy ───────────────────────────────────────────────────
app.post('/api/deploy', async (req, res) => {
  const { agent: agentName } = req.body;
  if (!agentName) return res.status(400).json({ error: 'agent name required' });

  let agentRow;
  try {
    const r = await db.query('SELECT * FROM agents WHERE name = $1', [agentName]);
    if (!r.rows.length) return res.status(404).json({ error: `Agent '${agentName}' not found` });
    agentRow = r.rows[0];
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const { lxc_ip, service_name, deploy_path, git_branch } = agentRow;
  if (!lxc_ip || !deploy_path) return res.status(400).json({ error: `Agent '${agentName}' has no deploy_path or lxc_ip configured` });

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: lxc_ip, username: SSH_USER, privateKeyPath: SSH_KEY });
    const branch = git_branch || 'main';
    const pull = await ssh.execCommand(`git -C ${deploy_path} pull origin ${branch}`);
    const restartCmd = agentRow.service_oneshot ? 'start' : 'restart';
    const restart = service_name
      ? await ssh.execCommand(`systemctl ${restartCmd} ${service_name} 2>&1 || echo "service not found"`)
      : { stdout: '(no service configured)' };
    ssh.dispose();
    res.json({
      agent:   agentName,
      pull:    pull.stdout    || pull.stderr,
      restart: restart.stdout || restart.stderr,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Weather scores ───────────────────────────────────────────
app.get('/api/weather/scores', async (req, res) => {
  try {
    const conditionBase = {
      sunny:        { solar: 8, rain: 1 },
      partlycloudy: { solar: 5, rain: 2 },
      cloudy:       { solar: 2, rain: 4 },
      rainy:        { solar: 1, rain: 7 },
      pouring:      { solar: 1, rain: 9 },
      snowy:        { solar: 1, rain: 6 },
    };

    // Fetch sun state from HA to decide day vs night mode
    let isNight = false;
    let nextRising  = null;
    let nextSetting = null;
    try {
      const sunRes = await fetch(`${HA_URL}/api/states/sun.sun`, {
        headers: { Authorization: `Bearer ${getHaToken()}` },
        signal: AbortSignal.timeout(4000),
      });
      if (sunRes.ok) {
        const sun   = await sunRes.json();
        isNight     = sun.state === 'below_horizon';
        nextRising  = sun.attributes?.next_rising  || null;
        nextSetting = sun.attributes?.next_setting || null;
      }
    } catch (_) { /* fall through to daytime logic */ }

    const fmtSunTime = iso => iso
      ? new Date(iso).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })
      : null;

    if (isNight) {
      // Night mode: score based on tomorrow's forecast
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowDate = tomorrow.toISOString().slice(0, 10);
      const d = await db.query(
        "SELECT * FROM raw_weather_daily WHERE forecast_date = $1 ORDER BY ts DESC LIMIT 1",
        [tomorrowDate]
      );
      const day    = d.rows[0] || {};
      const cond   = (day.condition || '').toLowerCase();
      const base   = conditionBase[cond] || { solar: 3, rain: 3 };
      const precip = parseFloat(day.precipitation_mm) || 0;
      const rainBonus  = precip >= 5 ? 3 : precip >= 2 ? 2 : precip > 0 ? 1 : 0;
      const solar_score = Math.min(10, Math.max(1, base.solar));
      const rain_score  = Math.min(10, Math.max(1, base.rain + rainBonus));

      // Format next sunrise in Jerusalem time
      let sunriseLabel = null;
      if (nextRising) {
        sunriseLabel = new Date(nextRising).toLocaleTimeString('he-IL', {
          timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit',
        });
      }

      return res.json({
        solar_score,
        rain_score,
        condition:        day.condition || null,
        uv:               0,
        precipitation:    precip,
        forecast_date:    day.forecast_date || null,
        is_forecast:      true,
        next_sunrise:     fmtSunTime(nextRising),
        next_sunset:      fmtSunTime(nextSetting),
        next_rising_iso:  nextRising,
        next_setting_iso: nextSetting,
      });
    }

    // Daytime: live score
    const [w, d] = await Promise.all([
      db.query('SELECT * FROM raw_weather ORDER BY ts DESC LIMIT 1'),
      db.query("SELECT * FROM raw_weather_daily WHERE forecast_date = CURRENT_DATE ORDER BY ts DESC LIMIT 1"),
    ]);
    const cur  = w.rows[0] || {};
    const day  = d.rows[0] || {};

    const cond   = (cur.condition || '').toLowerCase();
    const base   = conditionBase[cond] || { solar: 3, rain: 3 };
    const uv     = Math.max(parseFloat(cur.uv_index_ims) || 0, parseFloat(cur.uv_index_balcony) || 0);
    const precip = parseFloat(day.precipitation_mm) || 0;

    const solarBonus = uv >= 6 ? 2 : uv >= 3 ? 1 : 0;
    const rainBonus  = precip >= 5 ? 3 : precip >= 2 ? 2 : precip > 0 ? 1 : 0;

    const solar_score = Math.min(10, Math.max(1, base.solar + solarBonus));
    const rain_score  = Math.min(10, Math.max(1, base.rain  + rainBonus));

    res.json({
      solar_score,
      rain_score,
      condition:        cur.condition || null,
      uv:               uv,
      precipitation:    precip,
      forecast_date:    day.forecast_date || null,
      is_forecast:      false,
      next_sunrise:     fmtSunTime(nextRising),
      next_sunset:      fmtSunTime(nextSetting),
      next_rising_iso:  nextRising,
      next_setting_iso: nextSetting,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Weather latest (most recent row from raw_weather) ────────
app.get('/api/weather/latest', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM raw_weather ORDER BY ts DESC LIMIT 1');
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Weather hourly log ───────────────────────────────────────
app.get('/api/weather/hourly', async (req, res) => {
  const limit = parseInt(req.query.limit) || 24;
  try {
    const r = await db.query('SELECT * FROM raw_weather ORDER BY ts DESC LIMIT $1', [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Weather daily forecast log ───────────────────────────────
app.get('/api/weather/daily', async (req, res) => {
  const limit = parseInt(req.query.limit) || 14;
  try {
    const r = await db.query('SELECT * FROM raw_weather_daily ORDER BY ts DESC, forecast_date ASC LIMIT $1', [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POWER (P1 — Ingest + Live Status) ────────────────────────
// Card 1 status read: devices.last_state for shelly_3em_main has the
// 15 latest DPS values (R/S/T × V/A/W/PF/kWh). Total_w + imbalance %
// computed in software since HA exposes per-phase only. See POWER/CLAUDE.md.
// Resolve the Shelly's LAN IP (from net_devices via MAC join). Returns
// null if we can't find it — caller falls back gracefully.
async function _shellyResolveIp() {
  try {
    const r = await db.query(`
      SELECT split_part(n.ip::text, '/', 1) AS ip
      FROM devices d
      LEFT JOIN net_devices n ON lower(n.mac::text) = lower(d.mac::text)
      WHERE d.id = 'shelly_3em_main'
    `);
    return r.rows[0]?.ip || null;
  } catch (e) { return null; }
}

// Fetch Shelly Gen 1 EM3's local minute-by-minute energy log for one channel
// since the given unix timestamp. Returns kWh consumed in that window, or
// null if the device is unreachable / no buffered data covers the window.
// Shelly retains ~60 days of em_data locally — enough for current-period
// backfill in nearly every scenario.
async function _fetchShellyKwhSince(shellyIp, channelIdx, sinceUnix) {
  if (!shellyIp) return null;
  try {
    const r = await fetch(
      `http://${shellyIp}/emeter/${channelIdx}/em_data.csv?ts=${sinceUnix}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) return null;
    const text = await r.text();
    let sumWh = 0;
    let hadAnyRow = false;
    for (const line of text.trim().split('\n')) {
      const cols = line.split(',');
      const ts = parseInt(cols[0], 10);
      const energyWh = parseFloat(cols[1]);
      if (Number.isFinite(ts) && Number.isFinite(energyWh) && ts >= sinceUnix) {
        sumWh += energyWh;
        hadAnyRow = true;
      }
    }
    return hadAnyRow ? sumWh / 1000 : null;  // Wh → kWh
  } catch (e) { return null; }
}

// Resolve the current billing period from the user's billing settings.
// Auto-rolls the stored current_period_start_date forward when today is
// past the end of the period; persists the new start back to
// dashboard_settings.power.billing so future requests see the rolled value.
async function _powerResolveBillingPeriod(billing) {
  // Helper — add N months to a YYYY-MM-DD date, capping the day at the
  // target month's last day (so "Mar 31 + 1 month" lands on Apr 30, not
  // an invalid May 1).
  function _addMonths(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    const yy = d.getUTCFullYear();
    const mm = d.getUTCMonth() + n;
    const dd = d.getUTCDate();
    const t = new Date(Date.UTC(yy, mm, 1));
    const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(dd, lastDay)))
      .toISOString().slice(0, 10);
  }
  const todayISO = new Date().toISOString().slice(0, 10);

  // Derive a first period_start if the user hasn't set one. Pick the most
  // recent `start_day` that's ≤ today. (User can override in Settings to
  // align with their first IEC bill date.)
  let start = billing.current_period_start_date;
  if (!start) {
    const now = new Date();
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth();
    if (now.getUTCDate() < billing.start_day) {
      m -= 1;
      if (m < 0) { m = 11; y -= 1; }
    }
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    start = new Date(Date.UTC(y, m, Math.min(billing.start_day, lastDay))).toISOString().slice(0, 10);
  }
  // Roll forward while today is past the period end. Cap at 100 hops as
  // a safety guard against pathological input. Each hop = one cycle close
  // → record the closed cycle as a `power_bills` row + reset the baseline.
  let rolled = 0;
  let priorBaseline = billing.baseline_kwh;
  let closedPeriods = [];          // [{start, end, baseline}] — used to insert bill rows after the loop
  for (let i = 0; i < 100; i++) {
    const end = _addMonths(start, billing.length_months);
    if (todayISO < end) break;
    closedPeriods.push({ start, end, baseline: priorBaseline });
    start = end;
    rolled++;
    priorBaseline = null;          // each subsequent cycle re-baselined later
  }
  const end = _addMonths(start, billing.length_months);

  const changed = (start !== billing.current_period_start_date) || rolled > 0;
  // Baseline policy:
  //   * rolled > 0  → snap current Shelly cumulative kWh (perfect accuracy
  //                   going forward — we're AT the period start).
  //   * !baseline   → leave null; the status endpoint's em_data backfill
  //                   will try to recover the actual period-start values
  //                   from Shelly's 60-day local history. If that fails,
  //                   the endpoint sets a "lazy_init" baseline as a last
  //                   resort (period_kwh will count from now onwards).
  let baseline = billing.baseline_kwh;
  if (rolled > 0) {
    try {
      const r = await db.query(
        "SELECT last_state FROM devices WHERE id = 'shelly_3em_main' LIMIT 1"
      );
      const ls = r.rows[0]?.last_state || {};
      if (typeof ls.r_kwh === 'number' && typeof ls.s_kwh === 'number' && typeof ls.t_kwh === 'number') {
        baseline = {
          r: ls.r_kwh, s: ls.s_kwh, t: ls.t_kwh,
          captured_at: new Date().toISOString(),
          source:      'auto_snap',
        };
      }
    } catch (_) { /* leave baseline as-is */ }
  }

  // Persist updated billing back to settings (start + baseline).
  if (changed || baseline !== billing.baseline_kwh) {
    await db.query(`
      INSERT INTO dashboard_settings (key, value, updated_at)
      VALUES ('power.billing', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
    `, [JSON.stringify({ ...billing, current_period_start_date: start, baseline_kwh: baseline })]);
  }

  // For each cycle that just closed, snapshot it as a power_bills row so
  // the AI / history can read it later. Computed at rollover time, never
  // mutated again unless the user manually edits the row.
  for (const cp of closedPeriods) {
    if (!cp.baseline || !baseline) continue;  // can't compute without both endpoints
    const period_kwh = (Number(baseline.r) - Number(cp.baseline.r))
                     + (Number(baseline.s) - Number(cp.baseline.s))
                     + (Number(baseline.t) - Number(cp.baseline.t));
    // Cycle is fully closed → days = length_months × 30.42, the
    // approximation IEC themselves use on the bill.
    const days = Math.max(1, billing.length_months * 30.42);
    let est_cost = null;
    try {
      const t = (await _powerLoadSettings()).tariff;
      est_cost = _powerComputeCost(t, period_kwh, days);
    } catch (_) { /* fine, leave null */ }
    try {
      await db.query(`
        INSERT INTO power_bills (period_start, period_end, total_kwh, est_cost_ils, source, parsed)
        VALUES ($1::date, $2::date, $3, $4, 'auto_rollover', $5::jsonb)
      `, [cp.start, cp.end, Math.round(period_kwh * 100) / 100, est_cost,
          JSON.stringify({ baseline_start: cp.baseline, baseline_end: baseline })]);
    } catch (_) { /* duplicate or transient — fine */ }
  }

  return { start, end, baseline, rolled };
}

// Look up the kWh-baseline at the start of the period — i.e. the
// power_consumption row taken at-or-just-after period start.
async function _powerPeriodBaseline(periodStart) {
  const r = await db.query(`
    SELECT r_kwh, s_kwh, t_kwh, ts
    FROM power_consumption
    WHERE ts >= $1::timestamptz
    ORDER BY ts ASC LIMIT 1
  `, [periodStart]);
  return r.rows[0] || { r_kwh: null, s_kwh: null, t_kwh: null, ts: null };
}

// Period cost — mirrors the IEC bill's line items:
//   1. Energy:        period_kwh × rate          (₪/kWh × kWh)
//   2. KVA capacity:  kva × kva_rate × days/365  (yearly capacity charge prorated by elapsed days)
//   3. Fixed fee:     monthly_fee × days/30.42   (avg-month daily rate, matches IEC math)
//   4. Direct debit:  direct_debit_credit_ils    (per-bill credit, usually negative)
//   5. VAT:           (1 + 2 + 3 + 4) × VAT%     (applied to the post-credit subtotal)
// TAOZ uses a crude (peak + shoulder + off-peak) / 3 average until hourly
// integration lands in a follow-up iteration.
function _powerComputeCost(tariff, periodKwh, daysElapsed) {
  if (periodKwh == null) return null;
  const rate = (tariff.type === 'taoz')
    ? ((tariff.taoz_peak_rate + tariff.taoz_shoulder_rate + tariff.taoz_off_peak_rate) / 3)
    : tariff.flat_rate_ils_per_kwh;
  const days = Math.max(0, daysElapsed);

  const energyCost = periodKwh * rate;
  const kvaCost    = (Number(tariff.kva_rate_ils_per_year) || 0) *
                     (Number(tariff.connection_kva) || 0) * days / 365;
  const feeCost    = (Number(tariff.fixed_monthly_fee_ils) || 0) * days / 30.42;   // 365 / 12 ≈ avg-month
  const credit     = Number(tariff.direct_debit_credit_ils) || 0;                   // per-bill, applied in full

  const pretax     = energyCost + kvaCost + feeCost + credit;
  return Math.round((pretax * (1 + (tariff.vat_pct || 0) / 100)) * 100) / 100;
}

app.get('/api/power/status', async (req, res) => {
  try {
    const r = await db.query(
      "SELECT last_seen, last_state, NOW() - last_seen AS age FROM devices WHERE id = 'shelly_3em_main'"
    );
    if (!r.rows.length) return res.status(404).json({ error: 'shelly_3em_main not found' });
    // Baseline always-on power = sum of mean_w across all power_devices rows.
    // Includes manual always-on devices (their nominal_w) AND manual cyclic
    // devices' time-averaged contribution (their peak × duty/100). P3 auto-
    // discovered devices land here too once they exist. Surfaced under
    // "Total Power" on the LCD card so the user can see what fraction of
    // current draw is the unmovable baseline vs variable.
    const aoR = await db.query(
      "SELECT COALESCE(SUM(mean_w), 0)::int AS w FROM power_devices WHERE mean_w IS NOT NULL"
    );
    const always_on_w = aoR.rows[0]?.w ?? 0;

    // Companion to always_on_w: sum of live wattage for auto + state_known
    // devices the rules currently detect as ON. Surfaced next to ALWAYS-ON
    // on the LCD so the user can see the *detected* dynamic load (TV on,
    // dishwasher heating, etc.) separately from the constant baseline.
    // For single-phase rows live carries `w`; for 3-phase rows it carries
    // `r_w` / `s_w` / `t_w`. COALESCE handles both cases — irrelevant keys
    // resolve to NULL → 0 in the sum.
    const aoKnownR = await db.query(
      `SELECT COALESCE(SUM(
         CASE WHEN (live->>'on')::bool = TRUE
              AND source IN ('auto_pending','auto_custom','auto_discovered','state_known') THEN
           COALESCE((live->>'w')::int,   0)
         + COALESCE((live->>'r_w')::int, 0)
         + COALESCE((live->>'s_w')::int, 0)
         + COALESCE((live->>'t_w')::int, 0)
         ELSE 0 END
       ), 0)::int AS w
       FROM power_devices`
    );
    const auto_known_on_w = aoKnownR.rows[0]?.w ?? 0;

    // ON/OFF device counters are now computed client-side from
    // /api/power/devices in mdComputeOnOffCounts (rendered in the
    // Device Registry h2 — moved out of LCD card per user request).
    const row = r.rows[0];
    const s = row.last_state || {};
    const phase = (p) => ({
      v:   typeof s[`${p}_v`]   === 'number' ? s[`${p}_v`]   : null,
      a:   typeof s[`${p}_a`]   === 'number' ? s[`${p}_a`]   : null,
      w:   typeof s[`${p}_w`]   === 'number' ? s[`${p}_w`]   : null,
      pf:  typeof s[`${p}_pf`]  === 'number' ? s[`${p}_pf`]  : null,
      kwh: typeof s[`${p}_kwh`] === 'number' ? s[`${p}_kwh`] : null,
    });
    const R = phase('r'), S = phase('s'), T = phase('t');

    const ws = [R.w, S.w, T.w].filter(x => typeof x === 'number');
    const total_w = ws.length ? ws.reduce((a, b) => a + b, 0) : null;
    const max_w = ws.length ? Math.max(...ws) : 0;
    const min_w = ws.length ? Math.min(...ws) : 0;
    const imbalance_pct = max_w > 0 ? Math.round(((max_w - min_w) / max_w) * 1000) / 10 : null;

    const kwhs = [R.kwh, S.kwh, T.kwh].filter(x => typeof x === 'number');
    const total_kwh = kwhs.length === 3
      ? Math.round((kwhs[0] + kwhs[1] + kwhs[2]) * 100) / 100
      : null;

    // Apparent VA per phase (V × A); system PF = total_w / sum(va)
    const va = (p) => (typeof p.v === 'number' && typeof p.a === 'number')
      ? Math.round(p.v * p.a) : null;
    const vas = [va(R), va(S), va(T)].filter(x => typeof x === 'number');
    const total_va = vas.length === 3 ? vas[0] + vas[1] + vas[2] : null;
    const system_pf = (total_w != null && total_va && total_va > 0)
      ? Math.round((total_w / total_va) * 100) / 100 : null;

    res.json({
      device_id: 'shelly_3em_main',
      last_seen: row.last_seen,
      age_sec: row.age ? (row.age.seconds || 0) + (row.age.minutes || 0) * 60 + (row.age.milliseconds || 0) / 1000 : null,
      r: R, s: S, t: T,
      r_va: va(R), s_va: va(S), t_va: va(T),
      total_w,
      total_va,
      total_kwh,
      system_pf,
      imbalance_pct,
      always_on_w,
      auto_known_on_w,
      frequency_hz: 50,  // Israel grid standard — Shelly Gen 1 doesn't expose frequency via HA
      ...(await (async () => {
        // Billing-period kWh + cost.
        const { billing, tariff } = await _powerLoadSettings();
        const { start, end, baseline, rolled } = await _powerResolveBillingPeriod(billing);

        // If we still don't have a baseline for this cycle (only happens
        // when the system was first deployed mid-cycle, before the rollover
        // logic ever fired), try to backfill from Shelly's local 60-day
        // em_data.csv buffer. This is the "fully automatic current-period
        // recovery" path.
        let effectiveBaseline = baseline;
        if (!effectiveBaseline) {
          const shellyIp = await _shellyResolveIp();
          const startUnix = Math.floor(new Date(start + 'T00:00:00Z').getTime() / 1000);
          const [rConsumed, sConsumed, tConsumed] = await Promise.all([
            _fetchShellyKwhSince(shellyIp, 0, startUnix),
            _fetchShellyKwhSince(shellyIp, 1, startUnix),
            _fetchShellyKwhSince(shellyIp, 2, startUnix),
          ]);
          // baseline = current_cumulative − sum_consumed_since_start
          if (typeof R.kwh === 'number' && typeof rConsumed === 'number'
           && typeof S.kwh === 'number' && typeof sConsumed === 'number'
           && typeof T.kwh === 'number' && typeof tConsumed === 'number') {
            effectiveBaseline = {
              r: Math.round((R.kwh - rConsumed) * 100) / 100,
              s: Math.round((S.kwh - sConsumed) * 100) / 100,
              t: Math.round((T.kwh - tConsumed) * 100) / 100,
              captured_at: new Date().toISOString(),
              source:      'em_data_backfill',
            };
          } else if (typeof R.kwh === 'number' && typeof S.kwh === 'number' && typeof T.kwh === 'number') {
            // Last-resort fallback when Shelly is unreachable / has no
            // buffered data covering the period start. Snap current
            // cumulative — period_kwh will count from now onwards, which
            // is wrong-but-not-broken. User can manually correct via
            // Settings if they ever look up the May-15 readings.
            effectiveBaseline = {
              r: R.kwh, s: S.kwh, t: T.kwh,
              captured_at: new Date().toISOString(),
              source:      'lazy_init',
            };
          }
          if (effectiveBaseline) {
            await db.query(`
              INSERT INTO dashboard_settings (key, value, updated_at)
              VALUES ('power.billing', $1::jsonb, NOW())
              ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
            `, [JSON.stringify({ ...billing, current_period_start_date: start, baseline_kwh: effectiveBaseline })]);
          }
        }

        const periodKwh = (phaseChar) => {
          const cur = phaseChar === 'r' ? R : phaseChar === 's' ? S : T;
          const baseKwh = effectiveBaseline?.[phaseChar];
          if (cur.kwh == null || baseKwh == null) return null;
          return Math.round((Number(cur.kwh) - Number(baseKwh)) * 100) / 100;
        };
        const r_period = periodKwh('r'), s_period = periodKwh('s'), t_period = periodKwh('t');
        const total_period_kwh = [r_period, s_period, t_period]
          .filter(x => typeof x === 'number')
          .reduce((a, b) => a + b, 0);

        // Days elapsed / total in current period.
        const now = Date.now();
        const startTs = new Date(start + 'T00:00:00Z').getTime();
        const endTs   = new Date(end   + 'T00:00:00Z').getTime();
        const days_total    = Math.max(1, Math.round((endTs - startTs) / 86400000));
        const days_elapsed  = Math.max(0, Math.round((now - startTs) / 86400000));
        const elapsed_pct   = Math.min(100, Math.round((days_elapsed / days_total) * 100));

        return {
          period: {
            start, end,
            days_total, days_elapsed, elapsed_pct,
            r_kwh:     r_period,
            s_kwh:     s_period,
            t_kwh:     t_period,
            total_kwh: Math.round(total_period_kwh * 100) / 100,
            cost:      _powerComputeCost(tariff, total_period_kwh, days_elapsed),
            currency:  tariff.currency_symbol,
          },
        };
      })()),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POWER P2 — Device Registry ───────────────────────────────
// Every row is one device on one (or three) phase(s) with an expected
// power signature. The Behavior field decides what the future P3
// discovery rule does with the row:
//   * always_on — constant baseline subtracted from total continuously
//   * auto      — rule detects ON/OFF from Shelly per-phase deltas;
//                 contributes only while detected ON
// Each row carries an identity in one of two flavours:
//   * Linked  — power_devices.device_id = an existing real device's id;
//               the real devices row is left alone
//   * Custom  — a virtual devices row is created with id manual_<slug>
//               (always_on) or auto_<slug> (auto)
// Single-phase rows store {expected_w, max_w} in power_devices.config;
// 3-phase rows store {r/s/t_expected_w, r/s/t_max_w}. Max defaults to
// Expected if blank (single-state device — microwave / kettle).
// Variable-power devices (dishwasher with heating phase) get a Max
// value > Expected so the rule can recognize the device across its
// whole consumption range.
function slugify(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

app.get('/api/power/devices', async (req, res) => {
  try {
    // room comes from config.room first (the user's pick on the registry
    // form) and falls back to devices.room for legacy rows. Linked-real
    // rows specifically keep the user's pick in config since we don't
    // mutate the real device's room column.
    // pd.channel: NULL = whole device (single-channel devices, virtual rows,
    // legacy pre-channel rows); set = a specific channel of a multi-gang
    // switch. Display name appends " – <channel name>" when channel is set
    // and the parent device's channel_config has a name for that key.
    const r = await db.query(`
      SELECT pd.row_id, pd.device_id, pd.channel,
             pd.phase, pd.is_three_phase, pd.is_cyclic,
             pd.samples_count, pd.mean_w, pd.stddev_w, pd.cycle_max_w,
             pd.cycle_typical_kwh, pd.confidence, pd.last_observed_at,
             pd.source, pd.notes, pd.updated_at,
             pd.display_name, pd.config, pd.live, pd.sort_order,
             d.name, d.device_type, d.protocol, d.dps_config, d.channel_config,
             COALESCE(pd.config->>'room', d.room) AS room
      FROM power_devices pd
      JOIN devices d ON d.id = pd.device_id
      ORDER BY pd.sort_order ASC NULLS LAST,
               pd.phase      ASC NULLS LAST,
               COALESCE(pd.display_name, d.name) ASC,
               pd.channel    ASC NULLS LAST
    `);
    // Append channel name to row name for multi-channel rows.
    for (const row of r.rows) {
      if (row.channel && row.channel_config && row.channel_config[row.channel]) {
        const cn = row.channel_config[row.channel].name;
        if (cn) row.channel_name = cn;
      }
    }
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Devices eligible to register with behavior='auto' — discovery rule will
// watch their ON/OFF transitions and match Shelly deltas to the user-
// supplied expected power signature.
// Excludes:
//   * already-registered devices (NOT IN power_devices)
//   * the Shelly meter itself
//   * virtual + sensor types that can't actually draw measurable load (no
//     ON/OFF transitions to learn from)
//   * disabled devices
app.get('/api/power/devices/available', async (req, res) => {
  try {
    // Multi-channel switches (e.g. "Kitchen Switch" with channel_config keys
    // 1/2/3) are the actual loads, not the parent. Expand each enabled
    // channel into its own dropdown row so the user registers the lamp on
    // channel 1, the spots on channel 2 separately — each with its own
    // expected power signature. Single-channel devices (microwaves, AC
    // units, etc.) get one row as before.
    //
    // A row is "channel-already-registered" if power_devices has a row
    // matching BOTH device_id AND channel. The whole-device exclusion
    // (channel IS NULL) only applies when no channel is specified.
    const r = await db.query(`
      SELECT d.id, d.name, d.room, d.device_type, d.protocol, d.last_source,
             d.channel_config
      FROM devices d
      WHERE d.enabled = TRUE
        AND d.id <> 'shelly_3em_main'
        AND d.protocol NOT IN ('virtual')
        AND d.device_type NOT IN ('power_meter','presence','motion','door_sensor','remote','temp_controller','co_alarm','gas_detector','display','panel','unmanaged_load')
      ORDER BY d.room ASC NULLS LAST, d.name ASC
    `);
    // Which (device_id, channel) pairs are already taken? Used to filter
    // the dropdown so the user can't double-register.
    const takenR = await db.query(
      "SELECT device_id, COALESCE(channel, '') AS channel FROM power_devices"
    );
    const taken = new Set(takenR.rows.map(t => `${t.device_id}::${t.channel}`));

    const out = [];
    for (const d of r.rows) {
      const cfg = (d.channel_config && typeof d.channel_config === 'object') ? d.channel_config : {};
      // Pick the keys that look like genuine load channels — i.e. they have
      // a `name`. Channels with only {room, enabled:false} are skipped
      // (those are dead / unused gangs). Channels with only {room} also pass
      // (some are nameless but real, e.g. Bathroom Switch).
      const channelEntries = Object.entries(cfg).filter(([_k, c]) => {
        if (c && typeof c === 'object' && c.enabled === false) return false;
        return true;
      });
      if (channelEntries.length === 0) {
        // Single-channel device — emit as one row (channel=null).
        if (!taken.has(`${d.id}::`)) {
          out.push({ id: d.id, name: d.name, room: d.room, device_type: d.device_type,
                     protocol: d.protocol, channel: null });
        }
        continue;
      }
      // Multi-channel — one row per enabled channel.
      for (const [key, cdesc] of channelEntries) {
        if (taken.has(`${d.id}::${key}`)) continue;
        const chanName = (cdesc && cdesc.name) ? cdesc.name : `Ch ${key}`;
        out.push({
          id:          d.id,
          name:        `${d.name} – ${chanName}`,
          room:        (cdesc && cdesc.room) || d.room,
          device_type: d.device_type,
          protocol:    d.protocol,
          channel:     key,
        });
      }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Unified parser: every registry write goes through the same body shape.
//   {
//     behavior: 'always_on' | 'auto',
//     linked_device_id | custom_device_name,
//     display_name?,
//     phase: 'R'|'S'|'T'|null, is_three_phase: bool,
//     room: <text>,
//     expected_w?      // single phase
//     r_expected_w?, s_expected_w?, t_expected_w?   // 3-phase
//   }
// Returns either {ok:true, ...} or {error:string, status:int}.
function _powerParseBody(body) {
  const behavior = body.behavior;
  if (!['always_on','auto','state_known'].includes(behavior))
    return { error: 'behavior must be always_on, auto, or state_known', status: 400 };
  const phase = body.phase || null;
  const isThreePhase = !!body.is_three_phase;
  if (!isThreePhase && !['R','S','T'].includes(phase))
    return { error: 'phase must be R / S / T (or set is_three_phase=true)', status: 400 };
  // Room is optional — picks "(no room)" for routers / modems / closet
  // gear that don't belong to a specific room. Stored as NULL in
  // config.room + devices.room (linked rows leave the device's existing
  // room alone).
  const room = (body.room == null) ? null : String(body.room).trim() || null;

  const cfg = { behavior };
  if (room) cfg.room = room;
  let sumW = 0;
  if (isThreePhase) {
    const r_w = Number(body.r_expected_w) || 0;
    const s_w = Number(body.s_expected_w) || 0;
    const t_w = Number(body.t_expected_w) || 0;
    if (r_w + s_w + t_w <= 0)
      return { error: 'at least one of R/S/T expected power must be > 0', status: 400 };
    // Max defaults to Expected per phase if blank/missing. Validate max >= expected.
    const r_mx = Math.max(Number(body.r_max_w) || 0, r_w);
    const s_mx = Math.max(Number(body.s_max_w) || 0, s_w);
    const t_mx = Math.max(Number(body.t_max_w) || 0, t_w);
    cfg.r_expected_w = r_w; cfg.s_expected_w = s_w; cfg.t_expected_w = t_w;
    cfg.r_max_w = r_mx;     cfg.s_max_w = s_mx;     cfg.t_max_w = t_mx;
    sumW = r_w + s_w + t_w;
  } else {
    const w = Number(body.expected_w) || 0;
    if (w <= 0) return { error: 'expected_w must be > 0', status: 400 };
    const mx = Math.max(Number(body.max_w) || 0, w);
    cfg.expected_w = w;
    cfg.max_w = mx;
    sumW = w;
  }

  // mean_w semantics:
  //   always_on   → continuous baseline = sum of expected powers
  //   auto        → contributes only when the discovery rule detects ON.
  //   state_known → contributes only when device.state says ON; baseline NULL.
  // Only always_on adds to the always_on_w SUM in /api/power/status; the
  // other two are counted via live.on at runtime.
  const mean_w = behavior === 'always_on' ? sumW : null;
  const phaseToStore = isThreePhase ? null : phase;

  return { cfg, mean_w, phaseToStore, isThreePhase, behavior, room };
}

app.post('/api/power/devices', async (req, res) => {
  const parsed = _powerParseBody(req.body || {});
  if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
  const { cfg, mean_w, phaseToStore, isThreePhase, behavior, room } = parsed;

  const linked_device_id = req.body.linked_device_id || null;
  const channel          = req.body.channel ? String(req.body.channel) : null;  // multi-channel devices: which key (e.g. "1")
  const customName       = (req.body.custom_device_name || '').trim();
  const displayName      = (req.body.display_name || '').trim();
  if (!linked_device_id && !customName)
    return res.status(400).json({ error: 'pick a device or supply a custom name' });
  if (linked_device_id && customName)
    return res.status(400).json({ error: 'linked_device_id and custom_device_name are mutually exclusive' });

  // source values:
  //   linked   + always_on   → 'manual_linked'    (real device, baseline)
  //   linked   + auto        → 'auto_pending'
  //   linked   + state_known → 'state_known'      (HA-reported on/off)
  //   custom   + always_on   → 'manual_unmanaged' (virtual manual_<slug>)
  //   custom   + auto        → 'auto_custom'      (virtual auto_<slug>)
  //   state_known requires linked path (needs a real device's state.dps.state).
  const isLinked = !!linked_device_id;
  if (!isLinked && behavior === 'state_known')
    return res.status(400).json({ error: 'state_known requires a linked device — pick one, not custom' });
  const source = isLinked
    ? (behavior === 'always_on' ? 'manual_linked'
       : behavior === 'state_known' ? 'state_known'
       : 'auto_pending')
    : (behavior === 'always_on' ? 'manual_unmanaged' : 'auto_custom');

  const client = await db.connect();
  try {
    // Linked path — power_devices row references the real device; no virtual
    // device row created. Multiple rows can share device_id when channel
    // differs (e.g. Kitchen Switch ch1 + ch2 each registered separately).
    if (isLinked) {
      const dev = await client.query('SELECT id, channel_config, last_state FROM devices WHERE id = $1', [linked_device_id]);
      if (!dev.rows.length) return res.status(404).json({ error: `device "${linked_device_id}" not found` });
      // Validate channel exists in device's channel_config when supplied.
      if (channel) {
        const cc = dev.rows[0].channel_config || {};
        if (!cc[channel]) return res.status(400).json({ error: `channel "${channel}" not found on device` });
      }
      // Duplicate check: same (device_id, channel) already registered?
      const existing = await client.query(
        "SELECT row_id FROM power_devices WHERE device_id = $1 AND COALESCE(channel, '') = COALESCE($2, '')",
        [linked_device_id, channel],
      );
      if (existing.rows.length) return res.status(409).json({ error: `this device/channel is already in the registry` });

      // For state_known rows, seed `live` from the device's current
      // last_state.state so the LCD counter is accurate immediately (the
      // rule only writes live on a state change → without seeding, a TV
      // that's been off for hours would show OFF/'live' = default).
      let initialLive = { on: false };
      if (behavior === 'state_known') {
        const ls = dev.rows[0].last_state || {};
        const stateVal = channel && ls[channel] !== undefined ? ls[channel] : ls.state;
        const offSet = new Set(['off','unavailable','unknown','standby','none','']);
        const isOn = stateVal != null
          && !(typeof stateVal === 'string' && offSet.has(String(stateVal).toLowerCase()))
          && stateVal !== false;
        initialLive = isOn
          ? { on: true, w: Number(cfg.expected_w) || 0, ts: new Date().toISOString() }
          : { on: false, ts: new Date().toISOString() };
      }

      const r = await client.query(`
        INSERT INTO power_devices (device_id, channel, phase, is_three_phase, mean_w, source, confidence,
          is_cyclic, samples_count, display_name, config, live, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'high', FALSE, 0, $7, $8::jsonb, $9::jsonb, NOW())
        RETURNING row_id
      `, [linked_device_id, channel, phaseToStore, isThreePhase, mean_w, source, displayName || null,
          JSON.stringify(cfg), JSON.stringify(initialLive)]);
      return res.json({ ok: true, row_id: r.rows[0].row_id, device_id: linked_device_id, channel, source,
                        behavior, is_three_phase: isThreePhase, mean_w });
    }

    // Custom path — create a virtual device + power_devices row. Custom rows
    // are never channel-scoped (they're standalone unmanaged loads).
    const slug = slugify(customName);
    if (!slug) return res.status(400).json({ error: 'custom name produced empty slug' });
    const prefix = behavior === 'always_on' ? 'manual' : 'auto';
    const newId = `${prefix}_${slug}`;

    await client.query('BEGIN');
    const existsDev = await client.query('SELECT id FROM devices WHERE id = $1', [newId]);
    if (existsDev.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `device "${newId}" already exists` });
    }
    await client.query(`
      INSERT INTO devices (id, name, vendor, device_type, protocol, room,
        enabled, show_dashboard, poll_enabled, poll_interval_sec,
        dps_labels, dps_config, channel_config)
      VALUES ($1, $2, $3, 'unmanaged_load', 'virtual', $4,
        TRUE, FALSE, FALSE, 0, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `, [newId, customName, behavior === 'always_on' ? 'Manual' : 'Auto-tracked', room]);
    const r = await client.query(`
      INSERT INTO power_devices (device_id, channel, phase, is_three_phase, mean_w, source, confidence,
        is_cyclic, samples_count, display_name, config, updated_at)
      VALUES ($1, NULL, $2, $3, $4, $5, 'high', FALSE, 0, $6, $7::jsonb, NOW())
      RETURNING row_id
    `, [newId, phaseToStore, isThreePhase, mean_w, source, customName, JSON.stringify(cfg)]);
    await client.query('COMMIT');
    return res.json({ ok: true, row_id: r.rows[0].row_id, device_id: newId, channel: null, source,
                      behavior, is_three_phase: isThreePhase, mean_w });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// PATCH — every row type editable (manual_*, auto_*, real linked device id).
// Same body shape as POST minus the identity fields (device id is fixed in
// the URL; can't change it on edit — delete + re-add to switch device).
// PATCH keyed on power_devices.row_id (synthetic PK, since multiple rows can
// share device_id once channel-scoped registration is in play).
app.patch('/api/power/devices/:row_id', async (req, res) => {
  const rowId = parseInt(req.params.row_id, 10);
  if (!Number.isFinite(rowId)) return res.status(400).json({ error: 'row_id required' });
  const parsed = _powerParseBody(req.body || {});
  if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });
  const { cfg, mean_w, phaseToStore, isThreePhase, behavior, room } = parsed;
  const displayName = (req.body.display_name || '').trim();

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT row_id, device_id, channel FROM power_devices WHERE row_id = $1', [rowId]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const deviceId = cur.rows[0].device_id;

    // source flips with behavior — pick the right value based on whether the
    // row is virtual (manual_/auto_ prefix) or linked (real device id).
    // Virtual rows can't switch to state_known (no real device.state to read).
    const isVirtual = deviceId.startsWith('manual_') || deviceId.startsWith('auto_');
    if (isVirtual && behavior === 'state_known') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'state_known not valid for virtual rows' });
    }
    const source = isVirtual
      ? (behavior === 'always_on' ? 'manual_unmanaged' : 'auto_custom')
      : (behavior === 'always_on' ? 'manual_linked'
         : behavior === 'state_known' ? 'state_known'
         : 'auto_pending');

    // For virtual rows, also update the linked devices row's room so the
    // join still picks it up. Linked rows leave the real device untouched
    // (room lives in config.room for them).
    if (isVirtual) {
      await client.query('UPDATE devices SET room = $2, updated_at = NOW() WHERE id = $1', [deviceId, room]);
    }
    await client.query(`
      UPDATE power_devices
      SET phase = $2, is_three_phase = $3, mean_w = $4,
          source = $5, display_name = $6, config = $7::jsonb,
          is_cyclic = FALSE,
          updated_at = NOW()
      WHERE row_id = $1
    `, [rowId, phaseToStore, isThreePhase, mean_w, source, displayName || null, JSON.stringify(cfg)]);

    await client.query('COMMIT');
    res.json({ ok: true, row_id: rowId, device_id: deviceId, source, behavior, is_three_phase: isThreePhase, mean_w });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Discovery rule knobs are sentence-driven (parsed by rule_engine on heartbeat
// into state.shared['power_discovery.*']) — no dashboard_settings.power.discovery
// row, no server-side defaults. The P3 rule reads its knobs straight from
// state.shared via the standard KNOB_PATTERNS pipeline.

// Billing-cycle defaults — IEC residential is a 2-month cycle. Start day +
// length determine when each cycle begins; current_period_start_date is
// auto-rolled forward on each /api/power/status read once a cycle ends.
// baseline_kwh holds the Shelly cumulative readings at the moment the
// current period started — used to compute period_kwh = current − baseline.
// Auto-snapped on rollover (perfect accuracy going forward); for cycles
// already in progress when the system first deployed, em_data.csv backfill
// from Shelly's 60-day local history fills it in retroactively.
const _POWER_BILLING_DEFAULTS = {
  start_day:                 15,
  length_months:              2,
  current_period_start_date: null,
  baseline_kwh:              null,  // { r, s, t, captured_at, source: 'auto_snap'|'em_data_backfill'|'manual' }
};

// Tariff defaults — calibrated against the user's actual IEC bill
// (mid-2026, see commit log + POWER spec). User overrides via the
// Settings tab when their actual rate or connection size differs.
const _POWER_TARIFF_DEFAULTS = {
  type:                       'flat',        // 'flat' | 'taoz'
  flat_rate_ils_per_kwh:      0.5451,        // IEC residential — 54.51 אגורות/kWh
  taoz_peak_rate:             0.85,          // placeholder until user enters real TAOZ rates
  taoz_shoulder_rate:         0.55,
  taoz_off_peak_rate:         0.30,
  taoz_peak_hours:            '17:00-22:00', // free-text label; hourly integration deferred
  taoz_shoulder_hours:        '22:00-06:00',
  taoz_off_peak_hours:        '06:00-17:00',
  fixed_monthly_fee_ils:      26.25,         // distribution 11.45 + supply 14.80 (IEC residential)
  kva_rate_ils_per_year:      5.19,          // capacity charge per KVA per year (IEC published)
  connection_kva:             17.32,         // user's connection size — 3×25A = 17.32 KVA
  direct_debit_credit_ils:   -3.84,          // per-bill discount when paying by bank standing order (set 0 if not on direct debit)
  vat_pct:                    18,            // Israel VAT raised from 17% → 18% in 2025
  currency_symbol:            '₪',
};

// Load billing + tariff blocks merged with defaults for the Settings tab.
async function _powerLoadSettings() {
  const r = await db.query("SELECT key, value FROM dashboard_settings WHERE key IN ('power.billing','power.tariff')");
  const map = {};
  for (const row of r.rows) map[row.key] = row.value || {};
  return {
    billing: { ..._POWER_BILLING_DEFAULTS, ...(map['power.billing'] || {}) },
    tariff:  { ..._POWER_TARIFF_DEFAULTS,  ...(map['power.tariff']  || {}) },
  };
}

app.get('/api/power/settings', async (req, res) => {
  try { res.json(await _powerLoadSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/power/settings', async (req, res) => {
  const body = req.body || {};

  // Read existing billing to preserve system-managed fields (baseline_kwh)
  // that the frontend doesn't surface in the Settings form.
  const existingBillingRow = await db.query("SELECT value FROM dashboard_settings WHERE key = 'power.billing' LIMIT 1");
  const existingBilling = existingBillingRow.rows[0]?.value || {};
  const cleanedBilling = {
    start_day:     Math.min(28, Math.max(1, parseInt(body?.billing?.start_day, 10) || _POWER_BILLING_DEFAULTS.start_day)),
    length_months: Math.min(12, Math.max(1, parseInt(body?.billing?.length_months, 10) || _POWER_BILLING_DEFAULTS.length_months)),
    current_period_start_date: body?.billing?.current_period_start_date || existingBilling.current_period_start_date || _POWER_BILLING_DEFAULTS.current_period_start_date,
    baseline_kwh:  (body?.billing?.baseline_kwh !== undefined) ? body.billing.baseline_kwh : (existingBilling.baseline_kwh || null),
  };
  const tt = body?.tariff || {};
  // Helper — clamp to >=0 unless explicitly allowed negative (direct_debit_credit_ils).
  const _num = (v, dflt, { allowNeg = false, min = 0 } = {}) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return dflt;
    return allowNeg ? x : Math.max(min, x);
  };
  const cleanedTariff = {
    type:                    ['flat','taoz'].includes(tt.type) ? tt.type : _POWER_TARIFF_DEFAULTS.type,
    flat_rate_ils_per_kwh:   _num(tt.flat_rate_ils_per_kwh,   _POWER_TARIFF_DEFAULTS.flat_rate_ils_per_kwh),
    taoz_peak_rate:          _num(tt.taoz_peak_rate,          _POWER_TARIFF_DEFAULTS.taoz_peak_rate),
    taoz_shoulder_rate:      _num(tt.taoz_shoulder_rate,      _POWER_TARIFF_DEFAULTS.taoz_shoulder_rate),
    taoz_off_peak_rate:      _num(tt.taoz_off_peak_rate,      _POWER_TARIFF_DEFAULTS.taoz_off_peak_rate),
    taoz_peak_hours:         String(tt.taoz_peak_hours     || _POWER_TARIFF_DEFAULTS.taoz_peak_hours).slice(0, 64),
    taoz_shoulder_hours:     String(tt.taoz_shoulder_hours || _POWER_TARIFF_DEFAULTS.taoz_shoulder_hours).slice(0, 64),
    taoz_off_peak_hours:     String(tt.taoz_off_peak_hours || _POWER_TARIFF_DEFAULTS.taoz_off_peak_hours).slice(0, 64),
    fixed_monthly_fee_ils:   _num(tt.fixed_monthly_fee_ils,   _POWER_TARIFF_DEFAULTS.fixed_monthly_fee_ils),
    kva_rate_ils_per_year:   _num(tt.kva_rate_ils_per_year,   _POWER_TARIFF_DEFAULTS.kva_rate_ils_per_year),
    connection_kva:          _num(tt.connection_kva,          _POWER_TARIFF_DEFAULTS.connection_kva),
    direct_debit_credit_ils: _num(tt.direct_debit_credit_ils, _POWER_TARIFF_DEFAULTS.direct_debit_credit_ils, { allowNeg: true }),
    vat_pct:                 Math.max(0, Math.min(100, Number(tt.vat_pct) || _POWER_TARIFF_DEFAULTS.vat_pct)),
    currency_symbol:         String(tt.currency_symbol || _POWER_TARIFF_DEFAULTS.currency_symbol).slice(0, 4),
  };

  try {
    // Two idempotent UPSERTs — only blocks the user sent get written;
    // unsent blocks fall back to defaults on next GET.
    const writes = [
      ['power.billing', cleanedBilling],
      ['power.tariff',  cleanedTariff],
    ];
    for (const [key, value] of writes) {
      await db.query(`
        INSERT INTO dashboard_settings (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW()
      `, [key, JSON.stringify(value)]);
    }
    res.json({ ok: true, billing: cleanedBilling, tariff: cleanedTariff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Power Bills — history + PDF upload ─────────────────────
app.get('/api/power/bills', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT id, uploaded_at,
             to_char(period_start, 'YYYY-MM-DD') AS period_start,
             to_char(period_end,   'YYYY-MM-DD') AS period_end,
             total_kwh, total_cost_ils, est_cost_ils, raw_text, parsed, source, notes
      FROM power_bills
      ORDER BY COALESCE(period_start, uploaded_at::date) DESC, uploaded_at DESC
      LIMIT 200
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/power/bills/:id', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM power_bills WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IEC bill PDF parser — pure server-side, no LLM. Uses pdf-parse to extract
// text from the uploaded PDF, then regex-matches the IEC residential
// template's known anchor strings to pull the four key fields:
//   - period_start / period_end (DD/MM/YYYY pattern, RTL-flipped by pdf-parse)
//   - total_kwh   (from "סה\"כ N קוט\"ש")
//   - total_cost_ils (from "N סה\"כ לתשלום )ש\"ח(")
// Inserts directly into power_bills. If regex misses any field, the row
// still saves with NULL — user can delete + retry, or fix in DB.
function _parseIecBill(text) {
  const out = {};

  // Period dates — pdf-parse reverses RTL text, so the visual layout in
  // the PDF "מ-15/01/2026 עד 19/03/2026" extracts as
  // "19/03/2026 15/01/2026 עד-מ" — END_DATE comes first.
  const m = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+עד/);
  if (m) {
    const _iso = (ddmmyyyy) => ddmmyyyy.split('/').reverse().join('-');
    const a = _iso(m[1]);
    const b = _iso(m[2]);
    // Sort to be safe — earlier date is start, later is end.
    if (a < b) { out.period_start = a; out.period_end = b; }
    else       { out.period_start = b; out.period_end = a; }
  }

  // Total kWh consumed — "חיוב בגין צריכה - סה\"כ 1273 קוט\"ש"
  const k = text.match(/סה"כ\s+(\d+)\s+קוט"ש/);
  if (k) out.total_kwh = parseInt(k[1], 10);

  // Grand total ₪ — pdf-parse extracts as "898.05 \tסה\"כ לתשלום )ש\"ח(",
  // i.e. the number is BEFORE the label.
  const c = text.match(/([\d,]+\.\d+)\s+סה"כ\s+לתשלום/);
  if (c) out.total_cost_ils = parseFloat(c[1].replace(/,/g, ''));

  // Per-kWh rate in agorot — "54.51 \tאגורות" or in the consumption table.
  // Stored as ₪/kWh (agorot ÷ 100).
  const a = text.match(/(\d+\.\d{2})\s+(?:אגורות|לקוט"ש)/);
  if (a) out.rate_ils_per_kwh = parseFloat(a[1]) / 100;

  // VAT %
  const v = text.match(/(\d+\.\d+)\s*%\s*מע"מ/);
  if (v) out.vat_pct = parseFloat(v[1]);

  // Fixed monthly fee — IEC splits into distribution + supply rows in the
  // bill body. Each shows "תשלום קבוע <חלוקה|אספקה> ... ימים לפי <X.XX>".
  // Anchoring to "תשלום קבוע" is important — without it the generic
  // "ימים לפי" pattern also hits the KVA-rate row ("ימים לפי 5.19 ש\"ח
  // לשנה לכל 1 KVA") and contaminates the sum.
  const feeRates = [...text.matchAll(/תשלום\s+קבוע\s+(?:חלוקה|אספקה)[\s\S]{0,200}?ימים\s+לפי\s+(\d+\.\d+)/g)]
                    .map(m => parseFloat(m[1]));
  if (feeRates.length >= 2) {
    out.fixed_monthly_fee_ils = Math.round((feeRates[0] + feeRates[1]) * 100) / 100;
  }

  // KVA capacity rate (₪/year per KVA): "לפי 5.19 ש\"ח לשנה לכל 1 KVA"
  const kvaRate = text.match(/לפי\s+(\d+\.\d+)\s+ש"ח\s+לשנה/);
  if (kvaRate) out.kva_rate_ils_per_year = parseFloat(kvaRate[1]);

  // Connection size in KVA: "הספק 17.32 KVA"
  const connKva = text.match(/הספק\s+(\d+\.\d+)\s+KVA/);
  if (connKva) out.connection_kva = parseFloat(connKva[1]);

  // Direct-debit credit: "הוראת קבע בבנק -3.84" (typically negative).
  const ddCredit = text.match(/הוראת\s+קבע\s+בבנק\s+(-?\d+\.\d+)/);
  if (ddCredit) out.direct_debit_credit_ils = parseFloat(ddCredit[1]);

  return out;
}

// One-click PDF flow: pick a bill PDF in the dashboard → multer receives
// it → pdf-parse extracts text → regex pulls the IEC-template fields →
// INSERT into power_bills + return the new row. No LLM call, no external
// API dependency. If regex misses a field the row still saves (NULL).
app.post('/api/power/bills/upload', billPdfUpload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'pdf file required' });
  try {
    const pdfBytes = fs.readFileSync(req.file.path);
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    const { PDFParse } = require('pdf-parse');
    const result = await (new PDFParse({ data: pdfBytes })).getText();
    const text = result.text || '';
    const parsed = _parseIecBill(text);

    if (!parsed.period_start && !parsed.total_kwh && !parsed.total_cost_ils) {
      return res.status(422).json({ error: 'could not extract any fields from PDF — unrecognised IEC template?' });
    }

    const r = await db.query(`
      INSERT INTO power_bills (period_start, period_end, total_kwh, total_cost_ils,
        raw_text, parsed, source)
      VALUES ($1::date, $2::date, $3, $4, $5, $6::jsonb, 'pdf_parsed')
      RETURNING id,
                to_char(period_start, 'YYYY-MM-DD') AS period_start,
                to_char(period_end,   'YYYY-MM-DD') AS period_end,
                total_kwh, total_cost_ils
    `, [
      parsed.period_start || null,
      parsed.period_end   || null,
      parsed.total_kwh    != null ? Number(parsed.total_kwh)      : null,
      parsed.total_cost_ils != null ? Number(parsed.total_cost_ils) : null,
      text.slice(0, 6000),
      JSON.stringify(parsed),
    ]);

    // Tariff-drift detection: if this bill is the most recent the user
    // has uploaded, compare the parsed rate fields against the current
    // Settings values. Any field that differs by > 1% gets returned in
    // a `diff` array. The frontend offers an "Update Settings" button so
    // the user can sync the new IEC rates with a single click.
    let diff = [];
    if (parsed.period_end) {
      const latestQ = await db.query(
        "SELECT MAX(period_end) AS latest FROM power_bills WHERE id <> $1 AND period_end IS NOT NULL",
        [r.rows[0].id],
      );
      const latestExisting = latestQ.rows[0]?.latest;
      const isLatest = !latestExisting
        || new Date(parsed.period_end) >= new Date(latestExisting);
      if (isLatest) {
        const { tariff } = await _powerLoadSettings();
        const _drift = (cur, neu) => {
          if (cur == null || neu == null) return false;
          const ref = Math.abs(cur) > 0.001 ? Math.abs(cur) : 1;
          return Math.abs(cur - neu) / ref > 0.01;     // > 1% off
        };
        const _check = (field, parsedVal, label) => {
          if (parsedVal != null && _drift(tariff[field], parsedVal)) {
            diff.push({ field, label, current: tariff[field], new: parsedVal });
          }
        };
        _check('flat_rate_ils_per_kwh',   parsed.rate_ils_per_kwh,        'Rate per kWh (₪)');
        _check('fixed_monthly_fee_ils',   parsed.fixed_monthly_fee_ils,   'Fixed monthly fee (₪)');
        _check('kva_rate_ils_per_year',   parsed.kva_rate_ils_per_year,   'KVA rate (₪/year)');
        _check('connection_kva',          parsed.connection_kva,          'Connection size (KVA)');
        _check('direct_debit_credit_ils', parsed.direct_debit_credit_ils, 'Direct-debit credit (₪)');
        _check('vat_pct',                 parsed.vat_pct,                 'VAT (%)');
      }
    }

    res.json({ ok: true, parsed, row: r.rows[0], diff });
  } catch (e) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: `Bill upload failed: ${e.message}` });
  }
});

// Drag-to-reorder: receives the full ordered list of device ids, writes
// the index back to power_devices.sort_order. Mirrors the same pattern
// the media playlists use (POST /api/playlists/reorder).
// Reorder takes a list of row_ids — since multiple rows can share device_id
// (when channel-scoped), the synthetic row_id is the only unambiguous handle.
app.post('/api/power/devices/reorder', async (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order || !order.length) return res.status(400).json({ error: 'order array required' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE power_devices SET sort_order = NULL');
    for (let i = 0; i < order.length; i++) {
      const rid = parseInt(order[i], 10);
      if (!Number.isFinite(rid)) continue;
      await client.query(
        'UPDATE power_devices SET sort_order = $2, updated_at = NOW() WHERE row_id = $1',
        [rid, i],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: order.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// DELETE keyed on row_id. For virtual-device rows (manual_*/auto_* device_id),
// also remove the devices row IF this is the last power_devices row pointing
// at it — otherwise just remove the power_devices entry.
app.delete('/api/power/devices/:row_id', async (req, res) => {
  const rowId = parseInt(req.params.row_id, 10);
  if (!Number.isFinite(rowId)) return res.status(400).json({ error: 'row_id required' });
  try {
    const cur = await db.query('SELECT device_id FROM power_devices WHERE row_id = $1', [rowId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
    const deviceId = cur.rows[0].device_id;
    const isVirtual = deviceId.startsWith('manual_') || deviceId.startsWith('auto_');

    await db.query('DELETE FROM power_devices WHERE row_id = $1', [rowId]);

    if (isVirtual) {
      // Drop the virtual `devices` row IF no other power_devices row points
      // at it (virtual devices are uniquely created BY the registry).
      const remaining = await db.query(
        'SELECT 1 FROM power_devices WHERE device_id = $1 LIMIT 1',
        [deviceId],
      );
      if (remaining.rows.length === 0) {
        await db.query('DELETE FROM devices WHERE id = $1', [deviceId]);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Services status ──────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const result = { db: false, ha: false };
  await Promise.all([
    db.query('SELECT 1').then(() => { result.db = true; }).catch(() => {}),
    fetch(`${HA_URL}/api/`, {
      headers: getHaToken() ? { Authorization: `Bearer ${getHaToken()}` } : {},
      signal: AbortSignal.timeout(4000)
    }).then(r => { if (r.ok) result.ha = true; }).catch(() => {}),
  ]);
  res.json(result);
});

// ─── Consumptions ─────────────────────────────────────────────
app.get('/api/consumptions', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const from  = req.query.from || null;
  const to    = req.query.to   || null;
  try {
    const r = (from && to)
      ? await db.query(`
          SELECT id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at, cause, likely_rooms
          FROM boiler_consumptions
          WHERE start_ts >= $1 AND start_ts < $2
          ORDER BY start_ts ASC
        `, [from, to])
      : from
      ? await db.query(`
          SELECT id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at, cause, likely_rooms
          FROM boiler_consumptions
          WHERE start_ts >= $1
          ORDER BY start_ts ASC
        `, [from])
      : await db.query(`
          SELECT id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at, cause, likely_rooms
          FROM boiler_consumptions
          ORDER BY start_ts DESC
          LIMIT $1
        `, [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/consumptions/today', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        COUNT(*)                                                   AS count,
        COUNT(*) FILTER (WHERE cause = 'human')                    AS human,
        COUNT(*) FILTER (WHERE cause = 'panel')                    AS panel,
        COUNT(*) FILTER (WHERE cause = 'thermal')                  AS thermal,
        COUNT(*) FILTER (WHERE cause = 'boiler')                   AS boiler,
        COUNT(*) FILTER (WHERE cause = 'unknown')                  AS unknown,
        COUNT(*) FILTER (WHERE cause IS NULL)                      AS unclassified,
        MAX(drop_c)                                                AS max_drop,
        ROUND(AVG(drop_c)::numeric, 1)                             AS avg_drop,
        MAX(start_ts)                                              AS last_ts
      FROM boiler_consumptions
      WHERE start_ts >= (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
    `);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI Investigation ─────────────────────────────────────────
app.post('/api/ai-investigate', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in ecosystem.config.js' });
  }
  const { from_hour, to_hour, include_weather, include_outlook, include_agent_data, include_spatial } = req.body;
  const fh = parseInt(from_hour) || 7;
  const th = parseInt(to_hour)   || 14;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const [settingsR, agentR, weatherR, dailyR, latestRawR, coolingR, lastCloseR] = await Promise.all([
      db.query('SELECT * FROM agent_settings LIMIT 1'),
      include_agent_data
        ? db.query(`SELECT ts, boiler_temp, panel_temp, valve_state, boiler_trend, panel_trend, decision, why_decision
                    FROM agent_boiler_data ORDER BY ts DESC LIMIT 100`)
        : Promise.resolve({ rows: [] }),
      include_outlook
        ? db.query(`SELECT ts, condition, temp_ims, uv_index_ims, uv_index_balcony, illuminance_balcony
                    FROM raw_weather ORDER BY ts DESC LIMIT 24`)
        : Promise.resolve({ rows: [] }),
      include_weather
        ? db.query(`SELECT * FROM raw_weather_daily WHERE forecast_date >= CURRENT_DATE ORDER BY forecast_date ASC LIMIT 7`)
        : Promise.resolve({ rows: [] }),
      db.query(`SELECT ts, boiler_temp, valve_state FROM raw_data ORDER BY ts DESC LIMIT 1`),
      db.query(`
        SELECT
          ROUND(
            ((f.boiler_temp - l.boiler_temp) /
            NULLIF(EXTRACT(EPOCH FROM (l.ts - f.ts)) / 3600, 0))::numeric
          , 2) AS drop_per_hour
        FROM
          (SELECT boiler_temp, ts FROM raw_data
           WHERE valve_state = false AND ts >= NOW() - INTERVAL '14 hours'
           ORDER BY ts ASC LIMIT 1) f,
          (SELECT boiler_temp, ts FROM raw_data
           WHERE valve_state = false
           ORDER BY ts DESC LIMIT 1) l
      `),
      db.query(`
        SELECT ts FROM (
          SELECT ts, valve_state, LAG(valve_state) OVER (ORDER BY ts) AS prev
          FROM raw_data ORDER BY ts DESC LIMIT 500
        ) t WHERE valve_state = false AND prev = true
        ORDER BY ts DESC LIMIT 1
      `),
    ]);

    const settings   = settingsR.rows[0] || {};
    const tz  = 'Asia/Jerusalem';
    const fmt = ts => new Date(ts).toLocaleString('he-IL', { timeZone: tz });

    // Current state
    const latestRaw      = latestRawR.rows[0] || {};
    const currentBoiler  = latestRaw.boiler_temp != null ? parseFloat(latestRaw.boiler_temp) : null;
    const nowIL          = new Date().toLocaleString('en-US', { timeZone: tz });
    const nowDate        = new Date(nowIL);
    const nowHour        = nowDate.getHours();
    const nowMin         = nowDate.getMinutes();
    const hoursUntilWindow = ((fh - nowHour - nowMin / 60) + 24) % 24;

    const rawCoolingRate = coolingR.rows[0]?.drop_per_hour != null
      ? parseFloat(coolingR.rows[0].drop_per_hour)
      : null;
    // drop_per_hour = (first_temp - last_temp) / hours — positive means cooling
    // If <= 0 (boiler was heating or stable), fall back to 0.5°C/h minimum assumption
    const coolingRate = (rawCoolingRate != null && rawCoolingRate > 0.05)
      ? rawCoolingRate
      : 0.5;
    const estimatedStartTemp = currentBoiler != null
      ? Math.max(15, Math.round((currentBoiler - coolingRate * hoursUntilWindow) * 10) / 10)
      : null;

    // Panel validity at window start
    const panelValidAfterOff = parseInt(settings.panel_temp_valid_after_off) || 10;
    const lastCloseTs        = lastCloseR.rows[0]?.ts ? new Date(lastCloseR.rows[0].ts) : null;
    const minutesSinceClose  = lastCloseTs
      ? (Date.now() - lastCloseTs.getTime()) / 60000 + hoursUntilWindow * 60
      : 9999;
    const panelValidAtStart  = minutesSinceClose <= panelValidAfterOff;

    const startTempLine = estimatedStartTemp != null
      ? `BOILER TEMP AT ${fh}:00 (pre-calculated): ${estimatedStartTemp}°C`
      : `BOILER TEMP AT ${fh}:00: unknown`;
    const panelLine = panelValidAtStart
      ? `PANEL READING AT ${fh}:00: VALID (valve closed recently, within validity window)`
      : `PANEL READING AT ${fh}:00: INVALID — valve has been off for ~${Math.round(minutesSinceClose)} min, panel_temp_valid_after_off=${panelValidAfterOff} min. THE FIRST AGENT ACTION WILL BE A PROBE (open valve to check solar). Panel temp at ${fh}:00 is unknown — use outdoor/ambient temperature as estimate.`;

    const systemPrompt = `You are a solar boiler optimization AI. Analyze real operational data and suggest parameter tuning for a specific time window.

SYSTEM:
- Home solar boiler heated by solar panel water via a valve (ON/OFF)
- Agent controls valve based on temperature comparisons. Operational hours: 07:00-19:00 (Asia/Jerusalem)
- All temperatures in Celsius. Boiler loses heat passively when valve is off (overnight, cloudy).

VALVE LOGIC:
- Normal turn ON: panel_temp > boiler_temp + temp_debounce (only when panel reading is VALID)
- Probe: when panel reading is INVALID (too long after last valve close), open valve briefly to check
- Panel reading is VALID only within panel_temp_valid_after_off minutes after valve closes
- After that window expires, reading is INVALID until next probe/turn-on

THE 6 TUNABLE PARAMETERS:
1. run_interval_min — agent run frequency (min)
2. panel_temp_valid_after_on — min after valve ON before panel sensor stabilizes
3. panel_temp_valid_after_off — min after valve OFF that panel reading stays valid
4. trend_runs — runs used for trend calculation
5. temp_debounce — min °C gap required to act. LOW boiler temp → use LOWER debounce (boiler needs every degree)
6. probe_interval_min — min between probe attempts. LOW boiler temp → use SHORTER interval (probe more often)

RESPONSE FORMAT — return ONLY valid JSON, no text outside:
{
  "summary": "3 sentences: (1) current boiler temp and expected temp at window start after overnight cooling, (2) panel status at window start and first expected agent action, (3) solar potential and key recommendation",
  "settings": [
    { "param": "<name>", "current": <number>, "suggested": <number>, "reason": "<cite exact temps and why>" }
  ],
  "prediction": [
    { "time": "HH:MM", "boiler_temp": <number>, "panel_temp": <number>, "valve": <true|false> }
  ]
}
- prediction: one entry every 30 min from ${fh}:00 to ${th}:00
- For boiler_temp: show realistic evolution — starts cold, rises only when valve is ON and panel is warmer
- ${panelValidAtStart ? `Panel reading is VALID at window start` : `Panel reading is INVALID at window start (valve off too long). First entry: valve=false, panel_temp=outdoor ambient. First valve=true happens only after a probe opens`}
- settings: empty array if all params are already optimal`;

    const nowStr = `${nowHour}:${String(nowMin).padStart(2,'0')}`;
    let userContent = `=== WINDOW START CONDITIONS (pre-calculated, use these exactly) ===\n`;
    userContent += `Current time: ${nowStr} (Asia/Jerusalem)\n`;
    userContent += `Current boiler temp: ${currentBoiler != null ? currentBoiler + '°C' : 'unknown'}\n`;
    userContent += `Investigation window: ${fh}:00 – ${th}:00\n`;
    userContent += `Hours until window start: ${hoursUntilWindow.toFixed(1)}h\n`;
    userContent += `Cooling rate (measured, valve off): ${coolingRate}°C/hour\n`;
    userContent += `${startTempLine}\n`;
    userContent += `${panelLine}\n`;
    userContent += `\n=== CURRENT SETTINGS ===\n${JSON.stringify(settings, null, 2)}\n`;

    if (agentR.rows.length > 0) {
      userContent += `\nRECENT AGENT HISTORY (${agentR.rows.length} runs, newest first):\n`;
      userContent += agentR.rows.map(r =>
        `${fmt(r.ts)} | boiler:${r.boiler_temp}°C panel:${r.panel_temp}°C valve:${r.valve_state} bTrend:${r.boiler_trend} pTrend:${r.panel_trend} → ${r.decision} | ${r.why_decision}`
      ).join('\n');
    }
    if (weatherR.rows.length > 0) {
      userContent += `\n\nTODAY'S WEATHER (last 24h, newest first):\n`;
      userContent += weatherR.rows.map(r =>
        `${fmt(r.ts)} | ${r.condition} temp:${r.temp_ims}°C uv_ims:${r.uv_index_ims} uv_balcony:${r.uv_index_balcony} illuminance:${r.illuminance_balcony}`
      ).join('\n');
    }
    if (dailyR.rows.length > 0) {
      userContent += `\n\nWEATHER FORECAST:\n`;
      userContent += dailyR.rows.map(r =>
        `${r.forecast_date}: ${r.condition} high:${r.temp_high}°C low:${r.temp_low}°C rain:${r.precipitation_mm}mm`
      ).join('\n');
    }

    // Spatial context — apartment layout + live device state for room-aware reasoning
    if (include_spatial !== false) {
      try {
        const sceneText = await buildApartmentScene();
        if (sceneText && sceneText.length > 50) {
          userContent += `\n\n${sceneText}`;
        }
      } catch (e) {
        console.error('Failed to build apartment scene for AI:', e.message);
      }
    }

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = message.content[0].text.trim();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error('AI returned non-JSON response');
    }

    // ── Force-correct prediction starting conditions ──────────
    if (result.prediction && result.prediction.length > 0) {
      // 1. Shift all boiler temps so the first entry matches our calculated start temp
      if (estimatedStartTemp != null) {
        const aiStartBoiler = parseFloat(result.prediction[0].boiler_temp);
        const delta = estimatedStartTemp - aiStartBoiler;
        if (Math.abs(delta) > 0.1) {
          result.prediction = result.prediction.map(p => ({
            ...p,
            boiler_temp: Math.round((parseFloat(p.boiler_temp) + delta) * 10) / 10,
          }));
        }
      }
      // 2. If panel was invalid at window start, fix first entry
      if (!panelValidAtStart) {
        const ambientTemp = weatherR.rows[0]?.temp_ims != null
          ? parseFloat(weatherR.rows[0].temp_ims)
          : 15;
        result.prediction[0].valve      = false;
        result.prediction[0].panel_temp = ambientTemp;
      }
    }

    res.json({ ok: true, ran_at: new Date().toISOString(), from_hour: fh, to_hour: th, ...result,
      _debug: { system_prompt: systemPrompt, user_content: userContent } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Project Health — background status cache ─────────────────
const SSH_TIMEOUT = 5000;
let statusCache = null; // updated every 60s in background

function tcpCheck(host, port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.connect(port, host, () => { socket.destroy(); resolve({ ok: true }); });
    socket.on('error', () => { socket.destroy(); resolve({ ok: false }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function sshCheck(host, commands) {
  const ssh = new NodeSSH();
  const attempt = async () => {
    await ssh.connect({ host, username: SSH_USER, privateKeyPath: SSH_KEY, readyTimeout: SSH_TIMEOUT });
    const out = {};
    for (const [key, cmd] of Object.entries(commands)) {
      out[key] = (await ssh.execCommand(cmd)).stdout.trim();
    }
    ssh.dispose();
    return { ok: true, ...out };
  };
  const deadline = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), SSH_TIMEOUT)
  );
  try {
    return await Promise.race([attempt(), deadline]);
  } catch (e) {
    try { ssh.dispose(); } catch {}
    return { ok: false, error: e.message };
  }
}

async function runHealthChecks() {
  const [
    pgResult, haResult, pm2Result,
    rawDataResult, rawWeatherResult, orchLogResult, alertsResult, boilerDecisionResult, boilerServiceAlerts, mediaServiceAlerts, voiceAgentResult, autoScanResult,
    ruleEngineHeartbeat, ruleEngineServiceAlerts,
    backupJobsResult,
    vm101Result, lxc100Result, lxc102Result, lxc103Result, lxc104Result, lxc105Result, lxc106Result, lxc107Result, lxc108Result,
  ] = await Promise.all([
    db.query('SELECT 1').then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
    fetch(`${HA_URL}/api/`, { headers: { Authorization: `Bearer ${getHaToken()}` }, signal: AbortSignal.timeout(5000) })
      .then(r => ({ ok: r.ok })).catch(e => ({ ok: false, error: e.message })),
    new Promise(resolve => {
      exec('pm2.cmd jlist', { windowsHide: true }, (err, stdout) => {
        if (err) { resolve({ ok: false, error: err.message }); return; }
        try {
          const procs = JSON.parse(stdout);
          resolve({ ok: procs.every(p => p.pm2_env?.status === 'online'), raw: procs.map(p => `${p.name}: ${p.pm2_env?.status}`).join(', ') });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    }),
    db.query('SELECT MAX(ts) AS last_ts FROM raw_data').then(r => r.rows[0]?.last_ts).catch(() => null),
    db.query('SELECT MAX(ts) AS last_ts FROM raw_weather').then(r => r.rows[0]?.last_ts).catch(() => null),
    db.query('SELECT ts FROM orchestrator_log ORDER BY ts DESC LIMIT 1').then(r => r.rows[0]?.ts || null).catch(() => null),
    // Excludes network:* alerts — those drive the separate Network Integration badge.
    // Without this filter, the Health page Status card counted them too and double-fed
    // the sidebar Status badge from a second source.
    db.query("SELECT COUNT(*) AS n, MAX(severity) AS worst FROM system_alerts WHERE resolved_at IS NULL AND alert_type NOT LIKE 'network:%'")
      .then(r => ({ n: parseInt(r.rows[0]?.n) || 0, worst: r.rows[0]?.worst || null })).catch(() => ({ n: null, worst: null })),
    Promise.all([
      db.query('SELECT ts, decision FROM agent_boiler_data ORDER BY ts DESC LIMIT 1').catch(() => ({ rows: [] })),
      db.query('SELECT run_interval_min FROM agent_settings LIMIT 1').catch(() => ({ rows: [] })),
    ]).then(([bd, si]) => ({ lastTs: bd.rows[0]?.ts || null, decision: bd.rows[0]?.decision || null, runInterval: si.rows[0]?.run_interval_min || 5 })),
    db.query(`SELECT COUNT(*) AS n FROM system_alerts WHERE resolved_at IS NULL AND affected_agent = 'boiler' AND alert_type IN ('service_down','service_ssh_failed')`)
      .then(r => ({ ok: parseInt(r.rows[0]?.n) === 0 })).catch(() => ({ ok: null })),
    db.query(`SELECT affected_agent, COUNT(*) AS n FROM system_alerts WHERE resolved_at IS NULL AND affected_agent IN ('analyzer','player','ingest') AND alert_type IN ('service_down','service_ssh_failed') GROUP BY affected_agent`)
      .then(r => {
        const down = new Set(r.rows.map(row => row.affected_agent));
        return { analyzer: !down.has('analyzer'), player: !down.has('player'), ingest: !down.has('ingest') };
      }).catch(() => ({ analyzer: null, player: null, ingest: null })),
    db.query(`SELECT COUNT(*) AS n FROM system_alerts WHERE resolved_at IS NULL AND affected_agent = 'whisper-http' AND alert_type IN ('service_down','service_ssh_failed')`)
      .then(r => ({ ok: parseInt(r.rows[0]?.n) === 0 })).catch(() => ({ ok: null })),
    sshCheck('192.168.1.138', { age: "echo $(($(date +%s) - $(date +%s -r /var/log/auto_scan.log 2>/dev/null || echo 0)))" })
      .then(r => { const age = parseInt(r.age); return { ok: r.ok && !isNaN(age) && age <= 120, age_sec: isNaN(age) ? null : age }; }).catch(() => ({ ok: false, age_sec: null })),
    db.query('SELECT MAX(ts) AS last_ts FROM rule_engine_log').then(r => r.rows[0]?.last_ts || null).catch(() => null),
    db.query(`SELECT COUNT(*) AS n FROM system_alerts WHERE resolved_at IS NULL AND affected_agent = 'rule-engine' AND alert_type IN ('service_down','service_ssh_failed')`)
      .then(r => ({ ok: parseInt(r.rows[0]?.n) === 0 })).catch(() => ({ ok: null })),
    db.query(`
      SELECT j.id, j.name, j.max_age_hours,
             MAX(l.started_at) FILTER (WHERE l.status='ok') AS last_ok
      FROM backup_jobs j
      LEFT JOIN backup_log l ON l.job_id = j.id
      WHERE j.enabled = TRUE
      GROUP BY j.id, j.name, j.max_age_hours
    `).then(r => r.rows).catch(() => []),
    tcpCheck('192.168.1.110', 8123),  // VM 101 — Home Assistant
    tcpCheck('192.168.1.138', 22),    // LXC 100
    tcpCheck('192.168.1.219', 22),    // LXC 102 — Database
    tcpCheck('192.168.1.114', 22),    // LXC 103 — Agents
    tcpCheck('192.168.1.227', 22),    // LXC 104 — Commands
    tcpCheck('192.168.1.187', 22),    // LXC 105 — MainAgent
    tcpCheck('192.168.1.188', 22),    // LXC 106 — Voice
    tcpCheck('192.168.1.189', 22),    // LXC 107 — MQTT
    tcpCheck('192.168.1.195', 22),    // LXC 108 — NetBird gateway
  ]);

  const r = {};
  // Infrastructure
  r.postgres      = pgResult;
  r.homeassistant = haResult;
  // VM + LXC (TCP checks)
  r.vm101  = { ok: vm101Result.ok };
  r.lxc100 = { ok: lxc100Result.ok };
  r.lxc102 = { ok: lxc102Result.ok };
  r.lxc103 = { ok: lxc103Result.ok };
  r.lxc104 = { ok: lxc104Result.ok };
  r.lxc105 = { ok: lxc105Result.ok };
  r.lxc106 = { ok: lxc106Result.ok };
  r.lxc107 = { ok: lxc107Result.ok };
  r.lxc108 = { ok: lxc108Result.ok };
  // Server
  r.pm2 = pm2Result;
  // Services — boiler_agent status from orchestrator's system_alerts
  r.boiler_agent  = { ok: boilerServiceAlerts.ok };
  r.media_agents  = mediaServiceAlerts;
  r.voice_agent   = { ok: voiceAgentResult.ok };
  r.auto_scan     = autoScanResult;
  // Backup jobs freshness
  r.backup_jobs = (Array.isArray(backupJobsResult) ? backupJobsResult : []).map(j => {
    const ageH = j.last_ok ? (Date.now() - new Date(j.last_ok).getTime()) / 3600000 : null;
    return { name: j.name, age_hours: ageH !== null ? Math.round(ageH * 10) / 10 : null, ok: ageH !== null && ageH <= j.max_age_hours };
  });
  // Scripts — data freshness from DB
  const htpAge = rawDataResult ? (Date.now() - new Date(rawDataResult).getTime()) / 60000 : null;
  r.ha_to_pg = { last_ts: rawDataResult, age_min: htpAge !== null ? Math.round(htpAge) : null, data_ok: htpAge !== null && htpAge <= 15 };
  const cwAge = rawWeatherResult ? (Date.now() - new Date(rawWeatherResult).getTime()) / 60000 : null;
  r.collect_weather = { last_ts: rawWeatherResult, age_min: cwAge !== null ? Math.round(cwAge) : null, data_ok: cwAge !== null && cwAge <= 65 };
  // Data — freshness + orchestrator verdict
  const orchAge = orchLogResult ? (Date.now() - new Date(orchLogResult).getTime()) / 60000 : null;
  r.orchestrator_last_run = { last_ts: orchLogResult, age_min: orchAge !== null ? Math.round(orchAge) : null, ok: orchAge !== null && orchAge <= 70 };
  const bdAge = boilerDecisionResult.lastTs ? (Date.now() - new Date(boilerDecisionResult.lastTs).getTime()) / 60000 : null;
  r.boiler_last_decision = { last_ts: boilerDecisionResult.lastTs, age_min: bdAge !== null ? Math.round(bdAge) : null, decision: boilerDecisionResult.decision, ok: bdAge !== null && bdAge <= boilerDecisionResult.runInterval * 3 };
  const reAge = ruleEngineHeartbeat ? (Date.now() - new Date(ruleEngineHeartbeat).getTime()) / 60000 : null;
  const reHeartbeatOk = reAge !== null && reAge <= 3;
  r.rule_engine = {
    last_ts: ruleEngineHeartbeat,
    age_min: reAge !== null ? Math.round(reAge * 10) / 10 : null,
    service_ok: ruleEngineServiceAlerts.ok,
    heartbeat_ok: reHeartbeatOk,
    ok: ruleEngineServiceAlerts.ok === true && reHeartbeatOk,
  };
  r.active_alerts = { count: alertsResult.n, worst: alertsResult.worst, ok: alertsResult.n === 0 };

  // UPS — latest row from ups_status (populated by net-ups-poll on LXC 105 every 60 s)
  try {
    const upsR = await db.query(`
      SELECT status, battery_pct, runtime_min, line_volt, battery_volt,
             EXTRACT(EPOCH FROM (NOW() - ts))::int AS age_sec
        FROM ups_status ORDER BY ts DESC LIMIT 1
    `);
    const u = upsR.rows[0];
    if (!u) {
      r.ups = { ok: false, status: null, age_sec: null, msg: 'no data — check polling daemon' };
    } else {
      const status = (u.status || '').trim();
      const upper  = status.toUpperCase();
      const okStates = new Set(['ONLINE', 'ONLINE SLAVE']);
      const stale = (u.age_sec || 0) > 180;
      const ok = okStates.has(upper) && !stale;
      r.ups = {
        ok,
        status,
        battery_pct:  u.battery_pct  != null ? Number(u.battery_pct)  : null,
        runtime_min:  u.runtime_min  != null ? Number(u.runtime_min)  : null,
        line_volt:    u.line_volt    != null ? Number(u.line_volt)    : null,
        battery_volt: u.battery_volt != null ? Number(u.battery_volt) : null,
        age_sec: u.age_sec,
        stale,
      };
    }
  } catch (e) {
    r.ups = { ok: false, status: null, msg: 'query error: ' + e.message };
  }

  r.cached_at = new Date().toISOString();
  statusCache = r;
}

// Run immediately on startup, then every 60 s
runHealthChecks().catch(() => {});
setInterval(() => runHealthChecks().catch(() => {}), 60000);

// ─── Project Health — System Status ──────────────────────────
app.get('/api/health/status', (req, res) => {
  if (statusCache) return res.json(statusCache);
  // Cache not ready yet (first run still in progress) — wait for it
  runHealthChecks().then(() => res.json(statusCache)).catch(e => res.status(500).json({ error: e.message }));
});

// ─── Project Health — Dashboard self-stats ───────────────────
// LOC + on-disk footprint + RAM-of-this-process / total system RAM. Rendered
// next to System Status on the Health page header. Cached 60 s — none of
// these change fast and walking the dashboard tree on every poll is wasteful.
let _dashStatsCache = null;
let _dashStatsTs = 0;
const _DASH_STATS_TTL_MS = 60_000;
function _humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function _walkDashboard(root) {
  // Walk the dashboard subtree returning {loc, bytes}. Skips node_modules
  // (huge + not part of "the dashboard's code" by any meaningful measure)
  // and tmp/cache dirs.
  const SKIP_DIRS = new Set(['node_modules', '.git', 'tmp']);
  const COUNT_EXT = new Set(['.js', '.html', '.css', '.json']);
  let loc = 0, bytes = 0;
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        bytes += st.size;
        const ext = path.extname(e.name).toLowerCase();
        if (COUNT_EXT.has(ext)) {
          // Count newlines — cheap + good enough for LOC.
          const buf = fs.readFileSync(full);
          let n = 0;
          for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
          // +1 if file doesn't end with newline (still has content on last line)
          if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;
          loc += n;
        }
      } catch (_) { /* skip unreadable */ }
    }
  }
  return { loc, bytes };
}
app.get('/api/health/dashboard-stats', (req, res) => {
  if (_dashStatsCache && (Date.now() - _dashStatsTs) < _DASH_STATS_TTL_MS) {
    return res.json(_dashStatsCache);
  }
  try {
    const dashRoot = path.resolve(__dirname);
    const { loc, bytes } = _walkDashboard(dashRoot);
    const mem = process.memoryUsage();
    _dashStatsCache = {
      loc,
      disk_bytes:        bytes,
      disk_human:        _humanBytes(bytes),
      ram_process_bytes: mem.rss,
      ram_process_human: _humanBytes(mem.rss),
      ram_total_bytes:   os.totalmem(),
      ram_total_human:   _humanBytes(os.totalmem()),
      ram_pct:           Math.round((mem.rss / os.totalmem()) * 1000) / 10,  // 1 decimal
    };
    _dashStatsTs = Date.now();
    res.json(_dashStatsCache);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Project Health — DB Volumes ─────────────────────────────
app.get('/api/health/db-volumes', async (req, res) => {
  try {
    const tables = [
      'raw_data', 'agent_boiler_data', 'raw_weather', 'raw_weather_daily',
      'boiler_consumptions', 'orchestrator_log', 'sync_signals', 'system_alerts',
      'voice_token_log', 'manual_requests', 'voice_devices', 'voice_device_settings',
      'voice_intent_phrases', 'voice_device_entities', 'agents', 'agent_settings',
      'media_library', 'media_playlists',
      'face_registry', 'face_crops', 'person_embeddings', 'documents',
      'backup_storages', 'backup_jobs', 'backup_log',
      'devices', 'device_events', 'device_agent_log', 'device_blocklist',
      'rooms', 'net_devices', 'net_ports', 'net_scans',
      'rule_events', 'rule_engine_state', 'rule_engine_log',
      'pixoo_presets', 'pixoo_log', 'analyzer_settings', 'analyzer_log',
      'retention_policies', 'dashboard_settings', 'room_device_placements',
      'manual_people_log', 'ups_status',
      'hasp_panels', 'hasp_buttons', 'hasp_displays',
      'esp_boards',
      'power_consumption', 'power_devices', 'power_bills',
      'netbird_peers_local', 'netbird_tenant_settings',
      'device_locations', 'phone_trips',
    ];
    const tsCol = {
      raw_data: 'ts', agent_boiler_data: 'ts', raw_weather: 'ts', raw_weather_daily: 'ts',
      boiler_consumptions: 'start_ts', orchestrator_log: 'ts', sync_signals: 'ts',
      system_alerts: 'ts', voice_token_log: 'ts', manual_requests: 'ts',
      voice_devices: 'created_at', voice_device_settings: 'updated_at',
      voice_intent_phrases: 'created_at', voice_device_entities: null,
      agents: 'added_at', agent_settings: null,
      media_library: 'added_at', media_playlists: 'updated_at', face_registry: 'added_at',
      backup_storages: 'created_at', backup_jobs: 'created_at', backup_log: 'started_at',
      devices: 'last_seen', device_events: 'ts', device_agent_log: 'ts',
      device_blocklist: 'blocked_at', rooms: null, net_devices: 'last_seen',
      net_ports: null, net_scans: 'ts',
      rule_events: 'ts', rule_engine_state: 'updated_at', rule_engine_log: 'ts',
      pixoo_presets: 'created_at', pixoo_log: 'ts',
      analyzer_settings: null, analyzer_log: 'ts',
      face_crops: null, person_embeddings: null, documents: null,
      retention_policies: null,
      dashboard_settings: 'updated_at', room_device_placements: 'updated_at',
      manual_people_log: 'ts', ups_status: 'ts',
      hasp_panels: 'created_at', hasp_buttons: 'created_at', hasp_displays: 'created_at',
      esp_boards: 'created_at',
      power_consumption: 'ts',
      power_devices: 'updated_at',
      power_bills: 'uploaded_at',
      netbird_peers_local: 'updated_at',
      netbird_tenant_settings: 'updated_at',
      device_locations: 'ts',
      phone_trips: 'started_at',
    };

    const sizes = await db.query(`
      SELECT relname AS table_name,
             n_live_tup AS row_count,
             n_dead_tup AS dead_tup,
             CASE WHEN (n_live_tup + n_dead_tup) > 0
               THEN ROUND(n_dead_tup::numeric / (n_live_tup + n_dead_tup) * 100, 1)
               ELSE 0 END AS frag_pct,
             pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
             pg_total_relation_size(relid) AS size_bytes,
             GREATEST(last_vacuum, last_autovacuum) AS last_vacuumed
      FROM pg_stat_user_tables
      WHERE relname = ANY($1)
    `, [tables]);

    const ranges = await Promise.all(tables.map(t =>
      tsCol[t]
        ? db.query(`SELECT MIN(${tsCol[t]}) AS oldest, MAX(${tsCol[t]}) AS newest FROM ${t}`)
            .then(r => ({ table_name: t, oldest: r.rows[0]?.oldest, newest: r.rows[0]?.newest }))
            .catch(() => ({ table_name: t, oldest: null, newest: null }))
        : Promise.resolve({ table_name: t, oldest: null, newest: null })
    ));

    const rangeMap = Object.fromEntries(ranges.map(r => [r.table_name, r]));
    const result = tables.map(t => {
      const s = sizes.rows.find(r => r.table_name === t) || { row_count: 0, dead_tup: 0, frag_pct: 0, total_size: '—', size_bytes: 0 };
      return { table_name: t, row_count: parseInt(s.row_count) || 0,
               dead_tup: parseInt(s.dead_tup) || 0, frag_pct: parseFloat(s.frag_pct) || 0,
               total_size: s.total_size, size_bytes: parseInt(s.size_bytes) || 0,
               oldest: rangeMap[t]?.oldest || null, newest: rangeMap[t]?.newest || null,
               last_vacuumed: s.last_vacuumed || null };
    });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Project Health — MiniDLNA DB ────────────────────────────
app.get('/api/health/minidlna', async (req, res) => {
  try {
    const ssh = new NodeSSH();
    await ssh.connect({ host: MEDIA_LXC_IP, username: SSH_USER, privateKeyPath: SSH_KEY });
    const [countR, sizeR, orphanR, lastR] = await Promise.all([
      ssh.execCommand(`sqlite3 /var/cache/minidlna/files.db "SELECT COUNT(*) FROM details WHERE path IS NOT NULL AND path != '' AND path != '/mnt/media';"`),
      ssh.execCommand(`stat -c%s /var/cache/minidlna/files.db`),
      ssh.execCommand(`sqlite3 /var/cache/minidlna/files.db "SELECT COUNT(*) FROM details WHERE path IS NOT NULL AND path != '' AND path != '/mnt/media';" && find /mnt/media -type f | wc -l`),
      ssh.execCommand(`stat -c%Y /var/cache/minidlna/files.db`),
    ]);
    ssh.dispose();

    const indexed   = parseInt(countR.stdout?.trim()) || 0;
    const sizeBytes = parseInt(sizeR.stdout?.trim())  || 0;
    const lines     = orphanR.stdout?.trim().split('\n');
    const onDisk    = parseInt(lines?.[1]) || 0;
    const lastMod   = parseInt(lastR.stdout?.trim()) || 0;

    res.json({
      indexed,
      on_disk: onDisk,
      orphans: Math.max(0, indexed - onDisk),
      size_bytes: sizeBytes,
      size_pretty: sizeBytes < 1048576 ? Math.round(sizeBytes/1024) + ' KB' : (sizeBytes/1048576).toFixed(1) + ' MB',
      last_updated: lastMod ? new Date(lastMod * 1000).toISOString() : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Project Health — Retention Policies ─────────────────────
app.get('/api/health/retention', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM retention_policies ORDER BY table_name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/health/retention', async (req, res) => {
  const { table_name, keep_days, auto_clean, clean_interval_hours } = req.body;
  try {
    await db.query(`
      UPDATE retention_policies
      SET keep_days = $1, auto_clean = $2, clean_interval_hours = $3
      WHERE table_name = $4
    `, [keep_days ?? null, !!auto_clean, clean_interval_hours ?? 24, table_name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Project Health — Run Cleanup ────────────────────────────
app.post('/api/health/cleanup', async (req, res) => {
  const { table_name } = req.body; // null = all tables
  const tsCol = { raw_data: 'ts', agent_boiler_data: 'ts', raw_weather: 'ts', raw_weather_daily: 'ts', boiler_consumptions: 'start_ts', orchestrator_log: 'ts', sync_signals: 'ts' };
  try {
    const policies = await db.query(
      table_name
        ? 'SELECT * FROM retention_policies WHERE table_name = $1 AND keep_days IS NOT NULL'
        : 'SELECT * FROM retention_policies WHERE keep_days IS NOT NULL',
      table_name ? [table_name] : []
    );

    const results = [];
    for (const p of policies.rows) {
      const col = tsCol[p.table_name];
      if (!col) continue;
      const r = await db.query(
        `DELETE FROM ${p.table_name} WHERE ${col} < NOW() - INTERVAL '${parseInt(p.keep_days)} days'`
      );
      await db.query(`UPDATE retention_policies SET last_cleaned_at = NOW() WHERE table_name = $1`, [p.table_name]);
      results.push({ table_name: p.table_name, deleted: r.rowCount });
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Project Health — Vacuum Table ───────────────────────────
app.post('/api/health/vacuum', async (req, res) => {
  const { table_name } = req.body;
  if (!table_name || !/^[a-z_][a-z0-9_]*$/.test(table_name))
    return res.status(400).json({ error: 'Invalid table name' });
  try {
    await db.query(`VACUUM ANALYZE ${table_name}`);
    const stat = await db.query(
      `SELECT n_dead_tup, CASE WHEN (n_live_tup + n_dead_tup) > 0
         THEN ROUND(n_dead_tup::numeric / (n_live_tup + n_dead_tup) * 100, 1)
         ELSE 0 END AS frag_pct
       FROM pg_stat_user_tables WHERE relname = $1`, [table_name]);
    const row = stat.rows[0] || {};
    res.json({ ok: true, dead_tup: parseInt(row.n_dead_tup) || 0, frag_pct: parseFloat(row.frag_pct) || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Documents ───────────────────────────────────────────────
const DOCS_BASE = path.join('C:', 'Users', 'muroc', 'project_home', 'docs');

app.get('/api/documents', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM documents ORDER BY theme, sort_order, created_at');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/documents', async (req, res) => {
  const { title, url, theme, sort_order } = req.body;
  if (!title || !url || !theme) return res.status(400).json({ error: 'title, url and theme are required' });
  try {
    const r = await db.query(
      'INSERT INTO documents (title, url, theme, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [title.trim(), url.trim(), theme, parseInt(sort_order) || 0]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/documents/file', (req, res) => {
  const rel = req.query.path;
  if (!rel) return res.status(400).json({ error: 'path required' });
  const abs = path.resolve(DOCS_BASE, rel.replace(/^\//, ''));
  if (!abs.startsWith(DOCS_BASE)) return res.status(403).json({ error: 'forbidden' });
  res.sendFile(abs);
});

// ─── Network: latest scan summary ────────────────────────────
app.get('/api/network/summary', async (req, res) => {
  try {
    const [scan, ever] = await Promise.all([
      db.query('SELECT * FROM net_scans ORDER BY ts DESC LIMIT 1'),
      db.query('SELECT COUNT(*) AS n FROM net_devices'),
    ]);
    const s = scan.rows[0] || {};
    res.json({
      total_online:    s.total_online    ?? 0,
      total_offline:   s.total_offline   ?? 0,
      total_ever_seen: s.total_ever_seen ?? parseInt(ever.rows[0].n),
      last_scan:       s.ts              ?? null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Network: device list ─────────────────────────────────────
app.get('/api/network/devices', async (req, res) => {
  try {
    // LEFT JOIN devices via MAC so the frontend can classify red dots
    // (`d_protocol`, `d_device_type`, `d_last_source`). The columns are
    // NULL for net_devices rows that aren't registered as project devices
    // (transient guests, randomized MACs); the frontend tooltip falls
    // back to "unknown device, likely powered off or sleeping".
    const r = await db.query(`
      SELECT n.*,
             d.id           AS d_id,
             d.protocol     AS d_protocol,
             d.device_type  AS d_device_type,
             d.last_source  AS d_last_source
      FROM net_devices n
      LEFT JOIN devices d ON lower(d.mac::text) = lower(n.mac::text)
      ORDER BY n.last_online DESC NULLS LAST, n.mac ASC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Network: update device name ─────────────────────────────
app.post('/api/network/devices/:mac/name', async (req, res) => {
  const { mac } = req.params;
  const { name } = req.body;
  try {
    await db.query('UPDATE net_devices SET name = $1 WHERE mac = $2', [name || null, mac]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Network: port list ───────────────────────────────────────
app.get('/api/network/ports', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM net_ports ORDER BY port_index ASC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Network: update port name ───────────────────────────────
app.post('/api/network/ports/:idx/name', async (req, res) => {
  const idx  = parseInt(req.params.idx);
  const { name } = req.body;
  try {
    await db.query('UPDATE net_ports SET port_name = $1 WHERE port_index = $2', [name || null, idx]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Network: scan history for graph ─────────────────────────
app.get('/api/network/history', async (req, res) => {
  const limit = parseInt(req.query.limit) || 288; // 24h at 5min
  try {
    const r = await db.query(
      'SELECT ts, total_online, total_offline, total_ever_seen FROM net_scans ORDER BY ts DESC LIMIT $1',
      [limit]
    );
    res.json(r.rows.reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Network: timer status ────────────────────────────────────
app.get('/api/network/timers', async (req, res) => {
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: '192.168.1.227', username: 'root', privateKeyPath: SSH_KEY });
    const r = await ssh.execCommand(
      'systemctl status net-arp-scan.timer net-snmp-scan.timer --no-pager 2>&1'
    );
    ssh.dispose();
    // Parse "Trigger: Wed 2026-04-01 10:45:08 IDT; 4min 31s left"
    // (locale on LXC 104 is Asia/Jerusalem so timestamps come back as IDT or IST,
    // not UTC. Map them to numeric offsets so JS Date.parse handles them.)
    const timers = { arp: { next: null }, snmp: { next: null } };
    let current = null;
    for (const line of r.stdout.split('\n')) {
      // Detect block header — must check snmp before arp (snmp contains 'arp' substring)
      if (line.includes('net-snmp-scan.timer')) current = 'snmp';
      else if (line.includes('net-arp-scan.timer'))  current = 'arp';
      const m = line.match(/Trigger:\s+(.+?);/);
      if (m && current) {
        const tsStr = m[1].trim()
          .replace(/\s+UTC$/, ' +0000')
          .replace(/\s+IDT$/, ' +0300')   // Israel Daylight Time
          .replace(/\s+IST$/, ' +0200');  // Israel Standard Time
        const ms = new Date(tsStr).getTime();
        if (!isNaN(ms)) timers[current].next = ms;
      }
    }
    res.json(timers);
  } catch (e) { try { ssh.dispose(); } catch {} res.status(500).json({ error: e.message }); }
});

// Manual scan trigger — fires the systemd one-shot ARP scan AND then runs
// the group-health watchdog so any IP-collision / device-cloud-only /
// stale-local alerts get recomputed immediately based on the fresh ARP
// state. Without the chained watchdog the alerts would still take up to
// 5 min to update even after the user fixes the underlying problem.
//
// One SSH connection covers both commands. systemd one-shot for the ARP
// scan blocks `systemctl start` until ExecStart completes, so the
// watchdog only runs once the ARP table has been updated. Used by the
// "↻ Scan now" button in the Project Network overview card.
app.post('/api/network/scan', async (req, res) => {
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: '192.168.1.227', username: 'root', privateKeyPath: SSH_KEY });
    const arpR = await ssh.execCommand('systemctl start net-arp-scan.service');
    if (arpR.code !== 0) {
      ssh.dispose();
      return res.status(500).json({ error: `arp scan failed (exit ${arpR.code}): ${arpR.stderr || arpR.stdout}` });
    }
    // group_health_watchdog.py is the cron-driven script that evaluates
    // freshness/collision/cloud-only conditions and writes to
    // system_alerts. Running it right after ARP scan means the user sees
    // alerts clear (or fire) within the same click — no 5-min wait.
    const whR = await ssh.execCommand('/usr/bin/python3 /opt/group_health_watchdog.py');
    ssh.dispose();
    if (whR.code !== 0) {
      // Surface the failure but don't 500 — the ARP scan already succeeded.
      // User gets fresh devices table; alerts will still update on the next
      // cron tick (≤ 5 min).
      return res.json({ ok: true, watchdog_error: `exit ${whR.code}: ${whR.stderr || whR.stdout}` });
    }
    res.json({ ok: true });
  } catch (e) { try { ssh.dispose(); } catch {} res.status(500).json({ error: e.message }); }
});

// ───────────────────────────────────────────────────────────────────
// Project Gateway — NetBird peer identity overlay + tenant alert
// settings. Index: NETBIRD/CLAUDE.md. Tables: netbird_peers_local +
// netbird_tenant_settings on LXC 102. Token: NETBIRD_API_TOKEN in
// BOILER/dashboard/.env (consumed here) AND /etc/netbird-watchdog.env
// on LXC 104 (consumed by scripts/netbird_watchdog.py). When the env
// var is empty, every read endpoint returns 503 with a friendly error
// so the dashboard shell can render a "token missing" hint instead
// of an opaque failure.
// ───────────────────────────────────────────────────────────────────

const NETBIRD_API_BASE = 'https://api.netbird.io/api';
// Cache layout:
//   peers / peersTs               — raw /peers response (used by both endpoints)
//   routes / routesTs             — JOINED route objects {cidr, routing_peers, enabled,
//                                   …} produced by /api/gateway/routes. Has debounce
//                                   semantics applied. DO NOT write raw /networks here.
//   networksRaw / networksRawTs   — raw /networks response. Used by /api/gateway/status
//                                   for its lightweight healthy-count summary. Separate
//                                   slot so the two shapes can't collide.
const _NB_CACHE = {
  peers: null, peersTs: 0,
  routes: null, routesTs: 0,
  networksRaw: null, networksRawTs: 0,
};
const _NB_CACHE_TTL_MS = 30_000;
// Flap detection: tracks each peer's last COMMITTED `connected` state. A
// flip is only logged into gateway_peer_transitions after it persists for
// _NB_DEBOUNCE_MS — single-poll API blips from NetBird's control plane
// (occasionally reports all peers as offline for ~30 s while WireGuard is
// actually fine — verified 2026-06-01) are filtered out.
const _NB_PEER_STATE   = new Map();   // peer_id → committed boolean state
const _NB_PEER_PENDING = new Map();   // peer_id → { state: bool, ts: ms } when a flip is in-flight
const _NB_DEBOUNCE_MS  = 30_000;
// Same debounce pattern for the route's `enabled` flag. When /networks
// briefly reports routing_peers_count=0 (NetBird's control plane recomputing
// a network), we'd otherwise flash "— — Offline" on the dashboard for ~30 s.
// Now we serve the last known good route until offline persists for the
// debounce window. Keyed by network id.
const _NB_ROUTE_LAST_GOOD       = new Map();   // network_id → last route object that had enabled=true
const _NB_ROUTE_PENDING_OFFLINE = new Map();   // network_id → ts_ms when offline first seen

function _nbToken() {
  return (process.env.NETBIRD_API_TOKEN || '').trim();
}

async function _refreshPeersCache() {
  const fresh = await _nbFetch('/peers');
  const now = Date.now();
  for (const p of fresh) {
    const newState  = !!p.connected;
    const committed = _NB_PEER_STATE.get(p.id);
    const pending   = _NB_PEER_PENDING.get(p.id);

    if (committed === undefined) {
      // First time we see this peer — set committed state directly, no
      // transition logged (we have no prior baseline to flip from).
      _NB_PEER_STATE.set(p.id, newState);
      continue;
    }

    if (newState === committed) {
      // State matches the committed baseline. If a flip was pending, the
      // API reverted within the debounce window → discard it as noise.
      if (pending) _NB_PEER_PENDING.delete(p.id);
      continue;
    }

    // newState differs from committed → real flip candidate.
    if (!pending || pending.state !== newState) {
      // Start a fresh debounce timer for this flip direction.
      _NB_PEER_PENDING.set(p.id, { state: newState, ts: now });
      continue;
    }

    // Pending matches newState and has been in this state for a while.
    if (now - pending.ts >= _NB_DEBOUNCE_MS) {
      db.query(
        `INSERT INTO gateway_peer_transitions (peer_id, peer_name, from_state, to_state)
         VALUES ($1, $2, $3, $4)`,
        [p.id, p.name, committed ? 'connected' : 'disconnected', newState ? 'connected' : 'disconnected'],
      ).catch(e => console.error('[gateway] transition log failed:', e.message));
      _NB_PEER_STATE.set(p.id, newState);
      _NB_PEER_PENDING.delete(p.id);
    }
    // else: still inside the debounce window — wait for the next refresh.
  }
  _NB_CACHE.peers   = fresh;
  _NB_CACHE.peersTs = now;
  return fresh;
}

async function _nbFetch(path) {
  const token = _nbToken();
  if (!token) {
    const err = new Error('NETBIRD_API_TOKEN not configured');
    err.status = 503;
    throw err;
  }
  const url = `${NETBIRD_API_BASE}${path}`;
  const r = await fetch(url, {
    headers: { 'Authorization': `Token ${token}`, 'Accept': 'application/json' },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const err = new Error(`NetBird API ${r.status}: ${body.slice(0, 200) || r.statusText}`);
    err.status = r.status === 401 ? 401 : 502;
    throw err;
  }
  return r.json();
}

// GET /api/gateway/peers — live peer list from NetBird API joined with
// netbird_peers_local overlay. 30 s cache on the NetBird API hit so 5 s
// dashboard polling doesn't hammer the upstream.
app.get('/api/gateway/peers', async (req, res) => {
  try {
    const now = Date.now();
    if (!_NB_CACHE.peers || (now - _NB_CACHE.peersTs) > _NB_CACHE_TTL_MS) {
      await _refreshPeersCache();
    }
    const overlay = await db.query('SELECT * FROM netbird_peers_local');
    const overlayMap = new Map(overlay.rows.map(r => [r.peer_id, r]));
    const peers = (_NB_CACHE.peers || []).map(p => {
      const ov = overlayMap.get(p.id) || {};
      return {
        peer_id:      p.id,
        name:         p.name,
        fqdn:         p.dns_label || p.hostname,
        ip:           p.ip,
        connected:    !!p.connected,
        last_seen:    p.last_seen,
        os:           p.os,
        version:      p.version,
        user_name:    ov.user_name || null,
        role:         ov.role || null,
        device_label: ov.device_label || null,
        notes:        ov.notes || null,
        alert_offline_min: ov.alert_offline_min,
        alert_on_join:     ov.alert_on_join,
      };
    });
    res.json({ peers });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// PATCH /api/gateway/peer/:peer_id — upserts identity-overlay fields
app.patch('/api/gateway/peer/:peer_id', async (req, res) => {
  const allowed = ['user_name', 'role', 'device_label', 'notes', 'alert_offline_min', 'alert_on_join'];
  const fields = {};
  for (const k of allowed) if (k in (req.body || {})) fields[k] = req.body[k];
  if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'no allowed fields in body' });
  try {
    const cols = Object.keys(fields);
    const vals = cols.map(k => fields[k]);
    const setStr = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const insertCols = ['peer_id', ...cols].join(', ');
    const insertPlaceholders = ['$1', ...cols.map((_, i) => `$${i + 2}`)].join(', ');
    await db.query(
      `INSERT INTO netbird_peers_local (${insertCols})
       VALUES (${insertPlaceholders})
       ON CONFLICT (peer_id) DO UPDATE SET ${setStr}, updated_at = NOW()`,
      [req.params.peer_id, ...vals],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gateway/routes — NetBird's REST API splits route info across
// 3 endpoints: /networks (containers), /networks/{id}/resources (CIDR),
// /networks/{id}/routers (peer IDs). We join them here and resolve peer
// IDs against the cached peer list to surface friendly names.
//
// Failure handling: if a sub-fetch (/resources or /routers) throws, we
// FALL BACK to the raw /networks fields (routing_peers_count) for the
// enabled flag instead of pretending the route is offline. We also
// REFUSE to overwrite the cache when partial failures degraded the
// data — previous good data keeps serving until a clean refresh
// succeeds. Without this, a single transient NetBird API hiccup
// poisoned the cache for 30 s and the dashboard flipped to "Offline".
app.get('/api/gateway/routes', async (req, res) => {
  try {
    const now = Date.now();
    if (!_NB_CACHE.routes || (now - _NB_CACHE.routesTs) > _NB_CACHE_TTL_MS) {
      const nets = await _nbFetch('/networks');
      if (!_NB_CACHE.peers || (now - _NB_CACHE.peersTs) > _NB_CACHE_TTL_MS) {
        await _refreshPeersCache();
      }
      const peerById = new Map((_NB_CACHE.peers || []).map(p => [p.id, p.name]));
      let allCleanFetches = true;
      const expanded = await Promise.all((nets || []).map(async n => {
        let resources = null; let routers = null;   // null = sub-fetch failed
        try { resources = await _nbFetch(`/networks/${n.id}/resources`); }
        catch (_) { allCleanFetches = false; }
        try { routers   = await _nbFetch(`/networks/${n.id}/routers`); }
        catch (_) { allCleanFetches = false; }

        const rawRouterCount = Array.isArray(n.routers) ? n.routers.length
                              : (typeof n.routing_peers_count === 'number' ? n.routing_peers_count : 0);

        // "Clean" = sub-fetch came back AND had actual data. An empty
        // array is a transient NetBird state during route reconfiguration
        // (HTTP 200 with `[]` body) — render it the same way as a failed
        // sub-fetch, otherwise the dashboard flips to "Offline" for ~30 s
        // every time a route is briefly recomputed upstream.
        const resourcesClean = resources !== null && resources.length > 0;
        const routersClean   = routers   !== null && routers.length   > 0;
        if (!resourcesClean || !routersClean) allCleanFetches = false;

        // CIDR — only trust /resources when it actually has entries. Empty
        // array → show raw fallback marker instead of '—'.
        const cidrs = resourcesClean
          ? resources.map(r => r.address).filter(Boolean)
          : [];
        const cidrStr = cidrs.length
          ? cidrs.join(', ')
          : (rawRouterCount > 0 ? '(reconfiguring…)' : '—');

        // Peer names — same logic. Fall back to "<N peers>" from raw count
        // when /routers is empty or failed.
        const peerNames = routersClean
          ? routers.map(r => peerById.get(r.peer) || r.peer).filter(Boolean)
          : (rawRouterCount > 0 ? [`<${rawRouterCount} peer${rawRouterCount > 1 ? 's' : ''}>`] : []);

        // Enabled — require GOOD data from BOTH sub-endpoints with non-empty
        // arrays AND both confirming the route is active. Otherwise trust
        // /networks's rawRouterCount (route IS announcing if NetBird's
        // canonical network view says so).
        let enabled;
        if (resourcesClean && routersClean) {
          enabled = resources.some(r => r.enabled !== false)
                 && routers.some(r => r.enabled !== false);
        } else {
          enabled = rawRouterCount > 0;
        }

        const newRoute = {
          id:            n.id,
          network_name:  n.name,
          cidr:          cidrStr,
          routing_peers: peerNames,
          enabled:       enabled,
        };

        // Debounce offline transitions — if a previously-good route now
        // reports offline, serve the last known good version until the
        // offline state persists for _NB_DEBOUNCE_MS. Mirrors the peer
        // flap debouncer. Catches NetBird's "routing_peers_count briefly 0"
        // hiccup that otherwise paints "— — Offline" on the dashboard.
        const lastGood = _NB_ROUTE_LAST_GOOD.get(n.id);
        const pendingOffline = _NB_ROUTE_PENDING_OFFLINE.get(n.id);
        if (newRoute.enabled) {
          _NB_ROUTE_LAST_GOOD.set(n.id, newRoute);
          _NB_ROUTE_PENDING_OFFLINE.delete(n.id);
          return newRoute;
        }
        // newRoute.enabled === false at this point.
        if (!lastGood) {
          // No prior good state — first time we've seen this route, accept as-is.
          return newRoute;
        }
        if (!pendingOffline) {
          // First offline report after a known-good period → start debounce.
          _NB_ROUTE_PENDING_OFFLINE.set(n.id, now);
          return lastGood;
        }
        if (now - pendingOffline < _NB_DEBOUNCE_MS) {
          // Still within debounce window → keep serving last good.
          return lastGood;
        }
        // Offline state has persisted past the debounce → commit.
        _NB_ROUTE_LAST_GOOD.delete(n.id);
        _NB_ROUTE_PENDING_OFFLINE.delete(n.id);
        return newRoute;
      }));

      // Only commit to cache if every sub-fetch succeeded. On partial failure
      // we still SERVE the expanded data (best effort), but the cache stays
      // empty / stale so the next request gets a fresh attempt instead of
      // serving 30 s of degraded data.
      if (allCleanFetches) {
        _NB_CACHE.routes   = expanded;
        _NB_CACHE.routesTs = now;
      }
      return res.json({ routes: expanded });
    }
    res.json({ routes: _NB_CACHE.routes });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/gateway/transitions?limit=20 — Recent peer connected/disconnected
// flips written by _refreshPeersCache. Hand-evidence for "is the gateway
// actually flapping or is it just a UI artifact" debugging.
app.get('/api/gateway/transitions', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  try {
    const r = await db.query(
      `SELECT id, ts, peer_id, peer_name, from_state, to_state, source
       FROM gateway_peer_transitions
       ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    res.json({ transitions: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gateway/settings — singleton row in netbird_tenant_settings
app.get('/api/gateway/settings', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM netbird_tenant_settings WHERE id = 1');
    res.json(r.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/gateway/settings — update tenant-wide alert prefs
app.post('/api/gateway/settings', async (req, res) => {
  const b = req.body || {};
  try {
    await db.query(
      `UPDATE netbird_tenant_settings
       SET alert_new_peer    = COALESCE($1, alert_new_peer),
           alert_route_drop  = COALESCE($2, alert_route_drop),
           poll_interval_sec = COALESCE($3, poll_interval_sec),
           trusted_peers     = COALESCE($4::jsonb, trusted_peers),
           updated_at = NOW()
       WHERE id = 1`,
      [
        typeof b.alert_new_peer   === 'boolean' ? b.alert_new_peer   : null,
        typeof b.alert_route_drop === 'boolean' ? b.alert_route_drop : null,
        Number.isFinite(b.poll_interval_sec) ? b.poll_interval_sec : null,
        Array.isArray(b.trusted_peers) ? JSON.stringify(b.trusted_peers) : null,
      ],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gateway/status — lightweight summary for sidebar badge
app.get('/api/gateway/status', async (req, res) => {
  if (!_nbToken()) {
    return res.status(503).json({ error: 'NETBIRD_API_TOKEN not configured', peers: { total: 0, online: 0 }, routes: { total: 0, healthy: 0 }, alerts: { active: 0 } });
  }
  try {
    const now = Date.now();
    if (!_NB_CACHE.peers || (now - _NB_CACHE.peersTs) > _NB_CACHE_TTL_MS) {
      await _refreshPeersCache();
    }
    // Status uses raw /networks for the lightweight badge summary — kept in
    // its OWN cache slot so it never collides with the joined-shape data
    // /api/gateway/routes serves to the Routes table (collision used to
    // paint "— — Offline" rows whenever status's poll hit first).
    if (!_NB_CACHE.networksRaw || (now - _NB_CACHE.networksRawTs) > _NB_CACHE_TTL_MS) {
      _NB_CACHE.networksRaw   = await _nbFetch('/networks');
      _NB_CACHE.networksRawTs = now;
    }
    const peers   = _NB_CACHE.peers || [];
    const networks = _NB_CACHE.networksRaw || [];
    const alertR  = await db.query(`SELECT COUNT(*)::int AS n FROM system_alerts WHERE alert_type LIKE 'netbird:%' AND resolved_at IS NULL`);
    res.json({
      peers:  { total: peers.length,  online:  peers.filter(p => p.connected).length },
      // Raw-shape networks have `routing_peers_count` (number) or `routers`
      // (array) instead of an `enabled` boolean. A route is healthy when at
      // least one routing peer is announcing it.
      routes: {
        total:   networks.length,
        healthy: networks.filter(n => {
          const rc = Array.isArray(n.routers) ? n.routers.length
                                              : (typeof n.routing_peers_count === 'number' ? n.routing_peers_count : 0);
          return rc > 0;
        }).length,
      },
      alerts: { active: alertR.rows[0]?.n || 0 },
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/gateway/watchdog/run — manual trigger of the LXC 104 watchdog.
// Same script the cron runs every 5 min; this just runs it on demand so
// the user doesn't have to wait when they've just changed settings.
app.post('/api/gateway/watchdog/run', async (req, res) => {
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: '192.168.1.227', username: 'root', privateKeyPath: SSH_KEY });
    const r = await ssh.execCommand(
      'set -a; . /etc/netbird-watchdog.env; set +a; /usr/bin/python3 /opt/netbird_watchdog.py 2>&1'
    );
    ssh.dispose();
    if (r.code !== 0) {
      return res.status(500).json({ error: `watchdog exited ${r.code}`, output: r.stdout || r.stderr });
    }
    // The watchdog logs "Pass complete: N peers, N networks; offline_alerts=N"
    const m = (r.stdout || '').match(/Pass complete:.*/);
    res.json({ ok: true, summary: m ? m[0].trim() : 'OK', output: r.stdout });
  } catch (e) {
    try { ssh.dispose(); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// GET /api/gateway/events?limit=20 — recent system_alerts of type netbird:*
app.get('/api/gateway/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  try {
    const r = await db.query(
      `SELECT id, ts, alert_type, severity, message, resolved_at, affected_agent, source
       FROM system_alerts
       WHERE alert_type LIKE 'netbird:%'
       ORDER BY ts DESC
       LIMIT $1`,
      [limit],
    );
    res.json({ events: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/gateway/events/clear-resolved — wipe every resolved netbird:*
// alert. Active alerts (resolved_at IS NULL) are kept so the system_alerts
// card on Project Health still surfaces them.
app.delete('/api/gateway/events/clear-resolved', async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM system_alerts
       WHERE alert_type LIKE 'netbird:%' AND resolved_at IS NOT NULL`
    );
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ───────────────────────────────────────────────────────────────────
// Project Geolocation — phone movement tracking. Index:
// GEOLOCATION/CLAUDE.md. Tables: device_locations on LXC 102 (time
// series of GPS pings) + device_events rows for geofence:home /
// geofence:away crossings. Settings live in
// dashboard_settings.geolocation (singleton JSONB). Ingest runs on
// LXC 104 via systemd timer (geolocation-ingest.timer, 30 s cadence).
// ───────────────────────────────────────────────────────────────────

// 5-point median outlier filter for the trail. For each ping in a
// chronological list, take 2 neighbors on each side (5-ping window),
// compute the median lat/lon, and flag the center ping as outlier when
// its distance from that median exceeds 3× the neighbors' spread (and
// at least MIN_OUTLIER_DIST_M as an absolute floor so stationary
// jitter isn't flagged). Robust against single isolated bad pings
// (e.g. HA Companion publishing a stale home-area position while the
// phone is actually walking outdoors — verified 2026-06-01).
//
// First 2 and last 2 pings of the window keep is_outlier=false
// because they don't have enough context. Rare misses there are
// acceptable; bigger picture is to suppress mid-window glitches.
function _haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function _median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n/2 - 1] + sorted[n/2]) / 2;
}
function _flagOutliers(locs, opts) {
  const out = locs.map(p => ({ ...p, is_outlier: false }));
  if (locs.length === 0) return out;

  // Step 1 — stuck-source detector. Real GPS chips ALWAYS jitter between
  // consecutive fixes (sub-meter noise minimum). If two consecutive pings
  // from the same device report bit-identical lat/lon, the second is a
  // cached replay of the first — typically HA Companion in Samsung
  // battery-saver mode where the location service stops refreshing but
  // the app keeps publishing the last-known coord every minute.
  // Verified 2026-06-01: HA published the same (32.16750, 34.89958)
  // 18 times while the user was actually walking 100-400m away.
  for (let i = 1; i < locs.length; i++) {
    const prev = locs[i - 1];
    const p = locs[i];
    if (Math.abs(Number(p.lat) - Number(prev.lat)) < 0.00001 &&
        Math.abs(Number(p.lon) - Number(prev.lon)) < 0.00001) {
      out[i].is_outlier = true;
    }
  }

  // Step 2 — 5-point median outlier filter for isolated bad pings
  // (e.g. WiFi-DB poisoning sending a single ping to Dead Sea coords).
  // Skips already-flagged stuck pings so they don't poison the window.
  const HALF = 2;
  const OUTLIER_RATIO = 3;
  const MIN_OUTLIER_DIST_M = 30;
  const usable = locs.map((p, i) => out[i].is_outlier ? null : p);
  for (let i = HALF; i < locs.length - HALF; i++) {
    if (out[i].is_outlier) continue;
    const window = usable.slice(i - HALF, i + HALF + 1).filter(Boolean);
    if (window.length < 3) continue;
    const medianLat = _median(window.map(w => Number(w.lat)));
    const medianLon = _median(window.map(w => Number(w.lon)));
    const neighbors = window.filter(w => w !== locs[i]);
    if (neighbors.length === 0) continue;
    const neighborGaps = neighbors.map(n => _haversineM(Number(n.lat), Number(n.lon), medianLat, medianLon));
    const spread = Math.max(...neighborGaps);
    const myGap = _haversineM(Number(locs[i].lat), Number(locs[i].lon), medianLat, medianLon);
    const threshold = Math.max(OUTLIER_RATIO * spread, MIN_OUTLIER_DIST_M);
    if (myGap > threshold) out[i].is_outlier = true;
  }

  // Step 3 — Outdoor low-accuracy filter. The chip's reported accuracy_m
  // is the best signal for "GPS lost a clean satellite lock" — when it
  // climbs above 40m, the reported position drifts laterally by 50-150m
  // (verified 2026-06-01 against ground-truth user feedback). For pings
  // INSIDE the home radius this drift is irrelevant (they all cluster
  // at home anyway). For pings OUTSIDE the radius the drift moves them
  // off the real walking path. Flag those.
  if (opts && opts.centerLat != null && opts.centerLon != null && opts.radiusM > 0) {
    const accThreshold = opts.outsideAccThresholdM || 40;
    for (let i = 0; i < locs.length; i++) {
      if (out[i].is_outlier) continue;
      const acc = Number(locs[i].accuracy_m);
      if (!(acc > accThreshold)) continue;
      const dist = _haversineM(opts.centerLat, opts.centerLon,
                               Number(locs[i].lat), Number(locs[i].lon));
      if (dist > opts.radiusM) out[i].is_outlier = true;
    }
  }
  return out;
}

// GET /api/geolocation/settings — read singleton config
app.get('/api/geolocation/settings', async (req, res) => {
  try {
    const r = await db.query("SELECT value FROM dashboard_settings WHERE key = 'geolocation'");
    const defaults = {
      center:                { lat: 32.1593, lon: 34.8932 },
      home_radius_m:         80,
      tracked_devices:       [],
      retention_days:        30,
      geofence_events:       true,
      trail_window_default:  '24h',
      low_accuracy_filter_m: 100,
      outside_accuracy_threshold_m: 40,
      stale_alert_hours:     6,
      dedup_radius_m:        25,
      dedup_window_sec:      60,
      sensor_veto_enabled:           false,
      sensor_veto_still_debounce_sec: 60,
    };
    const val = r.rows[0]?.value || defaults;
    // Merge defaults for missing keys so frontend never breaks
    res.json({ ...defaults, ...val });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/geolocation/settings — replace config
app.post('/api/geolocation/settings', async (req, res) => {
  const cfg = req.body || {};
  // Allow-listed fields only; reject anything else to keep DB clean
  const allowed = ['center', 'home_radius_m', 'tracked_devices', 'retention_days',
                   'geofence_events', 'geofence_heartbeat_sec', 'trail_window_default',
                   'low_accuracy_filter_m', 'outside_accuracy_threshold_m',
                   'stale_alert_hours', 'dedup_radius_m', 'dedup_window_sec',
                   'sensor_veto_enabled', 'sensor_veto_still_debounce_sec'];
  const clean = {};
  for (const k of allowed) if (k in cfg) clean[k] = cfg[k];
  try {
    await db.query(
      `INSERT INTO dashboard_settings (key, value, updated_at)
       VALUES ('geolocation', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(clean)],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geolocation/locations?device_id=X&since=ISO&limit=N
// Returns trail points for a device, newest first. Default window 24h.
app.get('/api/geolocation/locations', async (req, res) => {
  const deviceId = String(req.query.device_id || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'device_id required' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 10000);
  const sinceStr = req.query.since;
  try {
    const params = [deviceId];
    let where = 'device_id = $1';
    if (sinceStr) {
      params.push(sinceStr);
      where += ` AND ts >= $${params.length}`;
    }
    params.push(limit);
    const r = await db.query(
      `SELECT id, ts, lat, lon, accuracy_m, altitude_m, speed, battery_pct, source
       FROM device_locations
       WHERE ${where}
       ORDER BY ts ASC
       LIMIT $${params.length}`,
      params,
    );
    // Pull center+radius once so the outdoor low-accuracy filter knows
    // which pings are outside the home circle (those need the strict
    // accuracy threshold; indoor pings are exempt).
    const s = await db.query("SELECT value FROM dashboard_settings WHERE key = 'geolocation'");
    const cfg = s.rows[0]?.value || {};
    const opts = {
      centerLat: cfg.center?.lat,
      centerLon: cfg.center?.lon,
      radiusM:   Number(cfg.home_radius_m) || 80,
      outsideAccThresholdM: Number(cfg.outside_accuracy_threshold_m) || 40,
    };
    res.json({ device_id: deviceId, locations: _flagOutliers(r.rows, opts) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geolocation/status — latest position per tracked-device GROUP
// + home/away/offline classification. Multiple tracked_devices entries
// can share a group_id (e.g. both HA Companion + OwnTracks of the same
// phone). Each group collapses to a single returned row using the
// freshest ping from any member. Entries without group_id stay
// standalone (group_id defaults to the device_id itself).
app.get('/api/geolocation/status', async (req, res) => {
  try {
    const s = await db.query("SELECT value FROM dashboard_settings WHERE key = 'geolocation'");
    const cfg = s.rows[0]?.value || {};
    const devices = Array.isArray(cfg.tracked_devices) ? cfg.tracked_devices : [];
    const center = cfg.center || {};
    const radius = Number(cfg.home_radius_m) || 80;
    const staleHours = Number(cfg.stale_alert_hours) || 6;
    // 1) Per-device latest ping (unchanged from before).
    const perDevice = await Promise.all(devices.map(async d => {
      const r = await db.query(
        `SELECT ts, lat, lon, accuracy_m, battery_pct FROM device_locations
         WHERE device_id = $1 ORDER BY ts DESC LIMIT 1`,
        [d.device_id],
      );
      return { dev: d, last: r.rows[0] || null };
    }));
    // 2) Collapse by group_id — pick member with the newest `last.ts`.
    const groups = new Map();
    for (const item of perDevice) {
      const gid = item.dev.group_id || item.dev.device_id;
      const prev = groups.get(gid);
      if (!prev) { groups.set(gid, item); continue; }
      if (item.last && (!prev.last || new Date(item.last.ts) > new Date(prev.last.ts))) {
        groups.set(gid, item);
      }
    }
    // 3) Format each group as one status row.
    const rows = [...groups.values()].map(({ dev, last }) => {
      const groupId = dev.group_id || dev.device_id;
      if (!last) {
        return { device_id: groupId, name: dev.name, status: 'no_data' };
      }
      const ageMs = Date.now() - new Date(last.ts).getTime();
      const stale = ageMs > staleHours * 3600_000;
      let distance = null, isHome = null;
      if (center.lat != null && center.lon != null) {
        const R = 6_371_000;
        const p1 = center.lat * Math.PI / 180;
        const p2 = Number(last.lat) * Math.PI / 180;
        const dp = (Number(last.lat) - center.lat) * Math.PI / 180;
        const dl = (Number(last.lon) - center.lon) * Math.PI / 180;
        const a  = Math.sin(dp/2)**2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2)**2;
        distance = 2 * R * Math.asin(Math.sqrt(a));
        isHome   = distance <= radius;
      }
      return {
        device_id:    groupId,
        name:         dev.name,
        status:       stale ? 'stale' : (isHome === true ? 'home' : (isHome === false ? 'away' : 'unknown')),
        ts:           last.ts,
        age_sec:      Math.round(ageMs / 1000),
        lat:          Number(last.lat),
        lon:          Number(last.lon),
        accuracy_m:   last.accuracy_m,
        battery_pct:  last.battery_pct,
        distance_m:   distance != null ? Math.round(distance) : null,
        freshest_source: dev.source,
      };
    });
    res.json({ devices: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geolocation/sensor-states — live values of the HA Companion
// entities referenced by tracked_devices' veto config (activity, wifi,
// android_auto). Used by the Settings card to display current sensor
// state in the "Sensor entities HA" table cells.
//
// Narrow on purpose: only fetches entity IDs already in the tracked_devices
// settings — no general HA-state proxy. Failed lookups become `null` per
// entity; the dashboard renders these as a grey dash.
app.get('/api/geolocation/sensor-states', async (req, res) => {
  try {
    const s = await db.query("SELECT value FROM dashboard_settings WHERE key = 'geolocation'");
    const cfg  = s.rows[0]?.value || {};
    const devs = Array.isArray(cfg.tracked_devices) ? cfg.tracked_devices : [];
    const ids  = new Set();
    for (const d of devs) {
      for (const k of ['ha_entity', 'battery_entity', 'activity_entity', 'wifi_entity', 'android_auto_entity']) {
        if (d[k]) ids.add(d[k]);
      }
    }
    const token = (process.env.HA_TOKEN || '').trim();
    const haUrl = 'http://192.168.1.110:8123';
    const out = {};
    await Promise.all([...ids].map(async eid => {
      try {
        const r = await fetch(`${haUrl}/api/states/${encodeURIComponent(eid)}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) { out[eid] = null; return; }
        const d = await r.json();
        out[eid] = { state: d.state, last_changed: d.last_changed };
      } catch (_) { out[eid] = null; }
    }));
    res.json({ states: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/geolocation/run-ingest — manual trigger of the LXC 104
// systemd unit. Same as `systemctl start geolocation-ingest.service`;
// the user clicks this after editing settings or charging the phone
// and doesn't want to wait for the next 30 s tick.
app.post('/api/geolocation/run-ingest', async (req, res) => {
  const { NodeSSH } = require('node-ssh');
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: '192.168.1.227', username: 'root', privateKeyPath: SSH_KEY });
    await ssh.execCommand('systemctl start geolocation-ingest.service');
    // The unit runs oneshot, so by the time the start returns it's complete.
    const r = await ssh.execCommand('tail -1 /var/log/geolocation-ingest.log');
    ssh.dispose();
    res.json({ ok: true, summary: r.stdout.trim() || 'started' });
  } catch (e) {
    try { ssh.dispose(); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geolocation/trips?limit=20 — closed trips with summary stats.
// Open trips (returned_at IS NULL) are excluded by default; pass
// ?include_open=1 to also return the in-progress trip with its current
// duration so far.
app.get('/api/geolocation/trips', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
  const includeOpen = req.query.include_open === '1';
  try {
    const r = await db.query(
      `SELECT id, group_id, device_label, started_at, returned_at,
              duration_sec, max_dist_m, path_length_m, outside_pings
       FROM phone_trips
       ${includeOpen ? '' : 'WHERE returned_at IS NOT NULL'}
       ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ trips: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geolocation/events?limit=20 — recent geofence crossings from
// either ingest path (HA Companion → geolocation_ingest, MQTT → owntracks_ingest).
app.get('/api/geolocation/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
  try {
    const r = await db.query(
      `SELECT id, ts, device_id, source, dps
       FROM device_events
       WHERE source IN ('geolocation_ingest', 'owntracks_ingest')
       ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    res.json({ events: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/geolocation/events — wipe BOTH the geofence events AND every
// device_locations row, so the "Clear all geolocation data" button on the
// dashboard fully empties the map + the events table in one click. Both
// ingest paths (HA Companion + OwnTracks) are covered.
app.delete('/api/geolocation/events', async (req, res) => {
  try {
    const evt = await db.query(
      "DELETE FROM device_events WHERE source IN ('geolocation_ingest', 'owntracks_ingest')"
    );
    const loc = await db.query("DELETE FROM device_locations");
    res.json({ ok: true, events_deleted: evt.rowCount, locations_deleted: loc.rowCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── System Alerts ───────────────────────────────────────────
app.get('/api/health/alerts', async (req, res) => {
  const includeResolved = req.query.include_resolved === 'true';
  // Optional type_prefix filter — used by Project Network's System Alerts card
  // to show only network:* alerts. ASCII-only, max 40 chars; PG `LIKE` pattern
  // is built as `<prefix>%` so callers pass the prefix without the wildcard.
  const rawPrefix = (req.query.type_prefix || '').toString();
  const typePrefix = /^[a-z0-9_:]{1,40}$/i.test(rawPrefix) ? rawPrefix : '';
  // Mirror filter for negative selection — Health page uses
  // ?type_prefix_exclude=network: so the network alerts only appear on the
  // Project Network page, not duplicated on Health.
  const rawExclude = (req.query.type_prefix_exclude || '').toString();
  const typeExclude = /^[a-z0-9_:]{1,40}$/i.test(rawExclude) ? rawExclude : '';
  try {
    const where = [];
    const params = [];
    if (!includeResolved) where.push('resolved_at IS NULL');
    if (typePrefix) {
      params.push(typePrefix + '%');
      where.push(`alert_type LIKE $${params.length}`);
    }
    if (typeExclude) {
      params.push(typeExclude + '%');
      where.push(`alert_type NOT LIKE $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await db.query(`
      SELECT id,
             ts AT TIME ZONE 'Asia/Jerusalem' AS ts_local,
             severity, affected_agent, alert_type, message,
             resolved_at AT TIME ZONE 'Asia/Jerusalem' AS resolved_local
      FROM system_alerts
      ${whereSql}
      ORDER BY resolved_at NULLS FIRST, ts DESC
      LIMIT 50
    `, params);
    let resolvedCount;
    if (includeResolved) {
      resolvedCount = r.rows.filter(x => x.resolved_local).length;
    } else {
      const cParams = [];
      const cWhere = ['resolved_at IS NOT NULL'];
      if (typePrefix) {
        cParams.push(typePrefix + '%');
        cWhere.push(`alert_type LIKE $${cParams.length}`);
      }
      if (typeExclude) {
        cParams.push(typeExclude + '%');
        cWhere.push(`alert_type NOT LIKE $${cParams.length}`);
      }
      const cQ = await db.query(`SELECT COUNT(*) AS n FROM system_alerts WHERE ${cWhere.join(' AND ')}`, cParams);
      resolvedCount = cQ.rows[0].n;
    }
    res.json({ rows: r.rows, resolved_count: parseInt(resolvedCount) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Integration health — count of active group_stale alerts (device-integration stalls)
app.get('/api/health/integrations', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT COUNT(*) AS n, COALESCE(json_agg(alert_type), '[]'::json) AS groups
      FROM system_alerts
      WHERE resolved_at IS NULL AND alert_type LIKE 'group_stale:%'
    `);
    res.json({ count: parseInt(r.rows[0].n), groups: r.rows[0].groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Network health — count of active network:* alerts (per-device LAN reachability problems).
// Drives the "Network Integration" badge in the sidebar; clicking the badge goes to
// Project Network where the same alerts are rendered in detail (System Alerts card).
// Excludes severity='info' — those are "pending drift detection" markers the
// watchdog uses to track when a device first entered a drifted state; they only
// promote to severity='warn' (and thus the badge) after the maturity threshold.
app.get('/api/health/network-integrations', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT COUNT(*) AS n, COALESCE(json_agg(alert_type), '[]'::json) AS groups
      FROM system_alerts
      WHERE resolved_at IS NULL
        AND alert_type LIKE 'network:%'
        AND severity != 'info'
    `);
    res.json({ count: parseInt(r.rows[0].n), groups: r.rows[0].groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/health/alerts/resolved', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM system_alerts WHERE resolved_at IS NOT NULL');
    res.json({ deleted: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orchestrator Log ────────────────────────────────────────
app.get('/api/health/orch-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const r = await db.query(
      `SELECT id, ts AT TIME ZONE 'Asia/Jerusalem' AS ts_local, severity, message
       FROM orchestrator_log ORDER BY ts DESC, id DESC LIMIT $1`,
      [limit]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Rule Engine State ───────────────────────────────────────
app.get('/api/rule-engine/state', async (req, res) => {
  try {
    const stateR = await db.query('SELECT key, value FROM rule_engine_state ORDER BY key');
    const state = {};
    for (const row of stateR.rows) state[row.key] = row.value;

    const hbR = await db.query(
      `SELECT ts AT TIME ZONE 'Asia/Jerusalem' AS ts, decision, error
       FROM rule_engine_log ORDER BY ts DESC LIMIT 1`
    );
    const heartbeat = hbR.rows[0] || {};

    // Gather all known rooms
    let rooms = [];
    try {
      const roomsR = await db.query('SELECT name FROM rooms ORDER BY name');
      rooms = roomsR.rows.map(r => r.name);
    } catch (_) { }

    // MQTT data health — count device DPS status
    let mqttHealth = { total: 0, clean: 0, empty: 0, noisy: 0 };
    try {
      const mR = await db.query(`
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE dps_config IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_each(dps_config) e WHERE (e.value->>'enabled')::text = 'false'
          ) AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(dps_config) e WHERE (e.value->>'enabled')::text != 'false'
          ) AND (dps_labels IS NULL OR dps_labels = '{}'::jsonb)) AS empty
        FROM devices WHERE enabled = true
      `);
      const row = mR.rows[0] || {};
      mqttHealth.total = parseInt(row.total) || 0;
      mqttHealth.empty = parseInt(row.empty) || 0;
      mqttHealth.clean = mqttHealth.total - mqttHealth.empty;
      mqttHealth.noisy = 0;
    } catch (_) { }

    res.json({ state, heartbeat, rooms, mqttHealth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Pixoo64 Display ─────────────────────────────────────────
app.get('/api/pixoo/status', async (_req, res) => {
  try {
    // Get current screen from pixoo (forward to device)
    const pixooResp = await fetch('http://192.168.1.243:80/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Channel/GetIndex' }),
      signal: AbortSignal.timeout(3000),
    }).then(r => r.json()).catch(() => null);

    // Get heartbeat from DB
    const hb = await db.query('SELECT ts, decision, error FROM pixoo_log ORDER BY ts DESC LIMIT 1')
      .then(r => r.rows[0] || {}).catch(() => ({}));

    // Get screen content from DB (Pixoo service writes it there)
    const screenR = await db.query("SELECT value FROM rule_engine_state WHERE key = '_pixoo_screen'")
      .catch(() => ({ rows: [] }));
    const screen = screenR.rows.length > 0 ? screenR.rows[0].value : {};

    const previewR = await db.query("SELECT value FROM rule_engine_state WHERE key = '_pixoo_preview'")
      .catch(() => ({ rows: [] }));
    const preview = previewR.rows.length > 0 ? previewR.rows[0].value : null;

    res.json({ device: pixooResp, heartbeat: hb, screen, preview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Manual People Count (Main Agent tab bar) ───────────────────────────
// Latest row in `manual_people_log` is the current effective manual value.
// `value=NULL` rows represent "cleared" (either user cleared, or a door
// transition cleared it). The dashboard displays `Manual: —` for NULL.
// Future AI calibration consumes the full history (source + door_event +
// calculated_count fields) to compare manual ground truth vs People Home.
app.get('/api/main-agent/manual-people', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT value, ts AT TIME ZONE 'Asia/Jerusalem' AS ts, source,
              door_event, calculated_count
       FROM manual_people_log ORDER BY ts DESC LIMIT 1`
    );
    if (r.rows.length === 0) {
      res.json({ value: null, ts: null, source: null, calculated_count: null });
    } else {
      res.json(r.rows[0]);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/main-agent/manual-people', async (req, res) => {
  try {
    const raw = req.body && req.body.value;
    let value = null;
    if (raw !== '' && raw !== null && raw !== undefined) {
      const n = parseInt(raw, 10);
      if (Number.isNaN(n) || n < 0 || n > 20) {
        return res.status(400).json({ error: 'value must be integer 0..20 or null' });
      }
      value = n;
    }
    // Capture current people_home from rule engine state for AI comparison.
    let calculated = null;
    try {
      const calcR = await db.query(
        "SELECT value FROM rule_engine_state WHERE key = 'people_home'"
      );
      if (calcR.rows.length > 0) {
        const v = calcR.rows[0].value;
        calculated = typeof v === 'number' ? v : parseInt(String(v), 10);
        if (Number.isNaN(calculated)) calculated = null;
      }
    } catch (_) { /* best-effort */ }
    await db.query(
      `INSERT INTO manual_people_log (value, source, door_event, calculated_count)
       VALUES ($1, 'user', NULL, $2)`,
      [value, calculated]
    );
    res.json({ ok: true, value, calculated_count: calculated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Corridor Simulator (Main Agent tab) ────────────────────────────────
// Four endpoints back the Corridor Simulator UI in main-agent.html:
//   1. GET  /api/corridor-sim/state           — aggregate live state of the 4 chain devices + server's MQTT ring buffer
//   2. POST /api/corridor-sim/trigger-presence — publish a fake Corridor Presence event
//   3. POST /api/corridor-sim/trigger-fr-event — publish a fake face_identified/face_unknown
//   4. POST /api/corridor-sim/clear            — empty the server's ring buffer (backs the "🗑 Clear all" button)
// IDs are hardcoded since the chain is single-purpose: Corridor + face_01 + remoteXY_01.
const CORRIDOR_SIM_IDS = {
  presence:         'bfbdca138cb1c78c3dlbmc',
  cor_switch:       'bfe47a84d7cb783f59inot',
  entrance_monitor: 'bfb4de883ef1713bfdfdpw',   // Tuya local switch, Ch.2 — added 2026-05-15
  fr:               'face_01',
  remotexy:         'remoteXY_01',
};

// ─── Pixoo64 device-direct state (channel + brightness + power) ────────
// pixoo_service tracks what WE pushed, but doesn't know if the user pressed
// the physical button to switch to Cloud / Visualizer / Faces. The Pixoo
// device's own HTTP API does. Cached 5 s — dashboard polls every 1 s, so
// 1 device call per 5 s in the worst case. ~100 ms response time.
const PIXOO_HTTP_URL    = 'http://192.168.1.243:80/post';
const PIXOO_CACHE_MS    = 5000;
const PIXOO_CHANNEL_NAMES = {
  0: 'Faces (clock)',
  1: 'Cloud',
  2: 'Visualizer (sound)',
  3: 'Custom scene',
  4: 'Drawing (custom)',
};
let _pixooDeviceCache = { ts: 0, data: null };

async function _fetchPixooDevice() {
  const now = Date.now();
  if (_pixooDeviceCache.data && now - _pixooDeviceCache.ts < PIXOO_CACHE_MS) {
    return _pixooDeviceCache.data;
  }
  try {
    const [idxR, confR] = await Promise.all([
      fetch(PIXOO_HTTP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Command: 'Channel/GetIndex' }),
        signal: AbortSignal.timeout(3000),
      }).then(r => r.json()),
      fetch(PIXOO_HTTP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Command: 'Channel/GetAllConf' }),
        signal: AbortSignal.timeout(3000),
      }).then(r => r.json()),
    ]);
    const channel_idx  = (idxR && typeof idxR.SelectIndex === 'number') ? idxR.SelectIndex : null;
    const channel_name = channel_idx != null ? (PIXOO_CHANNEL_NAMES[channel_idx] || `channel ${channel_idx}`) : null;
    const data = {
      channel_idx,
      channel_name,
      brightness:  confR && typeof confR.Brightness === 'number' ? confR.Brightness : null,
      power_on:    confR && confR.LightSwitch === 1,
      cur_clock_id: confR ? confR.CurClockId : null,
    };
    _pixooDeviceCache = { ts: now, data };
    return data;
  } catch (e) {
    // Pixoo offline / unreachable — return stale cache if we have one,
    // otherwise null. Don't update the cache timestamp so we retry next call.
    return _pixooDeviceCache.data;
  }
}

// ─── Server-side MQTT ring buffer for the Corridor Simulator ────────────
// We tried browser-side WS subscription first — turned out hard for the user
// to verify (browser tab churn dropped messages, ACL pattern mismatches were
// silent, hard to debug without dev tools). Simpler: server.js's MQTT client
// (rule_engine creds, full read access) subscribes once at startup, keeps a
// ring buffer of the last N messages on the 4 chain devices, exposes it via
// the existing /api/corridor-sim/state endpoint. Browser just polls — no
// MQTT lib, no WS lifecycle worries.
const CORRIDOR_SIM_BUFFER_MAX = 50;
const _corridorSimBuffer = [];                                     // [{ ts, topic, payload }] most-recent first
const _corridorSimChainIds = new Set(Object.values(CORRIDOR_SIM_IDS));

function _corridorSimRecord(topic, payloadBuf) {
  const t = String(topic || '');
  const parts = t.split('/');
  // Accept these topic shapes:
  //   mur/home/device/<id>/{event,state}        (length 5, id ∈ chain set)
  //   mur/home/esp/<id>/{event,status,command}  (length 5, id ∈ chain set)
  //   mur/home/pixoo/command                    (length 4, flat — no per-device id)
  //   awtrix_05ec2c/{notify,power}              (length 2, flat — device id is the prefix)
  if (parts.length < 2) return;
  const isAwtrix = (parts.length === 2 && parts[0] === 'awtrix_05ec2c'
                    && (parts[1] === 'notify' || parts[1] === 'power'));
  if (isAwtrix) {
    let payload;
    try { payload = JSON.parse(payloadBuf.toString()); } catch (_) { payload = payloadBuf.toString(); }
    _corridorSimBuffer.unshift({ ts: new Date().toISOString(), topic: t, payload });
    if (_corridorSimBuffer.length > CORRIDOR_SIM_BUFFER_MAX) _corridorSimBuffer.length = CORRIDOR_SIM_BUFFER_MAX;
    return;
  }
  if (parts[0] !== 'mur' || parts[1] !== 'home') return;
  const pixooMatch = (parts.length === 4 && parts[2] === 'pixoo' && parts[3] === 'command');
  const chainMatch = (parts.length === 5
    && (parts[2] === 'device' || parts[2] === 'esp')
    && _corridorSimChainIds.has(parts[3]));
  if (!pixooMatch && !chainMatch) return;
  let payload;
  try { payload = JSON.parse(payloadBuf.toString()); } catch (_) { payload = payloadBuf.toString(); }
  _corridorSimBuffer.unshift({ ts: new Date().toISOString(), topic: t, payload });
  if (_corridorSimBuffer.length > CORRIDOR_SIM_BUFFER_MAX) _corridorSimBuffer.length = CORRIDOR_SIM_BUFFER_MAX;
}

// Subscribe on MQTT connect — and re-subscribe on every reconnect, since
// mqtt.js v5 clears subscriptions after disconnect. The 'connect' event
// also fires on reconnect, so this is idempotent.
mqttClient.on('connect', () => {
  const topics = [
    'mur/home/device/+/event',
    'mur/home/device/+/state',
    'mur/home/esp/+/event',
    'mur/home/esp/+/status',
    'mur/home/esp/+/command',
    'mur/home/pixoo/command',
    'awtrix_05ec2c/notify',
    'awtrix_05ec2c/power',
  ];
  topics.forEach(t => mqttClient.subscribe(t, { qos: 0 }, (err) => {
    if (err) console.warn('corridor-sim broker subscribe failed:', t, err.message);
  }));
});
mqttClient.on('message', (topic, payload) => {
  _corridorSimRecord(topic, payload);
});

// Clear the ring buffer — backs the "🗑 Clear all" button in the dashboard.
app.post('/api/corridor-sim/clear', (_req, res) => {
  _corridorSimBuffer.length = 0;
  res.json({ ok: true });
});

// ─── FR Diagnostics — door-unlock chip toggle ───────────────────────────────
// Toggles the `@RemoteXY Gate` chip's action in s_frl1_unlock between
// "on" and "off". When "off", the rule engine's _resolve_esp_action
// silently drops the unlock command because RemoteXY Gate's `door`
// channel has no `action_off` mapping — door stays closed even on a
// successful face_identified. Lets the user walk past the camera with
// debug enabled WITHOUT physically opening the door.
//
// The rule's sentence cache TTL is 30 s — changes take effect within
// that window (or click Reload to force-refresh).
//
// GET returns the current chip state (extracted from the sentence's
// device segment): { enabled: true|false } based on whether the chip
// trailing word is "on" or "off".
// POST body { enabled: bool } sets it.
app.get('/api/fr-diagnostics/unlock-chip', async (_req, res) => {
  try {
    const r = await db.query("SELECT value FROM dashboard_settings WHERE key = 'apartment.rule_sentences'");
    if (!r.rows[0]) return res.status(404).json({ error: 'no rule_sentences row' });
    const arr = r.rows[0].value;
    const container = arr.find(c => c.id === 'r_face_recognition_loop_init');
    if (!container) return res.status(404).json({ error: 'no Face Recognition Loop container' });
    const sentence = container.sentences.find(s => s.id === 's_frl1_unlock');
    if (!sentence) return res.status(404).json({ error: 'no s_frl1_unlock sentence' });
    let action = null;
    for (const seg of (sentence.segments || [])) {
      if (seg.t === 'dev' && seg.v && seg.v.toLowerCase().includes('@remotexy gate')) {
        const m = seg.v.match(/\s+(on|off)\s*$/i);
        if (m) action = m[1].toLowerCase();
      }
    }
    return res.json({ enabled: action === 'on', action_token: action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fr-diagnostics/unlock-chip', async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (bool) required' });
    const newAction = enabled ? 'on' : 'off';
    const r = await db.query("SELECT value FROM dashboard_settings WHERE key = 'apartment.rule_sentences'");
    if (!r.rows[0]) return res.status(404).json({ error: 'no rule_sentences row' });
    const arr = r.rows[0].value;
    const container = arr.find(c => c.id === 'r_face_recognition_loop_init');
    if (!container) return res.status(404).json({ error: 'no Face Recognition Loop container' });
    const sentence = container.sentences.find(s => s.id === 's_frl1_unlock');
    if (!sentence) return res.status(404).json({ error: 'no s_frl1_unlock sentence' });
    let changed = false;
    for (const seg of (sentence.segments || [])) {
      if (seg.t === 'dev' && seg.v && seg.v.toLowerCase().includes('@remotexy gate')) {
        seg.v = seg.v.replace(/\s+(on|off)\s*$/i, ` ${newAction}`);
        changed = true;
      }
    }
    if (!changed) return res.status(404).json({ error: 'no @RemoteXY Gate chip found in s_frl1_unlock' });
    sentence.text = (sentence.segments || []).map(s => s.v).join('');
    const nowIso = new Date().toISOString();
    sentence.updated_at = nowIso;
    container.updated_at = nowIso;
    await db.query(
      "UPDATE dashboard_settings SET value = $1::jsonb, updated_at = NOW() WHERE key = 'apartment.rule_sentences'",
      [JSON.stringify(arr)]
    );
    res.json({ ok: true, enabled, new_action: newAction });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/corridor-sim/state', async (_req, res) => {
  try {
    const ids = Object.values(CORRIDOR_SIM_IDS);
    // 1) device-table state (Corridor Presence + Switch, and the projected ESP DPS for face_01 + remoteXY_01)
    const dvR = await db.query(
      `SELECT id, name, last_state, last_seen, last_source,
              EXTRACT(EPOCH FROM (now() - last_seen))::int AS age_sec
       FROM devices
       WHERE id = ANY($1)`,
      [ids]
    );
    const byId = Object.fromEntries(dvR.rows.map(r => [r.id, r]));
    // 2) esp_boards state for the two ESP boards (richer than the projected DPS — has sketch_version + raw last_status JSON)
    const ebR = await db.query(
      `SELECT id, last_status, last_seen, EXTRACT(EPOCH FROM (now() - last_seen))::int AS age_sec
       FROM esp_boards
       WHERE id IN ($1, $2)`,
      [CORRIDOR_SIM_IDS.fr, CORRIDOR_SIM_IDS.remotexy]
    );
    const boards = Object.fromEntries(ebR.rows.map(r => [r.id, r]));
    // 3) Recent MQTT messages from the server-side ring buffer (last 50,
    //    captured live by the mqttClient subscription above — covers every
    //    /event /state /status /command for the 4 chain devices regardless
    //    of whether it landed in device_events).
    // 4) Pixoo currently-displayed content + mode. Single source of truth:
    //    pixoo_service writes _pixoo_screen on every render — both for
    //    pushed presets ('screen' = 'preset:<name>') and rotation ticks
    //    ('screen' = 'clock' / 'weather' / etc). The dashboard parses the
    //    prefix to display the preset name when one's playing.
    //    `paused` tells the dashboard whether the rotation is locked
    //    (paused = pinned to a manual preset) or actively cycling.
    // Read pixoo state from DB (preset/screen + paused flag) AND from the
    // Pixoo device's HTTP API (current channel + brightness + power) in
    // parallel. The two sources serve different questions: DB tells what
    // we pushed; device tells what's actually on the matrix right now
    // (covers the case where the user pressed the physical button to
    // switch to Cloud / Visualizer / Faces).
    const [pixR, pixDevice] = await Promise.all([
      db.query(
        `SELECT key, value, EXTRACT(EPOCH FROM (now() - updated_at))::int AS age_sec
         FROM rule_engine_state WHERE key IN ('_pixoo_screen','_pixoo_paused')`
      ).catch(() => ({ rows: [] })),
      _fetchPixooDevice(),
    ]);
    let pixoo = null;
    if (pixR.rows.length || pixDevice) {
      const byKey = Object.fromEntries((pixR.rows || []).map(r => [r.key, r]));
      const screenRow = byKey._pixoo_screen;
      const pausedRow = byKey._pixoo_paused;
      const v = (screenRow && screenRow.value) || {};
      pixoo = {
        screen:       v.screen || null,
        ts:           v.ts || null,
        age_sec:      screenRow ? screenRow.age_sec : null,
        paused:       pausedRow ? (pausedRow.value === true || pausedRow.value === 'true') : false,
        channel_idx:  pixDevice ? pixDevice.channel_idx : null,
        channel_name: pixDevice ? pixDevice.channel_name : null,
        brightness:   pixDevice ? pixDevice.brightness : null,
        power_on:     pixDevice ? pixDevice.power_on : null,
      };
    }
    res.json({
      presence:         byId[CORRIDOR_SIM_IDS.presence]         || null,
      cor_switch:       byId[CORRIDOR_SIM_IDS.cor_switch]       || null,
      entrance_monitor: byId[CORRIDOR_SIM_IDS.entrance_monitor] || null,
      fr:               { device: byId[CORRIDOR_SIM_IDS.fr] || null, board: boards[CORRIDOR_SIM_IDS.fr] || null },
      remotexy:         { device: byId[CORRIDOR_SIM_IDS.remotexy] || null, board: boards[CORRIDOR_SIM_IDS.remotexy] || null },
      pixoo:            pixoo,         // {screen, ts, age_sec, channel_idx, channel_name, brightness, power_on} or null
      events:           _corridorSimBuffer.slice(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publishes {"1": <bool>} to mur/home/device/<corridor-presence-id>/event AND
// writes the matching device_events row + updates devices.last_state — same
// dual-action that device_agent on LXC 103 performs for real events. Without
// the DB writes, the simulator's monitor (which polls DB) wouldn't reflect
// the simulated event since rule_engine's update_device is in-memory only.
// Real subsequent events from device_agent overwrite the simulated state on
// the next poll, which is the correct behavior.
// Home State Simulator — physically toggles the matching 8 Gang Switch
// channel ON (HOME=ch4, AWAY=ch8, ABROAD=ch3 — matches the Mode Buttons
// rule's r_modebuttons_init container). Just delegates to the existing
// /api/devices/:id/toggle endpoint so the relay actually latches like a
// real wall-switch press. The Mode Buttons rule then reacts to the real
// device event the 8 Gang Switch emits, sets state.shared['home_mode'],
// and fires its own mutual-exclusivity turn_off for the previously-active
// channel — same chain as a real human press. Mode persists indefinitely
// (until another mode button is pressed) because the relay is latched ON.
const HOME_MODE_BUTTON = {
  device_id: 'bf85e819855d686918q6hz',          // 8 Gang Switch (Entrance)
  channels:  { home: '4', away: '8', abroad: '3' },
};
app.post('/api/corridor-sim/set-home-mode', async (req, res) => {
  try {
    const mode = (req.body && req.body.mode) ? String(req.body.mode).toLowerCase() : '';
    if (!['home', 'away', 'abroad'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be home|away|abroad' });
    }
    const targetChannel = HOME_MODE_BUTTON.channels[mode];
    // Pre-cleanup: turn OFF the two non-target channels BEFORE turning ON
    // the target. Without this, the brief HA→Tuya-cloud→device roundtrip
    // for the Mode Buttons rule's mutual-exclusivity cleanup (~1 s) leaves
    // a visible multi-on window where the previously-active button is
    // still latched while the new target is already ON. Sending turn_off
    // first (in parallel for speed) ensures other channels are commanded
    // off BEFORE the new one is commanded on — single-mode invariant
    // holds even momentarily.
    const toggle = (channel, state) => fetch(
      `http://127.0.0.1:3000/api/devices/${HOME_MODE_BUTTON.device_id}/toggle`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ state, channel }),
      }
    ).then(r => r.json());

    const offChannels = Object.values(HOME_MODE_BUTTON.channels).filter(c => c !== targetChannel);
    const offResults  = await Promise.all(offChannels.map(c => toggle(c, false)));
    const onResult    = await toggle(targetChannel, true);
    res.json({
      ok:           true,
      mode,
      channel:      targetChannel,
      cleared_off:  offChannels,
      off_results:  offResults,
      on_result:    onResult,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto falling-edge delay — when value=true, the endpoint schedules a synthetic
// "no presence" event this many ms later. Reason: the simulator publishes
// directly to MQTT, bypassing device-agent. Device-agent never sees the
// synthetic "presence", so when the real sensor reports its identical "none"
// (which it already was), device-agent's dedup drops the event silently.
// The rule engine never sees a falling-edge → move_in_corridor.last_presence
// stays at 'presence' forever → next simulator click is silently swallowed.
// Auto-firing a synthetic "none" closes the loop so each press is a complete
// rising+falling cycle. 5 s matches a brief real-life walk-through.
const CORRIDOR_SIM_AUTO_FALLING_EDGE_MS = 5000;

app.post('/api/corridor-sim/trigger-presence', async (req, res) => {
  try {
    const value = req.body && (req.body.value === true || req.body.value === 'true');
    const topic = `mur/home/device/${CORRIDOR_SIM_IDS.presence}/event`;
    const dps = { '1': value };
    // DB writes first (so the monitor sees it on next poll even if MQTT publish
    // is slow), MQTT second (to drive rule firing).
    await db.query(
      `INSERT INTO device_events (ts, device_id, source, dps) VALUES (now(), $1, 'event', $2::jsonb)`,
      [CORRIDOR_SIM_IDS.presence, JSON.stringify(dps)]
    );
    await db.query(
      `UPDATE devices SET last_state = COALESCE(last_state,'{}'::jsonb) || $1::jsonb,
                          last_seen = now(),
                          last_source = 'event'
        WHERE id = $2`,
      [JSON.stringify(dps), CORRIDOR_SIM_IDS.presence]
    );
    mqttClient.publish(topic, JSON.stringify(dps), { qos: 1 });

    // Schedule the falling-edge if we just fired a rising-edge. No-op for the
    // manual "Absent" button — that already IS a falling-edge.
    if (value === true) {
      setTimeout(async () => {
        try {
          const fallingDps = { '1': 'none' };
          await db.query(
            `INSERT INTO device_events (ts, device_id, source, dps) VALUES (now(), $1, 'event', $2::jsonb)`,
            [CORRIDOR_SIM_IDS.presence, JSON.stringify(fallingDps)]
          );
          await db.query(
            `UPDATE devices SET last_state = COALESCE(last_state,'{}'::jsonb) || $1::jsonb,
                                last_seen = now(),
                                last_source = 'event'
              WHERE id = $2`,
            [JSON.stringify(fallingDps), CORRIDOR_SIM_IDS.presence]
          );
          mqttClient.publish(topic, JSON.stringify(fallingDps), { qos: 1 });
          console.log(`corridor-sim: auto falling-edge fired (T+${CORRIDOR_SIM_AUTO_FALLING_EDGE_MS}ms after rising-edge)`);
        } catch (e) {
          console.error('corridor-sim: auto falling-edge failed:', e.message);
        }
      }, CORRIDOR_SIM_AUTO_FALLING_EDGE_MS);
    }

    res.json({ ok: true, published: topic, payload: dps, auto_falling_edge_ms: value === true ? CORRIDOR_SIM_AUTO_FALLING_EDGE_MS : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publishes a face_identified or face_unknown event to mur/home/esp/face_01/event
// AND mirrors the result into device_events + devices.last_state.
//
// The FR board normally publishes face_identified via /event topic, then on
// next /status heartbeat (60 s) updates last_recognition. We short-circuit by
// updating last_recognition immediately in the DB so the simulator's monitor
// reflects the fake event right away. Rule engine's current /event handler
// (rule_engine.py:778) drops esp /event messages — that's a separate fix
// needed when the actual rule gets authored. For now the publish is visible
// on the Project Boards Live MQTT card and the DB write is what drives the
// simulator's monitor.
app.post('/api/corridor-sim/trigger-fr-event', async (req, res) => {
  try {
    const kind = (req.body && req.body.kind) ? String(req.body.kind) : '';
    if (kind !== 'face_identified' && kind !== 'face_unknown') {
      return res.status(400).json({ error: 'kind must be face_identified or face_unknown' });
    }
    const ts = Math.floor(Date.now() / 1000);
    const envelope = { kind, src: 'fr_module', ts };
    let dbDps = {};

    if (kind === 'face_identified') {
      const uid = Number.parseInt(req.body.user_id, 10);
      const name = String(req.body.user_name || '').slice(0, 31).replace(/["\\]/g, '_');
      if (!Number.isInteger(uid) || uid < 0 || uid > 100) {
        return res.status(400).json({ error: 'user_id must be 0..100' });
      }
      envelope.payload = JSON.stringify({ user_id: uid, user_name: name });
      dbDps = {
        last_recognition:    name ? `${name} (${uid})` : `user_${uid}`,
        last_recognition_ts: ts,
      };
    } else {
      const reason = String(req.body.reason || 'no_match').slice(0, 31);
      envelope.payload = JSON.stringify({ reason });
      dbDps = {
        last_recognition:    `unknown (${reason})`,
        last_recognition_ts: ts,
      };
    }

    await db.query(
      `INSERT INTO device_events (ts, device_id, source, dps) VALUES (now(), $1, 'esp_event', $2::jsonb)`,
      [CORRIDOR_SIM_IDS.fr, JSON.stringify(dbDps)]
    );
    await db.query(
      `UPDATE devices SET last_state = COALESCE(last_state,'{}'::jsonb) || $1::jsonb,
                          last_seen = now(),
                          last_source = 'esp_event'
        WHERE id = $2`,
      [JSON.stringify(dbDps), CORRIDOR_SIM_IDS.fr]
    );
    const topic = `mur/home/esp/${CORRIDOR_SIM_IDS.fr}/event`;
    mqttClient.publish(topic, JSON.stringify(envelope), { qos: 1 });
    res.json({ ok: true, published: topic, payload: envelope, db_dps: dbDps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/brightness', async (req, res) => {
  try {
    const { value } = req.body;
    const r = await fetch('http://192.168.1.243:80/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Channel/SetBrightness', Brightness: parseInt(value) || 50 }),
      signal: AbortSignal.timeout(3000),
    }).then(r => r.json());
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/wipe', async (_req, res) => {
  try {
    const P = 'http://192.168.1.243:80/post';
    const h = { 'Content-Type': 'application/json' };
    const t = AbortSignal.timeout(3000);
    // Screen off/on is the only reliable wipe
    await fetch(P, { method: 'POST', headers: h, body: JSON.stringify({ Command: 'Draw/ResetHttpGifId' }), signal: t });
    await fetch(P, { method: 'POST', headers: h, body: JSON.stringify({ Command: 'Draw/ClearHttpText' }), signal: t });
    await fetch(P, { method: 'POST', headers: h, body: JSON.stringify({ Command: 'Channel/OnOffScreen', OnOff: 0 }), signal: t });
    await new Promise(r => setTimeout(r, 500));
    await fetch(P, { method: 'POST', headers: h, body: JSON.stringify({ Command: 'Channel/OnOffScreen', OnOff: 1 }), signal: t });
    // Pause service
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_pixoo_paused', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW()`
    ).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/restart', async (_req, res) => {
  try {
    await fetch('http://192.168.1.243:80/post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Device/SysReboot' }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {}); // device reboots immediately, response times out — expected
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/noise', async (_req, res) => {
  try {
    await fetch('http://192.168.1.243:80/post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Tools/SetNoiseStatus', NoiseStatus: 1 }),
      signal: AbortSignal.timeout(3000),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/power', async (req, res) => {
  try {
    const { on } = req.body;
    const r = await fetch('http://192.168.1.243:80/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Channel/OnOffScreen', OnOff: on ? 1 : 0 }),
      signal: AbortSignal.timeout(3000),
    }).then(r => r.json());
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/channel', async (req, res) => {
  try {
    const { index } = req.body;
    const r = await fetch('http://192.168.1.243:80/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Channel/SetIndex', SelectIndex: parseInt(index) || 0 }),
      signal: AbortSignal.timeout(3000),
    }).then(r => r.json());
    // Pause service rendering
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_pixoo_paused', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW()`
    ).catch(() => {});
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/custom', async (req, res) => {
  try {
    const { page } = req.body;
    // Switch to custom channel first, then set page
    await fetch('http://192.168.1.243:80/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Channel/SetIndex', SelectIndex: 3 }),
      signal: AbortSignal.timeout(3000),
    });
    const r = await fetch('http://192.168.1.243:80/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Channel/SetCustomPageIndex', CustomPageIndex: parseInt(page) || 0 }),
      signal: AbortSignal.timeout(3000),
    }).then(r => r.json());
    // Pause service rendering
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_pixoo_paused', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW()`
    ).catch(() => {});
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/resume', async (_req, res) => {
  try {
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_pixoo_paused', 'false'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = NOW()`
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/push-items', async (req, res) => {
  try {
    // Pause service in DB FIRST before sending to Pixoo
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_pixoo_paused', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW()`
    ).catch(() => {});
    // Route through Pixoo service on LXC 100 (uses pixoo library for rendering)
    const r = await fetch('http://192.168.1.138:8768/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    }).then(r => r.json());
    res.json(r);
  } catch (e) { console.error('Pixoo push error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/command', async (req, res) => {
  try {
    const r = await fetch('http://192.168.1.138:8768/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(10000),
    }).then(r => r.json());
    res.json(r);
  } catch (e) { console.error('Pixoo command error:', e.message); res.status(500).json({ error: e.message }); }
});

// ─── Pixoo64 Presets ──────────────────────────────────────────
app.get('/api/pixoo/presets', async (_req, res) => {
  try {
    const r = await db.query('SELECT id, name, type, content, image_data, created_at FROM pixoo_presets ORDER BY created_at DESC LIMIT 10');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/presets', async (req, res) => {
  try {
    const { name, type, content, image_data } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Missing name or type' });
    const r = await db.query(
      'INSERT INTO pixoo_presets (name, type, content, image_data) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, type || 'text', JSON.stringify(content || []), image_data || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/pixoo/presets/:id', async (req, res) => {
  try {
    const { name, type, content, image_data } = req.body;
    await db.query(
      'UPDATE pixoo_presets SET name=$1, type=$2, content=$3, image_data=$4 WHERE id=$5',
      [name, type || 'text', JSON.stringify(content || {}), image_data || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pixoo/presets/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM pixoo_presets WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pixoo/presets/:id/push', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM pixoo_presets WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Preset not found' });
    const preset = r.rows[0];

    // Reset display
    await fetch('http://192.168.1.243:80/post', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Draw/ResetHttpGifId' }),
      signal: AbortSignal.timeout(3000),
    });

    if (preset.type === 'text') {
      const items = typeof preset.content === 'string' ? JSON.parse(preset.content) : (preset.content || []);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const hex = `#${(item.r||255).toString(16).padStart(2,'0')}${(item.g||255).toString(16).padStart(2,'0')}${(item.b||255).toString(16).padStart(2,'0')}`;
        await fetch('http://192.168.1.243:80/post', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Command: 'Draw/SendHttpText',
            TextId: i + 1, x: item.x || 0, y: item.y || 0, dir: 0, font: 4,
            TextWidth: 64, TextString: item.t || '', speed: 60,
            color: hex, align: 1,
          }),
          signal: AbortSignal.timeout(3000),
        });
      }
    } else if (preset.type === 'image' && preset.image_data) {
      await fetch('http://192.168.1.243:80/post', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          Command: 'Draw/SendHttpGif',
          PicNum: 1, PicWidth: 64, PicOffset: 0, PicID: 1,
          PicSpeed: 1000, PicData: preset.image_data,
        }),
        signal: AbortSignal.timeout(5000),
      });
    }

    // Pause service
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_pixoo_paused', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW()`
    ).catch(() => {});

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rule-engine/toggle', async (req, res) => {
  try {
    const { name, enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing rule name' });
    const r = await db.query("SELECT value FROM rule_engine_state WHERE key = '_disabled_rules'");
    let disabled = (r.rows.length > 0 && Array.isArray(r.rows[0].value)) ? r.rows[0].value : [];
    if (enabled) {
      disabled = disabled.filter(n => n !== name);
    } else {
      if (!disabled.includes(name)) disabled.push(name);
    }
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_disabled_rules', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(disabled)]
    );
    res.json({ ok: true, disabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rule-engine/override', async (req, res) => {
  try {
    const { name, priority, conditions } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing rule name' });
    const r = await db.query("SELECT value FROM rule_engine_state WHERE key = '_rule_overrides'");
    let overrides = (r.rows.length > 0 && typeof r.rows[0].value === 'object') ? r.rows[0].value : {};
    if (!overrides[name]) overrides[name] = {};
    if (priority !== undefined) overrides[name].priority = parseInt(priority);
    if (conditions !== undefined) {
      if (!overrides[name].conditions) overrides[name].conditions = {};
      Object.assign(overrides[name].conditions, conditions);
    }
    // Remove empty overrides
    if (Object.keys(overrides[name]).length === 0 ||
        (Object.keys(overrides[name]).length === 1 && overrides[name].conditions && Object.keys(overrides[name].conditions).length === 0)) {
      delete overrides[name];
    }
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_rule_overrides', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(overrides)]
    );
    res.json({ ok: true, overrides });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rule-engine/reload', async (_req, res) => {
  try {
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_reload_request', '"pending"'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = '"pending"'::jsonb, updated_at = NOW()`
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-rule runs-counter reset. Two-part operation:
//   1. Write `_rule_stats_reset=<rule_name>` flag — engine heartbeat picks
//      it up within ≤60s and zeros count + total_ms in its in-memory
//      _rule_stats dict (so subsequent fires count from 1, avg recomputes).
//   2. Immediately patch the _rules JSON array in DB to set this rule's
//      stats.count=0 and stats.total_ms=0. Without this the dashboard's
//      next 5s poll would read the OLD count from _rules (engine only
//      refreshes _rules on the 60s heartbeat tick), causing the visual
//      count to revert seconds after the click.
// avg/max/last_fired are NOT cleared — they remain useful diagnostics.
app.post('/api/rule-engine/reset-runs', async (req, res) => {
  const ruleName = req.body && req.body.rule;
  if (!ruleName || typeof ruleName !== 'string') {
    return res.status(400).json({ error: 'rule (string) required in body' });
  }
  try {
    // 1. Set the flag so the engine eventually resets its in-memory counter.
    //    Flag value is a JSON ARRAY of pending rule names — appending on each
    //    click ensures multiple clicks queue up rather than overwrite each
    //    other (the original single-string design lost all but the last click).
    //    Engine processes every queued rule on next heartbeat, then clears.
    const cur = await db.query("SELECT value FROM rule_engine_state WHERE key = '_rule_stats_reset'");
    let queue = [];
    if (cur.rows.length) {
      const v = cur.rows[0].value;
      if (Array.isArray(v)) queue = v;
      else if (typeof v === 'string' && v) queue = [v]; // back-compat with old single-string writes
    }
    if (!queue.includes(ruleName)) queue.push(ruleName);
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at)
       VALUES ('_rule_stats_reset', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(queue)]
    );
    // 2. Patch _rules JSONB so dashboard polls see count=0 immediately.
    //    Iterates the rules array, sets stats.count + stats.total_ms = 0
    //    on the matching rule only, leaves others untouched.
    await db.query(
      `UPDATE rule_engine_state
       SET value = (
         SELECT jsonb_agg(
           CASE WHEN r->>'name' = $1
             THEN jsonb_set(
                    jsonb_set(r, '{stats,count}',    '0'::jsonb, true),
                    '{stats,total_ms}', '0'::jsonb, true)
             ELSE r
           END
         )
         FROM jsonb_array_elements(value) AS r
       ),
       updated_at = NOW()
       WHERE key = '_rules'`,
      [ruleName]
    );
    res.json({ ok: true, rule: ruleName, note: 'Dashboard shows 0 immediately; engine confirms within 60 s' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Flip `_spatial_reload_request='pending'` so the rule-engine heartbeat picks
// up apartment-layout / placement changes within ≤60s. Non-fatal: if this
// fails the next midnight refresh still catches the change.
async function signalSpatialReload() {
  try {
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_spatial_reload_request', '"pending"'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = '"pending"'::jsonb, updated_at = NOW()`
    );
  } catch (e) {
    console.warn('[spatial reload signal failed]', e.message);
  }
}

app.post('/api/rule-engine/test', async (req, res) => {
  try {
    const { rule_name, force } = req.body;
    if (!rule_name) return res.status(400).json({ error: 'Missing rule_name' });
    // Clear previous result
    await db.query(
      `INSERT INTO rule_engine_state (key, value, updated_at) VALUES ('_test_result', 'null'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'null'::jsonb, updated_at = NOW()`
    );
    // Publish test request via MQTT (instant delivery)
    mqttClient.publish('mur/home/rule-engine/test', JSON.stringify({ rule_name, force: !!force }));
    // Poll for result (up to 5s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      const r = await db.query("SELECT value FROM rule_engine_state WHERE key = '_test_result'");
      if (r.rows.length > 0 && r.rows[0].value !== null) {
        return res.json(r.rows[0].value);
      }
    }
    res.json({ status: 'timeout', reason: 'Rule engine did not respond within 5s' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HASP panel widget CRUD (button bindings + display templates) ──────────
// Config tables only — no business logic. Rule engine on LXC 105 owns dispatch.

const _HASP_PANEL_RE = /^[a-z][a-z0-9-]*$/;
const _HASP_BTN_FIELDS = new Set(['event', 'label', 'bindings', 'action_type', 'action_target', 'action_payload']);
const _HASP_DISP_FIELDS = new Set(['page', 'label_id', 'description', 'display_type', 'target_property',
                                    'source_type', 'source_value', 'format_string', 'refresh_sec']);

async function _haspPanelId(panel) {
  if (!_HASP_PANEL_RE.test(panel)) throw new Error('invalid panel name');
  const r = await db.query('SELECT id FROM hasp_panels WHERE name = $1', [panel]);
  if (!r.rows.length) throw new Error('panel not found');
  return r.rows[0].id;
}

app.get('/api/hasp/:panel/buttons', async (req, res) => {
  try {
    const pid = await _haspPanelId(req.params.panel);
    const r = await db.query(
      `SELECT id, page, button_id, event, label, icon_codepoint,
              bindings, action_type, action_target, action_payload, last_event_at
       FROM hasp_buttons WHERE panel_id = $1
       ORDER BY page, button_id, event`,
      [pid]
    );
    res.json({ buttons: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/hasp/:panel/buttons/:id', async (req, res) => {
  try {
    const pid = await _haspPanelId(req.params.panel);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!_HASP_BTN_FIELDS.has(k)) continue;
      sets.push(`${k} = $${i++}`);
      const isJson = k === 'action_payload' || k === 'bindings';
      vals.push(isJson ? JSON.stringify(v || (k === 'bindings' ? [] : {})) : v);
    }
    if (!sets.length) return res.status(400).json({ error: 'no valid fields' });
    vals.push(id, pid);
    const r = await db.query(
      `UPDATE hasp_buttons SET ${sets.join(', ')} WHERE id = $${i++} AND panel_id = $${i}
       RETURNING id, page, button_id, event, label, bindings`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ button: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test-fire — iterates bindings array, dispatches each (bypasses rule engine).
async function _haspDispatchOne(panelName, b) {
  if (b.type === 'hasp_command' || (!b.type && b.target && !b.device_id)) {
    const parts = String(b.target).trim().split(/\s+/);
    const path = parts[0];
    const value = parts.slice(1).join(' ');
    mqttClient.publish(`hasp/${panelName}/command/${path}`, value);
    return { kind: 'hasp_command', topic: `hasp/${panelName}/command/${path}`, payload: value };
  }
  if (b.type === 'pixoo_preset') {
    const payload = { action: 'push_preset', preset_name: b.target };
    if (b.vars) payload.vars = b.vars;
    mqttClient.publish('mur/home/pixoo/command', JSON.stringify(payload));
    return { kind: 'pixoo_preset', preset: b.target };
  }
  // Default: device binding
  const device_id = b.device_id;
  if (!device_id) throw new Error('binding missing device_id');
  const channel = b.channel;
  const action = b.action || 'toggle';
  const body = channel ? { channel } : {};
  if (action === 'turn_on') body.state = true;
  else if (action === 'turn_off') body.state = false;
  else {
    const devR = await db.query('SELECT last_state FROM devices WHERE id = $1', [device_id]);
    const cur = devR.rows[0]?.last_state || {};
    const curVal = channel ? cur[channel] : (cur['1'] ?? cur.state ?? cur.power);
    body.state = !(curVal === true || curVal === 1 || curVal === 'on' || curVal === 'ON' || curVal === 'true');
  }
  const proxy = await fetch(`http://127.0.0.1:3000/api/devices/${encodeURIComponent(device_id)}/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await proxy.json();
  if (!proxy.ok) throw new Error(out.error || `HTTP ${proxy.status}`);
  return { kind: 'device', device: b.name || device_id, action, result: out };
}

app.post('/api/hasp/:panel/buttons/:id/test', async (req, res) => {
  try {
    const pid = await _haspPanelId(req.params.panel);
    const id = parseInt(req.params.id, 10);
    const r = await db.query(
      `SELECT bindings FROM hasp_buttons WHERE id = $1 AND panel_id = $2`,
      [id, pid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const bindings = r.rows[0].bindings || [];
    if (!bindings.length) return res.status(400).json({ error: 'no bindings on this row' });

    const results = [];
    let ok = 0, fail = 0;
    for (const b of bindings) {
      try {
        const r = await _haspDispatchOne(req.params.panel, b);
        results.push({ ok: true, ...r });
        ok++;
      } catch (e) {
        results.push({ ok: false, error: e.message, binding: b });
        fail++;
      }
    }
    res.json({ ok: fail === 0, fired: ok, failed: fail, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hasp/:panel/displays', async (req, res) => {
  try {
    const pid = await _haspPanelId(req.params.panel);
    const r = await db.query(
      `SELECT id, page, label_id, description, display_type, target_property,
              source_type, source_value, format_string, refresh_sec, last_value, last_published_at
       FROM hasp_displays WHERE panel_id = $1
       ORDER BY page, label_id`,
      [pid]
    );
    res.json({ displays: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/hasp/:panel/displays', async (req, res) => {
  try {
    const pid = await _haspPanelId(req.params.panel);
    const b = req.body || {};
    const page = parseInt(b.page, 10);
    const label_id = parseInt(b.label_id, 10);
    if (!page || !label_id) return res.status(400).json({ error: 'page and label_id are required' });
    const r = await db.query(
      `INSERT INTO hasp_displays (panel_id, page, label_id, description, display_type, target_property,
                                  source_type, source_value, format_string, refresh_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, page, label_id`,
      [pid, page, label_id, b.description || null,
       b.display_type || 'text', b.target_property || 'text',
       b.source_type || 'shared_state', b.source_value || null,
       b.format_string || '', b.refresh_sec || 30]
    );
    res.json({ display: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/hasp/:panel/displays/:id', async (req, res) => {
  try {
    const pid = await _haspPanelId(req.params.panel);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!_HASP_DISP_FIELDS.has(k)) continue;
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
    if (!sets.length) return res.status(400).json({ error: 'no valid fields' });
    vals.push(id, pid);
    const r = await db.query(
      `UPDATE hasp_displays SET ${sets.join(', ')} WHERE id = $${i++} AND panel_id = $${i} RETURNING id`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HASP panel sync ──────────────────────────────────────────────────────
// Pull the panel's current pages.jsonl, upsert hasp_buttons / hasp_displays
// rows from every widget, save the jsonl back to BALCONY/pages.jsonl so
// the repo stays in sync. Existing bindings (action_type/target/payload,
// format_string/source) are preserved — only auto-derivable fields update.
const _HASP_BUTTON_OBJS = new Set(['btn', 'switch', 'checkbox', 'slider']);
const _HASP_DISPLAY_OBJS = {
  label: { display_type: 'text',  target_property: 'text' },
  gauge: { display_type: 'gauge', target_property: 'val'  },
  arc:   { display_type: 'gauge', target_property: 'val'  },
  bar:   { display_type: 'bar',   target_property: 'val'  },
};

app.post('/api/hasp/:panel/sync', async (req, res) => {
  try {
    if (!_HASP_PANEL_RE.test(req.params.panel)) return res.status(400).json({ error: 'invalid panel' });
    const pR = await db.query('SELECT id, ip FROM hasp_panels WHERE name = $1', [req.params.panel]);
    if (!pR.rows.length) return res.status(404).json({ error: 'panel not found' });
    const pid = pR.rows[0].id;
    const ip = pR.rows[0].ip;
    if (!ip) return res.status(400).json({ error: 'panel has no IP' });

    // 1) Fetch panel's pages.jsonl
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let text;
    try {
      const r = await fetch(`http://${ip}/pages.jsonl`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`panel returned HTTP ${r.status}`);
      text = await r.text();
    } finally { clearTimeout(timer); }

    // 2) Parse — one JSON object per non-comment line
    const objects = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//')) continue;
      try {
        const o = JSON.parse(t);
        if (o.page != null && o.id != null && o.obj) objects.push(o);
      } catch (_) {}
    }

    // 3) Upsert — for buttons, derive label from contained label widget
    //    (panel buttons typically have no text; the visible name is a
    //    separate label widget overlaid on the button bbox).
    //
    //    Filters:
    //      - page=0 is the global background/nav row — buttons there are
    //        OpenHASP-built-in (back/home/forward); they don't need rule
    //        bindings or display rows.
    //      - label widgets whose text is *only* a private-use codepoint
    //        (E000-F8FF) are icon glyphs, not data displays; skip them
    //        from hasp_displays.
    function isPureIcon(s) {
      if (!s) return false;
      for (const ch of String(s)) {
        const c = ch.codePointAt(0);
        if (c < 0xE000 || c > 0xF8FF) return false;
      }
      return true;
    }

    const labelsByPage = {};
    for (const o of objects) {
      if (o.obj === 'label' && o.text) {
        (labelsByPage[o.page] = labelsByPage[o.page] || []).push(o);
      }
    }
    function findBtnLabel(btn) {
      const cands = (labelsByPage[btn.page] || []).filter(lbl => {
        const lx = lbl.x ?? 0, ly = lbl.y ?? 0;
        const lxe = lx + (lbl.w ?? 0), lye = ly + (lbl.h ?? 0);
        const bx = btn.x ?? 0, by = btn.y ?? 0;
        const bxe = bx + (btn.w ?? 0), bye = by + (btn.h ?? 0);
        return lx >= bx && lxe <= bxe && ly >= by && lye <= bye;
      });
      if (!cands.length) return null;
      const text = cands.filter(lbl => !isPureIcon(lbl.text));
      const pool = text.length ? text : cands;
      pool.sort((a, b) => (b.y ?? 0) - (a.y ?? 0));
      return pool[0].text;
    }

    // Track widgets we deem "real" so we can delete unconfigured stale rows
    const liveButtons = new Set();   // 'page:button_id'
    const liveDisplays = new Set();  // 'page:label_id'

    let btnAdded = 0, btnRelabeled = 0;
    let dispAdded = 0, dispTypeUpdated = 0;
    for (const o of objects) {
      if (o.page === 0) continue;  // page-0 is OpenHASP's global/nav layer
      if (_HASP_BUTTON_OBJS.has(o.obj)) {
        liveButtons.add(`${o.page}:${o.id}`);
        // Derive label: panel.text → contained-label heuristic → existing row
        let labelToInsert = o.text || findBtnLabel(o);
        if (!labelToInsert) {
          const inh = await db.query(
            `SELECT label FROM hasp_buttons
             WHERE panel_id = $1 AND page = $2 AND button_id = $3 AND label IS NOT NULL LIMIT 1`,
            [pid, o.page, o.id]
          );
          if (inh.rows.length) labelToInsert = inh.rows[0].label;
        }
        const ins = await db.query(
          `INSERT INTO hasp_buttons (panel_id, page, button_id, event, label)
           VALUES ($1, $2, $3, 'up', $4)
           ON CONFLICT (panel_id, page, button_id, event) DO NOTHING
           RETURNING id`,
          [pid, o.page, o.id, labelToInsert]
        );
        if (ins.rowCount > 0) btnAdded++;
        else if (labelToInsert) {
          // Existing row — push the panel-derived label down (across all events)
          const upd = await db.query(
            `UPDATE hasp_buttons SET label = $1
             WHERE panel_id = $2 AND page = $3 AND button_id = $4
               AND label IS DISTINCT FROM $1`,
            [labelToInsert, pid, o.page, o.id]
          );
          if (upd.rowCount > 0) btnRelabeled++;
        }
      } else if (_HASP_DISPLAY_OBJS[o.obj]) {
        // Skip pure-icon labels — they're decorative glyphs, not data displays
        if (o.obj === 'label' && isPureIcon(o.text)) continue;
        liveDisplays.add(`${o.page}:${o.id}`);
        const dt = _HASP_DISPLAY_OBJS[o.obj];
        const ins = await db.query(
          `INSERT INTO hasp_displays (panel_id, page, label_id, display_type, target_property, format_string)
           VALUES ($1, $2, $3, $4, $5, '')
           ON CONFLICT (panel_id, page, label_id) DO NOTHING
           RETURNING id`,
          [pid, o.page, o.id, dt.display_type, dt.target_property]
        );
        if (ins.rowCount > 0) dispAdded++;
        else {
          const upd = await db.query(
            `UPDATE hasp_displays SET display_type = $1, target_property = $2
             WHERE panel_id = $3 AND page = $4 AND label_id = $5
               AND (display_type IS DISTINCT FROM $1 OR target_property IS DISTINCT FROM $2)`,
            [dt.display_type, dt.target_property, pid, o.page, o.id]
          );
          if (upd.rowCount > 0) dispTypeUpdated++;
        }
      }
    }

    // 3b) Delete unconfigured stale rows — widgets that no longer exist
    //     in pages.jsonl OR are now filtered out (page-0, pure-icon).
    //     Only delete rows with NO user configuration so we never lose
    //     bindings or templates.
    const exB = await db.query(
      `SELECT id, page, button_id FROM hasp_buttons
       WHERE panel_id = $1 AND action_type IS NULL AND action_target IS NULL`,
      [pid]
    );
    let btnDeleted = 0;
    for (const r of exB.rows) {
      if (!liveButtons.has(`${r.page}:${r.button_id}`)) {
        await db.query('DELETE FROM hasp_buttons WHERE id = $1', [r.id]);
        btnDeleted++;
      }
    }
    const exD = await db.query(
      `SELECT id, page, label_id FROM hasp_displays
       WHERE panel_id = $1 AND (format_string IS NULL OR format_string = '') AND source_value IS NULL`,
      [pid]
    );
    let dispDeleted = 0;
    for (const r of exD.rows) {
      if (!liveDisplays.has(`${r.page}:${r.label_id}`)) {
        await db.query('DELETE FROM hasp_displays WHERE id = $1', [r.id]);
        dispDeleted++;
      }
    }

    // 4) Save back to repo — per-panel directory by convention
    //    (panel slug → upper case + dashes → underscores; e.g.
    //    'balcony' → 'BALCONY/', 'my-bathroom' → 'MY_BATHROOM/').
    //    Skipped silently if the destination directory doesn't exist —
    //    the DB sync is the load-bearing part.
    let fileSaved = null;
    try {
      const dirName = req.params.panel.toUpperCase().replace(/-/g, '_');
      const repoDir = path.resolve(__dirname, '..', '..', dirName);
      if (fs.existsSync(repoDir)) {
        fs.writeFileSync(path.join(repoDir, 'pages.jsonl'), text);
        fileSaved = `${dirName}/pages.jsonl`;
      }
    } catch (e) {
      console.error('HASP sync: failed to save pages.jsonl —', e.message);
    }

    res.json({
      ok: true, objects: objects.length,
      buttons: { added: btnAdded, relabeled: btnRelabeled, deleted: btnDeleted },
      displays: { added: dispAdded, type_updated: dispTypeUpdated, deleted: dispDeleted },
      file_saved: fileSaved,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/hasp/:panel/displays/:id', async (req, res) => {
  try {
    const pid = await _haspPanelId(req.params.panel);
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const r = await db.query('DELETE FROM hasp_displays WHERE id = $1 AND panel_id = $2', [id, pid]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ESP boards (ESP8266 / ESP32) — config CRUD + command dispatch ─────────
// Phase 3 endpoints — registry + parameter push + test-action push.
// Status ingest (Phase 5) is owned by the rule engine on LXC 105.
// OTA upload (Phase 6) lands here later as POST /api/esp/boards/:id/ota.
const _ESP_BOARD_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const _ESP_BOARD_FIELDS = new Set(['name', 'enabled', 'ota_password']);

function _espBoardId(id) {
  if (!_ESP_BOARD_ID_RE.test(id || '')) throw new Error('invalid board id');
  return id;
}

// List boards. LEFT JOIN net_devices on MAC so live IP / last_seen reflect
// the ARP scanner (5-min cadence) — same pattern used by /api/devices.
app.get('/api/esp/boards', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT b.id, b.name,
             COALESCE(split_part(b.ip::text, '/', 1), nd.ip) AS ip,
             b.mac::text AS mac,
             b.sketch_name, b.sketch_version, b.build_ts,
             b.board_schema AS schema, b.parameters,
             b.ota_password IS NOT NULL AS has_ota_password,
             b.enabled,
             COALESCE(b.last_seen, nd.last_seen) AS last_seen,
             b.last_status, b.created_at
      FROM esp_boards b
      LEFT JOIN net_devices nd ON LOWER(nd.mac::text) = LOWER(b.mac::text)
      ORDER BY b.id
    `);
    // OTA falls back to the shared ESP_OTA_PASSWORD env var when the
    // per-board column is unset, so reflect that in has_ota_password.
    const sharedOta = !!process.env.ESP_OTA_PASSWORD;
    for (const row of r.rows) row.has_ota_password = row.has_ota_password || sharedOta;
    res.json({ boards: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update name / enabled / ota_password.
app.patch('/api/esp/boards/:id', async (req, res) => {
  try {
    const id = _espBoardId(req.params.id);
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!_ESP_BOARD_FIELDS.has(k)) continue;
      // Reject empty/whitespace ota_password — `has_ota_password` would
      // still report true (column is non-NULL) but OTA upload would fail
      // with the truthiness check, leaving the dashboard saying "set" while
      // every push errors. Clearer to refuse the bad input upfront.
      if (k === 'ota_password' && (typeof v !== 'string' || !v.trim())) {
        return res.status(400).json({ error: 'ota_password must be a non-empty string' });
      }
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
    if (!sets.length) return res.status(400).json({ error: 'no valid fields' });
    vals.push(id);
    const r = await db.query(
      `UPDATE esp_boards SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, name, enabled`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ board: r.rows[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Save parameters → publish JSON to mur/home/esp/<id>/config (board reads
// → updates EspParams + EEPROM where persistent=true). Validates each key
// against the board's published schema so a typo or stale dashboard tab
// can't push noise that the board's StaticJsonDocument can't parse.
app.post('/api/esp/boards/:id/parameters', async (req, res) => {
  try {
    const id = _espBoardId(req.params.id);
    const params = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (!Object.keys(params).length) return res.status(400).json({ error: 'no parameters in body' });

    // Fetch schema first to validate keys + (later) types.
    const schemaR = await db.query(`SELECT board_schema FROM esp_boards WHERE id = $1`, [id]);
    if (!schemaR.rows.length) return res.status(404).json({ error: 'not found' });
    const schemaParams = (schemaR.rows[0].board_schema?.parameters || []);
    const declared = new Set(schemaParams.map(p => p.key));

    if (declared.size === 0) {
      return res.status(400).json({ error: 'board has not yet published its parameter schema — wait for first connect' });
    }
    const unknown = Object.keys(params).filter(k => !declared.has(k));
    if (unknown.length) {
      return res.status(400).json({ error: `unknown parameter key(s): ${unknown.join(', ')}` });
    }

    const r = await db.query(
      `UPDATE esp_boards SET parameters = $1::jsonb WHERE id = $2 RETURNING id`,
      [JSON.stringify(params), id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    mqttClient.publish(`mur/home/esp/${id}/config`, JSON.stringify(params), { qos: 1 });
    res.json({ ok: true, published: `mur/home/esp/${id}/config`, keys: Object.keys(params) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Push test action → publish action key as plain string to
// mur/home/esp/<id>/command. Action must match a key declared in
// board_schema.actions (or one of the built-ins restart/factory_reset).
const _ESP_BUILTIN_ACTIONS = new Set(['restart', 'factory_reset']);
app.post('/api/esp/boards/:id/command', async (req, res) => {
  try {
    const id = _espBoardId(req.params.id);
    const action = (req.body && req.body.action) ? String(req.body.action).trim() : '';
    // Allow optional ":<digits>" suffix so dispatchers like "delete_user:5"
    // can be published. The base action key is what's validated against the
    // board schema; the numeric payload is passed through unchanged.
    const m = action.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(?::([0-9]+))?$/);
    if (!m) return res.status(400).json({ error: 'invalid action key' });
    const baseAction = m[1];
    const r = await db.query(`SELECT board_schema FROM esp_boards WHERE id = $1`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const declared = (r.rows[0].board_schema?.actions || []).map(a => a.key);
    if (!_ESP_BUILTIN_ACTIONS.has(baseAction) && !declared.includes(baseAction)) {
      return res.status(400).json({ error: `action '${baseAction}' not declared in board schema` });
    }
    mqttClient.publish(`mur/home/esp/${id}/command`, action, { qos: 1 });
    res.json({ ok: true, published: `mur/home/esp/${id}/command`, action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OTA upload — accept .bin via multipart, spawn espota.py against the board.
// Phase 6 (2026-05-02). Variant resolution: ESP8266_OTA_PY by default; if the
// board's last_status.sketch_name (or the chip query string) suggests ESP32,
// fall back to ESP32_OTA_PY. Both paths come from .env.
const espOtaUpload = multer({ dest: path.join(os.tmpdir(), 'esp-ota'), limits: { fileSize: 4 * 1024 * 1024 } });

app.post('/api/esp/boards/:id/ota', espOtaUpload.single('firmware'), async (req, res) => {
  // Capture tmpPath upfront — multer has ALREADY saved the file by the time
  // our handler runs. Any subsequent throw must still hit the finally
  // unlink, otherwise we leak a temp .bin per failed call.
  let tmpPath = req.file ? req.file.path : null;
  try {
    const id = _espBoardId(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'firmware (.bin) file required as multipart field "firmware"' });

    const r = await db.query(
      `SELECT b.id, b.ota_password,
              COALESCE(split_part(b.ip::text, '/', 1), nd.ip) AS ip,
              b.last_status
       FROM esp_boards b
       LEFT JOIN net_devices nd ON LOWER(nd.mac::text) = LOWER(b.mac::text)
       WHERE b.id = $1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'board not found' });
    const board = r.rows[0];
    if (!board.ip) return res.status(400).json({ error: 'board has no known IP — check that ARP scan or board status has populated it' });
    // Per-board ota_password (DB column) is an OPTIONAL override; the default
    // is the shared ESP_OTA_PASSWORD env var, baked into every board's sketch.
    const otaPassword = board.ota_password || process.env.ESP_OTA_PASSWORD || '';
    if (!otaPassword) return res.status(400).json({ error: 'no OTA password — set ESP_OTA_PASSWORD in .env, or PATCH this board with ota_password' });

    // Resolve which espota.py + ArduinoOTA listen port to use. ESP8266
    // ArduinoOTA defaults to 8266; ESP32 (incl. C3/S3) defaults to 3232.
    // Detection: explicit ESP8266 marker → port 8266; everything else →
    // port 3232. Defaulting to ESP32 because new boards in this project
    // are mostly ESP32 family; only RemoteXY's sketch carries "ESP8266" in
    // its name. Caller can still pin via ?chip=esp8266 / ?chip=esp32.
    const chipParam = (req.query.chip || '').toLowerCase();
    const sketchName = (board.last_status?.sketch_name || '').toLowerCase();
    const isEsp8266 = chipParam === 'esp8266' || sketchName.includes('esp8266');
    const isEsp32 = !isEsp8266;
    const otaPy = isEsp32 ? process.env.ESP32_OTA_PY : process.env.ESP8266_OTA_PY;
    const otaPort = isEsp32 ? '3232' : '8266';
    if (!otaPy) return res.status(500).json({ error: `ESP${isEsp32 ? 32 : 8266}_OTA_PY not configured in .env` });
    if (!fs.existsSync(otaPy)) return res.status(500).json({ error: `espota.py not found at configured path: ${otaPy}` });

    // Spawn — use python via PATH, stream stdout+stderr live to the client
    // so the dashboard can show real-time progress (espota.py prints
    // "Sending invitation .....", upload %, etc.). Final line is a JSON
    // sentinel "[exit N ok=true|false]" the client parses for outcome.
    const { spawn } = require('child_process');
    // -t 30 raises espota's per-ack timeout from default 10 s → 30 s. Helps
    // on ESP32-C3 boards where BLE + WiFi share the radio and packets
    // get dropped under contention. ESP8266 espota.py doesn't recognise
    // the -t flag (only ESP32 espota.py supports it) so we omit it on
    // ESP8266 to avoid an "option -t: no such option" failure.
    const args = [otaPy, '-i', board.ip, '-p', otaPort, '-a', otaPassword, '-f', tmpPath, '-r'];
    if (isEsp32) args.push('-t', '30');
    const child = spawn('python', args, { windowsHide: true });

    res.writeHead(200, {
      'Content-Type':      'text/plain; charset=utf-8',
      'Cache-Control':     'no-cache',
      'X-Accel-Buffering': 'no',   // no-op for Express but documents intent
    });
    res.write(`[ota] target=${board.ip} chip=${isEsp32 ? 'esp32' : 'esp8266'} port=${otaPort}\n`);

    child.stdout.on('data', d => res.write(d));
    child.stderr.on('data', d => res.write(d));

    const code = await new Promise((resolve) => {
      // Generous 180 s timeout — first OTA after a Windows Defender prompt
      // can stall for >60 s while the user clicks through. Successful pushes
      // typically take 5–15 s.
      const t = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(-1); }, 180_000);
      child.on('close', c => { clearTimeout(t); resolve(c); });
      child.on('error', e => { clearTimeout(t); res.write('\nSPAWN ERROR: ' + e.message + '\n'); resolve(-1); });
    });

    res.write(`\n[exit code=${code} ok=${code === 0}]\n`);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
});

app.get('/api/rule-engine/events', async (req, res) => {
  try {
    const name = req.query.rule || '';
    const range = req.query.range || '6h';
    const rangeMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000 }[range] || 21600000;
    const from = new Date(Date.now() - rangeMs).toISOString();
    const limit = 500;
    let query, params;
    if (name) {
      query = `SELECT ts AT TIME ZONE 'Asia/Jerusalem' AS ts, rule_name, device_id, source, event_type, result, duration_ms
               FROM rule_events WHERE rule_name = $1 AND ts >= $2 ORDER BY ts DESC LIMIT $3`;
      params = [name, from, limit];
    } else {
      query = `SELECT ts AT TIME ZONE 'Asia/Jerusalem' AS ts, rule_name, device_id, source, event_type, result, duration_ms
               FROM rule_events WHERE ts >= $1 ORDER BY ts DESC LIMIT $2`;
      params = [from, limit];
    }
    const r = await db.query(query, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ────────────────────────────────────────────────────
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS boiler_consumptions (
      id           SERIAL PRIMARY KEY,
      start_ts     TIMESTAMPTZ NOT NULL,
      end_ts       TIMESTAMPTZ NOT NULL,
      start_temp   NUMERIC(5,1) NOT NULL,
      end_temp     NUMERIC(5,1) NOT NULL,
      drop_c       NUMERIC(5,1) NOT NULL,
      duration_min INTEGER NOT NULL,
      detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (start_ts)
    )
  `);
  await db.query(`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS consumption_temp_delta NUMERIC(4,1) DEFAULT 3.0`);
  await db.query(`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS consumption_time_delta INTEGER DEFAULT 15`);
  await db.query(`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS consumption_descent_trigger_c NUMERIC DEFAULT 0.4`);
  await db.query(`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS glitch_drop_threshold_c NUMERIC DEFAULT 10.0`);
  await db.query(`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS glitch_bounce_recovery_c NUMERIC DEFAULT 8.0`);
  await db.query(`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS wf96c_temp_delta_c NUMERIC DEFAULT 0.3`);
  await db.query(`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS wf96c_heartbeat_sec INTEGER DEFAULT 60`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS retention_policies (
      table_name           VARCHAR(100) PRIMARY KEY,
      keep_days            INTEGER,
      auto_clean           BOOLEAN NOT NULL DEFAULT false,
      clean_interval_hours INTEGER NOT NULL DEFAULT 24,
      last_cleaned_at      TIMESTAMPTZ,
      description          TEXT
    )
  `);
  // Seed default policies if table is empty
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES
      ('raw_data',           90,   true,  24, 'Raw sensor readings every 5 min'),
      ('agent_boiler_data',  365,  true,  24, 'Agent decision log'),
      ('raw_weather',        60,   true,  24, 'Hourly weather readings'),
      ('raw_weather_daily',  60,   true,  24, 'Daily weather forecasts'),
      ('boiler_consumptions', NULL, false, 24, 'Hot water consumption events — keep forever'),
      ('orchestrator_log',   30,   true,  24, 'Main agent run logs and alerts'),
      ('system_alerts',      90,   true,  24, 'Cross-agent system alerts from orchestrator'),
      ('sync_signals',        7,   true,  24, 'raw_data producer wake-up signals for boiler agent (source=wf96c_ingest since 2026-04-23; was ha_to_pg)'),
      ('voice_token_log',    365,  true,  24, 'Voice pipeline Claude API token usage and cost'),
      ('backup_log',          90,  true,  24, 'Windows backup run history'),
      ('backup_jobs',        NULL, false, 24, 'Backup job definitions — keep forever'),
      ('backup_storages',    NULL, false, 24, 'Backup storage definitions — keep forever'),
      ('device_events',       30,  true,  24, 'Device state change events'),
      ('device_agent_log',    30,  true,  24, 'Device agent heartbeat log'),
      ('device_blocklist',  NULL, false, 24, 'Deactivated devices — keep forever'),
      ('devices',           NULL, false, 24, 'Device definitions — keep forever'),
      ('rooms',             NULL, false, 24, 'Room definitions — keep forever'),
      ('dashboard_settings', NULL, false, 24, 'Dashboard settings — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS dashboard_settings (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // V5 — device placements inside rooms. Each row = one physical device placed
  // at (x, y) in a room's local meters, with type-specific params JSON.
  await db.query(`
    CREATE TABLE IF NOT EXISTS room_device_placements (
      id            SERIAL PRIMARY KEY,
      slug          TEXT NOT NULL,
      device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      device_type   TEXT,
      x             REAL NOT NULL,
      y             REAL NOT NULL,
      rotation      INTEGER NOT NULL DEFAULT 0,
      params        JSONB NOT NULL DEFAULT '{}'::jsonb,
      label         TEXT,
      label_offset  JSONB,
      label_hidden  BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS room_device_placements_slug_idx      ON room_device_placements(slug)`);
  await db.query(`CREATE INDEX IF NOT EXISTS room_device_placements_device_id_idx ON room_device_placements(device_id)`);
  await db.query(`
    INSERT INTO dashboard_settings (key, value)
    VALUES ('battery_thresholds', '{"good": 60, "low": 20}'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS system_alerts (
      id              BIGSERIAL PRIMARY KEY,
      ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source          VARCHAR(50)  NOT NULL DEFAULT 'orchestrator',
      severity        VARCHAR(10)  NOT NULL DEFAULT 'warn',
      affected_agent  VARCHAR(50),
      alert_type      VARCHAR(50)  NOT NULL,
      message         TEXT         NOT NULL,
      resolved_at     TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_alerts_active ON system_alerts (resolved_at) WHERE resolved_at IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_alerts_agent  ON system_alerts (affected_agent, resolved_at)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_token_log (
      id             BIGSERIAL PRIMARY KEY,
      ts             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      input_text     TEXT,
      intent         VARCHAR(100),
      input_tokens   INTEGER NOT NULL,
      output_tokens  INTEGER NOT NULL,
      cost_usd       NUMERIC(12,8) NOT NULL,
      model          VARCHAR(100)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_signals (
      id      BIGSERIAL PRIMARY KEY,
      ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source  VARCHAR(50) NOT NULL DEFAULT 'ha_to_pg'
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sync_signals_ts ON sync_signals (ts DESC)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS manual_requests (
      id          BIGSERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      intent      VARCHAR(100) NOT NULL,
      status      VARCHAR(50)  NOT NULL DEFAULT 'pending',
      target_temp NUMERIC(5,1),
      start_temp  NUMERIC(5,1),
      ready_at    TIMESTAMPTZ,
      message     TEXT
    )
  `);

  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES ('manual_requests', 90, true, 24, 'Voice-initiated manual requests (shower, bath, etc.)')
    ON CONFLICT (table_name) DO NOTHING
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_device_settings (
      id               INT PRIMARY KEY DEFAULT 1,
      output_device    VARCHAR(50)  NOT NULL DEFAULT 'browser-speaker',
      vol_browser      INT          NOT NULL DEFAULT 80,
      vol_soundbar     INT          NOT NULL DEFAULT 40,
      vol_alexa_guy    INT          NOT NULL DEFAULT 70,
      boiler_low_temp  NUMERIC(5,1) NOT NULL DEFAULT 40,
      boiler_shower_temp NUMERIC(5,1) NOT NULL DEFAULT 45,
      boiler_bath_temp   NUMERIC(5,1) NOT NULL DEFAULT 50,
      boiler_heat_rate   NUMERIC(5,1) NOT NULL DEFAULT 15,
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  await db.query(`
    INSERT INTO voice_device_settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_devices (
      id                   SERIAL PRIMARY KEY,
      name                 VARCHAR(100) NOT NULL,
      device_type          VARCHAR(50)  NOT NULL DEFAULT 'switch',
      ha_entity            VARCHAR(200),
      intent               VARCHAR(100),
      response_style       VARCHAR(20)  NOT NULL DEFAULT 'short',
      custom_text_enabled  BOOLEAN      NOT NULL DEFAULT false,
      custom_response_text TEXT,
      custom_confirm_text  TEXT,
      custom_no_text       TEXT,
      enabled              BOOLEAN      NOT NULL DEFAULT true,
      sort_order           INTEGER      NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    INSERT INTO voice_devices (name, device_type, ha_entity, intent, response_style, custom_text_enabled, sort_order)
    SELECT 'Electric Boiler', 'boiler', 'switch.boiler_switch_switch_1', 'shower_prepare,bath_prepare,boiler_on,boiler_off', 'full_confirm', false, 0
    WHERE NOT EXISTS (SELECT 1 FROM voice_devices WHERE name = 'Electric Boiler')
  `);
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES ('voice_devices', NULL, false, 24, 'Voice device registry — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES ('voice_device_settings', NULL, false, 24, 'Voice output device and electric boiler settings — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_intent_phrases (
      id          SERIAL PRIMARY KEY,
      intent      TEXT      NOT NULL,
      phrase      TEXT      NOT NULL UNIQUE,
      language    CHAR(2)   NOT NULL DEFAULT 'he',
      device_type VARCHAR(50) NOT NULL DEFAULT 'boiler',
      sort_order  INTEGER   NOT NULL DEFAULT 0,
      enabled     BOOLEAN   NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE voice_intent_phrases ADD COLUMN IF NOT EXISTS device_type VARCHAR(50) NOT NULL DEFAULT 'boiler'`);
  await db.query(`ALTER TABLE voice_intent_phrases ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
  await db.query(`UPDATE voice_intent_phrases SET device_type = 'boiler' WHERE device_type IS NULL OR device_type = ''`);
  await db.query(`ALTER TABLE voice_devices ADD COLUMN IF NOT EXISTS language CHAR(2) NOT NULL DEFAULT ''`);
  await db.query(`
    INSERT INTO voice_intent_phrases (intent, phrase, language) VALUES
      ('boiler_on',      'הדלק את הדוד',           'he'),
      ('boiler_on',      'תדליק את הדוד',          'he'),
      ('boiler_on',      'הפעל את הדוד',           'he'),
      ('boiler_on',      'הפעל דוד',               'he'),
      ('boiler_on',      'switch on boiler',        'en'),
      ('boiler_on',      'turn on boiler',          'en'),
      ('boiler_on',      'start boiler',            'en'),
      ('boiler_on',      'включи бойлер',           'ru'),
      ('boiler_on',      'запусти бойлер',          'ru'),
      ('boiler_off',     'כבה את הדוד',            'he'),
      ('boiler_off',     'תכבה את הדוד',           'he'),
      ('boiler_off',     'סגור את הדוד',            'he'),
      ('boiler_off',     'switch off boiler',       'en'),
      ('boiler_off',     'turn off boiler',         'en'),
      ('boiler_off',     'stop boiler',             'en'),
      ('boiler_off',     'выключи бойлер',          'ru'),
      ('boiler_off',     'отключи бойлер',          'ru'),
      ('boiler_status',  'מה הטמפרטורה',           'he'),
      ('boiler_status',  'כמה חם הדוד',            'he'),
      ('boiler_status',  'boiler status',           'en'),
      ('boiler_status',  'как вода',                'ru'),
      ('shower_prepare', 'תכין מקלחת',             'he'),
      ('shower_prepare', 'אפשר להתקלח',            'he'),
      ('shower_prepare', 'is the shower ready',     'en'),
      ('bath_prepare',   'תכין אמבטיה',            'he'),
      ('bath_prepare',   'אפשר להכין אמבטיה',      'he'),
      ('bath_prepare',   'готовь ванну',            'ru')
    ON CONFLICT (phrase) DO NOTHING
  `);
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES ('voice_intent_phrases', NULL, false, 24, 'Voice intent phrase library — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_device_entities (
      id          SERIAL PRIMARY KEY,
      device_id   INTEGER NOT NULL REFERENCES voice_devices(id) ON DELETE CASCADE,
      ha_entity   VARCHAR(200) NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (device_id, ha_entity)
    )
  `);
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES ('voice_device_entities', NULL, false, 24, 'Voice switch group entity list — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES
      ('agents',         NULL, false, 24, 'Agent registry — keep forever'),
      ('agent_settings', NULL, false, 24, 'Boiler agent settings — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id         SERIAL PRIMARY KEY,
      title      VARCHAR(200) NOT NULL,
      url        TEXT         NOT NULL,
      theme      VARCHAR(50)  NOT NULL DEFAULT 'General',
      sort_order INTEGER      NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES ('documents', NULL, false, 24, 'Project documentation links — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);

  // ─── Media Library ────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS media_library (
      path            TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      type            TEXT,
      category        TEXT,
      person          TEXT[] DEFAULT '{}',
      event           TEXT,
      year            INT,
      location        TEXT,
      duration_sec    INT,
      size_bytes      BIGINT,
      resolution      TEXT,
      file_hash       TEXT UNIQUE,
      search_text     TEXT,
      added_at        TIMESTAMPTZ DEFAULT NOW(),
      last_played     TIMESTAMPTZ,
      play_count      INT DEFAULT 0
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_media_search ON media_library USING GIN (to_tsvector('english', coalesce(search_text,'')))`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS face_registry (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      embedding   FLOAT8[] NOT NULL,
      image_path  TEXT,
      added_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES
      ('media_library', NULL, false, 24, 'Media file metadata — keep forever'),
      ('face_registry',  NULL, false, 24, 'Face recognition embeddings — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);

  // ─── HASP touch panels (OpenHASP) — Phase 1 schema (2026-05-01) ────────────
  // Three config tables driving the rule on LXC 105 + dashboard "Panels" page.
  // hasp_panels  — registry of physical devices (one row per panel)
  // hasp_buttons — toggle-button → action mapping (page+button_id is the panel-side key)
  // hasp_displays — value-label → data source mapping (rule pushes values to panel)
  await db.query(`
    CREATE TABLE IF NOT EXISTS hasp_panels (
      id                 SERIAL PRIMARY KEY,
      name               VARCHAR(50)  UNIQUE NOT NULL,        -- short slug, used in MQTT topic
      ip                 INET,
      mac                MACADDR,
      hardware           VARCHAR(50),                          -- e.g. "ESP32-S3 4848S040"
      firmware_version   VARCHAR(50),
      location           VARCHAR(100),                         -- human label (e.g. "Balcony")
      mqtt_prefix        VARCHAR(100) DEFAULT 'hasp',          -- topic prefix; full = <prefix>/<name>/...
      enabled            BOOLEAN NOT NULL DEFAULT true,
      last_seen          TIMESTAMPTZ,
      last_status        JSONB,                                -- last statusupdate payload
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS hasp_buttons (
      id              SERIAL PRIMARY KEY,
      panel_id        INTEGER NOT NULL REFERENCES hasp_panels(id) ON DELETE CASCADE,
      page            INTEGER NOT NULL,
      button_id       INTEGER NOT NULL,
      event           VARCHAR(20) NOT NULL DEFAULT 'short',     -- 'short'|'long'|'down'|'up'|'double' — same panel button, different event = different row
      label           VARCHAR(50),                              -- "GATES" (display in dashboard)
      icon_codepoint  VARCHAR(10),                              -- "U+E10B" for car
      action_type     VARCHAR(30),                              -- 'device'|'hasp_command'|'pixoo_preset'|'scene'|NULL — picker dispatcher
      action_target   VARCHAR(200),                             -- device_id / "page 2" / preset name / scene_id
      action_payload  JSONB,                                    -- extra args (channel, var subs, etc.)
      last_state      JSONB,                                    -- last known toggle/event state from device
      last_event_at   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (panel_id, page, button_id, event)
    )
  `);

  // Idempotent migration for instances that pre-date the 'event' column (added 2026-05-01).
  await db.query(`ALTER TABLE hasp_buttons ADD COLUMN IF NOT EXISTS event VARCHAR(20) NOT NULL DEFAULT 'short'`);
  // bindings JSONB array — multi-device per button (added 2026-05-01, wallmote parity).
  await db.query(`ALTER TABLE hasp_buttons ADD COLUMN IF NOT EXISTS bindings JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db.query(`ALTER TABLE hasp_buttons DROP CONSTRAINT IF EXISTS hasp_buttons_panel_id_page_button_id_key`);
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'hasp_buttons_panel_id_page_button_id_event_key'
      ) THEN
        ALTER TABLE hasp_buttons ADD CONSTRAINT hasp_buttons_panel_id_page_button_id_event_key
          UNIQUE (panel_id, page, button_id, event);
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS hasp_displays (
      id                  SERIAL PRIMARY KEY,
      panel_id            INTEGER NOT NULL REFERENCES hasp_panels(id) ON DELETE CASCADE,
      page                INTEGER NOT NULL,
      label_id            INTEGER NOT NULL,
      description         TEXT,                                 -- "UPS battery percentage"
      display_type        VARCHAR(20) NOT NULL DEFAULT 'text',  -- 'text'|'gauge'|'series'|'bar' — drives renderer
      target_property     VARCHAR(20) NOT NULL DEFAULT 'text',  -- HASP property to mutate ('text','val','bg_color',…)
      source_type         VARCHAR(20),                          -- 'sql'|'mqtt_subscribe'|'shared_state'|'ha_state'
      source_value        VARCHAR(500),                         -- SQL query / topic / shared key / HA entity
      format_string       VARCHAR(100) DEFAULT '{}',            -- "{{val}}°C" applied to the source value
      refresh_sec         INTEGER NOT NULL DEFAULT 30,
      last_value          TEXT,
      last_published_at   TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (panel_id, page, label_id)
    )
  `);

  // Idempotent migration for instances that pre-date display_type / target_property (added 2026-05-01).
  await db.query(`ALTER TABLE hasp_displays ADD COLUMN IF NOT EXISTS display_type    VARCHAR(20) NOT NULL DEFAULT 'text'`);
  await db.query(`ALTER TABLE hasp_displays ADD COLUMN IF NOT EXISTS target_property VARCHAR(20) NOT NULL DEFAULT 'text'`);

  // Retention: all three are config tables — keep forever.
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES
      ('hasp_panels',   NULL, false, 24, 'OpenHASP panel registry — keep forever'),
      ('hasp_buttons',  NULL, false, 24, 'HASP button → action mapping — keep forever'),
      ('hasp_displays', NULL, false, 24, 'HASP value-label → data source mapping — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);

  // Seed: balcony panel (the one already configured + persisted to /etc/apcupsd-style location)
  await db.query(`
    INSERT INTO hasp_panels (name, ip, mac, hardware, firmware_version, location)
    VALUES ('balcony', '192.168.1.141', '8c:bf:ea:0d:c3:24', 'ESP32-S3 4848S040', '0.7.0-rc12', 'Balcony')
    ON CONFLICT (name) DO NOTHING
  `);

  // Seed: balcony's 4 buttons (action_type/target NULL — wired in Phase 2)
  await db.query(`
    INSERT INTO hasp_buttons (panel_id, page, button_id, event, label, icon_codepoint)
    SELECT p.id, 1, b.button_id, 'up', b.label, b.icon
    FROM hasp_panels p,
         (VALUES (110, 'GATES', 'U+E10B'),
                 (120, 'BARRIER', 'U+E10B'),
                 (130, 'LIGHT 1', 'U+E769'),
                 (140, 'LIGHT 3', 'U+E769')) AS b(button_id, label, icon)
    WHERE p.name = 'balcony'
    ON CONFLICT (panel_id, page, button_id, event) DO NOTHING
  `);

  // ─── ESP boards (ESP8266 / ESP32 sketches) — Phase 3 schema (2026-05-02) ────
  // Registry of self-managed Arduino boards. Each board self-declares its
  // tunable parameters + test actions via MQTT topic mur/home/esp/<id>/schema.
  // Status (RSSI / uptime / heap) flows in via mur/home/esp/<id>/status and is
  // persisted to last_status. Rule engine on LXC 105 owns the MQTT ingest;
  // dashboard only owns config CRUD + OTA orchestration.
  await db.query(`
    CREATE TABLE IF NOT EXISTS esp_boards (
      id              VARCHAR(50) PRIMARY KEY,         -- matches MQTT <id>, e.g. 'remoteXY_01'
      name            VARCHAR(100),                     -- human label
      ip              INET,                             -- last known IP (also resolvable via net_devices.mac)
      mac             MACADDR,                          -- for net_devices live-IP join
      sketch_name     VARCHAR(100),                     -- self-reported via /status
      sketch_version  VARCHAR(50),
      build_ts        TIMESTAMPTZ,
      board_schema    JSONB DEFAULT '{}'::jsonb,        -- {parameters:[...], actions:[...]} from /schema
      parameters      JSONB DEFAULT '{}'::jsonb,        -- last-set values (dashboard → /config)
      ota_password    VARCHAR(100),                     -- per-board ArduinoOTA password
      enabled         BOOLEAN NOT NULL DEFAULT true,
      last_seen       TIMESTAMPTZ,
      last_status     JSONB,                            -- last /status payload
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Retention: config table — keep forever, no auto-clean.
  await db.query(`
    INSERT INTO retention_policies (table_name, keep_days, auto_clean, clean_interval_hours, description)
    VALUES ('esp_boards', NULL, false, 24, 'ESP8266/ESP32 board registry — keep forever')
    ON CONFLICT (table_name) DO NOTHING
  `);
}

// ─── HA service call helper ───────────────────────────────────
async function callHA(domain, service, data) {
  const r = await fetch(`${HA_URL}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getHaToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(5000)
  });
  if (!r.ok) throw new Error(`HA ${domain}.${service} failed: ${r.status}`);
  return r.json();
}

// ─── Voice: Execute intent ─────────────────────────────────────
const SHOWER_TEMP = 45;
const BATH_TEMP   = 50;

app.post('/api/request', async (req, res) => {
  const { intent, params = {} } = req.body;
  if (!intent) return res.status(400).json({ error: 'No intent' });

  try {
    // ── boiler_status ──────────────────────────────────────────
    if (intent === 'boiler_status') {
      const r = await db.query('SELECT boiler_temp, panel_temp, valve_state FROM raw_data ORDER BY ts DESC LIMIT 1');
      if (!r.rows.length) return res.json({ ok: false, message: 'No boiler data available' });
      const { boiler_temp, panel_temp, valve_state } = r.rows[0];
      return res.json({
        ok: true,
        message: `Boiler is ${boiler_temp}°C, panel is ${panel_temp}°C, valve is ${valve_state ? 'open' : 'closed'}`,
        data: { boiler_temp, panel_temp, valve_state }
      });
    }

    // ── boiler_on / boiler_off ─────────────────────────────────
    if (intent === 'boiler_on' || intent === 'boiler_off') {
      const service = intent === 'boiler_on' ? 'turn_on' : 'turn_off';
      await callHA('switch', service, { entity_id: 'switch.boiler_switch_switch_1' });
      const r = await db.query('SELECT boiler_temp FROM raw_data ORDER BY ts DESC LIMIT 1');
      const boiler_temp = r.rows.length ? r.rows[0].boiler_temp : null;
      const action = intent === 'boiler_on' ? 'on' : 'off';
      const tempNote = boiler_temp !== null ? ` Current temperature: ${boiler_temp}°C.` : '';
      return res.json({ ok: true, message: `Electric boiler turned ${action}.${tempNote}`, data: { action, boiler_temp } });
    }

    // ── shower_prepare / bath_prepare ──────────────────────────
    if (intent === 'shower_prepare' || intent === 'bath_prepare') {
      const ds = await db.query('SELECT * FROM voice_device_settings WHERE id = 1');
      const cfg = ds.rows[0] || {};
      const threshold = intent === 'bath_prepare'
        ? parseFloat(cfg.boiler_bath_temp   || BATH_TEMP)
        : parseFloat(cfg.boiler_shower_temp || SHOWER_TEMP);
      const heatRate  = parseFloat(cfg.boiler_heat_rate || 15);
      const label = intent === 'bath_prepare' ? 'Bath' : 'Shower';
      const r = await db.query('SELECT boiler_temp FROM raw_data ORDER BY ts DESC LIMIT 1');
      if (!r.rows.length) return res.json({ ok: false, message: 'No boiler data available' });
      const { boiler_temp } = r.rows[0];
      const current = parseFloat(boiler_temp);
      const ready = current >= threshold;

      // Confirmed by user (second call after yes) — turn on electric boiler if not ready
      if (req.body.confirmed) {
        if (ready) {
          return res.json({ ok: true, message: `${label} is ready! Boiler is ${boiler_temp}°C`, data: { boiler_temp: current, threshold, ready: true } });
        }
        await callHA('switch', 'turn_on', { entity_id: 'switch.boiler_switch_switch_1' });
        const waitMin = Math.ceil((threshold - current) / heatRate * 60);
        const message = `Electric boiler is on. Estimated ~${waitMin} min to reach ${threshold}°C`;
        await db.query(
          `INSERT INTO manual_requests (intent, status, target_temp, start_temp, message, ready_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [intent, 'heating', threshold, boiler_temp, message, null]
        );
        return res.json({ ok: true, message, data: { boiler_temp: current, threshold, ready: false, heating: true } });
      }

      // First call — report status
      let message;
      if (ready) {
        message = `${label} is ready! Boiler is ${boiler_temp}°C`;
      } else {
        const waitMin = Math.ceil((threshold - current) / heatRate * 60);
        message = `Boiler is ${boiler_temp}°C, need ${threshold}°C. Estimated wait: ~${waitMin} min`;
      }
      await db.query(
        `INSERT INTO manual_requests (intent, status, target_temp, start_temp, message, ready_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [intent, ready ? 'ready' : 'pending', threshold, boiler_temp, message, ready ? new Date() : null]
      );
      return res.json({ ok: true, message, data: { boiler_temp: current, threshold, ready } });
    }

    // ── light_on / light_off ───────────────────────────────────
    if (intent === 'light_on' || intent === 'light_off') {
      const room = params.room;
      if (!room) return res.json({ ok: false, message: 'Which room? Please say the room name.' });
      const entity = `light.${room.toLowerCase().replace(/\s+/g, '_')}`;
      const service = intent === 'light_on' ? 'turn_on' : 'turn_off';
      await callHA('light', service, { entity_id: entity });
      return res.json({
        ok: true,
        message: `Light ${intent === 'light_on' ? 'on' : 'off'} in ${room}`,
        data: { entity }
      });
    }

    // ── switch_on / switch_off ────────────────────────────────
    if (intent === 'switch_on' || intent === 'switch_off') {
      const service = intent === 'switch_on' ? 'turn_on' : 'turn_off';
      const devR = await db.query(
        `SELECT * FROM voice_devices WHERE enabled = true AND intent LIKE '%' || $1 || '%' ORDER BY sort_order, id LIMIT 1`,
        [intent]
      );
      if (!devR.rows.length) return res.json({ ok: false, message: 'No switch device configured for this command.' });
      const dev = devR.rows[0];
      if (dev.device_type === 'switch_group') {
        const entR = await db.query('SELECT ha_entity FROM voice_device_entities WHERE device_id = $1 ORDER BY sort_order, id', [dev.id]);
        if (!entR.rows.length) return res.json({ ok: false, message: `No entities configured for ${dev.name}` });
        const failed = [];
        for (const { ha_entity } of entR.rows) {
          try { await callHA('switch', service, { entity_id: ha_entity }); }
          catch (_) { failed.push(ha_entity); }
        }
        const action = intent === 'switch_on' ? 'on' : 'off';
        const ok = failed.length === 0;
        const msg = ok
          ? `${dev.name} turned ${action} (${entR.rows.length} switches)`
          : `${dev.name} partially ${action} — ${failed.length} failed: ${failed.join(', ')}`;
        return res.json({ ok, message: msg, data: { entities: entR.rows.map(r => r.ha_entity), failed } });
      } else {
        if (!dev.ha_entity) return res.json({ ok: false, message: `No HA entity configured for ${dev.name}` });
        await callHA('switch', service, { entity_id: dev.ha_entity });
        const action = intent === 'switch_on' ? 'on' : 'off';
        return res.json({ ok: true, message: `${dev.name} turned ${action}.`, data: { entity: dev.ha_entity } });
      }
    }

    // ── media_search ───────────────────────────────────────────
    if (intent === 'media_search') {
      const q = params.query || '';
      if (!q) return res.json({ ok: false, message: 'What do you want to find?' });
      const r = await fetch(`${PLAYER_API_URL}/api/media/search?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!r.ok) return res.json({ ok: false, message: d.error || 'Search failed.' });
      const results = d.results || [];
      _mediaSearchSession = { results, timestamp: Date.now() };
      const msg = results.length
        ? `Found ${results.length} result${results.length > 1 ? 's' : ''} for ${q}. Say play 1, play 2, and so on.`
        : `No results found for ${q}.`;
      return res.json({ ok: true, message: msg, data: { count: results.length, results } });
    }

    // ── media_play_number ──────────────────────────────────────
    if (intent === 'media_play_number') {
      const num = parseInt(params.number);
      if (!num) return res.json({ ok: false, message: 'Which number?' });
      const sessionAge = Date.now() - _mediaSearchSession.timestamp;
      if (sessionAge > 600000) return res.json({ ok: false, message: 'Search session expired. Search again first.' });
      const item = _mediaSearchSession.results.find(r => r.number === num);
      if (!item) return res.json({ ok: false, message: `No item number ${num} in results.` });
      fetch(`${PLAYER_API_URL}/api/media/play-number`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: num })
      }).catch(() => {});
      return res.json({ ok: true, message: `Playing ${item.title}.`, data: { title: item.title, number: num } });
    }

    // ── general_query / fallback ───────────────────────────────
    return res.json({ ok: false, message: `Sorry, I didn't understand that command. Try: "turn on boiler", "shower status", "boiler temperature".`, intent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Voice: Transcribe audio via Whisper (LXC 106 HTTP helper) ──
app.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });
  try {
    const mime = req.file.mimetype || 'audio/webm';
    const audioBuffer = fs.readFileSync(req.file.path);
    const response = await fetch(`http://192.168.1.188:10301/transcribe`, {
      method: 'POST',
      body: audioBuffer,
      headers: { 'Content-Type': mime, 'Content-Length': audioBuffer.length },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Whisper HTTP error: ${response.status}`);
    const data = await response.json();
    fs.unlinkSync(req.file.path);
    res.json({ text: data.text });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// ─── Voice: phrase cache ───────────────────────────────────────────────
let _phrasesCache = null;
let _phrasesCacheTs = 0;
let _mediaSearchSession = { results: [], timestamp: 0 };
async function loadPhrasesCache() {
  if (_phrasesCache && Date.now() - _phrasesCacheTs < 60000) return _phrasesCache;
  const r = await db.query('SELECT intent, phrase FROM voice_intent_phrases WHERE enabled = true ORDER BY sort_order, length(phrase) DESC');
  _phrasesCache = r.rows;
  _phrasesCacheTs = Date.now();
  return _phrasesCache;
}
function clearPhrasesCache() { _phrasesCache = null; }

// ─── Voice: keyword pre-filter (runs before Claude) ──────
function stripNiqqud(text) {
  return text.replace(/[ְ-ׇװ-״]/g, '');
}

function keywordIntent(rawText) {
  const t = stripNiqqud(rawText).toLowerCase().trim();
  const hasBoiler = /boiler|דוד|בויל|бойлер|котёл|котел/.test(t);
  const hasOn  = /on|turn|switch|start|הדל|תדל|הפעל|הפעיל|включи|запусти/.test(t);
  const hasOff = /off|stop|shut|כבה|תכבה|לכבות|כבי|סגור|עצור|выключи|отключи|останови/.test(t);
  if (hasBoiler && hasOn && !hasOff) return 'boiler_on';
  if (hasBoiler && hasOff)           return 'boiler_off';

  // Media search: "find X", "search X", "show X"
  const mediaSearch = t.match(/^(?:find|search|show|look for)\s+(.+)$/);
  if (mediaSearch) return { intent: 'media_search', params: { query: mediaSearch[1].trim() } };

  // Media play by number: "play 1", "play number 2", just a digit 1-15
  const playNum = t.match(/^(?:play\s+(?:number\s+)?|watch\s+)(\d+)$/) || t.match(/^(\d+)$/);
  if (playNum) {
    const n = parseInt(playNum[1]);
    if (n >= 1 && n <= 15) return { intent: 'media_play_number', params: { number: n } };
  }

  return null;
}

async function phraseIntent(rawText) {
  try {
    const phrases = await loadPhrasesCache();
    const t = stripNiqqud(rawText).toLowerCase();
    for (const { intent, phrase } of phrases) {
      if (t.includes(stripNiqqud(phrase).toLowerCase())) return intent;
    }
  } catch (_) {}
  return null;
}

// ─── Voice: Extract intent via Claude ────────────────────
app.post('/api/voice/intent', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  // Fast path 1 — hardcoded regex
  const kw = keywordIntent(text);
  if (kw) return res.json({ intent: kw, params: {}, confidence: 'high', original_language: 'auto', _source: 'keyword' });

  // Fast path 2 — DB phrase match
  const ph = await phraseIntent(text);
  if (ph) return res.json({ intent: ph, params: {}, confidence: 'high', original_language: 'auto', _source: 'phrase' });

  try {
    const phrases = await loadPhrasesCache();
    const byIntent = {};
    for (const { intent, phrase } of phrases) {
      (byIntent[intent] = byIntent[intent] || []).push('"' + phrase + '"');
    }
    const examplesBlock = Object.entries(byIntent)
      .map(([k, v]) => '- ' + k + ': ' + v.slice(0, 4).join(', '))
      .join('\n');

    const systemPrompt = `You are a smart home voice controller. The user speaks Hebrew, Russian, or English.\nExtract the user's intent and return ONLY a JSON object — no explanation, no markdown.\n\nKnown phrase examples per intent:\n${examplesBlock}\n\nAvailable intents:\n- boiler_on, boiler_off, boiler_status\n- shower_prepare, bath_prepare\n- light_on (params: room), light_off (params: room)\n- climate_set (params: temp, room)\n- media_play (params: what, where), media_pause, media_volume (params: level, device)\n- media_search (params: query): say find/search/show + name
- media_play_number (params: number): say play 1-15 or just a number
- general_query: only if truly unclear\n\nReturn format: {"intent":"...","params":{},"confidence":"high|medium|low","original_language":"he|ru|en"}`;

    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }]
    });
    const raw = result.content[0].text.trim();
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ ...json, _usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, model: 'claude-haiku-4-5-20251001' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Voice: HA switch list ────────────────────────────────────────────────
app.get('/api/ha/switches', async (_req, res) => {
  try {
    const r = await fetch(`${HA_URL}/api/states`, {
      headers: { Authorization: `Bearer ${getHaToken()}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error(`HA states error: ${r.status}`);
    const states = await r.json();
    const switches = states
      .filter(s => s.entity_id.startsWith('switch.'))
      .map(s => ({ entity_id: s.entity_id, state: s.state, friendly_name: s.attributes?.friendly_name || s.entity_id }))
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    res.json(switches);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Voice: Intent phrases CRUD ───────────────────────────────────────────
app.get('/api/voice/phrases', async (req, res) => {
  try {
    const conditions = ['1=1'];
    const vals = [];
    if (req.query.device_type) { vals.push(req.query.device_type); conditions.push(`device_type = $${vals.length}`); }
    if (req.query.language)    { vals.push(req.query.language);    conditions.push(`trim(language) = $${vals.length}`); }
    const where = conditions.join(' AND ');
    const r = await db.query(`SELECT * FROM voice_intent_phrases WHERE ${where} ORDER BY sort_order, length(phrase) DESC, id`, vals);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voice/phrases', async (req, res) => {
  const { intent, phrase, language, device_type, sort_order } = req.body;
  if (!intent || !phrase) return res.status(400).json({ error: 'intent and phrase required' });
  try {
    const r = await db.query(
      'INSERT INTO voice_intent_phrases (intent, phrase, language, device_type, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [intent, phrase.trim(), language || 'he', device_type || 'boiler', sort_order || 0]
    );
    clearPhrasesCache();
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/voice/phrases/:id', async (req, res) => {
  const { enabled, sort_order } = req.body;
  try {
    const sets = [];
    const vals = [];
    if (enabled    !== undefined) { vals.push(enabled);     sets.push(`enabled = $${vals.length}`); }
    if (sort_order !== undefined) { vals.push(sort_order);  sets.push(`sort_order = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    const r = await db.query(
      `UPDATE voice_intent_phrases SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    clearPhrasesCache();
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/voice/phrases/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM voice_intent_phrases WHERE id = $1', [req.params.id]);
    clearPhrasesCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Voice: Device settings ───────────────────────────────────
app.get('/api/voice/device-settings', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM voice_device_settings WHERE id = 1');
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voice/device-settings', async (req, res) => {
  const { output_device, vol_browser, vol_soundbar, vol_alexa_guy,
          boiler_low_temp, boiler_shower_temp, boiler_bath_temp, boiler_heat_rate,
          response_style, custom_text_enabled, custom_response_text, custom_confirm_text } = req.body;
  try {
    await db.query(`
      UPDATE voice_device_settings SET
        output_device        = COALESCE($1, output_device),
        vol_browser          = COALESCE($2, vol_browser),
        vol_soundbar         = COALESCE($3, vol_soundbar),
        vol_alexa_guy        = COALESCE($4, vol_alexa_guy),
        boiler_low_temp      = COALESCE($5, boiler_low_temp),
        boiler_shower_temp   = COALESCE($6, boiler_shower_temp),
        boiler_bath_temp     = COALESCE($7, boiler_bath_temp),
        boiler_heat_rate     = COALESCE($8, boiler_heat_rate),
        response_style       = COALESCE($9, response_style),
        custom_text_enabled  = COALESCE($10, custom_text_enabled),
        custom_response_text = COALESCE($11, custom_response_text),
        custom_confirm_text  = COALESCE($12, custom_confirm_text),
        updated_at           = NOW()
      WHERE id = 1
    `, [output_device, vol_browser, vol_soundbar, vol_alexa_guy,
        boiler_low_temp, boiler_shower_temp, boiler_bath_temp, boiler_heat_rate,
        response_style, custom_text_enabled ?? null, custom_response_text ?? null, custom_confirm_text ?? null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Voice: Device registry ───────────────────────────────────
app.get('/api/voice/devices', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM voice_devices ORDER BY sort_order, id');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voice/devices', async (req, res) => {
  const { name, device_type, ha_entity, intent, response_style,
          custom_text_enabled, custom_response_text, custom_confirm_text, custom_no_text, sort_order, language } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = await db.query(
      `INSERT INTO voice_devices (name, device_type, ha_entity, intent, response_style,
         custom_text_enabled, custom_response_text, custom_confirm_text, custom_no_text, sort_order, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, device_type || 'switch', ha_entity || null, intent || null,
       response_style || 'short', custom_text_enabled || false,
       custom_response_text || null, custom_confirm_text || null, custom_no_text || null, sort_order || 0,
       language || '']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/voice/devices/:id', async (req, res) => {
  const { name, device_type, ha_entity, intent, response_style,
          custom_text_enabled, custom_response_text, custom_confirm_text, custom_no_text, enabled, sort_order, language } = req.body;
  try {
    const r = await db.query(
      `UPDATE voice_devices SET
        name                 = COALESCE($1, name),
        device_type          = COALESCE($2, device_type),
        ha_entity            = COALESCE($3, ha_entity),
        intent               = COALESCE($4, intent),
        response_style       = COALESCE($5, response_style),
        custom_text_enabled  = COALESCE($6, custom_text_enabled),
        custom_response_text = COALESCE($7, custom_response_text),
        custom_confirm_text  = COALESCE($8, custom_confirm_text),
        custom_no_text       = COALESCE($9, custom_no_text),
        enabled              = COALESCE($10, enabled),
        sort_order           = COALESCE($11, sort_order),
        language             = COALESCE($12, language)
       WHERE id = $13 RETURNING *`,
      [name, device_type, ha_entity, intent, response_style,
       custom_text_enabled ?? null, custom_response_text ?? null,
       custom_confirm_text ?? null, custom_no_text ?? null,
       enabled ?? null, sort_order ?? null, language ?? null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/voice/devices/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM voice_devices WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Voice: Device entity list (for switch groups) ────────────────────────
app.get('/api/voice/device-entities/:deviceId', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM voice_device_entities WHERE device_id = $1 ORDER BY sort_order, id', [req.params.deviceId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/voice/device-entities', async (req, res) => {
  const { device_id, ha_entity } = req.body;
  if (!device_id || !ha_entity) return res.status(400).json({ error: 'device_id and ha_entity required' });
  try {
    const r = await db.query(
      'INSERT INTO voice_device_entities (device_id, ha_entity) VALUES ($1, $2) RETURNING *',
      [device_id, ha_entity]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/voice/device-entities/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM voice_device_entities WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Voice: Save token usage to DB ───────────────────────────
app.post('/api/voice/token-log', async (req, res) => {
  const { input_text, intent, input_tokens, output_tokens, cost_usd, model } = req.body;
  try {
    await db.query(
      `INSERT INTO voice_token_log (input_text, intent, input_tokens, output_tokens, cost_usd, model)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input_text?.slice(0,500), intent, input_tokens, output_tokens, cost_usd, model]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voice/token-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  try {
    const r = await db.query(
      `SELECT id, ts, input_text, intent, input_tokens, output_tokens, cost_usd, model
       FROM voice_token_log ORDER BY ts DESC LIMIT $1`, [limit]
    );
    const totals = await db.query(
      `SELECT COALESCE(SUM(input_tokens),0) AS total_in,
              COALESCE(SUM(output_tokens),0) AS total_out,
              COALESCE(SUM(cost_usd),0) AS total_cost
       FROM voice_token_log`
    );
    res.json({ rows: r.rows, totals: totals.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Media: all endpoints → LXC 100 media-service http://192.168.1.138:8766 ──

// ─── Alexa: HA-mediated control (notify.alexa_media + media_player.*) ─────
// Reuses callHA() above (line ~2810). Devices live in `devices` table with
// protocol='alexa' and id=HA entity_id (e.g. 'media_player.10inch_echo_show').

// GET /api/alexa/devices — list rows + live HA state for each
app.get('/api/alexa/devices', async (_req, res) => {
  try {
    const r = await db.query(
      "SELECT id, name, room FROM devices WHERE protocol='alexa' AND enabled=true ORDER BY name"
    );
    const now = Date.now();
    const states = await Promise.all(r.rows.map(async d => {
      const speakingUntil = _alexaSpeakingUntil.get(d.id);
      const speaking      = speakingUntil != null && speakingUntil > now;
      try {
        const sr = await fetch(`${HA_URL}/api/states/${d.id}`,
          { headers: { Authorization: `Bearer ${getHaToken()}` },
            signal: AbortSignal.timeout(4000) });
        const ha = sr.ok ? await sr.json() : null;
        return { ...d, ha, speaking };
      } catch (_) { return { ...d, ha: null, speaking }; }
    }));
    res.json(states);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Global Alexa speech settings (rate, voice, announcement volume). One row
// in dashboard_settings; applies to every device. Standardized 2026-05-07
// on plain TTS for all devices — was per-device notify_type='announce' vs
// 'tts' but SSML (which we need for rate + voice) only works in TTS mode.
// Echo announce-chime feature was lost in the move; the user did not hear
// the chime in testing anyway, so the trade is purely a feature gain.
const ALEXA_SPEECH_KEY = 'media-agents.alexa_speech';

async function getAlexaSpeechSettings() {
  try {
    const r = await db.query(
      "SELECT value FROM dashboard_settings WHERE key = $1", [ALEXA_SPEECH_KEY],
    );
    if (!r.rows[0]) return { rate_pct: 100, voice: null, loudness_db: null };
    let v = r.rows[0].value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = {}; } }
    // Attenuate-only: Alexa's TTS reference level is the ceiling on this
    // hardware. Positive dB is silently ignored by Alexa cloud, so we cap
    // at 0. Range -20..0 lets the user make the announcement quieter than
    // the device's baseline (e.g. mix at lower level into TV audio).
    let dbv = v.loudness_db;
    if (dbv == null || isNaN(Number(dbv))) dbv = null;
    else { dbv = Math.round(Number(dbv)); if (dbv < -20) dbv = -20; if (dbv > 0) dbv = 0; }
    let pct = v.rate_pct;
    if (pct == null || isNaN(Number(pct))) pct = 100;
    else { pct = Math.round(Number(pct)); if (pct < 50) pct = 50; if (pct > 100) pct = 100; }
    return {
      rate_pct:    pct,
      voice:       v.voice || null,
      loudness_db: dbv,
    };
  } catch (_) {
    return { rate_pct: 100, voice: null, loudness_db: null };
  }
}

function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Wrap message in SSML when rate / voice / loudness is non-default.
// `rate_pct` is a percentage (50..100) of normal speed, applied as
// <prosody rate="XX%">. 100 = normal (default; no attribute emitted).
// User asked for fine-grained control between very slow and normal —
// the named "fast"/"x-fast" buckets were dropped 2026-05-07.
//
// `loudness_db` is an integer dB delta applied via <prosody volume>.
// Loudness affects only the announcement audio — the device's hardware
// volume is never touched, so TV audio (mixed in via HDMI ARC) stays at
// its own level instead of bumping up for ~1 s before TTS starts.
const ALEXA_VOICES = new Set([
  'Matthew','Joanna','Salli','Joey','Justin','Kendra','Kimberly','Ivy','Brian','Amy',
]);

function wrapAlexaSsml(message, ratePct, voice, loudnessDb) {
  const useRate  = Number.isInteger(ratePct) && ratePct >= 50 && ratePct < 100;
  const useVoice = voice && ALEXA_VOICES.has(voice);
  const useLoud  = loudnessDb != null && Number.isInteger(loudnessDb) && loudnessDb !== 0;
  if (!useRate && !useVoice && !useLoud) return String(message);
  let inner = escapeSsml(message);
  const prosodyAttrs = [];
  if (useRate) prosodyAttrs.push(`rate="${ratePct}%"`);
  if (useLoud) {
    const sign = loudnessDb > 0 ? '+' : '';
    prosodyAttrs.push(`volume="${sign}${loudnessDb}dB"`);
  }
  if (prosodyAttrs.length) inner = `<prosody ${prosodyAttrs.join(' ')}>${inner}</prosody>`;
  if (useVoice)            inner = `<voice name="${voice}">${inner}</voice>`;
  return `<speak>${inner}</speak>`;
}

// Per-entity "currently speaking" expiry timestamps. Alexa's notify.tts
// path doesn't transition the media_player entity to state='playing'
// (announcements overlay without flipping state), so the dashboard's
// red-dot-while-playing visual misses TTS by default. We track an
// estimated end-of-speech per call here and surface it through
// /api/alexa/devices so the card can render red during the window.
const _alexaSpeakingUntil = new Map();   // entity_id → ms timestamp

function _estimateAlexaTtsMs(plainMessage) {
  // ~12 chars/sec for Alexa neural TTS at medium rate, + 1.5 s pad
  // for cloud latency and trailing tone. Same heuristic as in the
  // earlier ephemeral-volume restore (kept consistent for sanity).
  const chars = String(plainMessage).length;
  return (Math.max(2, Math.ceil(chars / 12) + 1) + 1) * 1000;
}

async function speakAlexa(targets, plainMessage, overrideLoudnessDb) {
  const settings = await getAlexaSpeechSettings();
  let loudnessDb;
  if (overrideLoudnessDb !== undefined && overrideLoudnessDb !== null
      && !isNaN(Number(overrideLoudnessDb))) {
    loudnessDb = Math.max(-20, Math.min(0, Math.round(Number(overrideLoudnessDb))));
  } else {
    loudnessDb = settings.loudness_db;
  }
  const ssml = wrapAlexaSsml(plainMessage, settings.rate_pct, settings.voice, loudnessDb);
  const expiry  = Date.now() + _estimateAlexaTtsMs(plainMessage);
  const targetArr = Array.isArray(targets) ? targets : [targets];
  for (const t of targetArr) _alexaSpeakingUntil.set(t, expiry);
  await callHA('notify', 'alexa_media', { target: targets, message: ssml });
}

// POST /api/alexa/:entity/say   body: { message, loudness_db? }
// `loudness_db` is a per-call SSML loudness override (-12..+12 dB) applied
// to the TTS only — the device's hardware volume is not touched, so TV
// audio (mixed via ARC) stays at its current level. Global rate + voice
// from dashboard_settings.media-agents.alexa_speech are always applied.
app.post('/api/alexa/:entity/say', async (req, res) => {
  try {
    const { message, loudness_db } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    await speakAlexa(req.params.entity, message, loudness_db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alexa/announce  body: { message, targets:[entity_id,...], loudness_db? }
app.post('/api/alexa/announce', async (req, res) => {
  try {
    const { message, targets, loudness_db } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'targets array required' });
    await speakAlexa(targets, message, loudness_db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alexa/:entity/volume   body: { level: 0..1 }
app.post('/api/alexa/:entity/volume', async (req, res) => {
  try {
    const lvl = Number((req.body || {}).level);
    if (isNaN(lvl) || lvl < 0 || lvl > 1) return res.status(400).json({ error: 'level must be 0..1' });
    await callHA('media_player', 'volume_set', { entity_id: req.params.entity, volume_level: lvl });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alexa/:entity/mute     body: { mute: true|false }
app.post('/api/alexa/:entity/mute', async (req, res) => {
  try {
    const mute = !!(req.body || {}).mute;
    await callHA('media_player', 'volume_mute', { entity_id: req.params.entity, is_volume_muted: mute });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alexa/:entity/play_media   body: { content_id, content_type? }
// Starts new playback (radio / song / playlist) — call when device is idle.
// Default content_type='DEFAULT' lets Alexa interpret the phrase as a voice
// command (e.g. content_id='ON 50s' acts like "Alexa, play ON 50s").
app.post('/api/alexa/:entity/play_media', async (req, res) => {
  try {
    const { content_id, content_type } = req.body || {};
    if (!content_id) return res.status(400).json({ error: 'content_id required' });
    await callHA('media_player', 'play_media', {
      entity_id:          req.params.entity,
      media_content_id:   String(content_id),
      media_content_type: String(content_type || 'DEFAULT'),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/alexa/:entity/play | pause | stop | next | prev | turn_on | turn_off
//   Generic media_player.<action> dispatcher; whitelists allowed actions.
const _ALEXA_TRANSPORT = {
  play:    'media_play',
  pause:   'media_pause',
  stop:    'media_stop',
  next:    'media_next_track',
  prev:    'media_previous_track',
  turn_on: 'turn_on',
  turn_off:'turn_off',
};
app.post('/api/alexa/:entity/:action', async (req, res) => {
  try {
    const svc = _ALEXA_TRANSPORT[req.params.action];
    if (!svc) return res.status(404).json({ error: 'unknown action' });
    await callHA('media_player', svc, { entity_id: req.params.entity });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Vacuum (Roomba etc.) ─ HA-mediated, same callHA() pattern as Alexa ──
// One endpoint per supported action so the dashboard's Devices page +
// future bindings code can fire start/stop/pause/dock/locate via plain
// POST. Mirrors RULES/rule_engine.py:_dispatch_vacuum.
const _VACUUM_HA_SERVICE = {
  start:  'start',
  stop:   'stop',
  pause:  'pause',
  dock:   'return_to_base',
  locate: 'locate',
};

app.post('/api/vacuum/:entity/:verb', async (req, res) => {
  try {
    const verb = String(req.params.verb || '').toLowerCase();
    const service = _VACUUM_HA_SERVICE[verb];
    if (!service) return res.status(400).json({ error: `unknown verb '${verb}' (allowed: ${Object.keys(_VACUUM_HA_SERVICE).join(',')})` });
    await callHA('vacuum', service, { entity_id: req.params.entity });
    res.json({ ok: true, service });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/curtains — list curtain devices + auto-sync position_pct
// from observed DPS motion+settle pairs. Position is ONLY updated by
// real motor observations (never predicted from clicks), so dashboard
// click and wall press are treated identically.
//
// Per-device state (in dps_config.direction):
//   full_run_sec    — manual calibration: full motion duration (sec)
//   position_pct    — 0=closed, 100=open. Single source of truth.
//   last_motion_ts  — timestamp of the LATEST processed settle event;
//                      prevents re-counting the same motion across polls.
app.get('/api/curtains', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT id, name, room, protocol, dps_config
      FROM devices
      WHERE device_type = 'curtain'
        AND dps_config->'direction' IS NOT NULL
        AND show_dashboard != false
      ORDER BY name
    `);

    for (const dev of r.rows) {
      dev.is_moving = false;
      const cfg = (dev.dps_config && dev.dps_config.direction) || {};
      const fullRunSec = Number(cfg.full_run_sec);
      if (!Number.isFinite(fullRunSec) || fullRunSec < 1) continue;  // not calibrated → skip

      // Gateway-protocol curtains (Guy Room) emit "open"/"closed"/"stop"
      // string codes — they never produce SCS-shaped events. Skip the
      // motion-pair logic for them and let the gateway HA-fallback
      // branch below do all the work.
      const evs = dev.protocol === 'gateway'
        ? { rows: [] }
        : await db.query(
            `SELECT ts, dps->>'1' AS code
               FROM device_events
              WHERE device_id = $1
                AND ts > NOW() - INTERVAL '5 minutes'
                AND dps->>'1' IN ('3','4','5')
              ORDER BY ts ASC`,
            [dev.id],
          );
      if (!evs.rows.length && dev.protocol !== 'gateway') continue;

      const lastProcessed = cfg.last_motion_ts
        ? new Date(cfg.last_motion_ts).getTime()
        : 0;

      let curPct = Number.isFinite(Number(cfg.position_pct)) ? Number(cfg.position_pct) : 0;
      let processedAny = false;
      let newestSettleTs = lastProcessed;

      // Pair each motion ('5'/'4') with its next settle ('3'); each pair
      // contributes (duration / full_run_sec) × 100 % in the appropriate
      // direction. Skip pairs already processed (settle.ts <= last_motion_ts).
      // Build a list of (motion, settleTs) pairs. A "settle" comes from:
      //   1. A real "3" event after the motion (Stop pressed)
      //   2. The next motion event (motor must have stopped to switch
      //      direction or restart) — virtual settle = next motion's ts
      //   3. End-of-list, if the orphan is older than full_run_sec —
      //      the motor reached the physical limit (no "3" emitted on
      //      hitting limit switches; this is just how this hardware
      //      works), virtual settle = motion + full_run_sec
      const pairs = [];
      let pendingMotion = null;
      for (const e of evs.rows) {
        if (e.code === '4' || e.code === '5') {
          if (pendingMotion) {
            pairs.push({ motion: pendingMotion, settleTs: new Date(e.ts).getTime() });
          }
          pendingMotion = e;
        } else if (e.code === '3' && pendingMotion) {
          pairs.push({ motion: pendingMotion, settleTs: new Date(e.ts).getTime() });
          pendingMotion = null;
        }
      }
      let autoStopTriggered = false;
      if (pendingMotion) {
        const motionTs = new Date(pendingMotion.ts).getTime();
        const age = Date.now() - motionTs;
        if (age >= fullRunSec * 1000) {
          pairs.push({ motion: pendingMotion, settleTs: motionTs + fullRunSec * 1000 });
          autoStopTriggered = true;
        } else {
          // Motor still running — surface a moving flag for the dashboard.
          dev.is_moving = true;
        }
      }

      for (const p of pairs) {
        const motionTs = new Date(p.motion.ts).getTime();
        const settleTs = p.settleTs;
        // Both motion AND settle must post-date the last processed
        // timestamp; otherwise an anchor would be undone by a stale
        // pre-anchor motion.
        if (motionTs > lastProcessed && settleTs > lastProcessed) {
          const durSec = Math.min((settleTs - motionTs) / 1000, fullRunSec);
          const deltaPct = (durSec / fullRunSec) * 100;
          curPct = p.motion.code === '5'
            ? Math.min(100, curPct + deltaPct)
            : Math.max(0,   curPct - deltaPct);
          processedAny = true;
          if (settleTs > newestSettleTs) newestSettleTs = settleTs;
        }
      }

      if (processedAny) {
        const newPct = Math.round(curPct);
        await db.query(
          `UPDATE devices SET dps_config = jsonb_set(
             jsonb_set(dps_config::jsonb, '{direction,position_pct}',   $1::jsonb),
                                           '{direction,last_motion_ts}', to_jsonb($2::text))
           WHERE id = $3`,
          [JSON.stringify(newPct), new Date(newestSettleTs).toISOString(), dev.id],
        );
        dev.dps_config.direction.position_pct   = newPct;
        dev.dps_config.direction.last_motion_ts = new Date(newestSettleTs).toISOString();

        // Auto-Stop dispatch: when an orphan motion was virtual-settled
        // (no "3" arrived because motor hit the physical limit), send a
        // stop_cover to clean up the device's relay state. Idempotent —
        // motor is already stopped physically, this just resets its
        // internal "in-motion" flag.
        if (autoStopTriggered && cfg.ha_entity) {
          try {
            await callHA('cover', 'stop_cover', { entity_id: cfg.ha_entity });
          } catch (e) {
            // Non-fatal; just log
            console.error(`curtain auto-stop ${dev.id}: ${e.message}`);
          }
        }
      }

      // Gateway-protocol curtains (Zigbee via Tuya gateway, e.g. Guy Room
      // roller motor) emit DPS as strings ("open"/"closed") not the
      // numeric "5"/"4"/"3" codes the SCS family uses, so the loop above
      // skips them. But HA exposes `current_position` (0..100) for these
      // entities directly — that's a perfect signal we can use instead.
      if (dev.protocol === 'gateway' && cfg.ha_entity) {
        try {
          const tok = getHaToken();
          if (tok) {
            const haRes = await fetch(`${HA_URL}/api/states/${encodeURIComponent(cfg.ha_entity)}`,
              { headers: { Authorization: `Bearer ${tok}` } });
            if (haRes.ok) {
              const s = await haRes.json();
              if (s.state === 'opening' || s.state === 'closing') {
                dev.is_moving = true;
              }
              // Some Tuya integrations skip opening/closing and only
              // report the final open/closed state. Fallback: treat as
              // moving for full_run_sec after the last non-stop command.
              if (!dev.is_moving && cfg.assumed_state && cfg.assumed_state_ts && cfg.assumed_state !== 'stop') {
                const ageMs = Date.now() - new Date(cfg.assumed_state_ts).getTime();
                if (ageMs >= 0 && ageMs < fullRunSec * 1000) {
                  dev.is_moving = true;
                }
              }
              const pos = s.attributes && Number(s.attributes.current_position);
              if (Number.isFinite(pos) && pos >= 0 && pos <= 100) {
                // Some Tuya covers are wired such that HA's
                // current_position is inverted relative to our
                // convention (we use 100=fully open, 0=fully closed).
                // Per-device flag: dps_config.direction.position_inverted.
                const inverted = cfg.position_inverted === true;
                const haPct = Math.round(inverted ? 100 - pos : pos);
                if (haPct !== Number(cfg.position_pct)) {
                  await db.query(
                    `UPDATE devices SET dps_config = jsonb_set(dps_config::jsonb,
                       '{direction,position_pct}', $1::jsonb)
                     WHERE id = $2`,
                    [JSON.stringify(haPct), dev.id],
                  );
                  dev.dps_config.direction.position_pct = haPct;
                }
              }
            }
          }
        } catch (e) { /* non-fatal */ }
      }
    }

    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/curtain/:id/settings — set per-device calibration values.
// Currently only full_run_sec; more fields can be added with the same shape.
app.patch('/api/curtain/:id/settings', async (req, res) => {
  try {
    const updates = [];
    const params  = [req.params.id];
    let pIdx = 1;

    if (req.body && req.body.full_run_sec !== undefined) {
      const v = Number(req.body.full_run_sec);
      if (!Number.isFinite(v) || v < 1 || v > 300) {
        return res.status(400).json({ error: 'full_run_sec must be 1..300' });
      }
      pIdx += 1;
      params.push(Math.round(v));
      updates.push(`'{direction,full_run_sec}', to_jsonb($${pIdx}::int)`);
    }
    if (req.body && req.body.position_pct !== undefined) {
      const v = Number(req.body.position_pct);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return res.status(400).json({ error: 'position_pct must be 0..100' });
      }
      pIdx += 1;
      params.push(Math.round(v));
      updates.push(`'{direction,position_pct}', to_jsonb($${pIdx}::int)`);
      // Reset last_motion_ts so the auto-sync's drift correction
      // applies on top of THIS anchor (not on top of stale events
      // that predate it).
      pIdx += 1;
      params.push(new Date().toISOString());
      updates.push(`'{direction,last_motion_ts}', to_jsonb($${pIdx}::text)`);
    }
    if (!updates.length) return res.status(400).json({ error: 'nothing to update' });

    let expr = 'dps_config::jsonb';
    for (const u of updates) expr = `jsonb_set(${expr}, ${u})`;
    const r = await db.query(
      `UPDATE devices SET dps_config = ${expr}
       WHERE id = $1 AND device_type = 'curtain'
       RETURNING dps_config->'direction' AS direction`,
      params,
    );
    if (!r.rows.length) return res.status(404).json({ error: 'curtain not found' });
    res.json({ ok: true, direction: r.rows[0].direction });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Curtains / Blinds — HA cover services dispatched per device ────────────
// Device-agent owns local-TCP state stream; commands go via HA's cover.* services.
// dps_config.direction.{ha_entity, action_open|stop|close} drives the mapping
// so each device id maps to the right HA cover entity.
const _CURTAIN_ACTION_TO_DEFAULT_SERVICE = {
  open:  'open_cover',
  stop:  'stop_cover',
  close: 'close_cover',
};

app.post('/api/curtain/:id/:action', async (req, res) => {
  try {
    const action = String(req.params.action || '').toLowerCase();
    if (!_CURTAIN_ACTION_TO_DEFAULT_SERVICE[action]) {
      return res.status(400).json({ error: `unknown action '${action}' (allowed: open,stop,close)` });
    }
    const r = await db.query("SELECT dps_config FROM devices WHERE id = $1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'device not found' });
    const cfg = (r.rows[0].dps_config || {}).direction || {};
    const entity_id = cfg.ha_entity;
    if (!entity_id) return res.status(400).json({ error: 'dps_config.direction.ha_entity not set' });
    const service = cfg[`action_${action}`] || _CURTAIN_ACTION_TO_DEFAULT_SERVICE[action];
    await callHA('cover', service, { entity_id });
    // Persist assumed state — this hardware doesn't report position,
    // so the last button click is the only position signal we have.
    // Survives page reload + visible to rules via /api/devices.
    await db.query(
      `UPDATE devices SET dps_config = jsonb_set(
         jsonb_set(dps_config::jsonb, '{direction,assumed_state}',    $1::jsonb),
                                       '{direction,assumed_state_ts}', to_jsonb(NOW()::text))
       WHERE id = $2`,
      [JSON.stringify(action), req.params.id]
    );
    res.json({ ok: true, service, entity_id, assumed_state: action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Proxmox Backups ──────────────────────────────────────────
app.get('/api/backups/proxmox', async (_req, res) => {
  try {
    const [jobsResp, nodesResp] = await Promise.all([
      pveGet('/api2/json/cluster/backup'),
      pveGet('/api2/json/nodes'),
    ]);
    const jobs  = jobsResp.data  || [];
    const nodes = (nodesResp.data || []).map(n => n.node);

    // Recent vzdump tasks from all nodes
    const taskArrays = await Promise.all(
      nodes.map(node =>
        pveGet(`/api2/json/nodes/${node}/tasks?typefilter=vzdump&limit=100`)
          .then(r => (r.data || []).map(t => ({ ...t, node })))
          .catch(() => [])
      )
    );
    const allTasks = taskArrays.flat().sort((a, b) => b.starttime - a.starttime);

    // Match last run per job
    const jobsOut = jobs.map(job => {
      const vmids = job.vmid ? String(job.vmid).split(',').map(v => v.trim()) : [];
      const isAll = !job.vmid || job.vmid === 'all';
      const relevant = allTasks.filter(t => isAll || vmids.includes(String(t.id)));
      const last = relevant[0] || null;
      return {
        id:        job.id,
        enabled:   job.enabled !== 0,
        schedule:  job.schedule  || '—',
        storage:   job.storage   || '—',
        vmid:      job.vmid      || 'all',
        mode:      job.mode      || '—',
        compress:  job.compress  || 'none',
        retention: job['prune-backups'] || (job.maxfiles ? `keep-last=${job.maxfiles}` : '—'),
        comment:   job.comment   || '',
        lastRun:   last ? { starttime: last.starttime, endtime: last.endtime, status: last.status, node: last.node } : null,
      };
    });

    res.json({ jobs: jobsOut, tasks: allTasks.slice(0, 30), nodes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Windows Backup API ────────────────────────────────────────────

app.get('/api/backup/storages', async (_req, res) => {
  try {
    const r = await db.query('SELECT id, name, type, host, share, description, created_at FROM backup_storages ORDER BY id');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backup/storages', async (req, res) => {
  const { name, type, host, share, smb_user, smb_pass, mount_path, description } = req.body;
  if (!name || !host || !share) return res.status(400).json({ error: 'name, host, share required' });
  try {
    const r = await db.query(
      'INSERT INTO backup_storages (name, type, host, share, smb_user, smb_pass, mount_path, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name, type || 'smb', host, share, smb_user || '', smb_pass || '', mount_path || null, description || '']
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/backup/storages/:id', async (req, res) => {
  try {
    const jobs = await db.query('SELECT name FROM backup_jobs WHERE storage_id=$1', [req.params.id]);
    if (jobs.rows.length) {
      const names = jobs.rows.map(j => j.name).join(', ');
      return res.status(400).json({ error: `Cannot delete: ${jobs.rows.length} job(s) use this storage (${names}). Delete those jobs first.` });
    }
    await db.query('DELETE FROM backup_storages WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/jobs', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT j.id, j.name, j.source_host, j.source_path, j.dest_subdir,
             j.max_age_hours, j.retry_interval_min, j.retention,
             j.enabled, j.run_now, j.created_at,
             s.name AS storage_name, s.share,
             l.started_at AS last_run, l.status AS last_status,
             l.size_bytes AS last_size, l.message AS last_message
      FROM backup_jobs j
      JOIN backup_storages s ON s.id = j.storage_id
      LEFT JOIN LATERAL (
        SELECT started_at, status, size_bytes, message
        FROM backup_log WHERE job_id = j.id
        ORDER BY started_at DESC LIMIT 1
      ) l ON TRUE
      ORDER BY j.id
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/backup/jobs', async (req, res) => {
  const { name, source_host, source_path, storage_id, dest_subdir, max_age_hours, retry_interval_min, retention } = req.body;
  if (!name || !source_path || !storage_id || !dest_subdir) return res.status(400).json({ error: 'name, source_path, storage_id, dest_subdir required' });
  try {
    const r = await db.query(
      'INSERT INTO backup_jobs (name, source_host, source_path, storage_id, dest_subdir, max_age_hours, retry_interval_min, retention) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [name, source_host || 'muroc@192.168.1.128', source_path, storage_id, dest_subdir, max_age_hours || 26, retry_interval_min || 30, retention || 7]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/backup/jobs/:id', async (req, res) => {
  const allowed = ['enabled', 'run_now', 'max_age_hours', 'retry_interval_min', 'retention', 'name', 'source_path', 'dest_subdir', 'storage_id'];
  const updates = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'no valid fields' });
  try {
    const sets = updates.map((k, i) => `${k}=$${i + 1}`).join(', ');
    const vals = updates.map(k => req.body[k]);
    await db.query(`UPDATE backup_jobs SET ${sets} WHERE id=$${updates.length + 1}`, [...vals, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/backup/jobs/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM backup_log WHERE job_id=$1', [req.params.id]);
    await db.query('DELETE FROM backup_jobs WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const jobId = req.query.job_id;
  try {
    const where = jobId ? 'WHERE l.job_id=$2' : '';
    const params = jobId ? [limit, jobId] : [limit];
    const r = await db.query(`
      SELECT l.id, l.job_id, j.name AS job_name, l.started_at, l.finished_at,
             l.status, l.size_bytes, l.message,
             EXTRACT(EPOCH FROM (l.finished_at - l.started_at))::INT AS duration_sec
      FROM backup_log l JOIN backup_jobs j ON j.id = l.job_id
      ${where} ORDER BY l.started_at DESC LIMIT $1
    `, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/storages/:id/folders', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM backup_storages WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Storage not found' });
    const s = r.rows[0];
    if (!s.mount_path) return res.json([]);
    const ssh = new NodeSSH();
    await ssh.connect({ host: '192.168.1.227', username: 'root', privateKeyPath: SSH_KEY });
    const result = await ssh.execCommand(`find "${s.mount_path}" -mindepth 1 -maxdepth 1 -type d ! -name '@*' -printf '%f\n' 2>/dev/null | sort`);
    ssh.dispose();
    const folders = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
    res.json(folders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Containment for the Windows directory browser used by the Health page's
// backup-job source picker. Only paths under the user profile are allowed
// — without this, any LAN device could enumerate the full filesystem
// (returns dir NAMES, not file contents — but still maps the host's disk
// layout, which is unnecessary info leak).
const _WIN_BROWSE_ROOT = 'c:/users/muroc';
function _isAllowedWinBrowsePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('..')) return false;
  // Normalize separators + case for the prefix compare; the OS handles the
  // real path resolution case-insensitively anyway.
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return norm === _WIN_BROWSE_ROOT || norm.startsWith(_WIN_BROWSE_ROOT + '/');
}
app.get('/api/backup/windows/browse', (req, res) => {
  const reqPath = req.query.path || 'C:/Users/muroc';
  if (!_isAllowedWinBrowsePath(reqPath)) {
    return res.status(400).json({ error: 'path outside allowed root (C:/Users/muroc)' });
  }
  try {
    const entries = fs.readdirSync(reqPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('$'))
      .map(e => e.name)
      .sort();
    res.json({ path: reqPath, dirs });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Device Agent ─────────────────────────────────────────────────────────────

app.get('/api/devices', async (req, res) => {
  try {
    const { type, protocol, room, search } = req.query;
    // LEFT JOIN net_devices via MAC for devices that aren't managed by
    // device_agent (pixoo, hasp:balcony, awtrix, …): when devices.local_ip
    // is NULL, fall back to net_devices.ip and surface ARP-discovered
    // last_online. Adapter-managed devices keep their own local_ip.
    let sql = `
      SELECT d.*,
             COALESCE(d.local_ip, net.ip)        AS local_ip,
             COALESCE(d.last_seen, net.last_online) AS last_seen,
             CASE WHEN d.local_ip IS NULL AND net.ip IS NOT NULL THEN 'net_devices' ELSE NULL END AS ip_source
      FROM devices d
      LEFT JOIN net_devices net ON d.mac IS NOT NULL AND lower(d.mac) = lower(net.mac::text)
      WHERE 1=1`;
    const params = [];
    if (type)     { params.push(type);          sql += ` AND d.device_type=$${params.length}`; }
    if (protocol) { params.push(protocol);      sql += ` AND d.protocol=$${params.length}`; }
    if (room)     { params.push(room);          sql += ` AND d.room=$${params.length}`; }
    if (search)   { params.push(`%${search}%`); sql += ` AND (d.name ILIKE $${params.length} OR d.notes ILIKE $${params.length})`; }
    sql += ' ORDER BY d.device_type, d.room, d.name';
    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/blocklist', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM device_blocklist ORDER BY blocked_at DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/blocklist/:id/deactivate', async (req, res) => {
  try {
    const { id } = req.params;
    const dev = await db.query('SELECT id, name, vendor, device_type, protocol, mac, local_ip, local_key, version FROM devices WHERE id = $1', [id]);
    if (!dev.rows.length) return res.status(404).json({ error: 'Device not found' });
    const d = dev.rows[0];
    await db.query(
      `INSERT INTO device_blocklist (id, name, vendor, device_type, protocol, mac, local_ip, local_key, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO UPDATE SET blocked_at = NOW()`,
      [d.id, d.name, d.vendor, d.device_type, d.protocol, d.mac, d.local_ip, d.local_key, d.version]
    );
    await db.query('DELETE FROM device_events WHERE device_id = $1', [id]);
    await db.query('DELETE FROM devices WHERE id = $1', [id]);
    res.json({ ok: true, name: d.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/blocklist/:id/reactivate', async (req, res) => {
  try {
    const { id } = req.params;
    const bl = await db.query('SELECT * FROM device_blocklist WHERE id = $1', [id]);
    if (!bl.rows.length) return res.status(404).json({ error: 'Not in blocklist' });
    const d = bl.rows[0];
    await db.query(
      `INSERT INTO devices (id, name, vendor, device_type, protocol, mac, local_ip, local_key, version, enabled, show_dashboard)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, true) ON CONFLICT (id) DO NOTHING`,
      [d.id, d.name, d.vendor, d.device_type, d.protocol, d.mac, d.local_ip, d.local_key, d.version]
    );
    await db.query('DELETE FROM device_blocklist WHERE id = $1', [id]);
    res.json({ ok: true, name: d.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/devices/:id', async (req, res) => {
  try {
    const allowed = ['name','room','notes','show_dashboard','enabled','poll_enabled','poll_interval_sec'];
    const sets = []; const vals = [];
    for (const k of allowed) {
      if (k in req.body) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    }
    if ('channel_config' in req.body) {
      vals.push(JSON.stringify(req.body.channel_config));
      sets.push(`channel_config=$${vals.length}::jsonb`);
    }
    if ('dps_labels' in req.body) {
      vals.push(JSON.stringify(req.body.dps_labels));
      sets.push(`dps_labels=$${vals.length}::jsonb`);
    }
    if ('dps_config' in req.body) {
      vals.push(JSON.stringify(req.body.dps_config));
      sets.push(`dps_config=$${vals.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });

    // Sync channel_config.name ↔ dps_labels for matching keys
    if ('channel_config' in req.body || 'dps_labels' in req.body) {
      const cur = await db.query('SELECT channel_config, dps_labels FROM devices WHERE id=$1', [req.params.id]);
      if (cur.rows.length) {
        let cc = req.body.channel_config || cur.rows[0].channel_config || {};
        let dl = req.body.dps_labels || cur.rows[0].dps_labels || {};
        if ('channel_config' in req.body) {
          // channel_config changed → sync names into dps_labels
          for (const [k, ch] of Object.entries(cc)) {
            if (ch.name && k in dl) dl[k] = ch.name;
          }
          if (!('dps_labels' in req.body)) {
            vals.push(JSON.stringify(dl));
            sets.push(`dps_labels=$${vals.length}::jsonb`);
          }
        } else {
          // dps_labels changed → sync names into channel_config
          for (const [k, label] of Object.entries(dl)) {
            if (k in cc) cc[k] = { ...cc[k], name: label };
          }
          vals.push(JSON.stringify(cc));
          sets.push(`channel_config=$${vals.length}::jsonb`);
        }
      }
    }

    vals.push(req.params.id);
    await db.query(`UPDATE devices SET ${sets.join(',')},updated_at=NOW() WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/:id/events', async (req, res) => {
  try {
    const seconds = Math.round((parseFloat(req.query.minutes) || 1) * 60);
    const r = await db.query(
      `SELECT ts, dps, source FROM device_events
       WHERE device_id = $1 AND ts > NOW() - make_interval(secs => $2)
       ORDER BY ts ASC`,
      [req.params.id, seconds]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/:id/battery-history', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
    const key  = String(req.query.key || 'battery');
    const r = await db.query(
      `SELECT date_trunc('day', ts) AS day,
              ROUND(AVG((dps->>$2)::float)::numeric, 1)::float AS battery_avg
         FROM device_events
        WHERE device_id = $1
          AND ts > now() - make_interval(days => $3)
          AND dps ? $2
          AND dps->>$2 ~ '^-?[0-9]+(\\.[0-9]+)?$'
        GROUP BY day
        ORDER BY day ASC`,
      [req.params.id, key, days]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { state } = req.body; // true = ON, false = OFF

    // Pull row with dps_config — needed by the per-protocol branches below
    // that resolve channel → MQTT action key via action_on / action_off
    // aliases (same pattern the rule engine uses in _dispatch_command).
    const devR = await db.query('SELECT name, protocol, dps_config FROM devices WHERE id = $1', [id]);
    const dev = devR.rows[0] || {};
    const protocol = dev.protocol;
    const channel = req.body.channel || '';
    const dpsCfg = dev.dps_config || {};
    const chCfg  = channel && dpsCfg[channel] ? dpsCfg[channel] : {};
    const alias  = state ? chCfg.action_on : chCfg.action_off;

    // Zigbee devices: toggle via Z2M MQTT (not HA API)
    if (protocol === 'zigbee') {
      const key = req.body.channel || 'state_l1';
      const payload = JSON.stringify({ [key]: state ? 'ON' : 'OFF' });
      mqttClient.publish(`zigbee2mqtt/${dev.name}/set`, payload);
      return res.json({ ok: true, entity_id: `z2m:${dev.name}`, service: state ? 'ON' : 'OFF' });
    }

    // HASP touch panels — same dispatch logic as rule_engine._dispatch_command.
    // dps_config.<channel>.action_on/_off carries an alias (e.g. 'backlight_on')
    // that we translate to (path, value) → publish hasp/<plate>/command/<path>.
    if (protocol === 'hasp') {
      const plate = id.startsWith('hasp:') ? id.slice(5).split(':')[0] : dev.name;
      let path, value;
      if      (alias === 'backlight_on')  { path = 'backlight'; value = 'on'; }
      else if (alias === 'backlight_off') { path = 'backlight'; value = 'off'; }
      else if (alias === 'goto_page') {
        // page-select bindings need a page number; the test button doesn't
        // currently send one, so refuse rather than publish a bad payload.
        const pn = req.body.page_num;
        if (pn == null) return res.status(400).json({ error: 'goto_page requires page_num — page-select bindings cannot be tested from this endpoint' });
        path = 'page'; value = String(parseInt(pn, 10));
      } else {
        return res.status(400).json({ error: `No HASP alias for channel '${channel}' action_${state?'on':'off'}` });
      }
      mqttClient.publish(`hasp/${plate}/command/${path}`, value);
      return res.json({ ok: true, mqtt_topic: `hasp/${plate}/command/${path}`, mqtt_value: value });
    }

    // ESP boards — alias is the sketch action key, published as a plain
    // string to mur/home/esp/<id>/command (rule_engine pattern).
    if (protocol === 'esp') {
      if (!alias) return res.status(400).json({ error: `No ESP alias for channel '${channel}' action_${state?'on':'off'}` });
      mqttClient.publish(`mur/home/esp/${id}/command`, alias);
      return res.json({ ok: true, mqtt_topic: `mur/home/esp/${id}/command`, mqtt_value: alias });
    }

    // Awtrix LED matrix — backlight via <id>/power with {power: bool}. Other
    // channels (push_preset etc.) aren't testable from a turn_on/off button.
    if (protocol === 'awtrix') {
      if (alias === 'power_on' || alias === 'power_off') {
        const payload = JSON.stringify({ power: alias === 'power_on' });
        mqttClient.publish(`${id}/power`, payload);
        return res.json({ ok: true, mqtt_topic: `${id}/power`, mqtt_value: payload });
      }
      return res.status(400).json({ error: `Awtrix channel '${channel}' alias '${alias}' not supported from this endpoint` });
    }

    // Vacuum (HA-mediated). Map turn_on/turn_off → start/return_to_base.
    if (protocol === 'vacuum') {
      const service = state ? 'start' : 'return_to_base';
      await callHA('vacuum', service, { entity_id: id });
      return res.json({ ok: true, entity_id: id, service: `vacuum.${service}` });
    }

    // Alexa (HA-mediated). Most Alexa bindings are 'speak' / 'play' which
    // the test button doesn't carry parameters for; only on/off works here.
    if (protocol === 'alexa') {
      const service = state ? 'turn_on' : 'turn_off';
      await callHA('media_player', service, { entity_id: id });
      return res.json({ ok: true, entity_id: id, service: `media_player.${service}` });
    }

    // Look up HA entity for this device via template.
    // Matches both `tuya` (local-discovered) and `smartthings` (zwave via SmartThings hub) identifiers.
    const tpl = `{% for s in states %}{% set ids = device_attr(s.entity_id,"identifiers") %}{% if ids %}{% for i in ids %}{% if (i[0] == "tuya" or i[0] == "smartthings") and i[1] == "${id}" %}{{ s.entity_id }}|{{ s.state }}\n{% endif %}{% endfor %}{% endif %}{% endfor %}`;
    const tplRes = await fetch(`${HA_URL}/api/template`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getHaToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: tpl }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await tplRes.text();
    const entities = text.trim().split('\n').filter(Boolean).map(l => {
      const [eid, st] = l.split('|');
      return { entity_id: eid.trim(), state: st?.trim() };
    });
    // Find the matching switchable entity for the requested channel
    // (channel was already destructured at the top of the handler).
    const suffix = channel ? `_${channel}` : null;
    // Prefer entities ending with _switch, _switch_1, or the channel suffix
    const switchable = (suffix && entities.find(e => e.entity_id.startsWith('switch.') && e.entity_id.endsWith(suffix)))
      || (suffix && entities.find(e => e.entity_id.startsWith('light.') && e.entity_id.endsWith(suffix)))
      || (suffix && entities.find(e => e.entity_id.startsWith('cover.') && e.entity_id.endsWith(suffix)))
      || entities.find(e => e.entity_id.startsWith('switch.') && e.entity_id.endsWith('_switch'))
      || entities.find(e => e.entity_id.startsWith('switch.') && e.entity_id.endsWith('_switch_1'))
      || entities.find(e => e.entity_id.startsWith('light.') && e.entity_id.endsWith('_light'))
      || entities.find(e => e.entity_id.startsWith('cover.') && e.entity_id.endsWith('_curtain'))
      || entities.find(e => e.entity_id.startsWith('switch.') && !/child_lock|countdown|indicator/.test(e.entity_id))
      || entities.find(e => e.entity_id.startsWith('switch.'));
    if (!switchable) return res.status(404).json({ error: 'No switchable HA entity found for this device' });
    const domain = switchable.entity_id.split('.')[0];
    const service = state ? 'turn_on' : 'turn_off';
    await callHA(domain, service, { entity_id: switchable.entity_id });
    res.json({ ok: true, entity_id: switchable.entity_id, service: `${domain}.${service}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Direct Tuya local DPS write ────────────────────────────────────────────
// Bypasses HA — dashboard widgets that drive device-specific DPS values (mode,
// scene, HSV colour, timer, vendor-specific 101/102/103, …) call this and the
// device_agent on LXC 103 sets them on the device via tuya local TCP.
// Payload: { dps: { "<dps_key>": <value>, ... } }
// Scope:   protocol='local' only (Tuya local TCP). Other protocols 400.
app.post('/api/devices/:id/dps', async (req, res) => {
  try {
    const { id } = req.params;
    const { dps } = req.body || {};
    if (!dps || typeof dps !== 'object' || Array.isArray(dps) || !Object.keys(dps).length) {
      return res.status(400).json({ error: 'dps required (non-empty object)' });
    }
    const devR = await db.query('SELECT protocol FROM devices WHERE id = $1', [id]);
    if (!devR.rows[0]) return res.status(404).json({ error: 'device not found' });
    if (devR.rows[0].protocol !== 'local') {
      return res.status(400).json({ error: `dps endpoint only supports protocol=local (got '${devR.rows[0].protocol}')` });
    }
    const payload = JSON.stringify({ action: 'set_dps', dps, rule: 'dashboard' });
    mqttClient.publish(`mur/home/device/${id}/command`, payload);
    return res.json({ ok: true, dps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dashboard Settings ─────────────────────────────────────────────────────
app.get('/api/dashboard-settings/:key', async (req, res) => {
  try {
    if (req.params.key === '_mqtt_browser_pass') {
      // Self-healing: prefer process.env, fall back to reading .env at request time
      // (with 5-min TTL) so a stale pm2 env (e.g. after `pm2 restart` instead of
      // delete+start, or a Windows reboot that resurrected with cached env)
      // doesn't break the Awtrix tab silently.
      let v = process.env.MQTT_BROWSER_PASS;
      if (!v) {
        const now = Date.now();
        if (!global._envCache) global._envCache = { ts: 0, vals: {} };
        if (now - global._envCache.ts > 5 * 60 * 1000) {
          try {
            const lines = require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n');
            const vals = {};
            for (const line of lines) {
              const [k, ...rest] = line.trim().split('=');
              if (k && !k.startsWith('#')) vals[k] = rest.join('=');
            }
            global._envCache = { ts: now, vals };
          } catch (_) { global._envCache.ts = now; }
        }
        v = global._envCache.vals.MQTT_BROWSER_PASS || null;
      }
      return res.json({ value: v || null });
    }
    if (req.params.key === '_awtrix_settings') {
      const proxyReq = http.get('http://192.168.1.165/api/settings', { timeout: 4000 }, (devRes) => {
        let data = '';
        devRes.on('data', c => data += c);
        devRes.on('end', () => {
          try { res.json({ value: JSON.parse(data) }); }
          catch (e) { res.json({ value: null, error: 'parse failed' }); }
        });
      });
      proxyReq.on('error',   (e) => res.json({ value: null, error: e.message }));
      proxyReq.on('timeout', ()  => { proxyReq.destroy(); res.json({ value: null, error: 'timeout' }); });
      return;
    }
    // UPS live — latest row from ups_status (populated by net-ups-poll on LXC 105 every 60 s)
    if (req.params.key === '_ups_live') {
      const r = await db.query(
        `SELECT ts, status, battery_pct, runtime_min, line_volt, battery_volt,
                load_pct, model, serial, last_xfer, raw,
                EXTRACT(EPOCH FROM (NOW() - ts))::int AS age_sec
           FROM ups_status ORDER BY ts DESC LIMIT 1`
      );
      return res.json({ value: r.rows[0] || null });
    }
    // UPS history — last N days for charts
    if (req.params.key === '_ups_history') {
      const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
      const r = await db.query(
        `SELECT ts, battery_pct, runtime_min, line_volt, battery_volt, load_pct
           FROM ups_status
          WHERE ts > NOW() - ($1 || ' days')::interval
          ORDER BY ts ASC`,
        [days]
      );
      return res.json({ value: r.rows });
    }
    // UPS events — tail PVE's /var/log/apcupsd.events via SSH + file mtime
    if (req.params.key === '_ups_events') {
      const { NodeSSH } = require('node-ssh');
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: '192.168.1.101', username: 'root', privateKeyPath: SSH_KEY });
        const r = await ssh.execCommand(
          'tail -25 /var/log/apcupsd.events 2>&1; echo "---MTIME---"; stat -c %Y /var/log/apcupsd.events 2>/dev/null'
        );
        ssh.dispose();
        const [body, mtimeBlock] = (r.stdout || '').split('---MTIME---').map(s => s.trim());
        const mtime_unix = parseInt(mtimeBlock, 10) || null;
        const lines = (body || '').split('\n').filter(Boolean);
        return res.json({ value: { lines, mtime_unix } });
      } catch (e) { try { ssh.dispose(); } catch {} return res.json({ value: null, error: e.message }); }
    }
    // UPS trigger settings — read-only snapshot of apcupsd.conf knobs + flag state
    if (req.params.key === '_ups_settings') {
      const { NodeSSH } = require('node-ssh');
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: '192.168.1.101', username: 'root', privateKeyPath: SSH_KEY });
        const r = await ssh.execCommand(
          'grep -E "^(BATTERYLEVEL|MINUTES|TIMEOUT|ONBATTERYDELAY)" /etc/apcupsd/apcupsd.conf; ' +
          'echo "---FLAG---"; [ -f /etc/apcupsd/SAFETY_MODE ] && echo present || echo absent; ' +
          'echo "---BOOT---"; systemctl is-enabled apcupsd 2>/dev/null; ' +
          'echo "---NOMPOWER---"; apcaccess status 2>/dev/null | awk "/^NOMPOWER/{print \\$3}"'
        );
        ssh.dispose();
        const out = (r.stdout || '');
        const [confBlock, safetyMode, atBoot, nompower] = out.split(/---(?:FLAG|BOOT|NOMPOWER)---/).map(s => s.trim());
        const conf = {};
        for (const line of confBlock.split('\n')) {
          const m = line.match(/^(\w+)\s+(\S+)/);
          if (m) conf[m[1]] = m[2];
        }
        return res.json({ value: {
          battery_level:    parseInt(conf.BATTERYLEVEL, 10),
          minutes:          parseInt(conf.MINUTES, 10),
          timeout:          parseInt(conf.TIMEOUT, 10),
          onbattery_delay:  parseInt(conf.ONBATTERYDELAY, 10),
          safety_mode:      safetyMode,
          at_boot:          atBoot,
          nompower_w:       parseInt(nompower, 10) || null,
        }});
      } catch (e) { try { ssh.dispose(); } catch {} return res.json({ value: null, error: e.message }); }
    }
    // UPS auto-recover settings — read-only snapshot of /etc/apcupsd/recover.conf
    if (req.params.key === '_ups_recover_settings') {
      const { NodeSSH } = require('node-ssh');
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: '192.168.1.101', username: 'root', privateKeyPath: SSH_KEY });
        // Grep only the 5 known keys; recover.conf may not exist yet (Phase 4 install)
        const r = await ssh.execCommand(
          '[ -f /etc/apcupsd/recover.conf ] && ' +
          'grep -E "^(RECOVER_AUTO|RECOVER_MIN_BCHARGE|RECOVER_REQUIRE_ONLINE_SEC|RECOVER_BOOT_DELAY_SEC|RECOVER_MARKER_MAX_AGE_HOURS|BATTERY_GATE_PCT)=" /etc/apcupsd/recover.conf || ' +
          'echo "MISSING"'
        );
        ssh.dispose();
        const out = (r.stdout || '').trim();
        if (out === 'MISSING') return res.json({ value: { installed: false } });
        const conf = {};
        for (const line of out.split('\n')) {
          const m = line.match(/^(\w+)=(\S+)/);
          if (m) conf[m[1]] = m[2];
        }
        return res.json({ value: {
          installed:                  true,
          recover_auto:               conf.RECOVER_AUTO || 'no',
          min_bcharge_pct:            parseInt(conf.RECOVER_MIN_BCHARGE, 10),
          require_online_sec:         parseInt(conf.RECOVER_REQUIRE_ONLINE_SEC, 10),
          boot_delay_sec:             parseInt(conf.RECOVER_BOOT_DELAY_SEC, 10),
          marker_max_age_hours:       parseInt(conf.RECOVER_MARKER_MAX_AGE_HOURS, 10),
          battery_gate_pct:           parseInt(conf.BATTERY_GATE_PCT, 10) || 0,
        }});
      } catch (e) { try { ssh.dispose(); } catch {} return res.json({ value: null, error: e.message }); }
    }
    // UPS shutdown inventory — what would be propagated by /etc/apcupsd/doshutdown right now
    if (req.params.key === '_ups_inventory') {
      const { NodeSSH } = require('node-ssh');
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: '192.168.1.101', username: 'root', privateKeyPath: SSH_KEY });
        const r = await ssh.execCommand(
          'pct list 2>/dev/null; echo "---VMS---"; qm list 2>/dev/null; echo "---QNAP---"; ' +
          'ping -c 1 -W 1 192.168.1.155 >/dev/null 2>&1 && echo OK || echo DOWN'
        );
        ssh.dispose();
        const [lxcBlock, vmBlock, qnapBlock] = (r.stdout || '').split(/---(?:VMS|QNAP)---/).map(s => s.trim());
        // pct list columns: VMID Status [Lock] Name — return ALL (any status) so the
        // Shutdown Propagation card can show live transitions during a rehearsal.
        const lxcs = lxcBlock.split('\n').slice(1).map(l => {
          const parts = l.trim().split(/\s+/);
          return parts.length >= 3 && /^\d+$/.test(parts[0])
            ? { id: parseInt(parts[0], 10), status: parts[1], name: parts[parts.length - 1] }
            : null;
        }).filter(x => x);
        // qm list columns: VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID — return ALL.
        const vms = vmBlock.split('\n').slice(1).map(l => {
          const m = l.match(/^\s*(\d+)\s+(\S+)\s+(\S+)/);
          return m ? { id: parseInt(m[1], 10), name: m[2], status: m[3] } : null;
        }).filter(x => x);
        const qnap_reachable = qnapBlock.split('\n').pop().trim() === 'OK';
        return res.json({ value: { lxcs, vms, qnap_reachable, qnap_ip: '192.168.1.155' } });
      } catch (e) { try { ssh.dispose(); } catch {} return res.json({ value: null, error: e.message }); }
    }
    // UPS test runners — read-only or SAFETY_MODE-gated commands
    if (req.params.key.startsWith('_ups_test_')) {
      const testName = req.params.key.slice('_ups_test_'.length);
      const cmds = {
        apcaccess:  'apcaccess status | head -25',
        qnap_ssh:   'timeout 5 ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i /root/.ssh/id_ed25519_ups admin123@192.168.1.155 "echo qnap-reachable"',
        dryrun:     '/etc/apcupsd/doshutdown && tail -10 /var/log/apcupsd_shutdown.log',
        rehearse:   '/etc/apcupsd/doshutdown_rehearse && tail -25 /var/log/apcupsd_shutdown.log',
        recover:    '/etc/apcupsd/doshutdown_recover && tail -30 /var/log/apcupsd_shutdown.log',
        safety_on:  'touch /etc/apcupsd/SAFETY_MODE && ls -la /etc/apcupsd/SAFETY_MODE',
        safety_off: 'rm -f /etc/apcupsd/SAFETY_MODE && (ls /etc/apcupsd/SAFETY_MODE 2>&1 || echo "SAFETY_MODE removed — orchestrator will fire for real on next BATTERYLEVEL trigger")',
      };
      const cmd = cmds[testName];
      if (!cmd) return res.status(400).json({ error: `unknown test '${testName}'` });
      const { NodeSSH } = require('node-ssh');
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: '192.168.1.101', username: 'root', privateKeyPath: SSH_KEY });
        const r = await ssh.execCommand(cmd);
        ssh.dispose();
        return res.json({ value: { stdout: r.stdout, stderr: r.stderr, code: r.code } });
      } catch (e) { try { ssh.dispose(); } catch {} return res.json({ value: null, error: e.message }); }
    }
    const r = await db.query('SELECT value, updated_at FROM dashboard_settings WHERE key = $1', [req.params.key]);
    res.json(r.rows.length ? { value: r.rows[0].value, updated_at: r.rows[0].updated_at } : { value: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dashboard-settings/:key', async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'Missing value' });
    // UPS settings writeback — single endpoint that dispatches per field type.
    // Body: { value: { field: '<name>', value: '<new_value>' } }
    // Field map enforces validation server-side; client-side validation is a UX
    // nicety only (server is the source of truth for what's accepted).
    if (req.params.key === '_ups_settings_set') {
      const f = (value && value.field) || '';
      const v = value && value.value;
      const FIELDS = {
        // apcupsd.conf integers — sed-rewrite + restart apcupsd
        battery_level:    { kind: 'apcupsd_int', conf_key: 'BATTERYLEVEL',    min: 1, max: 99 },
        minutes:          { kind: 'apcupsd_int', conf_key: 'MINUTES',         min: 0, max: 60 },
        timeout:          { kind: 'apcupsd_int', conf_key: 'TIMEOUT',         min: 0, max: 86400 },
        onbattery_delay:  { kind: 'apcupsd_int', conf_key: 'ONBATTERYDELAY',  min: 0, max: 60 },
        // SAFETY_MODE flag file — touch / rm
        safety_mode:      { kind: 'flag', allowed: ['present', 'absent'] },
        // apcupsd unit enable/disable at boot
        at_boot:          { kind: 'service', allowed: ['enabled', 'disabled'] },
        // recover.conf — sed-rewrite (no daemon to restart, read at next boot)
        recover_auto:                 { kind: 'recover_yn',  conf_key: 'RECOVER_AUTO', allowed: ['yes', 'no'] },
        min_bcharge_pct:              { kind: 'recover_int', conf_key: 'RECOVER_MIN_BCHARGE',          min: 0, max: 100 },
        require_online_sec:           { kind: 'recover_int', conf_key: 'RECOVER_REQUIRE_ONLINE_SEC',   min: 0, max: 600 },
        boot_delay_sec:               { kind: 'recover_int', conf_key: 'RECOVER_BOOT_DELAY_SEC',       min: 0, max: 600 },
        marker_max_age_hours:         { kind: 'recover_int', conf_key: 'RECOVER_MARKER_MAX_AGE_HOURS', min: 1, max: 720 },
        battery_gate_pct:             { kind: 'recover_int', conf_key: 'BATTERY_GATE_PCT',            min: 0, max: 99  },
      };
      const meta = FIELDS[f];
      if (!meta) return res.status(400).json({ error: `unknown field '${f}'` });
      // Build SSH command per kind
      let cmd;
      if (meta.kind === 'apcupsd_int' || meta.kind === 'recover_int') {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n < meta.min || n > meta.max) {
          return res.status(400).json({ error: `value must be integer ${meta.min}-${meta.max}` });
        }
        const path = meta.kind === 'apcupsd_int' ? '/etc/apcupsd/apcupsd.conf' : '/etc/apcupsd/recover.conf';
        const sep  = meta.kind === 'apcupsd_int' ? ' ' : '=';   // apcupsd.conf is "KEY VALUE", recover.conf is "KEY=VALUE"
        // sed: replace existing line, or append if missing. Use # as delimiter to avoid / collisions.
        cmd = `if grep -qE "^${meta.conf_key}${sep === ' ' ? '\\s' : '='}" ${path}; then ` +
              `sed -i "s#^${meta.conf_key}${sep === ' ' ? '\\s.*' : '=.*'}#${meta.conf_key}${sep}${n}#" ${path}; ` +
              `else echo "${meta.conf_key}${sep}${n}" >> ${path}; fi; ` +
              `grep -E "^${meta.conf_key}${sep === ' ' ? '\\s' : '='}" ${path}`;
        if (meta.kind === 'apcupsd_int') cmd += '; systemctl restart apcupsd && systemctl is-active apcupsd';
      } else if (meta.kind === 'recover_yn') {
        if (!meta.allowed.includes(v)) return res.status(400).json({ error: `value must be one of: ${meta.allowed.join(', ')}` });
        cmd = `sed -i "s#^${meta.conf_key}=.*#${meta.conf_key}=${v}#" /etc/apcupsd/recover.conf && grep -E "^${meta.conf_key}=" /etc/apcupsd/recover.conf`;
      } else if (meta.kind === 'flag') {
        if (!meta.allowed.includes(v)) return res.status(400).json({ error: `value must be one of: ${meta.allowed.join(', ')}` });
        cmd = v === 'present'
          ? 'touch /etc/apcupsd/SAFETY_MODE && ls -la /etc/apcupsd/SAFETY_MODE'
          : 'rm -f /etc/apcupsd/SAFETY_MODE && (ls /etc/apcupsd/SAFETY_MODE 2>&1 || echo "SAFETY_MODE absent — go-live confirmed")';
      } else if (meta.kind === 'service') {
        if (!meta.allowed.includes(v)) return res.status(400).json({ error: `value must be one of: ${meta.allowed.join(', ')}` });
        cmd = v === 'enabled' ? 'systemctl enable apcupsd 2>&1' : 'systemctl disable apcupsd 2>&1';
        cmd += '; systemctl is-enabled apcupsd';
      }
      const { NodeSSH } = require('node-ssh');
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: '192.168.1.101', username: 'root', privateKeyPath: SSH_KEY });
        const r = await ssh.execCommand(cmd);
        ssh.dispose();
        if (r.code !== 0) return res.status(500).json({ error: `SSH command failed: ${r.stderr || r.stdout}` });
        return res.json({ ok: true, field: f, value: v, output: r.stdout });
      } catch (e) { try { ssh.dispose(); } catch {} return res.status(500).json({ error: e.message }); }
    }
    if (req.params.key === '_awtrix_settings') {
      const body = JSON.stringify(value);
      const proxyReq = http.request({
        hostname: '192.168.1.165', port: 80, path: '/api/settings', method: 'POST', timeout: 4000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (devRes) => {
        let data = '';
        devRes.on('data', c => data += c);
        devRes.on('end', () => res.json({ ok: devRes.statusCode === 200, status: devRes.statusCode }));
      });
      proxyReq.on('error',   (e) => res.status(502).json({ error: e.message }));
      proxyReq.on('timeout', ()  => { proxyReq.destroy(); res.status(504).json({ error: 'timeout' }); });
      proxyReq.write(body);
      proxyReq.end();
      return;
    }
    // UPS test runners — same allow-list as the GET branch (POST is more REST-correct since these have side effects)
    if (req.params.key.startsWith('_ups_test_')) {
      const testName = req.params.key.slice('_ups_test_'.length);
      const cmds = {
        apcaccess:  'apcaccess status | head -25',
        qnap_ssh:   'timeout 5 ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -i /root/.ssh/id_ed25519_ups admin123@192.168.1.155 "echo qnap-reachable"',
        dryrun:     '/etc/apcupsd/doshutdown && tail -10 /var/log/apcupsd_shutdown.log',
        rehearse:   '/etc/apcupsd/doshutdown_rehearse && tail -25 /var/log/apcupsd_shutdown.log',
        recover:    '/etc/apcupsd/doshutdown_recover && tail -30 /var/log/apcupsd_shutdown.log',
        safety_on:  'touch /etc/apcupsd/SAFETY_MODE && ls -la /etc/apcupsd/SAFETY_MODE',
        safety_off: 'rm -f /etc/apcupsd/SAFETY_MODE && (ls /etc/apcupsd/SAFETY_MODE 2>&1 || echo "SAFETY_MODE removed — orchestrator will fire for real on next BATTERYLEVEL trigger")',
      };
      const cmd = cmds[testName];
      if (!cmd) return res.status(400).json({ error: `unknown test '${testName}'` });
      // Build optional SELECTION env from POST body's `devices` array — only
      // honored by rehearse + recover. Validates: only `qnap` or numeric ids,
      // deduped, up to 16 entries. Anything fancier is rejected. If the array
      // is provided but empty / all-invalid, return 400 — the caller asked for
      // a selection and we have nothing valid to act on, do NOT default to all.
      let envPrefix = '';
      const devs = (req.body && req.body.value && req.body.value.devices);
      if (Array.isArray(devs) && (testName === 'rehearse' || testName === 'recover')) {
        const clean = Array.from(new Set(
          devs.map(d => String(d).trim().toLowerCase())
              .filter(d => d === 'qnap' || /^\d{1,5}$/.test(d))
        )).slice(0, 16);
        if (!clean.length) {
          return res.status(400).json({ error: 'devices array provided but no valid tokens (expected "qnap" or 1-5 digit ids)' });
        }
        envPrefix = `SELECTION=${JSON.stringify(clean.join(','))} `;
      }
      const { NodeSSH } = require('node-ssh');
      const ssh = new NodeSSH();
      try {
        await ssh.connect({ host: '192.168.1.101', username: 'root', privateKeyPath: SSH_KEY });
        const r = await ssh.execCommand(envPrefix + cmd);
        ssh.dispose();
        return res.json({ value: { stdout: r.stdout, stderr: r.stderr, code: r.code } });
      } catch (e) { try { ssh.dispose(); } catch {} return res.json({ value: null, error: e.message }); }
    }
    await db.query(
      `INSERT INTO dashboard_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [req.params.key, JSON.stringify(value)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Room list for layout picker ────────────────────────────────────────────
app.get('/api/room-slugs', async (_req, res) => {
  try {
    // `rooms` table has only `name` — derive slug on the fly (same regex the
    // /room-shape skill uses) so values stay consistent with future layouts.
    const r = await db.query(
      "SELECT name, regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g') AS slug FROM rooms ORDER BY name"
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Room Layouts (shape + walls + windows + doors per room) ────────────────
// Stored under dashboard_settings.room_layouts.<slug> as a single JSON blob.
// Read → returns the whole object (or empty); Write → merges with any other
// keys (zones/devices/doorways) that future skills may have added.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// IMPORTANT: /all must come before /:slug or Express will match 'all' as a slug.
app.get('/api/room-layouts/all', async (_req, res) => {
  try {
    const r = await db.query(
      "SELECT key, value FROM dashboard_settings WHERE key LIKE 'room_layouts.%' AND key != 'room_layouts._apartment' ORDER BY key"
    );
    const result = {};
    for (const row of r.rows) result[row.key.replace('room_layouts.', '')] = row.value;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/room-layouts/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
    // Direct hit: the slug owns its own layout.
    const direct = await db.query(
      "SELECT value FROM dashboard_settings WHERE key = $1",
      ['room_layouts.' + slug]
    );
    if (direct.rows.length) return res.json(direct.rows[0].value);
    // Shared fallback: another room's layout lists this slug in shared_with.
    // e.g. Living Room owns the open-plan layout and has shared_with:["kitchen"].
    const shared = await db.query(
      `SELECT key, value FROM dashboard_settings
        WHERE key LIKE 'room_layouts.%'
          AND value ? 'shared_with'
          AND value->'shared_with' @> $1::jsonb`,
      [JSON.stringify([slug])]
    );
    if (shared.rows.length) {
      return res.json({ ...shared.rows[0].value, _shared_from: shared.rows[0].key.replace('room_layouts.', '') });
    }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/room-layouts/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
    const b = req.body || {};
    // Accept only known fields; ignore anything else silently.
    const patch = {};
    for (const k of ['shape', 'grid', 'orientation', 'origin', 'walls', 'windows', 'doors', 'dividers', 'shared_with', 'view_w', 'view_h', 'furniture', 'label_offset', 'label_hidden', 'height_m', 'zones']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No known fields in body' });
    }
    // Merge with existing value so zones/devices/doorways from other tools are preserved.
    await db.query(
      `INSERT INTO dashboard_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET
         value      = dashboard_settings.value || $2::jsonb,
         updated_at = NOW()`,
      ['room_layouts.' + slug, JSON.stringify(patch)]
    );
    await signalSpatialReload();
    res.json({ ok: true, merged_keys: Object.keys(patch) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apartment-level coordination (canvas size, room order, visibility, active room).
app.get('/api/apartment-layout', async (_req, res) => {
  try {
    const r = await db.query("SELECT value FROM dashboard_settings WHERE key = 'room_layouts._apartment'");
    res.json(r.rows.length ? r.rows[0].value : {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apartment-layout', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['canvas', 'room_order', 'layer_visibility', 'active_room']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No known fields' });
    await db.query(
      `INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('room_layouts._apartment', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = dashboard_settings.value || $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(patch)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Room dimensions (AI spatial reasoning) ──────────────────────────────────
// Compact per-slug approximate W × L × H for rooms that aren't drawn with
// walls (divider/door targets, plus devices-only rooms). Stored as a single
// jsonb blob: { "<slug>": { "w": 4.0, "l": 3.0, "h": 2.5 } }.
// Replaces the earlier passage_dims key — migrate-on-read from passage_dims
// if room_dims is empty so existing entries carry over silently.
async function getRoomDims() {
  const r = await db.query("SELECT value FROM dashboard_settings WHERE key = 'room_dims'");
  if (r.rows.length) return r.rows[0].value || {};
  // First read after deploy — copy from legacy passage_dims if present.
  const legacy = await db.query("SELECT value FROM dashboard_settings WHERE key = 'passage_dims'");
  if (legacy.rows.length && legacy.rows[0].value && Object.keys(legacy.rows[0].value).length) {
    await db.query(
      `INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('room_dims', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(legacy.rows[0].value)]
    );
    return legacy.rows[0].value;
  }
  return {};
}

app.get('/api/room-dims', async (_req, res) => {
  try { res.json(await getRoomDims()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/room-dims', async (req, res) => {
  try {
    const b = req.body || {};
    // Sanitize: keep only {slug: {w?, l?, h?}} with finite positive numbers.
    const clean = {};
    for (const [slug, dims] of Object.entries(b)) {
      if (!SLUG_RE.test(slug) || !dims || typeof dims !== 'object') continue;
      const out = {};
      for (const k of ['w', 'l', 'h']) {
        const v = parseFloat(dims[k]);
        if (v > 0 && isFinite(v)) out[k] = +v.toFixed(2);
      }
      if (Object.keys(out).length) clean[slug] = out;
    }
    await db.query(
      `INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('room_dims', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify(clean)]
    );
    res.json({ ok: true, saved: Object.keys(clean).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backward-compat alias — any code still hitting /api/passage-dims keeps working.
app.get('/api/passage-dims', async (_req, res) => {
  try { res.json(await getRoomDims()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Device placements inside rooms (V5) ────────────────────────────────────
// Each row represents a physical device placed at (x, y) in a specific room.
// Params JSONB holds type-specific settings (for presence/motion:
//   beam_angle_deg, beam_length_m, hold_s).
app.get('/api/room-device-placements', async (req, res) => {
  try {
    const slug = req.query.slug;
    const rows = slug
      ? (await db.query(
          `SELECT p.*, d.name AS device_name, d.last_state, d.last_seen, d.last_source
             FROM room_device_placements p
             JOIN devices d ON d.id = p.device_id
             WHERE p.slug = $1
             ORDER BY p.id`, [slug])).rows
      : (await db.query(
          `SELECT p.*, d.name AS device_name, d.last_state, d.last_seen, d.last_source
             FROM room_device_placements p
             JOIN devices d ON d.id = p.device_id
             ORDER BY p.slug, p.id`)).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/room-device-placements', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.slug || !SLUG_RE.test(b.slug)) return res.status(400).json({ error: 'Invalid slug' });
    if (!b.device_id || typeof b.device_id !== 'string') return res.status(400).json({ error: 'device_id required' });
    const x = parseFloat(b.x), y = parseFloat(b.y);
    if (!isFinite(x) || !isFinite(y)) return res.status(400).json({ error: 'x, y required' });
    const rotation = Math.round(parseFloat(b.rotation) || 0) % 360;
    const params = (b.params && typeof b.params === 'object') ? b.params : {};
    // Ensure device exists and grab its type
    const devR = await db.query(`SELECT id, device_type FROM devices WHERE id = $1`, [b.device_id]);
    if (!devR.rows.length) return res.status(400).json({ error: 'Unknown device_id' });
    // V7: placement device_type may override the devices row (e.g. a switch
    // placed as a light controller stores device_type='light' on the row).
    // Sensors keep the "one placement per device_id" invariant; lights are
    // allowed multiple placements per controller (multi-gang / cross-room).
    const placementType = (typeof b.device_type === 'string' && b.device_type)
      ? b.device_type
      : devR.rows[0].device_type;
    // Prevent duplicate sensor placements (same device placed twice as a sensor).
    // BUT preserve parameter_label rows that REFERENCE this sensor — they
    // share device_id without claiming the sensor. Lights are already excluded.
    // So: only delete same-device sensor-type placements.
    const SENSOR_TYPES = ['presence', 'motion', 'door_sensor'];
    if (SENSOR_TYPES.includes(placementType)) {
      await db.query(
        `DELETE FROM room_device_placements
         WHERE device_id = $1 AND device_type = ANY($2::text[])`,
        [b.device_id, SENSOR_TYPES]
      );
    }
    const r = await db.query(
      `INSERT INTO room_device_placements
         (slug, device_id, device_type, x, y, rotation, params, label, label_offset, label_hidden)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)
       RETURNING *`,
      [b.slug, b.device_id, placementType, +x.toFixed(2), +y.toFixed(2),
       rotation, JSON.stringify(params),
       b.label || null,
       b.label_offset ? JSON.stringify(b.label_offset) : null,
       !!b.label_hidden]
    );
    await signalSpatialReload();
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/room-device-placements/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const b = req.body || {};
    const sets = []; const vals = []; let n = 1;
    if (b.slug !== undefined) { if (!SLUG_RE.test(b.slug)) return res.status(400).json({ error: 'Invalid slug' }); sets.push(`slug = $${n++}`); vals.push(b.slug); }
    if (b.device_id !== undefined) {
      // V7: allow retargeting the placement to a different controller device.
      // Validate the device exists so FK doesn't blow up the UPDATE.
      const d = await db.query(`SELECT id FROM devices WHERE id = $1`, [b.device_id]);
      if (!d.rows.length) return res.status(400).json({ error: 'Unknown device_id' });
      sets.push(`device_id = $${n++}`); vals.push(b.device_id);
    }
    if (b.x !== undefined)      { const v = parseFloat(b.x); if (!isFinite(v)) return res.status(400).json({ error: 'Invalid x' }); sets.push(`x = $${n++}`); vals.push(+v.toFixed(2)); }
    if (b.y !== undefined)      { const v = parseFloat(b.y); if (!isFinite(v)) return res.status(400).json({ error: 'Invalid y' }); sets.push(`y = $${n++}`); vals.push(+v.toFixed(2)); }
    if (b.rotation !== undefined) { sets.push(`rotation = $${n++}`); vals.push(((parseInt(b.rotation, 10) || 0) % 360 + 360) % 360); }
    if (b.params !== undefined)    { sets.push(`params = $${n++}::jsonb`); vals.push(JSON.stringify(b.params || {})); }
    if (b.label !== undefined)     { sets.push(`label = $${n++}`); vals.push(b.label || null); }
    if (b.label_offset !== undefined) { sets.push(`label_offset = $${n++}::jsonb`); vals.push(b.label_offset ? JSON.stringify(b.label_offset) : null); }
    if (b.label_hidden !== undefined) { sets.push(`label_hidden = $${n++}`); vals.push(!!b.label_hidden); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const r = await db.query(
      `UPDATE room_device_placements SET ${sets.join(', ')} WHERE id = $${n} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    await signalSpatialReload();
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/room-device-placements/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const r = await db.query(`DELETE FROM room_device_placements WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    await signalSpatialReload();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Compact state snapshot for polling — only what the Rooms page needs.
app.get('/api/devices/states', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json([]);
    const r = await db.query(
      `SELECT id, device_type, last_state, last_seen, last_source
         FROM devices WHERE id = ANY($1::text[])`, [ids]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Polygon area helper ─────────────────────────────────────────────────────
// Traces the walls array as a connected graph and returns the area of the
// outer polygon via the shoelace formula. Coordinates are canonicalized by
// merging all endpoints within SNAP meters to a common representative. Any
// dangling endpoints (degree 1) left after snapping are auto-joined to their
// nearest neighbour (closes user-forgotten gaps at notches/openings). Returns
// null only if no connected loop can be formed.
function computeRoomAreaFromWalls(walls) {
  if (!Array.isArray(walls) || walls.length < 3) return null;
  const SNAP = 0.08; // 8cm tolerance for endpoint merging
  // Collect raw endpoints
  const pts = [];
  walls.forEach((w, i) => {
    pts.push({ x: +w.x1, y: +w.y1, wall: i, end: 'a' });
    pts.push({ x: +w.x2, y: +w.y2, wall: i, end: 'b' });
  });
  // Union-find by proximity: merge endpoints within SNAP
  const repOf = pts.map((_, i) => i);
  const find = (i) => { while (repOf[i] !== i) { repOf[i] = repOf[repOf[i]]; i = repOf[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) repOf[ra] = rb; };
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[i].x - pts[j].x) < SNAP && Math.abs(pts[i].y - pts[j].y) < SNAP) union(i, j);
    }
  }
  // Representative coord per group = average
  const groups = new Map();
  for (let i = 0; i < pts.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { xs: [], ys: [], members: [] });
    const g = groups.get(r);
    g.xs.push(pts[i].x); g.ys.push(pts[i].y); g.members.push(i);
  }
  const ptGroup = pts.map((_, i) => find(i));
  const groupXY = new Map();
  for (const [r, g] of groups) {
    groupXY.set(r, {
      x: g.xs.reduce((a, b) => a + b, 0) / g.xs.length,
      y: g.ys.reduce((a, b) => a + b, 0) / g.ys.length,
    });
  }
  // Adjacency: groupId → [{ wallIdx, otherGroup }]
  const adj = new Map();
  walls.forEach((w, i) => {
    const a = ptGroup[i * 2], b = ptGroup[i * 2 + 1];
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ i, other: b });
    adj.get(b).push({ i, other: a });
  });
  // Auto-close dangling endpoints (degree 1) by pairing nearest neighbours.
  const singles = [];
  for (const [g, list] of adj) if (list.length === 1) singles.push(g);
  while (singles.length >= 2) {
    const a = singles.shift();
    const pa = groupXY.get(a);
    let best = -1, bestD = Infinity;
    for (let k = 0; k < singles.length; k++) {
      const pb = groupXY.get(singles[k]);
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) break;
    const b = singles.splice(best, 1)[0];
    // Add a synthetic wall connecting a ↔ b to close the gap.
    const syntheticIdx = 'syn_' + a + '_' + b;
    adj.get(a).push({ i: syntheticIdx, other: b });
    adj.get(b).push({ i: syntheticIdx, other: a });
  }
  // Walk: start at any vertex, traverse unused edges.
  const startG = ptGroup[0];
  const used = new Set();
  const verts = [groupXY.get(startG)];
  let cur = startG, prev = null;
  for (let step = 0; step < (walls.length + 10); step++) {
    const neighbors = adj.get(cur) || [];
    let next = neighbors.find(n => !used.has(n.i) && n.other !== prev);
    if (!next) next = neighbors.find(n => !used.has(n.i));
    if (!next) return null;
    used.add(next.i);
    if (next.other === startG) break;
    verts.push(groupXY.get(next.other));
    prev = cur;
    cur = next.other;
  }
  if (verts.length < 3) return null;
  let sum = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

// V6 Zones — 1m grid helpers for the scene serializer.
// Mirrors the client logic in rooms.js (cellIdForPoint). Used to append a
// "(in zone <name>)" / "(cell N)" suffix on every placed device so AI context
// gains a stable spatial anchor.
function zoneGridBoundsSrv(layout) {
  const walls = (layout && layout.walls) || [];
  if (!walls.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, +w.x1, +w.x2); minY = Math.min(minY, +w.y1, +w.y2);
    maxX = Math.max(maxX, +w.x1, +w.x2); maxY = Math.max(maxY, +w.y1, +w.y2);
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, cols: Math.max(1, Math.ceil(maxX - minX)), rows: Math.max(1, Math.ceil(maxY - minY)) };
}
function cellIdForPointSrv(layout, x, y) {
  const g = zoneGridBoundsSrv(layout);
  if (!g) return null;
  const col = Math.floor(+x - g.minX);
  const row = Math.floor(+y - g.minY);
  if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) return null;
  return row * g.cols + col + 1;
}
function resolveCellSrv(layout, x, y) {
  const cellId = cellIdForPointSrv(layout, x, y);
  if (cellId == null) return null;
  for (const z of (layout.zones || [])) {
    if ((z.cells || []).includes(cellId)) return { cellId, zoneName: z.name };
  }
  return { cellId, zoneName: null };
}

// Pick a reasonable on/off value from a device's last_state for a given dps_key.
// Returns 'ON' | 'OFF' | 'unknown'. Handles booleans, numeric 0/1, and the
// common Tuya string flag on channel '20' (power) for direct lights.
function readControllerChannelState(lastState, dpsKey) {
  if (!lastState || typeof lastState !== 'object') return 'unknown';
  const raw = (dpsKey != null) ? lastState[String(dpsKey)] : undefined;
  if (raw === true || raw === 1 || raw === '1' || raw === 'on' || raw === 'ON' || raw === 'true' || raw === 'True') return 'ON';
  if (raw === false || raw === 0 || raw === '0' || raw === 'off' || raw === 'OFF' || raw === 'false' || raw === 'False') return 'OFF';
  // Fallback for direct light entities: some lights don't use dps_key and store on at top-level
  if (dpsKey == null) {
    if (lastState.on === true || lastState['20'] === true) return 'ON';
    if (lastState.on === false || lastState['20'] === false) return 'OFF';
  }
  return 'unknown';
}

// Format one device-placement line for the scene text — type-aware.
// When a layout is supplied, the line is suffixed with the V6 zone/cell this
// device lands in (retroactively enriches AI context). `devicesById` is an
// optional map used to resolve light controller names / dps_labels — passed in
// by buildApartmentScene so describePlacement doesn't need its own DB round-trip.
function describePlacement(p, layout, devicesById) {
  const dt = p.device_type || 'device';
  const name = p.label || p.device_name || p.device_id;
  const rot = ((p.rotation || 0) % 360 + 360) % 360;
  const isEnabled = (p.params || {}).enabled !== false;
  // V6 Zones suffix — present only when a layout with the 1m grid is supplied.
  let zoneSuffix = '';
  if (layout) {
    const r = resolveCellSrv(layout, p.x, p.y);
    if (r) zoneSuffix = r.zoneName ? ` (in zone ${r.zoneName})` : ` (cell ${r.cellId})`;
  }
  // Disabled placements: AI should exclude them from coverage/active reasoning.
  if (!isEnabled) {
    return `    - ${name} (${dt}, DISABLED) @ (${(+p.x).toFixed(1)}, ${(+p.y).toFixed(1)}), rot ${rot}°${zoneSuffix}, state: n/a`;
  }
  // V7 Lights — fixture_type / intensity / spread + controller lookup + state.
  if (dt === 'light') {
    const pr = p.params || {};
    const intensity = pr.intensity || 'mid';
    const fixture = pr.fixture_type || 'lamp';
    // Spread is fixture-driven (spot = cone, strip = 180° half-rect, other = radius).
    let spread = '';
    if (fixture === 'spot') {
      const ang = pr.beam_angle_deg != null ? Number(pr.beam_angle_deg) : 30;
      const len = pr.beam_length_m  != null ? Number(pr.beam_length_m)  : 2.5;
      spread = `cone ${ang}°×${len}m`;
    } else if (fixture === 'strip') {
      const stripLen = pr.strip_length_m != null ? Number(pr.strip_length_m) : 2.0;
      const width    = pr.strip_width_m  != null ? Number(pr.strip_width_m)
                       : (pr.radius_m != null ? Number(pr.radius_m) : 1.5);
      spread = `strip ${stripLen}m × ${width}m 180°`;
    } else {
      const defaultR = intensity === 'high' ? 4.0 : (intensity === 'ambient' ? 3.0 : 1.5);
      const radius = pr.radius_m != null ? Number(pr.radius_m) : defaultR;
      spread = `radius ${radius}m`;
    }
    let via = '';
    let lightState = 'unknown';
    const ctrlId = pr.controller_device_id || p.device_id;
    const dpsKey = pr.controller_dps_key != null ? String(pr.controller_dps_key) : null;
    const ctrl = devicesById ? devicesById[ctrlId] : null;
    if (ctrl) {
      const labels = ctrl.dps_labels || {};
      const channelLabel = (dpsKey != null && labels[dpsKey]) ? labels[dpsKey] : null;
      via = channelLabel
        ? `, via ${ctrl.name}:${dpsKey} (${channelLabel})`
        : `, via ${ctrl.name}${dpsKey != null ? ':' + dpsKey : ''}`;
      lightState = readControllerChannelState(ctrl.last_state, dpsKey);
    } else if (ctrlId) {
      via = `, via ${ctrlId}${dpsKey != null ? ':' + dpsKey : ''}`;
    }
    return `    - ${name} (light:${fixture}, intensity=${intensity}, ${spread}) @ (${(+p.x).toFixed(1)}, ${(+p.y).toFixed(1)}), rot ${rot}°${via}${zoneSuffix}, state: ${lightState}`;
  }
  const AGE_OFFLINE_MS = 10 * 60 * 1000; // 10 min — single flat threshold (device agent owns freshness)
  const lastSeenMs = p.last_seen ? new Date(p.last_seen).getTime() : 0;
  const age = lastSeenMs ? (Date.now() - lastSeenMs) : Infinity;
  let state;
  if (age > AGE_OFFLINE_MS) state = 'OFFLINE';
  else {
    const ls = p.last_state || {};
    const active = ls.presence === true || ls.motion === true || ls.occupied === true;
    state = active ? 'ACTIVE' : 'CLEAR';
  }
  let geom = '';
  if ((dt === 'presence' || dt === 'motion') && p.params) {
    const pr = p.params;
    const legacyAng = Number(pr.beam_angle_deg);
    const legacyLen = Number(pr.beam_length_m);
    const angL = pr.beam_angle_left_deg  != null ? Number(pr.beam_angle_left_deg)  : (isFinite(legacyAng) ? legacyAng / 2 : 0);
    const angR = pr.beam_angle_right_deg != null ? Number(pr.beam_angle_right_deg) : (isFinite(legacyAng) ? legacyAng / 2 : 0);
    const lenL = pr.beam_length_left_m   != null ? Number(pr.beam_length_left_m)   : (isFinite(legacyLen) ? legacyLen : 0);
    const lenR = pr.beam_length_right_m  != null ? Number(pr.beam_length_right_m)  : (isFinite(legacyLen) ? legacyLen : 0);
    if ((angL > 0 || angR > 0) && (lenL > 0 || lenR > 0)) {
      // Each half = π·L²·(angle/360); sum both sides for total raw cone area.
      const coverage = +((Math.PI * lenL * lenL * (angL / 360)) + (Math.PI * lenR * lenR * (angR / 360))).toFixed(1);
      const symmetric = angL === angR && lenL === lenR;
      geom = symmetric
        ? `, cone ${angL + angR}°×${lenL}m (≈ ${coverage} m²`
        : `, cone L ${angL}°×${lenL}m / R ${angR}°×${lenR}m (≈ ${coverage} m²`;
      if (pr.wall_barrier) geom += ', wall-clipped';
      geom += ')';
    }
  }
  // Live DPS telemetry — emit every labeled DPS key with a fresh value. Stale
  // (OFFLINE) sensors emit no telemetry so AI isn't misled by old readings.
  let telemetry = '';
  if ((dt === 'presence' || dt === 'motion') && state !== 'OFFLINE') {
    const dev = devicesById ? devicesById[p.device_id] : null;
    const labels = dev?.dps_labels || {};
    const last   = dev?.last_state || {};
    const pairs = [];
    for (const [k, label] of Object.entries(labels)) {
      if (!label) continue;
      if (!(k in last)) continue;
      const v = last[k];
      if (v == null) continue;
      pairs.push(`${label}=${v}`);
    }
    pairs.sort();
    if (pairs.length) telemetry = `\n      telemetry: ${pairs.join(', ')}`;
  }
  return `    - ${name} (${dt}) @ (${(+p.x).toFixed(1)}, ${(+p.y).toFixed(1)}), rot ${rot}°${geom}${zoneSuffix}, state: ${state}${telemetry}`;
}

// ─── Apartment scene serializer (AI consumption) ─────────────────────────────
// Reads all room layouts + live device state and returns structured text that
// Claude can parse for spatial reasoning during investigations.
async function buildApartmentScene() {
  const layoutsR = await db.query(
    "SELECT key, value FROM dashboard_settings WHERE key LIKE 'room_layouts.%' AND key != 'room_layouts._apartment' ORDER BY key"
  );
  const devicesR = await db.query(
    "SELECT id, name, room, device_type, protocol, last_state, last_seen, dps_labels FROM devices WHERE enabled = true ORDER BY room, name"
  );
  // V7: lookup for light-controller resolution in describePlacement (name + dps_labels + last_state).
  const devicesById = {};
  for (const d of devicesR.rows) devicesById[d.id] = d;
  const roomSlugsR = await db.query(
    "SELECT name, regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g') AS slug FROM rooms ORDER BY name"
  );
  // Generalized W × L × H blob for undrawn rooms (replaces passage_dims).
  const roomDims = await getRoomDims();

  // V5 device placements + current state
  const placementsR = await db.query(
    `SELECT p.*, d.name AS device_name, d.last_state, d.last_seen, d.last_source
       FROM room_device_placements p
       JOIN devices d ON d.id = p.device_id
       ORDER BY p.slug, p.id`
  );
  const placementsBySlug = {};
  for (const p of placementsR.rows) (placementsBySlug[p.slug] ||= []).push(p);

  const layouts = {};
  for (const row of layoutsR.rows) {
    layouts[row.key.replace('room_layouts.', '')] = row.value;
  }

  const slugToName = {};
  for (const r of roomSlugsR.rows) { slugToName[r.slug] = r.name; }

  // Split: divider leads_to = true passage (sub-zone of parent's open-plan);
  // door leads_to = separate adjacent room reached via a door. These mean
  // different things to an AI reasoning about motion/coverage, so label them
  // distinctly in the scene text.
  const passageConnections = {}; // targetSlug → [{ parent, length }]
  const doorConnections    = {}; // targetSlug → [{ parent, length, dtype }]
  for (const [slug, layout] of Object.entries(layouts)) {
    const roomName = slugToName[slug] || slug;
    for (const div of (layout.dividers || [])) {
      if (!div.leads_to) continue;
      const len = Math.hypot((div.x2 || 0) - (div.x1 || 0), (div.y2 || 0) - (div.y1 || 0));
      (passageConnections[div.leads_to] ||= []).push({ parent: roomName, length: len });
    }
    for (const door of (layout.doors || [])) {
      if (!door.leads_to) continue;
      const len = Number(door.width_m) || 0;
      const dtype = door.door_type === 'sliding' ? 'sliding'
                  : door.door_type === 'opening' ? 'archway'
                  : 'hinged';
      (doorConnections[door.leads_to] ||= []).push({ parent: roomName, length: len, dtype });
    }
  }

  // Group devices by room name
  const devicesByRoom = {};
  for (const d of devicesR.rows) {
    const room = d.room || 'Unassigned';
    if (!devicesByRoom[room]) devicesByRoom[room] = [];
    devicesByRoom[room].push(d);
  }

  // Build adjacency graph from doors + dividers leads_to
  const edges = [];
  for (const [slug, layout] of Object.entries(layouts)) {
    const roomName = slugToName[slug] || slug;
    for (const door of (layout.doors || [])) {
      if (door.leads_to) {
        const targetName = slugToName[door.leads_to] || door.leads_to;
        const dtype = door.door_type === 'sliding' ? 'sliding'
                    : door.door_type === 'opening' ? 'archway'
                    : 'hinged';
        edges.push(`${roomName} ↔ ${targetName} (${dtype} ${door.width_m}m)`);
      }
    }
    for (const div of (layout.dividers || [])) {
      if (div.leads_to) {
        const targetName = slugToName[div.leads_to] || div.leads_to;
        const len = Math.hypot((div.x2 || 0) - (div.x1 || 0), (div.y2 || 0) - (div.y1 || 0)).toFixed(1);
        edges.push(`${roomName} ↔ ${targetName} (passage ${len}m)`);
      }
    }
  }

  let text = '=== APARTMENT LAYOUT ===\n\n';

  // Per-room descriptions
  for (const [slug, layout] of Object.entries(layouts)) {
    const roomName = slugToName[slug] || slug;
    const shape = layout.shape || {};
    const shared = layout.shared_with || [];
    const sharedLabel = shared.length
      ? ` + ${shared.map(s => slugToName[s] || s).join(' + ')} (open-plan)`
      : '';
    // Prefer true polygon area (walls) for non-rectangular rooms; fall back
    // to bounding-box dims from shape when walls don't form a closed loop.
    const walls0 = layout.walls || [];
    const polyArea = computeRoomAreaFromWalls(walls0);
    const bboxArea = shape.width_m && shape.length_m
      ? +(shape.width_m * shape.length_m).toFixed(1)
      : null;
    let effectiveArea = null;
    let dims;
    if (polyArea != null && bboxArea != null) {
      const a = +polyArea.toFixed(1);
      effectiveArea = a;
      const nonRect = Math.abs(a - bboxArea) / bboxArea > 0.05;
      dims = nonRect
        ? `≈ ${a} m² non-rectangular, bbox ${shape.width_m}m × ${shape.length_m}m`
        : `${shape.width_m}m × ${shape.length_m}m = ${a} m²`;
    } else if (shape.width_m && shape.length_m) {
      effectiveArea = +(shape.width_m * shape.length_m).toFixed(1);
      dims = `${shape.width_m}m × ${shape.length_m}m (bbox only)`;
    } else {
      dims = 'dimensions unknown';
    }
    const heightM = Number(layout.height_m);
    const volumeSuffix = (heightM > 0 && effectiveArea)
      ? `, ${heightM}m H → ${+(effectiveArea * heightM).toFixed(1)} m³` : '';
    const devCount = (devicesByRoom[roomName] || []).length;
    const devSuffix = devCount ? `, ${devCount} device${devCount === 1 ? '' : 's'}` : '';

    text += `ROOM: ${roomName}${sharedLabel} (${dims}${volumeSuffix}${devSuffix})\n`;

    // Walls summary
    const walls = layout.walls || [];
    const windows = layout.windows || [];
    const doors = layout.doors || [];
    const dividers = layout.dividers || [];

    if (walls.length) text += `  Walls: ${walls.length} segments\n`;

    // Windows
    for (const w of windows) {
      text += `  Window: ${w.width_m}m wide at offset ${w.offset_m}m\n`;
    }

    // Doors + sliding + archway
    for (const d of doors) {
      const dtype = d.door_type === 'sliding' ? 'sliding glass door'
                  : d.door_type === 'opening' ? 'open archway'
                  : 'hinged door';
      const target = d.leads_to ? ` → ${slugToName[d.leads_to] || d.leads_to}` : '';
      let swingInfo = '';
      if (!d.door_type || d.door_type === 'hinged') {
        const hinge = d.hinge_side === 'end' ? 'right-hinge' : 'left-hinge';
        const swing = d.swing_dir === 'outward' ? 'opens outward' : 'opens inward';
        swingInfo = ` (${hinge}, ${swing})`;
      }
      text += `  ${dtype}: ${d.width_m}m wide at offset ${d.offset_m}m${target}${swingInfo}\n`;
    }

    // Dividers with leads_to
    for (const d of dividers) {
      if (d.leads_to) {
        const len = Math.hypot((d.x2 || 0) - (d.x1 || 0), (d.y2 || 0) - (d.y1 || 0)).toFixed(1);
        text += `  Open passage (${len}m) → ${slugToName[d.leads_to] || d.leads_to}\n`;
      } else {
        text += `  Internal divider (open-plan boundary)\n`;
      }
    }

    // Devices in this room
    const roomDevices = devicesByRoom[roomName] || [];
    if (roomDevices.length) {
      const summary = roomDevices.map(d => {
        let state = '';
        if (d.last_state && typeof d.last_state === 'object') {
          const keys = Object.keys(d.last_state).filter(k => k !== 'last_seen' && k !== 'linkquality');
          if (keys.length <= 3) {
            state = ' (' + keys.map(k => `${k}:${d.last_state[k]}`).join(', ') + ')';
          }
        }
        const age = d.last_seen
          ? ` [${Math.round((Date.now() - new Date(d.last_seen).getTime()) / 60000)}m ago]`
          : '';
        return `${d.name} (${d.device_type})${state}${age}`;
      });
      text += `  Devices: ${summary.join('; ')}\n`;
    }

    // Furniture
    const furnList = layout.furniture || [];
    if (furnList.length) {
      const furnDesc = furnList.map(f => {
        const label = f.label ? `"${f.label}" ` : '';
        return `${label}${f.type} (${f.w}m × ${f.h}m)`;
      });
      text += `  Furniture: ${furnDesc.join('; ')}\n`;
    }

    // V6 Zones — named 1m-grid regions for AI spatial anchors.
    // V7: zones also own a Lights sub-block listing the lights placed inside
    // each named zone (by point-in-cell lookup). Sensors + un-zoned lights
    // stay in the flat "Devices placed:" block below with a (cell N) suffix.
    const zones = layout.zones || [];
    const zGrid = zoneGridBoundsSrv(layout);
    const allRoomPlacements = placementsBySlug[slug] || [];
    const lightsInRoom = allRoomPlacements.filter(p => p.device_type === 'light');
    // Group lights by the named zone they fall into (null = un-zoned).
    const lightsByZoneName = {};
    const unzonedLights = [];
    for (const lp of lightsInRoom) {
      const rc = resolveCellSrv(layout, lp.x, lp.y);
      if (rc && rc.zoneName) {
        (lightsByZoneName[rc.zoneName] ||= []).push(lp);
      } else {
        unzonedLights.push(lp);
      }
    }
    if (zones.length && zGrid) {
      text += `  Zones (1m grid, ${zGrid.cols}×${zGrid.rows}):\n`;
      for (const z of zones) {
        const cells = (z.cells || []).slice().sort((a, b) => a - b);
        const area = cells.length;
        const desc = z.description ? `, "${z.description}"` : '';
        text += `    - ${z.name}: cells ${cells.join(',')} (≈ ${area} m²${desc})\n`;
        const zoneLights = lightsByZoneName[z.name] || [];
        if (zoneLights.length) {
          text += `      Lights:\n`;
          for (const lp of zoneLights) text += '  ' + describePlacement(lp, layout, devicesById) + '\n';
        }
      }
    }

    // Un-zoned lights (not inside any named zone) — list separately so AI
    // can still see them with a (cell N) suffix.
    if (unzonedLights.length) {
      text += `  Lights (un-zoned):\n`;
      for (const lp of unzonedLights) text += describePlacement(lp, layout, devicesById) + '\n';
    }

    // Devices placed — non-light placements (presence/motion sensors, etc.).
    // Lights are listed in the Zones block or under "Lights (un-zoned)" above.
    const nonLightPlacements = allRoomPlacements.filter(p => p.device_type !== 'light');
    if (nonLightPlacements.length) {
      text += `  Devices placed:\n`;
      for (const p of nonLightPlacements) text += describePlacement(p, layout, devicesById) + '\n';
    }

    text += '\n';
  }

  // Rooms without layouts — every such room gets a status label plus
  // approximate W × L × H when set in room_dims.
  for (const r of roomSlugsR.rows) {
    if (layouts[r.slug]) continue;
    const devs  = devicesByRoom[r.name] || [];
    const pConns = passageConnections[r.slug] || [];
    const dConns = doorConnections[r.slug]    || [];
    if (!devs.length && !pConns.length && !dConns.length) continue;

    // Status: Passage from X / Adjacent to X (door|archway) / Not in layout
    const statusParts = [];
    if (pConns.length) {
      const parents = [...new Set(pConns.map(c => c.parent))];
      statusParts.push(`Passage from ${parents.join(', ')}`);
    }
    if (dConns.length) {
      const viaByParent = {};
      for (const c of dConns) (viaByParent[c.parent] ||= new Set()).add(c.dtype);
      const parts = Object.entries(viaByParent).map(([p, types]) =>
        `${p} (${[...types].join('/')})`);
      statusParts.push(`Adjacent to ${parts.join(', ')}`);
    }
    if (!statusParts.length) statusParts.push('Not in layout');
    const statusStr = statusParts.join('; ');

    const dims = roomDims[r.slug] || {};
    const hasWL = dims.w > 0 && dims.l > 0;
    const h = dims.h > 0 ? dims.h : null;
    let dimsStr;
    if (hasWL) {
      const area = +(dims.w * dims.l).toFixed(1);
      const diag = +Math.hypot(dims.w, dims.l).toFixed(1);
      const volPart = h ? `, ${h}m H → ${+(area * h).toFixed(1)} m³` : '';
      dimsStr = `≈ ${dims.w}m × ${dims.l}m = ${area} m², diag ≈ ${diag}m${volPart}`;
    } else {
      dimsStr = 'dimensions not set';
    }
    const devSuffix = devs.length ? `, ${devs.length} device${devs.length === 1 ? '' : 's'}` : '';

    text += `ROOM: ${r.name} (${statusStr}; ${dimsStr}${devSuffix})\n`;

    if (pConns.length) {
      const byParent = {};
      for (const c of pConns) (byParent[c.parent] ||= []).push(c.length);
      const parts = Object.entries(byParent).map(([p, lens]) =>
        `${p} (passage${lens.length > 1 ? 's' : ''} ${lens.map(l => l.toFixed(1) + 'm').join(' + ')})`
      );
      text += `  Reached from: ${parts.join(', ')}\n`;
    }
    if (dConns.length) {
      const byParent = {};
      for (const c of dConns) (byParent[c.parent] ||= []).push(c);
      const parts = Object.entries(byParent).map(([p, list]) => {
        const descs = list.map(c => c.dtype === 'archway'
          ? `archway ${Number(c.length).toFixed(1)}m`
          : `${c.dtype} door ${Number(c.length).toFixed(1)}m`
        ).join(' + ');
        return `${p} (${descs})`;
      });
      text += `  Reached from: ${parts.join(', ')}\n`;
    }
    if (devs.length) {
      text += `  Devices: ${devs.map(d => `${d.name} (${d.device_type})`).join('; ')}\n`;
    }
    // V5 placements (e.g. presence cones in passage rooms)
    const placements = placementsBySlug[r.slug] || [];
    if (placements.length) {
      text += `  Devices placed:\n`;
      for (const p of placements) text += describePlacement(p) + '\n';
    }
    text += '\n';
  }

  // Adjacency graph
  if (edges.length) {
    text += 'ADJACENCY GRAPH:\n';
    // Deduplicate bidirectional edges
    const seen = new Set();
    for (const e of edges) {
      const parts = e.split(' ↔ ');
      const key = [parts[0], parts[1]].sort().join('|');
      if (!seen.has(key)) { text += `  ${e}\n`; seen.add(key); }
    }
    text += '\n';
  }

  // Exterior exposure (rooms with windows)
  const exposed = [];
  for (const [slug, layout] of Object.entries(layouts)) {
    const winCount = (layout.windows || []).length;
    if (winCount > 0) {
      exposed.push(`${slugToName[slug] || slug}: ${winCount} window(s)`);
    }
  }
  if (exposed.length) {
    text += 'EXTERIOR EXPOSURE:\n';
    for (const e of exposed) text += `  ${e} — weather-exposed\n`;
  }

  return text;
}

app.get('/api/apartment-scene', async (_req, res) => {
  try {
    const text = await buildApartmentScene();
    res.type('text/plain').send(text);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Rooms management ─────────────────────────────────────────────────────────

app.get('/api/rooms', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT r.name AS room,
        COALESCE(d.device_count, 0) + COALESCE(ch.chan_count, 0) AS device_count
      FROM rooms r
      LEFT JOIN (
        SELECT room, COUNT(*) AS device_count FROM devices
        WHERE room IS NOT NULL AND room <> '' GROUP BY room
      ) d ON d.room = r.name
      LEFT JOIN (
        SELECT ch.value->>'room' AS room, COUNT(*) AS chan_count
        FROM devices, jsonb_each(COALESCE(channel_config,'{}')) AS ch(key, value)
        WHERE ch.value->>'room' IS NOT NULL AND ch.value->>'room' <> ''
        GROUP BY ch.value->>'room'
      ) ch ON ch.room = r.name
      ORDER BY r.name
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    await db.query(`INSERT INTO rooms (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rooms scoreboard — observability scores (old baseline + new rolling)
app.get('/api/rooms/scoreboard', async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT name,
             ai_score_old, ai_score_old_at, ai_score_old_reason,
             ai_score_new, ai_score_new_at, ai_score_new_reason
      FROM rooms
      ORDER BY COALESCE(ai_score_new, ai_score_old, 0) DESC, name
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rotate new → old (called by skill at start of re-run). Only rotates rows
// where ai_score_new IS NOT NULL — preserves original baseline on first run.
app.post('/api/rooms/scoreboard/rotate', async (_req, res) => {
  try {
    const r = await db.query(`
      UPDATE rooms SET
        ai_score_old = ai_score_new,
        ai_score_old_at = ai_score_new_at,
        ai_score_old_reason = ai_score_new_reason
      WHERE ai_score_new IS NOT NULL
    `);
    res.json({ ok: true, rotated: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Write a fresh score for one room (called by skill per room).
app.patch('/api/rooms/:name/score', async (req, res) => {
  try {
    const name = req.params.name;
    const score = parseInt(req.body.score, 10);
    const reason = (req.body.reason || '').trim();
    if (isNaN(score) || score < 0 || score > 10) {
      return res.status(400).json({ error: 'score must be 0..10' });
    }
    const r = await db.query(`
      UPDATE rooms SET
        ai_score_new = $1,
        ai_score_new_at = now(),
        ai_score_new_reason = $2
      WHERE name = $3
    `, [score, reason, name]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'room not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/rooms/:name', async (req, res) => {
  try {
    const oldName = req.params.name;
    const newName = (req.body.name || '').trim();
    if (!newName) return res.status(400).json({ error: 'name required' });
    await db.query(`INSERT INTO rooms (name) VALUES ($1) ON CONFLICT DO NOTHING`, [newName]);
    await db.query(`UPDATE devices SET room=$1, updated_at=NOW() WHERE room=$2`, [newName, oldName]);
    await db.query(`
      UPDATE devices
      SET channel_config = (
        SELECT jsonb_object_agg(k, CASE WHEN v->>'room'=$1 THEN v || jsonb_build_object('room',$2::text) ELSE v END)
        FROM jsonb_each(channel_config) AS t(k,v)
      ), updated_at=NOW()
      WHERE channel_config::text LIKE $3
    `, [oldName, newName, `%"${oldName}"%`]);
    await db.query(`DELETE FROM rooms WHERE name=$1`, [oldName]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/rooms/:name', async (req, res) => {
  try {
    const name = req.params.name;
    await db.query(`UPDATE devices SET room=NULL, updated_at=NOW() WHERE room=$1`, [name]);
    await db.query(`
      UPDATE devices
      SET channel_config = (
        SELECT jsonb_object_agg(k, CASE WHEN v->>'room'=$1 THEN v - 'room' ELSE v END)
        FROM jsonb_each(channel_config) AS t(k,v)
      ), updated_at=NOW()
      WHERE channel_config::text LIKE $2
    `, [name, `%"${name}"%`]);
    await db.query(`DELETE FROM rooms WHERE name=$1`, [name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All media/library/browse/play endpoints → LXC 100 media-service http://192.168.1.138:8766



const PORT = 3000;
ensureSchema().then(() => {
  // Bind to all interfaces so NetBird peers can reach the dashboard via the
  // wt0 (WireGuard Tunnel) interface at 100.102.207.1:3000. A Windows
  // Firewall rule restricts inbound TCP/3000 to the wt0 interface only —
  // home LAN (eth/wifi) inbound is blocked. Loopback (127.0.0.1) still
  // works for pm2 health checks + local browser access.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Boiler Dashboard running at http://localhost:${PORT}`);
  });
}).catch(e => {
  console.error('Schema init failed:', e.message);
  process.exit(1);
});
