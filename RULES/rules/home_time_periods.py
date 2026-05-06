"""Home Time Periods — Layer 0 aggregator (renamed from home_state.py 2026-04-26).

Reads sentences from the "Home Time Periods" rule container in
``dashboard_settings.apartment.rule_sentences``. Each sentence declares one
time window:

    between <HH:MM | sun_event> and <HH:MM | sun_event> time_mode is <name>

Sun event tokens supported: dawn, sunrise, noon, sunset, dusk.

Sun events are computed via the `astral` library using the lat/lon declared
in the **Apartment Location** rule container:

    Apartment location: latitude 32.1593, longitude 34.8932

State outputs (state.shared):
- time_mode    — current mode string (matched window's name) or 'unknown'
- day_of_week  — 0..6 (Mon..Sun)
- sunrise / sunset / dawn / dusk / noon — ISO datetime strings for today

Virtual event:
- virtual:home_state — kept under that id for backwards compat with the
  dashboard + historical device_events queries; only the Python rule and
  sentence container are renamed. The `name` / `source` fields reflect the
  new identity.
"""

import json
import logging
import re
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    from backports.zoneinfo import ZoneInfo

from astral import LocationInfo
from astral.sun import sun

log = logging.getLogger('rule.home_time_periods')

TZ = ZoneInfo('Asia/Jerusalem')

SUN_EVENTS = ('dawn', 'sunrise', 'noon', 'sunset', 'dusk')

# Time token = HH:MM OR a sun event name. The window regex builds on it.
_TIME_TOKEN = r'(\d{1,2}:\d{2}|dawn|sunrise|noon|sunset|dusk)'
_TIME_WINDOW_RE = re.compile(
    r'between\s+' + _TIME_TOKEN + r'\s+and\s+' + _TIME_TOKEN +
    r'\s+time_mode\s+is\s+(\w+)',
    re.IGNORECASE,
)

_LATITUDE_RE  = re.compile(r'latitude\s+(-?\d+(?:\.\d+)?)',  re.IGNORECASE)
_LONGITUDE_RE = re.compile(r'longitude\s+(-?\d+(?:\.\d+)?)', re.IGNORECASE)


RULE = {
    "name":        "Home Time Periods",
    "description": "Layer 0 — current time_mode + sun event times (dawn/sunrise/noon/sunset/dusk)",
    "triggers":    ["heartbeat"],
    "controls":    [],
    "category":    "info",
    "group":       "info",
    "priority":    1,
}


# ─────────────────────────── Helpers ───────────────────────────

def _sentence_text(s):
    """Flatten a sentence into plain text. Handles both segment-based and
    legacy text-only sentences."""
    segs = s.get('segments')
    if isinstance(segs, list) and segs:
        return ''.join((seg or {}).get('v', '') for seg in segs)
    return s.get('text') or ''


def _read_apartment_location(rules):
    """Return (lat, lon) from the 'Apartment Location' container, or (None, None)."""
    lat, lon = None, None
    for r in rules or []:
        if not r.get('active'):
            continue
        if (r.get('name') or '').strip().lower() != 'apartment location':
            continue
        for s in (r.get('sentences') or []):
            if not s.get('active'):
                continue
            text = _sentence_text(s)
            m_lat = _LATITUDE_RE.search(text)
            m_lon = _LONGITUDE_RE.search(text)
            if m_lat:
                try:
                    lat = float(m_lat.group(1))
                except (TypeError, ValueError):
                    pass
            if m_lon:
                try:
                    lon = float(m_lon.group(1))
                except (TypeError, ValueError):
                    pass
    return lat, lon


def _compute_sun_times(lat, lon, tz, today_date):
    """Compute {dawn, sunrise, noon, sunset, dusk} as datetimes in tz.
    Returns {} if lat/lon missing or astral raises."""
    if lat is None or lon is None:
        return {}
    try:
        loc = LocationInfo('Apartment', 'Israel', str(tz), lat, lon)
        s = sun(loc.observer, today_date, tzinfo=tz)
        return {k: s[k] for k in SUN_EVENTS if k in s}
    except Exception as e:
        log.warning("home_time_periods: astral compute failed: %s", e)
        return {}


def _token_to_minute(token, sun_times):
    """Convert a time token (HH:MM or sun event name) to minute-of-day,
    or None if unparseable."""
    token = (token or '').strip().lower()
    if ':' in token:
        try:
            hh, mm = token.split(':', 1)
            return int(hh) * 60 + int(mm)
        except (ValueError, IndexError):
            return None
    dt = sun_times.get(token)
    if dt is None:
        return None
    return dt.hour * 60 + dt.minute


def _in_window(now_hm, start, end):
    """True if now_hm is inside [start, end), midnight-wrap aware."""
    if start < end:
        return start <= now_hm < end
    return now_hm >= start or now_hm < end


