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
const upload = multer({ dest: voiceUploadDir });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// PostgreSQL connection to LXC 102
const db = new Pool({
  host: '192.168.1.219',
  database: 'home_data',
  user: 'postgres',
  port: 5432,
});

// MQTT client for rule engine commands (test, reload).
// MQTT_RULE_PASS MUST be set in .env — no hardcoded fallback so a
// misconfigured env fails loudly instead of silently using a compromised
// default credential that would otherwise be committed to the repo.
if (!process.env.MQTT_RULE_PASS) {
  console.error('FATAL: MQTT_RULE_PASS not set in .env — rule-engine test/reload requires it');
}
const mqttClient = mqtt.connect('mqtt://192.168.1.189:1883', {
  username: 'rule_engine', password: process.env.MQTT_RULE_PASS,
  clientId: 'dashboard-' + process.pid, reconnectPeriod: 5000,
});
mqttClient.on('error', (e) => console.error('MQTT error:', e.message));

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
    vm101Result, lxc100Result, lxc102Result, lxc103Result, lxc104Result, lxc105Result, lxc106Result, lxc107Result,
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
    db.query('SELECT COUNT(*) AS n, MAX(severity) AS worst FROM system_alerts WHERE resolved_at IS NULL')
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

// ─── Project Health — DB Volumes ─────────────────────────────
app.get('/api/health/db-volumes', async (req, res) => {
  try {
    const tables = [
      'raw_data', 'agent_boiler_data', 'raw_weather', 'raw_weather_daily',
      'boiler_consumptions', 'orchestrator_log', 'sync_signals', 'system_alerts',
      'voice_token_log', 'manual_requests', 'voice_devices', 'voice_device_settings',
      'voice_intent_phrases', 'voice_device_entities', 'agents', 'agent_settings',
      'media_library', 'face_registry', 'face_crops', 'person_embeddings', 'documents',
      'backup_storages', 'backup_jobs', 'backup_log',
      'devices', 'device_events', 'device_agent_log', 'device_blocklist',
      'rooms', 'net_devices', 'net_ports', 'net_scans',
      'rule_events', 'rule_engine_state', 'rule_engine_log',
      'pixoo_presets', 'pixoo_log', 'analyzer_settings', 'analyzer_log',
      'retention_policies', 'dashboard_settings', 'room_device_placements',
      'ups_status',
    ];
    const tsCol = {
      raw_data: 'ts', agent_boiler_data: 'ts', raw_weather: 'ts', raw_weather_daily: 'ts',
      boiler_consumptions: 'start_ts', orchestrator_log: 'ts', sync_signals: 'ts',
      system_alerts: 'ts', voice_token_log: 'ts', manual_requests: 'ts',
      voice_devices: 'created_at', voice_device_settings: 'updated_at',
      voice_intent_phrases: 'created_at', voice_device_entities: null,
      agents: 'added_at', agent_settings: null,
      media_library: 'added_at', face_registry: 'added_at',
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
      ups_status: 'ts',
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
    const r = await db.query('SELECT * FROM net_devices ORDER BY last_online DESC NULLS LAST, mac ASC');
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

// ─── System Alerts ───────────────────────────────────────────
app.get('/api/health/alerts', async (req, res) => {
  const includeResolved = req.query.include_resolved === 'true';
  try {
    const r = await db.query(`
      SELECT id,
             ts AT TIME ZONE 'Asia/Jerusalem' AS ts_local,
             severity, affected_agent, alert_type, message,
             resolved_at AT TIME ZONE 'Asia/Jerusalem' AS resolved_local
      FROM system_alerts
      ${includeResolved ? '' : 'WHERE resolved_at IS NULL'}
      ORDER BY resolved_at NULLS FIRST, ts DESC
      LIMIT 50
    `);
    const resolvedCount = includeResolved
      ? r.rows.filter(x => x.resolved_local).length
      : (await db.query('SELECT COUNT(*) AS n FROM system_alerts WHERE resolved_at IS NOT NULL')).rows[0].n;
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

app.get('/api/backup/windows/browse', (req, res) => {
  const reqPath = req.query.path || 'C:/';
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
    let sql = 'SELECT * FROM devices WHERE 1=1';
    const params = [];
    if (type)     { params.push(type);              sql += ` AND device_type=$${params.length}`; }
    if (protocol) { params.push(protocol);           sql += ` AND protocol=$${params.length}`; }
    if (room)     { params.push(room);               sql += ` AND room=$${params.length}`; }
    if (search)   { params.push(`%${search}%`);      sql += ` AND (name ILIKE $${params.length} OR notes ILIKE $${params.length})`; }
    sql += ' ORDER BY device_type, room, name';
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

app.post('/api/devices/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { state } = req.body; // true = ON, false = OFF

    // Zigbee devices: toggle via Z2M MQTT (not HA API)
    const devR = await db.query('SELECT name, protocol FROM devices WHERE id = $1', [id]);
    if (devR.rows.length && devR.rows[0].protocol === 'zigbee') {
      const key = req.body.channel || 'state_l1';
      const payload = JSON.stringify({ [key]: state ? 'ON' : 'OFF' });
      mqttClient.publish(`zigbee2mqtt/${devR.rows[0].name}/set`, payload);
      return res.json({ ok: true, entity_id: `z2m:${devR.rows[0].name}`, service: state ? 'ON' : 'OFF' });
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
    const { channel } = req.body;
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
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Boiler Dashboard running at http://localhost:${PORT}`);
  });
}).catch(e => {
  console.error('Schema init failed:', e.message);
  process.exit(1);
});
