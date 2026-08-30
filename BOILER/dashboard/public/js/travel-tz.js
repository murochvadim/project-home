// Frontend twin of lib-travel-tz.js — resolves which timezone a personal feature's
// "today" / date default should use, honoring dashboard_settings.travel.
//
//   window.loadTravelSettings()  -> Promise, populates window._travelCache
//   window.activeTzFor(feature)  -> tz string (sync; reads the preloaded cache)
//
// Call `await window.loadTravelSettings()` once before the first sync activeTzFor()
// use on a page (e.g. at the top of a tab's onShow). Until the cache is ready it
// falls back to Asia/Jerusalem (the safe Home default = current behavior).
(function () {
  const HOME_TZ = 'Asia/Jerusalem';
  const TZ_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;
  let loading = null;
  window._travelCache = window._travelCache || null;

  window.loadTravelSettings = function (force) {
    if (loading && !force) return loading;
    loading = fetch('/api/dashboard-settings/travel')
      .then(r => r.json())
      .then(j => {
        const v = j && j.value;
        window._travelCache = (v && typeof v === 'object') ? v : {};
        return window._travelCache;
      })
      .catch(() => { window._travelCache = window._travelCache || {}; return window._travelCache; });
    return loading;
  };

  window.activeTzFor = function (feature) {
    const s = window._travelCache || {};
    const feats = (s && s.features) || {};
    const tz = s && s.active_timezone;
    if (feats[feature] && tz && TZ_RE.test(tz)) return tz;
    return HOME_TZ;
  };

  // Best-effort preload so most sync calls have the cache ready.
  window.loadTravelSettings();
})();
