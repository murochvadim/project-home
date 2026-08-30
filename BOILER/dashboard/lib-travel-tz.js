// Shared "travel mode" timezone resolver (backend).
//
// The whole project is anchored to Asia/Jerusalem. When the user travels abroad,
// PERSONAL features (Daily Journal, Personal Health day-boundaries, the Reminders
// badge) should follow the LOCAL time of wherever they are — while HOME AUTOMATION
// stays Israel (the apartment doesn't move). This resolver is the single source of
// truth for "which timezone does feature X use right now".
//
// Setting: dashboard_settings.travel = {
//   active_timezone: "Asia/Jerusalem" | "America/New_York" | ...,   // manual, default Home
//   features: { daily_journal:true, medical:true, personal_health:true, reminders:false }
// }
//
// activeTzFor(feature) → active_timezone when features[feature] is ON (and the tz is
// a valid IANA-looking string), else 'Asia/Jerusalem'. Home automation NEVER calls it.
//
// The returned string is validated against TZ_RE, so it is SAFE to interpolate into
// SQL (`AT TIME ZONE '<tz>'`). 30 s in-process cache so the eval path stays cheap.
const HOME_TZ = 'Asia/Jerusalem';
// IANA-ish: Region/City, optional extra path segment (e.g. America/Argentina/Salta),
// letters/digits/_ + -. Asia/Jerusalem and America/New_York both pass.
const TZ_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;

module.exports = (db) => {
  let cache = null, cacheAt = 0;
  async function load() {
    const now = Date.now();
    if (cache && (now - cacheAt) < 30000) return cache;
    try {
      const r = await db.query('SELECT value FROM dashboard_settings WHERE key=$1', ['travel']);
      const v = r.rows[0] && r.rows[0].value;
      cache = (v && typeof v === 'object') ? v : (v ? JSON.parse(v) : {});
    } catch (e) { cache = {}; }
    cacheAt = now;
    return cache;
  }
  async function activeTzFor(feature) {
    const s = await load();
    const feats = (s && s.features) || {};
    const tz = s && s.active_timezone;
    if (feats[feature] && tz && TZ_RE.test(tz)) return tz;
    return HOME_TZ;
  }
  return { activeTzFor, HOME_TZ, TZ_RE };
};