def _parse_windows(rules, sun_times):
    """Extract (start_min, end_min, mode) tuples from the 'Home Time Periods'
    container. Tokens that don't resolve (e.g. sun event with missing lat/lon)
    cause that window to be skipped — no crash."""
    windows = []
    for r in rules or []:
        if not r.get('active'):
            continue
        if (r.get('name') or '').strip().lower() != 'home time periods':
            continue
        for s in (r.get('sentences') or []):
            if not s.get('active'):
                continue
            text = _sentence_text(s)
            m = _TIME_WINDOW_RE.search(text)
            if not m:
                continue
            start_token, end_token, mode = m.groups()
            start_min = _token_to_minute(start_token, sun_times)
            end_min   = _token_to_minute(end_token, sun_times)
            if start_min is None or end_min is None:
                log.debug(
                    "home_time_periods: unparseable window: %r — start=%r end=%r",
                    text, start_token, end_token,
                )
                continue
            windows.append((start_min, end_min, mode.lower()))
    return windows


# ─────────────────────────── Rule ───────────────────────────

def evaluate(event, state):
    # Belt-and-braces — engine already filters by trigger.
    if event.get('device_id') != 'heartbeat':
        return []

    rows = state.db_query(
        "SELECT value FROM dashboard_settings WHERE key = %s",
        ('apartment.rule_sentences',),
    )
    rules = []
    if rows:
        raw = rows[0][0]
        if isinstance(raw, list):
            rules = raw
        elif isinstance(raw, str):
            try:
                rules = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                log.warning("home_time_periods: rule_sentences not valid JSON; skipping")
                rules = []

    now = datetime.now(TZ)

    # Compute sun event times for today's date using sentence-declared lat/lon.
    lat, lon = _read_apartment_location(rules)
    sun_times = _compute_sun_times(lat, lon, TZ, now.date())

    # Compute tomorrow's sun events too — used to derive `next_sunrise` /
    # `next_sunset` when today's event has already passed.
    tomorrow_sun = _compute_sun_times(lat, lon, TZ, (now + timedelta(days=1)).date())

    # Parse windows; resolve tokens (HH:MM or sun event) → minute-of-day.
    windows = _parse_windows(rules, sun_times)
    if not windows:
        log.debug("home_time_periods: no windows parsed from sentences")

    now_hm = now.hour * 60 + now.minute
    time_mode = None
    for start, end, mode in windows:
        if _in_window(now_hm, start, end):
            time_mode = mode
            break

    # Compute "next" sunrise / sunset — today's event if still upcoming,
    # else tomorrow's. Used by the dashboard tab-bar live display.
    next_sunrise = None
    if 'sunrise' in sun_times and sun_times['sunrise'] > now:
        next_sunrise = sun_times['sunrise']
    elif 'sunrise' in tomorrow_sun:
        next_sunrise = tomorrow_sun['sunrise']

    next_sunset = None
    if 'sunset' in sun_times and sun_times['sunset'] > now:
        next_sunset = sun_times['sunset']
    elif 'sunset' in tomorrow_sun:
        next_sunset = tomorrow_sun['sunset']

    # Mirror to state.shared so consumer rules can read without querying the
    # virtual device. Sun events written as ISO strings (date + time + tz).
    state.shared['time_mode']   = time_mode or 'unknown'
    state.shared['day_of_week'] = now.weekday()
    # Wall-clock HH:MM for HASP panel clock widgets (and any other consumer)
    state.shared['clock_hhmm']  = now.strftime("%H:%M")
    for ev in SUN_EVENTS:
        if ev in sun_times:
            state.shared[ev] = sun_times[ev].isoformat()
    if next_sunrise is not None:
        state.shared['next_sunrise'] = next_sunrise.isoformat()
    if next_sunset is not None:
        state.shared['next_sunset'] = next_sunset.isoformat()

    # Emit to virtual:home_state (id retained for backwards compat).
    dps = {
        'time_mode':   time_mode or 'unknown',
        'day_of_week': now.weekday(),
    }
    for ev in SUN_EVENTS:
        if ev in sun_times:
            dps[ev] = sun_times[ev].isoformat()
    if next_sunrise is not None:
        dps['next_sunrise'] = next_sunrise.isoformat()
    if next_sunset is not None:
        dps['next_sunset'] = next_sunset.isoformat()

    state.emit_virtual_event(
        virtual_id='virtual:home_state',
        dps=dps,
        source='rule:Home Time Periods',
        name='Home Time Periods',
        dps_labels={
            'time_mode':    'Time Mode',
            'day_of_week':  'Day of Week (Mon=0)',
            'dawn':         'Dawn',
            'sunrise':      'Sunrise',
            'noon':         'Solar Noon',
            'sunset':       'Sunset',
            'dusk':         'Dusk',
            'next_sunrise': 'Next Sunrise',
            'next_sunset':  'Next Sunset',
        },
    )

    return []
