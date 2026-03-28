const express = require('express');
const { Pool } = require('pg');
const { NodeSSH } = require('node-ssh');
const path = require('path');
const { exec } = require('child_process');
const _anthropic = require('@anthropic-ai/sdk');
const Anthropic = _anthropic.default || _anthropic;

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
  const { run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off,
          trend_runs, temp_debounce, probe_interval_min,
          consumption_temp_delta, consumption_time_delta } = req.body;
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
        consumption_time_delta     = $8
    `, [run_interval_min, panel_temp_valid_after_on, panel_temp_valid_after_off,
        trend_runs, temp_debounce, probe_interval_min,
        consumption_temp_delta, consumption_time_delta]);
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
  try {
    const r = from
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

// ─── Project Health — System Status ──────────────────────────
app.get('/api/health/status', async (req, res) => {
  const SSH_TIMEOUT = 5000; // 5 seconds per SSH connect attempt

  // Helper: SSH connect with timeout
  async function sshCheck(host, commands) {
    // commands: { key: 'shell command', ... } — all run in one session
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host, username: SSH_USER, privateKeyPath: SSH_KEY, readyTimeout: SSH_TIMEOUT });
      const out = {};
      for (const [key, cmd] of Object.entries(commands)) {
        out[key] = (await ssh.execCommand(cmd)).stdout.trim();
      }
      ssh.dispose();
      return { ok: true, ...out };
    } catch (e) {
      try { ssh.dispose(); } catch {}
      return { ok: false, error: e.message };
    }
  }

  // Run all checks in parallel
  const [
    pgResult,
    haResult,
    lxc103Result,
    lxc105Result,
    pm2Result,
    rawDataResult,
    rawWeatherResult,
    orchLogResult,
    alertsResult,
    boilerDecisionResult,
  ] = await Promise.all([

    // PostgreSQL
    db.query('SELECT 1').then(() => ({ ok: true })).catch(e => ({ ok: false, error: e.message })),

    // Home Assistant
    fetch(`${HA_URL}/api/`, { headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: AbortSignal.timeout(5000) })
      .then(r => ({ ok: r.ok })).catch(e => ({ ok: false, error: e.message })),

    // LXC 103 — boiler-agent service + both cron checks in one session
    sshCheck('192.168.1.114', {
      svc:   'systemctl is-active boiler-agent',
      cron1: 'crontab -l 2>/dev/null | grep -c ha_to_pg',
      cron2: 'crontab -l 2>/dev/null | grep -c collect_weather',
    }),

    // LXC 105 — orchestrator timers
    sshCheck('192.168.1.187', {
      timer: 'systemctl is-active main-agent.timer',
      quick: 'systemctl is-active main-agent-quick.timer',
    }),

    // PM2 local
    new Promise(resolve => {
      exec('pm2.cmd jlist', (err, stdout) => {
        if (err) { resolve({ ok: false, error: err.message }); return; }
        try {
          const procs = JSON.parse(stdout);
          const list  = procs.map(p => `${p.name}: ${p.pm2_env?.status}`).join(', ');
          resolve({ ok: procs.every(p => p.pm2_env?.status === 'online'), raw: list });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    }),

    // raw_data freshness
    db.query('SELECT MAX(ts) AS last_ts FROM raw_data')
      .then(r => r.rows[0]?.last_ts).catch(() => null),

    // raw_weather freshness
    db.query('SELECT MAX(ts) AS last_ts FROM raw_weather')
      .then(r => r.rows[0]?.last_ts).catch(() => null),

    // orchestrator_log last run
    db.query('SELECT ts FROM orchestrator_log ORDER BY ts DESC LIMIT 1')
      .then(r => r.rows[0]?.ts || null).catch(() => null),

    // active alerts
    db.query('SELECT COUNT(*) AS n, MAX(severity) AS worst FROM system_alerts WHERE resolved_at IS NULL')
      .then(r => ({ n: parseInt(r.rows[0]?.n) || 0, worst: r.rows[0]?.worst || null }))
      .catch(() => ({ n: null, worst: null })),

    // boiler last decision + run_interval
    Promise.all([
      db.query('SELECT ts, decision FROM agent_boiler_data ORDER BY ts DESC LIMIT 1').catch(() => ({ rows: [] })),
      db.query('SELECT run_interval_min FROM agent_settings LIMIT 1').catch(() => ({ rows: [] })),
    ]).then(([bd, si]) => ({ lastTs: bd.rows[0]?.ts || null, decision: bd.rows[0]?.decision || null, runInterval: si.rows[0]?.run_interval_min || 5 })),
  ]);

  // Assemble results
  const results = {};

  results.postgres      = pgResult;
  results.homeassistant = haResult;

  // LXC 103
  if (lxc103Result.ok) {
    results.lxc103       = { ok: true };
    results.boiler_agent = { ok: lxc103Result.svc === 'active', status: lxc103Result.svc };
    results.ha_to_pg     = { cron_ok: parseInt(lxc103Result.cron1) > 0 };
    results.collect_weather = { cron_ok: parseInt(lxc103Result.cron2) > 0 };
  } else {
    results.lxc103          = { ok: false, error: lxc103Result.error };
    results.boiler_agent    = { ok: false, status: 'unknown' };
    results.ha_to_pg        = { cron_ok: false };
    results.collect_weather = { cron_ok: false };
  }

  // LXC 105
  if (lxc105Result.ok) {
    const timerOk = lxc105Result.timer === 'active';
    const quickOk = lxc105Result.quick === 'active';
    results.orchestrator = { ok: timerOk && quickOk, timer: lxc105Result.timer, quick: lxc105Result.quick };
  } else {
    results.orchestrator = { ok: false, error: lxc105Result.error };
  }

  results.pm2 = pm2Result;

  // ha_to_pg data freshness
  const htpAge = rawDataResult ? (Date.now() - new Date(rawDataResult).getTime()) / 60000 : null;
  results.ha_to_pg = { ...results.ha_to_pg, last_ts: rawDataResult, age_min: htpAge !== null ? Math.round(htpAge) : null, data_ok: htpAge !== null && htpAge <= 15 };

  // collect_weather data freshness
  const cwAge = rawWeatherResult ? (Date.now() - new Date(rawWeatherResult).getTime()) / 60000 : null;
  results.collect_weather = { ...results.collect_weather, last_ts: rawWeatherResult, age_min: cwAge !== null ? Math.round(cwAge) : null, data_ok: cwAge !== null && cwAge <= 35 };

  // orchestrator last run
  const orchAge = orchLogResult ? (Date.now() - new Date(orchLogResult).getTime()) / 60000 : null;
  results.orchestrator_last_run = { last_ts: orchLogResult, age_min: orchAge !== null ? Math.round(orchAge) : null, ok: orchAge !== null && orchAge <= 70 };

  // active alerts
  results.active_alerts = { count: alertsResult.n, worst: alertsResult.worst, ok: alertsResult.n === 0 };

  // boiler last decision
  const bdAge = boilerDecisionResult.lastTs ? (Date.now() - new Date(boilerDecisionResult.lastTs).getTime()) / 60000 : null;
  results.boiler_last_decision = { last_ts: boilerDecisionResult.lastTs, age_min: bdAge !== null ? Math.round(bdAge) : null, decision: boilerDecisionResult.decision, ok: bdAge !== null && bdAge <= boilerDecisionResult.runInterval * 3 };

  res.json(results);
});

// ─── Project Health — DB Volumes ─────────────────────────────
app.get('/api/health/db-volumes', async (req, res) => {
  try {
    const tables = ['raw_data', 'agent_boiler_data', 'raw_weather', 'raw_weather_daily', 'boiler_consumptions', 'orchestrator_log', 'sync_signals'];
    const tsCol  = { raw_data: 'ts', agent_boiler_data: 'ts', raw_weather: 'ts', raw_weather_daily: 'ts', boiler_consumptions: 'start_ts', orchestrator_log: 'ts', sync_signals: 'ts' };

    const sizes = await db.query(`
      SELECT relname AS table_name,
             n_live_tup AS row_count,
             pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
             pg_total_relation_size(relid) AS size_bytes
      FROM pg_stat_user_tables
      WHERE relname = ANY($1)
    `, [tables]);

    const ranges = await Promise.all(tables.map(t =>
      db.query(`SELECT MIN(${tsCol[t]}) AS oldest, MAX(${tsCol[t]}) AS newest FROM ${t}`)
        .then(r => ({ table_name: t, oldest: r.rows[0]?.oldest, newest: r.rows[0]?.newest }))
        .catch(() => ({ table_name: t, oldest: null, newest: null }))
    ));

    const rangeMap = Object.fromEntries(ranges.map(r => [r.table_name, r]));
    const result = tables.map(t => {
      const s = sizes.rows.find(r => r.table_name === t) || { row_count: 0, total_size: '—', size_bytes: 0 };
      return { table_name: t, row_count: parseInt(s.row_count) || 0,
               total_size: s.total_size, size_bytes: parseInt(s.size_bytes) || 0,
               oldest: rangeMap[t]?.oldest || null, newest: rangeMap[t]?.newest || null };
    });

    res.json(result);
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
      ('sync_signals',        7,   true,  24, 'ha_to_pg data-ready signals for boiler agent wake-up')
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
    CREATE TABLE IF NOT EXISTS sync_signals (
      id      BIGSERIAL PRIMARY KEY,
      ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source  VARCHAR(50) NOT NULL DEFAULT 'ha_to_pg'
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sync_signals_ts ON sync_signals (ts DESC)`);
}

const PORT = 3000;
ensureSchema().then(() => {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Boiler Dashboard running at http://localhost:${PORT}`);
  });
}).catch(e => {
  console.error('Schema init failed:', e.message);
  process.exit(1);
});
