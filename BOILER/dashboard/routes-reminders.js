// Project-wide reminders — evaluates "due" reminders and serves them to the shared
// reminders-badge.js (red badge, top-right, on the pages chosen in Privacy →
// Settings). Own module (wired into server.js via one require line) so server.js
// stays past the architecture-guard hook.
//
// Sources today (pluggable — add a function, no UI/engine change):
//   • medications     — active ph_medications whose schedule is due today/now
//   • measure schedules — ph_profiles.weight_sched / bp_sched overdue (nothing
//                         logged within the window)
//
// Per-instance snooze/clear lives in reminder_state, keyed by a deterministic
// rkey, so Clear / Delay persist across pages, tabs and reloads. All time logic
// is Asia/Jerusalem (the DB session is UTC).
//
//   GET  /api/reminders          -> {enabled, snooze_min, pages, items:[{rkey,user_name,label,kind}]}
//   POST /api/reminders/snooze   {rkey} -> snooze until now + snooze_min
//   POST /api/reminders/clear    {rkey} -> clear this occurrence (next one re-appears)
const SETTINGS_KEY = 'reminders';
// med_window_hours: how long a dose stays on the badge after its time, carrying
// PAST MIDNIGHT (so a 23:30 dose doesn't vanish at 00:00). Daytime doses still
// show until end of day via the same-day rule; this only adds the overnight
// carry-over for late doses. 0 = legacy behavior (clears at midnight).
const DEFAULTS = { enabled: true, snooze_min: 30, med_window_hours: 8, pages: [] };
const { logExerciseRoutine } = require('./lib-exercise-log');

