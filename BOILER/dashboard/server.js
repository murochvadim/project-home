const express = require('express');
const { Pool } = require('pg');
const { NodeSSH } = require('node-ssh');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// LXC 103 SSH config for deploy
const SSH_HOST = '192.168.1.114';
const SSH_USER = 'root';
const SSH_KEY  = process.env.SSH_KEY_PATH || require('os').homedir() + '/.ssh/id_ed25519';

// ─── Settings ────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM agent_settings LIMIT 1');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
  const { run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce, probe_interval_min } = req.body;
  try {
    await db.query(`
      UPDATE agent_settings SET
        run_interval_min          = $1,
        panel_temp_valid_after_on = $2,
        panel_temp_valid_after_off= $3,
        trend_runs                = $4,
        temp_debounce             = $5,
        probe_interval_min        = $6
    `, [run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce, probe_interval_min]);
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
  const range = req.query.range || '6h';
  const resolution = req.query.resolution || '15m';

  const rangeMap = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours' };
  const resMap   = { '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '6h': '6 hours', '1d': '1 day' };

  const interval = rangeMap[range] || '6 hours';
  const bucket   = resMap[resolution] || '15 minutes';

  const bucketSeconds = {
    '5 minutes': 300, '15 minutes': 900, '1 hour': 3600, '6 hours': 21600, '1 day': 86400
  }[bucket] || 900;

  try {
    const r = await db.query(`
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
    const s = await db.query('SELECT probe_interval_min, agent_enabled FROM agent_settings LIMIT 1');
    const probeMin      = s.rows[0]?.probe_interval_min ?? 60;
    const agentEnabled  = s.rows[0]?.agent_enabled ?? false;

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
      return res.json({ next_probe: null, last_turn_on_origin: lastTurnOnOrigin,
                        last_turn_on_ts: lastTurnOnTs, valve_is_on: valveIsOn,
                        agent_enabled: agentEnabled });
    }

    const lastClose = new Date(r.rows[0].ts);
    const nextProbe = new Date(lastClose.getTime() + probeMin * 60 * 1000);
    res.json({ next_probe: nextProbe.toISOString(), last_turn_on_origin: lastTurnOnOrigin,
               last_turn_on_ts: lastTurnOnTs, valve_is_on: valveIsOn,
               agent_enabled: agentEnabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Versions list ────────────────────────────────────────────
app.get('/api/versions', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT DISTINCT version, MIN(ts) AS first_seen
      FROM agent_boiler_data
      WHERE version IS NOT NULL
      GROUP BY version
      ORDER BY first_seen DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Version comparison ───────────────────────────────────────
app.get('/api/compare', async (req, res) => {
  const { versionA, versionB } = req.query;
  try {
    const metrics = async (version) => {
      const r = await db.query(`
        SELECT
          ROUND(AVG(boiler_temp)::numeric, 1)  AS avg_boiler_temp,
          ROUND(MAX(boiler_temp)::numeric, 1)  AS max_boiler_temp,
          COUNT(*) FILTER (WHERE decision = 'turn_on')  AS valve_on_count,
          COUNT(*) FILTER (WHERE decision = 'turn_off') AS valve_off_count,
          ROUND(AVG(CASE WHEN decision = 'keep_on' OR decision = 'hold'
            THEN 1 ELSE 0 END)::numeric * 100, 1) AS pct_time_on
        FROM agent_boiler_data
        WHERE version = $1
      `, [version]);
      return { version, ...r.rows[0] };
    };
    const [a, b] = await Promise.all([metrics(versionA), metrics(versionB)]);
    res.json({ a, b });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Deploy ───────────────────────────────────────────────────
app.post('/api/deploy', async (req, res) => {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: SSH_HOST, username: SSH_USER, privateKeyPath: SSH_KEY });
    const pull = await ssh.execCommand('git -C /opt/Agents-agent/project pull origin main');
    const restart = await ssh.execCommand('systemctl restart boiler-agent 2>&1 || echo "service not found"');
    ssh.dispose();
    res.json({
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
    const [w, d] = await Promise.all([
      db.query('SELECT * FROM raw_weather ORDER BY ts DESC LIMIT 1'),
      db.query("SELECT * FROM raw_weather_daily WHERE forecast_date = CURRENT_DATE ORDER BY ts DESC LIMIT 1"),
    ]);
    const cur  = w.rows[0] || {};
    const day  = d.rows[0] || {};

    const conditionBase = {
      sunny: { solar: 8, rain: 1 },
      partlycloudy: { solar: 5, rain: 2 },
      cloudy:       { solar: 2, rain: 4 },
      rainy:        { solar: 1, rain: 7 },
      pouring:      { solar: 1, rain: 9 },
      snowy:        { solar: 1, rain: 6 },
    };

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
      condition:      cur.condition || null,
      uv:             uv,
      precipitation:  precip,
      forecast_date:  day.forecast_date || null,
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
      signal: AbortSignal.timeout(4000)
    }).then(() => { result.ha = true; }).catch(() => {}),
  ]);
  res.json(result);
});

// ─── Start ────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Boiler Dashboard running at http://localhost:${PORT}`);
});
