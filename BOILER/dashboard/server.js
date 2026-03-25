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
const SSH_KEY  = process.env.SSH_KEY_PATH || '/root/.ssh/id_rsa';

// ─── Settings ────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM agent_settings LIMIT 1');
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
  const { run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce } = req.body;
  try {
    await db.query(`
      UPDATE agent_settings SET
        run_interval_min          = $1,
        panel_temp_valid_after_on = $2,
        panel_temp_valid_after_off= $3,
        trend_runs                = $4,
        temp_debounce             = $5
    `, [run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off, trend_runs, temp_debounce]);
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

// ─── Start ────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Boiler Dashboard running at http://localhost:${PORT}`);
});