module.exports = (app, db) => {
  const err = (res, e) => res.status(500).json({ error: (e && e.message) || String(e) });

  async function getSettings() {
    try {
      const r = await db.query('SELECT value FROM dashboard_settings WHERE key=$1', [SETTINGS_KEY]);
      const v = r.rows[0] && r.rows[0].value;
      const val = (v && typeof v === 'object') ? v : (v ? JSON.parse(v) : {});
      return Object.assign({}, DEFAULTS, val);
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }

  // current Asia/Jerusalem date / HH:MM / dow + epoch, straight from the DB clock.
  // Also yesterday's date + dow, for the overnight med carry-over.
  async function localNow() {
    const r = await db.query(
      `SELECT (now() AT TIME ZONE 'Asia/Jerusalem')::date::text                          AS ldate,
              to_char(now() AT TIME ZONE 'Asia/Jerusalem','HH24:MI')                     AS lhm,
              lower(to_char(now() AT TIME ZONE 'Asia/Jerusalem','Dy'))                   AS ldow,
              ((now() AT TIME ZONE 'Asia/Jerusalem')::date - 1)::text                    AS ydate,
              lower(to_char((now() AT TIME ZONE 'Asia/Jerusalem') - interval '1 day','Dy')) AS ydow,
              extract(epoch from now())::bigint                                          AS epoch`);
    return r.rows[0];
  }
  const hm2min = (hm) => { const [h, m] = (hm || '0:0').split(':').map(Number); return h * 60 + m; };

  // is today a dose day for this med?
  function medDoseDay(m, ldate, ldow) {
    switch (m.freq) {
      case 'daily': return true;
      case 'weekly': return m.dow ? m.dow.toLowerCase().includes(ldow) : false;
      case 'every_n_days':
      case 'every_n_months':
      case 'once': return m.next_due ? (m.next_due <= ldate) : false;
      default: return false; // as_needed / unknown — no auto reminder
    }
  }

  function isoWeek(ldate) {
    const d = new Date(ldate + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const w = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + '-' + w;
  }
  // a key that changes only when the measure window rolls over (so a Clear sticks
  // for the whole window, and the next window re-raises a fresh reminder)
  function windowKey(sched, ldate, epoch) {
    const f = sched.freq, n = Math.max(1, Number(sched.interval_n) || 1);
    if (f === 'weekly') return 'w' + isoWeek(ldate);
    if (f === 'every_n_days') return 'nd' + Math.floor(Math.floor(epoch / 86400) / n);
    if (f === 'every_n_months') {
      const d = new Date(ldate + 'T00:00:00Z');
      return 'nm' + Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / n);
    }
    return ldate; // daily / fallback
  }
  function windowDays(sched) {
    const f = sched.freq, n = Math.max(1, Number(sched.interval_n) || 1);
    if (f === 'weekly') return 7;
    if (f === 'every_n_days') return n;
    if (f === 'every_n_months') return n * 30;
    return 1; // daily
  }

  async function evaluate(s) {
    const t = await localNow();
    const items = [];

    // ── medications ──
    const winMin = Math.max(0, Math.round((Number(s.med_window_hours) || 0) * 60));
    const nowMin = hm2min(t.lhm);
    const meds = (await db.query(
      `SELECT m.id, m.name, m.dose, m.freq, m.interval_n, m.times, m.dow,
              to_char(m.next_due,'YYYY-MM-DD') AS next_due, hu.name AS user_name
         FROM ph_medications m
         JOIN ph_profiles pr ON pr.id = m.profile_id
         LEFT JOIN household_users hu ON hu.id = pr.user_id
        WHERE m.active = true`)).rows;
    const pushMed = (m, doseDate, slot) => items.push({
      rkey: `med:${m.id}:${doseDate}:${slot || '-'}`,
      user_name: m.user_name || '—',
      label: '💊 ' + m.name + (m.dose ? ' · ' + m.dose : '') + (slot ? ' · ' + slot : ''),
      kind: 'med',
    });
    for (const m of meds) {
      const slots = (m.times || '').split(',').map(x => x.trim()).filter(Boolean);
      if (!slots.length) {
        // no specific time → due all day today (no overnight carry)
        if (medDoseDay(m, t.ldate, t.ldow)) pushMed(m, t.ldate, '');
        continue;
      }
      for (const slot of slots) {
        const doseMin = hm2min(slot);
        if (medDoseDay(m, t.ldate, t.ldow) && nowMin >= doseMin) {
          // (1) today's dose: visible from its time until end of local day (unchanged)
          pushMed(m, t.ldate, slot);
        } else if (winMin > 0 && medDoseDay(m, t.ydate, t.ydow)
                   && ((1440 - doseMin) + nowMin) < winMin) {
          // (2) yesterday's late dose carried past midnight, up to winMin after its time.
          //     Same rkey (dose date = yesterday) so a pre-midnight Clear still sticks.
          pushMed(m, t.ydate, slot);
        }
      }
    }

    // ── measure schedules (weight / BP) ──
    const profs = (await db.query(
      `SELECT pr.id, hu.id AS uid, hu.name AS user_name, pr.weight_sched, pr.bp_sched, pr.body_sched, pr.bobo_sched
         FROM ph_profiles pr LEFT JOIN household_users hu ON hu.id = pr.user_id`)).rows;
    for (const pr of profs) {
      const checks = [
        ['weight', pr.weight_sched, 'ph_measurements', '⚖ Weight'],
        ['bp',     pr.bp_sched,     'ph_bp',           '🩺 Blood pressure'],
        ['body',   pr.body_sched,   'ph_body',         '📏 Waist & hip'],
      ];
      for (const [kind, sched, table, label] of checks) {
        if (!sched || !sched.freq) continue;
        const last = (await db.query(`SELECT max(measured_at) AS m FROM ${table} WHERE profile_id=$1`, [pr.id])).rows[0].m;
        const overdue = !last || (Date.now() - new Date(last).getTime()) / 86400000 >= windowDays(sched);
        if (!overdue) continue;
        items.push({
          rkey: `${kind}:${pr.id}:${windowKey(sched, t.ldate, Number(t.epoch))}`,
          user_name: pr.user_name || '—',
          label: label,
          kind,
        });
      }
      // ── play Bobo: overdue = no balance game within the schedule window ──
      const bs = pr.bobo_sched;
      if (bs && bs.freq && pr.uid != null) {
        const last = (await db.query(
          `SELECT max(measured_at) AS m FROM ph_bobo WHERE profile_id=$1`,
          [pr.id])).rows[0].m;
        const overdue = !last || (Date.now() - new Date(last).getTime()) / 86400000 >= windowDays(bs);
        if (overdue) items.push({
          rkey: `bobo:${pr.id}:${windowKey(bs, t.ldate, Number(t.epoch))}`,
          user_name: pr.user_name || '—',
          label: '🛹 Bobo',
          kind: 'bobo',
        });
      }
    }

    // ── water: nudge every interval (cups so far < what you should have by now).
    // Config is GLOBAL (Medical → Settings) in dashboard_settings.medical.water:
    // {enabled, target, start_hm, end_hm, interval_min}. interval_min blank/0 = auto
    // (window ÷ target). Applies to every profile, each with its own ph_water count. ──
    let waterCfg = null;
    try {
      const wr = await db.query("SELECT value FROM dashboard_settings WHERE key='medical.water'");
      const v = wr.rows[0] && wr.rows[0].value;
      waterCfg = (v && typeof v === 'object') ? v : (v ? JSON.parse(v) : null);
    } catch (e) { /* no config → no water reminders */ }
    if (waterCfg && waterCfg.enabled && Number(waterCfg.target) > 0) {
      const target = Number(waterCfg.target);
      const startMin = hm2min(waterCfg.start_hm || '08:00'), endMin = hm2min(waterCfg.end_hm || '22:00');
      const interval = Number(waterCfg.interval_min) > 0
        ? Number(waterCfg.interval_min)
        : Math.floor((endMin - startMin) / target);
      if (nowMin >= startMin && endMin > startMin && interval > 0) {
        const expected = Math.min(target, Math.floor((nowMin - startMin) / interval));
        if (expected > 0) {
          for (const pr of profs) {
            const cups = Number((await db.query(
              `SELECT COALESCE(SUM(cups),0) AS c FROM ph_water
                WHERE profile_id=$1 AND day = $2::date`,
              [pr.id, t.ldate])).rows[0].c) || 0;
            if (cups >= expected) continue;                            // caught up to this interval
            items.push({
              // rkey keyed to the interval slot you've fallen behind on → Delay/Clear
              // stick for that slot; a fresh nudge raises at the next interval.
              rkey: `water:${pr.id}:${t.ldate}:${expected}`,
              user_name: pr.user_name || '—',
              label: `💧 Drink water (${cups}/${target})`,
              kind: 'water',
            });
          }
        }
      }
    }

    // ── daily journal: for each configured slot, nudge once its time has passed
    // (today) UNTIL that slot's entry exists. Config GLOBAL in
    // dashboard_settings.journal {enabled, user_id, slots:[{id,name,time_hm}]}.
    // rkey journal:<uid>:<date>:<slot_id> → Skip(Clear)/Later(snooze) stick per slot;
    // Save (from the capture panel) writes journal_entries → the nudge disappears. ──
    let jCfg = null;
    try {
      const jr = await db.query("SELECT value FROM dashboard_settings WHERE key='journal'");
      const v = jr.rows[0] && jr.rows[0].value;
      jCfg = (v && typeof v === 'object') ? v : (v ? JSON.parse(v) : null);
    } catch (e) { /* no config → no journal reminders */ }
    if (jCfg && jCfg.enabled && Array.isArray(jCfg.slots) && jCfg.slots.length) {
      const juid = Number(jCfg.user_id) || 1;
      const juName = (await db.query("SELECT name FROM household_users WHERE id=$1", [juid])).rows[0]?.name || '—';
      for (const slot of jCfg.slots) {
        if (!slot || !slot.id || !slot.time_hm) continue;
        if (nowMin < hm2min(slot.time_hm)) continue;                 // not due yet today
        const done = Number((await db.query(
          "SELECT count(*) AS c FROM journal_entries WHERE user_id=$1 AND entry_date=$2::date AND slot_id=$3",
          [juid, t.ldate, slot.id])).rows[0].c) || 0;
        if (done) continue;                                          // this slot already written today
        items.push({
          rkey: `journal:${juid}:${t.ldate}:${slot.id}`,
          user_name: juName,
          label: `📓 ${slot.name || 'Journal'}`,
          kind: 'journal',
          slot_id: slot.id,
          slot_name: slot.name || '',
          entry_date: t.ldate,
          user_id: juid,
        });
      }
    }

    // ── morning exercises: due once per day after the scheduled time, until the
    // routine is logged (the card's ✓ Done OR this reminder's Clear). Config is
    // GLOBAL in dashboard_settings.medical.exercises {enabled, schedule:{time_hm},
    // items[]}; per-profile log in ph_exercise_log. ──
    let exCfg = null;
    try {
      const er = await db.query("SELECT value FROM dashboard_settings WHERE key='medical.exercises'");
      const v = er.rows[0] && er.rows[0].value;
      exCfg = (v && typeof v === 'object') ? v : (v ? JSON.parse(v) : null);
    } catch (e) { /* no config → no exercise reminders */ }
    const exIncluded = (exCfg && Array.isArray(exCfg.items) ? exCfg.items : []).filter(it => it && it.include !== false).length;
    if (exCfg && exCfg.enabled && exIncluded > 0) {
      const timeHm = (exCfg.schedule && exCfg.schedule.time_hm) || '07:00';
      if (nowMin >= hm2min(timeHm)) {
        for (const pr of profs) {
          const doneToday = Number((await db.query(
            `SELECT count(*) AS c FROM ph_exercise_log
              WHERE profile_id=$1 AND (measured_at AT TIME ZONE 'Asia/Jerusalem')::date = $2::date`,
            [pr.id, t.ldate])).rows[0].c) || 0;
          if (doneToday) continue;
          items.push({
            rkey: `exercise:${pr.id}:${t.ldate}`,    // daily → Clear/Delay stick for the day
            user_name: pr.user_name || '—',
            label: '🏋️ Morning exercises',
            kind: 'exercise',
          });
        }
      }
    }

    // ── filter out snoozed / cleared instances ──
    if (!items.length) return [];
    const states = (await db.query(
      'SELECT rkey, snoozed_until, cleared_at FROM reminder_state WHERE rkey = ANY($1)',
      [items.map(i => i.rkey)])).rows;
    const st = {}; states.forEach(s => { st[s.rkey] = s; });
    const now = Date.now();
    return items.filter(i => {
      const s = st[i.rkey];
      if (!s) return true;
      if (s.cleared_at) return false;
      if (s.snoozed_until && new Date(s.snoozed_until).getTime() > now) return false;
      return true;
    });
  }

  app.get('/api/reminders', async (req, res) => {
    try {
      const s = await getSettings();
      if (!s.enabled) return res.json({ enabled: false, snooze_min: s.snooze_min, pages: s.pages || [], items: [] });
      const items = await evaluate(s);
      res.json({ enabled: true, snooze_min: s.snooze_min, pages: s.pages || [], items });
    } catch (e) { err(res, e); }
  });

  app.post('/api/reminders/snooze', async (req, res) => {
    try {
      const rkey = (req.body || {}).rkey;
      if (!rkey) return res.status(400).json({ error: 'rkey required' });
      const s = await getSettings();
      const mins = Math.max(1, Number(s.snooze_min) || 30);
      await db.query(
        `INSERT INTO reminder_state (rkey, snoozed_until, cleared_at, updated_at)
         VALUES ($1, now() + make_interval(mins => $2), NULL, now())
         ON CONFLICT (rkey) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until, cleared_at = NULL, updated_at = now()`,
        [rkey, mins]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  app.post('/api/reminders/clear', async (req, res) => {
    try {
      const rkey = (req.body || {}).rkey;
      if (!rkey) return res.status(400).json({ error: 'rkey required' });
      // Water reminders: Clear means "I drank it" → +1 cup to TODAY's row (one-row-
      // per-day model, migration 017; upsert-increment, not a new row). rkey = water:<pid>:…
      if (rkey.startsWith('water:')) {
        const pid = parseInt(rkey.split(':')[1], 10);
        if (pid) await db.query(
          `INSERT INTO ph_water (profile_id, day, cups)
           VALUES ($1, (now() AT TIME ZONE 'Asia/Jerusalem')::date, 1)
           ON CONFLICT (profile_id, day) DO UPDATE SET cups = ph_water.cups + 1, measured_at = now()`,
          [pid]);
      }
      // Exercise reminders: Clear means "I did my routine" → LOG it (total calories
      // + muscles, computed from the global definitions). rkey = exercise:<pid>:…
      if (rkey.startsWith('exercise:')) {
        const pid = parseInt(rkey.split(':')[1], 10);
        if (pid) await logExerciseRoutine(db, pid);
      }
      await db.query(
        `INSERT INTO reminder_state (rkey, cleared_at, updated_at) VALUES ($1, now(), now())
         ON CONFLICT (rkey) DO UPDATE SET cleared_at = now(), updated_at = now()`,
        [rkey]);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
};
