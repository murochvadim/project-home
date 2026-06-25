# Pill Reminders — build plan (PLANNED, NOT BUILT)

**Status:** PLANNED — decided 2026-06-25, nothing built yet. Waiting for an explicit build order.

Send a phone notification when a medication in `ph_medications` is due. This is the **first consumer** of the self-hosted **ntfy notification channel** — the channel (ntfy server on LXC 109 + per-person topics + phone app) is owned by **`NETBIRD/MOBILE/CLAUDE.md`** ("Push Notifications — ntfy channel"). This doc covers only the **pill-specific logic** that publishes to that channel.

> Separation of concerns: **how a message reaches a phone** = NETBIRD/MOBILE (ntfy/NetBird). **when a pill is due + what to say** = here (Medical → Personal Health).

## Architecture

```
ph_medications (LXC 102)  ──read──►  pill watcher (LXC 104, cron)
                                          │ resolve person → ntfy topic
                                          │ HTTP POST when a pill is due
                                          ▼
                                   ntfy server (LXC 109)  ── over NetBird ─►  phones
                                   (owned by NETBIRD/MOBILE)
```

## What this consumer adds

### 1. Pill watcher — `scripts/pill_reminder_watchdog.py` → `/opt/pill_reminder_watchdog.py` (LXC 104)
- Cron alongside the other watchdogs (cadence = open decision below).
- Reads active `ph_medications` + `ph_profiles` (person → ntfy topic).
- For each med, computes today's due datetimes (Asia/Jerusalem) from the schedule fields, and if now is at a due time **and not already sent for that slot** → publishes to that person's ntfy topic.
- Message: `💊 Losardex Plus (50 mg) — time to take` · title `Pill reminder`.
- Config in `/etc/pill-reminder.env` (`NTFY_URL`, `NTFY_TOKEN`; DB needs no password — Postgres trusts the subnet).

**Schedule coverage** (from the existing `ph_medications` fields — no schema change needed for the schedule itself):
| `freq` | due computation |
|---|---|
| `daily` | each `HH:MM` in `times`, every day |
| `weekly` | each `HH:MM` in `times` on the days in `dow` |
| `every_n_days` | every `interval_n` days from an anchor (`next_due`) at `times` |
| `every_n_months` | on `next_due` at `times`, then advance `next_due` by `interval_n` months |
| `once` | at `next_due` (+ `times`), once |
| `as_needed` | never auto-reminds |

### 2. Dedupe table — `ph_med_reminders` (LXC 102)
`(id, med_id FK → ph_medications, due_ts, sent_at)` — one row per fired slot so a minute-by-minute watcher never double-sends. Retention: keep ~90 d, auto_clean. Register in `retention_policies` + Health DB-Volumes.

### 3. Per-person topic
Resolve `ph_profiles.name` → the person's ntfy topic via the registry defined in NETBIRD/MOBILE (a `privacy.users` field or derived `<name>_pills`). No phone number involved.

## Open decisions (answer when ordering the build)
1. **Cadence**: every **1 min** (on-time) vs every **5 min** (±5 min, matches the other LXC-104 watchdogs).
2. **Scope**: all household meds → the one ready phone (Fold 5) vs only the owner's meds per person (Maya silent until her S 21 has the app).
3. **Acknowledgement**: plain reminder (Phase 1) vs actionable **[Taken]/[Snooze]** (ntfy action button → a small log endpoint; needs a `ph_med_log` table — Phase 2).
4. **Repeat if ignored**: one-shot per time vs repeat until Taken (needs #3).

## Pre-build checks
- **A med only reminds if it has a `times` value** — verify the existing meds (e.g. Losardex Plus for Vadim) have a time set; if blank, reminders can't fire until one is entered on the Personal Health med form.
- The **ntfy channel must exist first** (NETBIRD/MOBILE phases 1–2) and the target phone must have the app + be subscribed.

## Touch points when built
- **Repo**: `scripts/pill_reminder_watchdog.py`, `PERSONAL_HEALTH/migrations/*` (ph_med_reminders), this plan → status BUILT.
- **LXC 104**: `/opt/pill_reminder_watchdog.py` + cron + `/etc/pill-reminder.env`.
- **LXC 102**: `ph_med_reminders` table + retention.
- **Docs**: update `PERSONAL_HEALTH/CLAUDE.md` (reminder watcher), root `CLAUDE.md` (LXC 104 cron list), memory.
- **Optional dashboard**: a per-med "🔔 Test reminder" button on the Personal Health tab.

## When ready
Tell me **"build pill reminders phase N"** with your calls on the 4 open decisions. The ntfy channel (NETBIRD/MOBILE) must be built first (or in the same order).
