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
const voiceUploadDir = path.join(os.tmpdir(), 'voice-uploads');
if (!fs.existsSync(voiceUploadDir)) fs.mkdirSync(voiceUploadDir, { recursive: true });
const upload = multer({ dest: voiceUploadDir });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// PostgreSQL connection to LXC 102
const db = new Pool({
  host: '192.168.1.219',
  database: 'home_data',
  user: 'postgres',
  port: 5432,
});

// HA config
const HA_URL = 'http://192.168.1.110:8123';
const HA_TOKEN = process.env.HA_TOKEN || '';

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
  const { run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off,
          trend_runs, temp_debounce, probe_interval_min,
          consumption_temp_delta, consumption_time_delta,
          probe_max_boiler_temp, probe_max_delta } = req.body;
  try {
    await db.query(`
      UPDATE agent_settings SET
        run_interval_min           = $1,
        panel_temp_valid_after_on  = $2,
        panel_temp_valid_after_off = $3,
        trend_runs                 = $4,
        temp_debounce              = $5,
        probe_interval_min         = $6,
        consumption_temp_delta     = $7,
        consumption_time_delta     = $8,
        probe_max_boiler_temp      = $9,
        probe_max_delta            = $10
    `, [run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off,
        trend_runs, temp_debounce, probe_interval_min,
        consumption_temp_delta, consumption_time_delta,
        probe_max_boiler_temp, probe_max_delta]);
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
  const limit = parseInt(req.query.limit) || 10;
  try {
    const r = await db.query('SELECT * FROM raw_data ORDER BY ts DESC LIMIT $1', [limit]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Agent data table ─────────────────────────────────────────
app.get('/api/agent-data', async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
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
        headers: { Authorization: `Bearer ${HA_TOKEN}` },
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
      headers: HA_TOKEN ? { Authorization: `Bearer ${HA_TOKEN}` } : {},
      signal: AbortSignal.timeout(4000)
    }).then(r => { if (r.ok) result.ha = true; }).catch(() => {}),
  ]);
  res.json(result);
});

// ─── Boiler timer ─────────────────────────────────────────────
app.get('/api/timer', async (req, res) => {
  try {
    const r = await fetch(`${HA_URL}/api/states/timer.boiler_temp_update_timer`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return res.status(502).json({ error: 'HA error' });
    const data = await r.json();
    res.json({ state: data.state, remaining: data.attributes.remaining, duration: data.attributes.duration, finishes_at: data.attributes.finishes_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Consumptions ─────────────────────────────────────────────
app.get('/api/consumptions', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const from  = req.query.from || null;
  const to    = req.query.to   || null;
  try {
    const r = (from && to)
      ? await db.query(`
          SELECT id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at
          FROM boiler_consumptions
          WHERE start_ts >= $1 AND start_ts < $2
          ORDER BY start_ts ASC
        `, [from, to])
      : from
      ? await db.query(`
          SELECT id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at
          FROM boiler_consumptions
          WHERE start_ts >= $1
          ORDER BY start_ts ASC
        `, [from])
      : await db.query(`
          SELECT id, start_ts, end_ts, start_temp, end_temp, drop_c, duration_min, detected_at
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
        COUNT(*)                          AS count,
        MAX(drop_c)                       AS max_drop,
        ROUND(AVG(drop_c)::numeric, 1)    AS avg_drop,
        MAX(start_ts)                     AS last_ts
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
  const { from_hour, to_hour, include_weather, include_outlook, include_agent_data } = req.body;
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
    backupJobsResult,
    vm101Result, lxc100Result, lxc102Result, lxc103Result, lxc104Result, lxc105Result, lxc106Result,
  ] = await Promise.all([
    db.query('SELECT 1').then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),
    fetch(`${HA_URL}/api/`, { headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: AbortSignal.timeout(5000) })
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
  r.active_alerts = { count: alertsResult.n, worst: alertsResult.worst, ok: alertsResult.n === 0 };

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
      'media_library', 'face_registry',
      'backup_storages', 'backup_jobs', 'backup_log',
      'devices', 'device_events', 'device_agent_log', 'device_blocklist',
      'rooms', 'net_devices'
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
      device_blocklist: 'blocked_at', rooms: null, net_devices: 'last_seen'
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
    // Parse "Trigger: Wed 2026-04-01 10:45:08 UTC; 4min 31s left"
    const timers = { arp: { next: null }, snmp: { next: null } };
    let current = null;
    for (const line of r.stdout.split('\n')) {
      // Detect block header — must check snmp before arp (snmp contains 'arp' substring)
      if (line.includes('net-snmp-scan.timer')) current = 'snmp';
      else if (line.includes('net-arp-scan.timer'))  current = 'arp';
      const m = line.match(/Trigger:\s+(.+UTC)/);
      if (m && current) {
        const ms = new Date(m[1]).getTime();
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

    res.json({ state, heartbeat, rooms });
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
      ('sync_signals',        7,   true,  24, 'ha_to_pg data-ready signals for boiler agent wake-up'),
      ('voice_token_log',    365,  true,  24, 'Voice pipeline Claude API token usage and cost'),
      ('backup_log',          90,  true,  24, 'Windows backup run history'),
      ('backup_jobs',        NULL, false, 24, 'Backup job definitions — keep forever'),
      ('backup_storages',    NULL, false, 24, 'Backup storage definitions — keep forever'),
      ('device_events',       30,  true,  24, 'Device state change events'),
      ('device_agent_log',    30,  true,  24, 'Device agent heartbeat log'),
      ('device_blocklist',  NULL, false, 24, 'Deactivated devices — keep forever'),
      ('devices',           NULL, false, 24, 'Device definitions — keep forever'),
      ('rooms',             NULL, false, 24, 'Room definitions — keep forever')
    ON CONFLICT (table_name) DO NOTHING
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
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
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
  const mediaSearch = t.match(/^(?:find|search|show|look for)s+(.+)$/);
  if (mediaSearch) return { intent: 'media_search', params: { query: mediaSearch[1].trim() } };

  // Media play by number: "play 1", "play number 2", just a digit 1-15
  const playNum = t.match(/^(?:plays+(?:numbers+)?|watchs+)(d+)$/) || t.match(/^(d+)$/);
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
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
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
    // Look up HA entity for this Tuya device via template
    const tpl = `{% for s in states %}{% set ids = device_attr(s.entity_id,"identifiers") %}{% if ids %}{% for i in ids %}{% if i[0] == "tuya" and i[1] == "${id}" %}{{ s.entity_id }}|{{ s.state }}\n{% endif %}{% endfor %}{% endif %}{% endfor %}`;
    const tplRes = await fetch(`${HA_URL}/api/template`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
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
