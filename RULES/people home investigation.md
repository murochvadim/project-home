# People Home undercount — investigation log

> Started 2026-04-25. User reports 5 people physically present, system shows `people_home = 2`.
> Read-only investigation. No fixes yet. User will decide algorithm changes after all findings collected.

---

## 1. Current state snapshot (2026-04-25 ~19:15 IDT)

### `virtual:people_home` last emit
| field | value |
|---|---|
| `people_home` (locked) | **2** |
| `people_home_dynamic` (locked + discoveries) | **2** |
| `people_count_live` (sensors right now) | **3** (then dropped to 2 — see §3) |
| `people_count_state` | `stable` |
| `people_count_floored` | `true` (live ≠ locked) |
| `people_count_high_water` | 2 |
| `people_discovered_count` | 0 |
| `people_confidence` | `high` |
| `last_transition_source` | `door_sensor` |
| `last_transition_ts` (UTC) | 2026-04-25T16:07:48 (= 19:07:48 IDT, 2 min before snapshot) |
| `occupied_rooms` | Bedroom, Dining Room, DressRoom, Kitchen, Living Room, My BathRoom |
| `last_entered_via` | Dressroom Door |
| `last_exited_via` | Entrance Presence (inferred) |

### `virtual:home_activity` last emit (4 s before)
| field | value |
|---|---|
| `active_rooms` (held by Home Activity) | Bedroom, Dining Room, DressRoom, Hallway, Living Room, My BathRoom (6 rooms) |
| `active_zones` | Bathroom Walkway, Bedroom Doorway, Dining Table, Sofa Entertainment (4 zones) |
| `activity_level` | `active` |
| `last_motion_room` | Bedroom |
| `door_state` | Main=closed, Balcony=open, Bathroom=open, Dressroom=closed, My Bathroom=closed |

### Door log (last 6 hrs, Main Door)
| local time | event |
|---|---|
| 15:36:00 | open |
| 15:36:06 | close |
| 18:03:03 | open |
| 18:03:34 | close |
| 18:04:26 | open |
| 18:04:31 | close |
| (since) | only temperature reports — no door open/close |

→ Main Door has been closed since **18:04:31** (~70 min before the issue manifests).

---

## 2. Sensor inventory + current state

| Sensor | Room | Protocol | Currently active? |
|---|---|---|---|
| Bedroom Presence (mmWave) | Bedroom | Tuya cloud | **YES** — `1=presence` |
| Aeotec Motion Bedroom (PIR) | Bedroom | Z-Wave | no — `motion=false` (`1`=19 = lux) |
| Living Room Presence (mmWave) | Living Room | Tuya local | **YES** — `1=presence` |
| Sallon Corner Motion (PIR) | Living Room | Z-Wave | no — `motion=false` |
| TV Wall Corner Motion (PIR) | Living Room | Z-Wave | no — `motion=false` |
| Dining Room Presence (mmWave) | Dining Room | Tuya local | **YES** — `1=presence` |
| Kitchen Motion (Aeotec PIR) | Kitchen | Z-Wave | **YES** — `motion=true` |
| Kitchen Presence Sensor (mmWave) | Kitchen | Tuya local | no — `1=false` |
| DressRoom Presence (mmWave) | DressRoom | Tuya local | no — `1=none` |
| My Bathroom Presence (mmWave) | My BathRoom | Tuya local | no — `1=none` |
| Hallway Motion / Hallway 2 Motion | Hallway | Z-Wave | no |
| Balcony presence (mmWave) | Balcony | Tuya local | no — `1=none` |
| Balcony Motion (PIR) | Balcony | Z-Wave | no |
| Entrance Presence (mmWave) | Entrance | Tuya local | no — `1=none` |
| Corridor Presence (mmWave) | Corridor | Tuya local | no — `1=none` |
| Ring Doorbell | Entrance | Ring | no — last fired 7 min ago |
| Guy Room Presence | Guy Room | Tuya local | no — `1=none` |
| Laundry Room Presence | Laundry | Tuya local | no — `1=none` |
| My Room presence | My Room | Tuya cloud | no — `1=none` |

### Rooms with NO presence sensor
- Bathroom (the one labeled `door:Bathroom Door` is open in state.shared but no sensor)
- BedRoom Balcony

### Rooms with multiple sensors (redundancy)
- **Bedroom**: Tuya cloud mmWave (active) + Aeotec PIR (idle). PIR doesn't see still people.
- **Living Room**: Tuya local mmWave (active) + 2 Aeotec PIRs (both idle). PIRs don't see still people.
- **Kitchen**: Aeotec PIR (active) + Tuya local mmWave (idle). PIR seeing motion the mmWave didn't pick up — possibly someone walking through but not standing still in the mmWave field.
- **Balcony**: Tuya mmWave + Aeotec PIR (both idle).

→ Only **Tuya mmWave** sensors are catching the "people sitting still" cases. The Z-Wave Aeotec PIRs are entirely idle in occupied rooms because residents aren't moving.

---

## 3. Counted vs true count walk-through (right now)

People Home rule iterates `state.devices`, applies `_presence_active(dev.dps)`, builds `presence_rooms`.

Sensors currently passing `_presence_active`:
1. Bedroom Presence (`1=presence`) → "Bedroom"
2. Living Room Presence (`1=presence`) → "Living Room"
3. Dining Room Presence (`1=presence`) → "Dining Room"
4. Kitchen Motion (`motion=true`) → "Kitchen"

Raw `presence_rooms` = [Bedroom, Living Room, Dining Room, Kitchen] = 4 distinct rooms.

### Sub-room folding ([people_home.py:282-297](RULES/rules/people_home.py#L282-L297))

`DEFAULT_MANUAL_SUBROOM_MERGE = {'Dining Room': 'Living Room', 'Entrance': 'Living Room'}`. Plus auto-detected from spatial: Kitchen → Living Room (zone names start with "Kitchen ").

Folded:
- Bedroom → Bedroom
- Living Room → Living Room
- Dining Room → Living Room
- Kitchen → Living Room

After fold, `presence_rooms` = [Bedroom, Living Room] = **2 distinct counted units**.

### Adjacency-aware dedupe ([people_home.py:312-327](RULES/rules/people_home.py#L312-L327))

`people_count = 2` initially. Loop checks pairs:
- Bedroom + Living Room: are they adjacent? Need to check spatial graph. Even if yes, requires a recent `corridor:Bedroom>Living Room` or reverse timer fire within 30 s. Looking at the dump: `corridor:Bedroom>Living Room` last fired at unix 1777132694.23, current time approx 1777135000+, so age = ~2300+ s = ~38 min. Outside the 30 s window. → No merge.

→ `people_count_live` = **2**.

### Lock state ([people_home.py:398-427](RULES/rules/people_home.py#L398-L427))

`_people_locked_count = 2`, `_people_lock_rooms = [Bedroom, Living Room]`. Last set at `_people_last_lock_ts = 2026-04-25T15:05:32` UTC = **18:05:32 IDT** = right after Main Door closed at 18:04:31, after the 60 s stabilize window.

Since 18:05:32, no Main Door close has fired → lock has not refreshed → still 2.

### Discovery layer ([people_home.py:443-485](RULES/rules/people_home.py#L443-L485))

`_people_accounted_rooms` (rooms already accounted for via corridor transit since last lock):
```
[Balcony, Bedroom, Dining Room, DressRoom, Entrance, Hallway, Kitchen,
 Laundry, Living Room, My BathRoom, My Room]
```

Every meaningful room is already "accounted for" — meaning at some point since 18:05:32, someone walked between rooms and the corridor timer fired, marking the destination as "occupied by an already-counted person." Discovery layer therefore can't bump the count via the 4-signal test (signal 2 fails for every candidate room).

→ `people_discovered_count` stays 0. Dynamic count stays at 2.

---

## 4. Key parameters in effect (`state.shared` knobs)

| knob | value |
|---|---|
| `people_home.corridor_sec` | 15 |
| `people_home.adjacency_dedupe_sec` | 30 |
| `people_home.away_after_no_motion_min` | 30 |
| `people_home.door_transit_window_sec` | 10 |
| `people_home.exit_quiet_window_sec` | 30 |
| `people_home.transit_sequence_window_sec` | 15 |
| `people_home.door_close_stabilize_sec` | **60** (raised from default 15 — sentence says "recount 60 seconds after Main Door closes") |
| `home_activity.hold_off_sec` | 10 |
| `home_activity.interact_window_sec` | 120 |

---

## 5. Findings — ranked by impact on the undercount

### 5.1 Sub-room folding collapses the open-plan area to 1 person
- 3 sub-rooms (Living Room, Dining Room, Kitchen) currently active simultaneously → fold to **1**.
- If 3 people are spread across the open plan, all 3 are missed.
- Code: `DEFAULT_MANUAL_SUBROOM_MERGE` + auto-fold from `state.spatial.subrooms`. There is **no condition** today that prevents folding — it always folds, regardless of how long sub-rooms have been independently active.

### 5.2 Lock-refresh trigger is Main Door only
- `_people_lock_rooms` was set at 18:05:32 (right after the 18:04 Main Door close cycle).
- Between then and now, **`active_rooms` shrank from a possibly-larger set to 6 rooms** because Home Activity holds aged out for the rooms that went quiet.
- Even if more people came in since 18:05, the lock cannot refresh until Main Door fires again.
- Balcony Door has been **open** the whole time (per `door_state.Balcony Door = open`). Balcony entries entirely bypass the recount.
- Other interior doors (Bathroom, Dressroom, My Bathroom) are tracked but not used for recount.

### 5.3 Live count uses CURRENT sensor state, not held state
- `_presence_active(dev.dps)` reads what each sensor is reporting **right now**.
- PIR sensors hold for ~10 s after last motion; mmWave for ~60-100 s.
- A still person in a PIR-only room is invisible.
- Home Activity's `active_rooms` (held set, 10 s motion / 120 s switch hold) is NOT consulted for presence counting — only as a `count == 0` floor.

### 5.4 Discovery layer's "accounted_rooms" closes off all discovery candidates
- After people walk around between door events, `_people_accounted_rooms` accumulates every room they've visited.
- Once a room is in that set, the discovery layer (Signal 2) refuses to flag it as a potential hidden occupant.
- Today the set covers 11 rooms — every plausible discovery candidate is already excluded.
- The set only resets on the next door-event recount.

### 5.5 Counts ROOMS not HEADS — architectural ceiling
- Even with sub-rooms unfolded and held state used: max count = number of distinct rooms with active sensors.
- Right now: 4 active sensor rooms. Even with all merges/folds disabled, ceiling = 4.
- True count = 5. Two people are likely in the same room (e.g. couple in Bedroom, friends on the sofa) → invisible to a binary-presence sensor.
- No sensors expose `target_count` (multi-target tracking like Aqara FP2 / LD2450).

### 5.6 Open-plan over-counting risk if folding is removed
- One person walking from Kitchen to Living Room briefly fires both sensors. Without folding, that's 2.
- Any fix to 5.1 must distinguish "transit" (one person across sub-rooms) from "occupancy" (different people in each sub-room).
- Existing infrastructure for this: `room_first_active:<room>` timers (already set in §4b), corridor timers, `_people_accounted_rooms`.

---

## 6. Possible bug — `_people_accounted_rooms` over-accumulation

Walk through what happens when someone walks A → B → C → D:
- At A→B transition, corridor timer fires, B is added to `_people_accounted_rooms`.
- At B→C, C is added.
- At C→D, D is added.
- Set stays accumulated until next door-event recount.

If the same person walks the whole apartment between two door events, every room becomes "accounted" — even rooms where a *different* person later sits down. The discovery layer becomes blind to anyone who happened to be in a room the first person walked through.

This is amplified by the open-plan area: walking from Kitchen to the Sofa marks Kitchen + Dining Room + Living Room all as accounted. Anyone independently in any of those rooms loses their chance to be "discovered."

---

## 7. Lock_rooms vs presence_rooms drift

`_people_lock_rooms = [Bedroom, Living Room]` was snapshotted at 18:05:32 — only those 2 rooms were active right after the door close.

Since then, sensors have fired in Dining Room, Kitchen, DressRoom, Hallway, My BathRoom, etc. None of them are in `lock_rooms`, so all of them are theoretically eligible for discovery — except they all got into `accounted_rooms` via corridor transits, killing the discovery test (§5.4 + §6).

→ Discovery cannot succeed under current logic when residents are mobile. Discovery is essentially only useful for "hidden person who was already there at door close, doesn't move much, and a separate visible person stays in their original lock-room."

---

## 8. Sensor-coverage rooms with active doors

The user could have people in:
- **BedRoom Balcony** (no sensor at all)
- **Bathroom** (the regular bathroom — door is currently open per `door:Bathroom Door = open`, but no presence sensor in the room)
- **Balcony** (sensors there but both showing inactive — possibly someone sitting still on the balcony?)

These are blind spots not addressed by any current logic.

---

## 9. Smoking gun — recount snapshots the WRONG moment

Today's `virtual:people_home` history (1289 emits today). Aggregate stats:

| metric | value |
|---|---|
| `max(people_count_live)` today | **5** |
| `max(people_home)` (locked) today | **2** |
| `max(people_home_dynamic)` today | **2** |

**Live DID hit 5 today — it just got snapshotted as 2.**

### The 18:04 entry sequence — minute by minute

The single moment live=5 was reached: **18:04:54**.

Reconstructed from the event stream:

```
17:55-18:02   live oscillating 1-3, locked=2 stable
18:03:03      Main Door OPEN  → state=transit
18:03:34      Main Door CLOSE → state=recounting, live=1
18:03:38..    still recounting, live=1
18:04:08-25   recounting, live 1-2 (mid-cycle, residents moving around)
18:04:26      Main Door OPEN again → transit
18:04:31      Main Door CLOSE again → recounting (this is the cycle that matters)
18:04:31  +0  live=2
18:04:38  +7  live=2
18:04:43  +12 live=3   ← people arriving
18:04:45  +14 live=4
18:04:53  +22 live=4
18:04:54  +23 live=5   ← *** PEAK, all 5 detected ***
18:04:57  +26 live=4
18:05:08  +37 live=4
18:05:16  +45 live=3
18:05:24  +53 live=2
18:05:32  +61 STABILIZE WINDOW ELAPSES → state=stable, locked = live = 2  ← SNAPSHOT
18:05:35..    locked permanently 2 thereafter
```

The 60 s stabilize window expired at **18:05:32** — the moment chosen to snapshot the count. At that exact moment `live=2`. So `locked` was assigned 2 — even though `max(live)` during that 60 s window was **5**.

### Why live decayed from 5 → 2 in 38 seconds

Sensors that briefly fired during entry then went quiet:
- Hallway / Kitchen / Bathroom Walkway / Bedroom Doorway — PIR / mmWave that picked up *transit* through these rooms as people walked in.
- After everyone reached their destination room (e.g. clustered on the sofa or in Bedroom), only the destination rooms still report active.

Combined with sub-room folding and adjacency merge, the count collapses to 2 distinct counted rooms (Bedroom + Living Room) even though 5 people are physically there.

### Why this is a bug, not architecture limitation

The whole point of the door-locked count is to capture the **entry tally**. People entering through the door are counted at the moment of entry. The stabilize window is supposed to give sensors time to settle. But the implementation **snapshots at the END** instead of taking **the max over the window**:

```python
# people_home.py:403-406
if recalc_pending and state.get_timer('_post_door_stabilize') >= effective_stabilize:
    state.shared['_people_locked_count'] = live_count   # ← takes value at THIS instant
    state.shared['_people_last_lock_ts'] = _now_iso()
```

A max-during-window snapshot would have caught the `live=5` peak at 18:04:54 and locked at 5 instead of 2.

### Same issue at the previous cycle (18:03)

The 18:03:03 / 18:03:34 cycle:
- live started at 2-3 before the door fired
- Recount kicked in
- Stabilize wait: 60 s
- During that wait, a SECOND door cycle fired at 18:04:26, retriggering the stabilize timer (people in `_post_door_stabilize` reset semantics need confirmation — but the data shows the 18:03 recount didn't get snapshotted as a separate value).

So 18:03's recount was effectively discarded by the 18:04 retrigger. Net effect: only one snapshot at 18:05:32, value = 2.

### The "live=5" moment was real, not a glitch

For 1+ second the rule independently agreed 5 distinct counted rooms had active sensors. That matches the user's "5 people entered." The system saw them — it just refused to lock that count.

---

## 10. Other discoveries while pulling history

- `max(people_home_dynamic)` today is **2** — discovery layer never bumped at all today, despite many room visits. Confirms §6 (`_people_accounted_rooms` over-accumulation) is killing discovery in practice.
- The `inferred_entry` source dominates `last_transition_source` between door events — meaning Tier-1↔Tier-3 inferred transit IS firing regularly, but it doesn't trigger a lock recount with the same weight. Looking at code: it DOES set `_post_door_stabilize` if `inferred_transit` is truthy ([people_home.py:398](RULES/rules/people_home.py#L398)) — so it should recount. But the data shows locked stayed at 2 throughout, suggesting either (a) the inferred path isn't actually setting the timer, or (b) every inferred recount snapshotted at a low value too, same end-of-window bug.

---

## 11. Spatial adjacency graph (from `dashboard_settings.room_layouts.*`)

| room_slug | doors lead to (from this room) |
|---|---|
| balcony | (none — sliding door is on living-room side) |
| bathroom | bedroom |
| **bedroom** | hallway, dressroom, bedroom-balcony, bathroom |
| bedroom-balcony | (none — opening is on bedroom side) |
| **corridor** (exterior) | entrance, living-room (Main Door is here) |
| dressroom | bedroom |
| entrance | (none — Main Door is on corridor side) |
| guy-room | hallway |
| hallway | my-bathroom, living-room, my-room, bedroom, guy-room |
| laundry | my-bathroom |
| **living-room** | balcony, hallway, corridor |
| my-bathroom | hallway, laundry |
| my-room | hallway |

### Implications for adjacency-merge logic
- **Bedroom is NOT adjacent to Living Room** → no direct merge between them. Any merge requires intermediary (hallway) and corridor timer.
- **Bedroom IS adjacent to DressRoom + Bathroom + bedroom-balcony** → these will merge with Bedroom whenever a corridor timer fires within 30 s. Couples / family in adjacent bedroom areas always collapse to 1.
- **Living Room is the open-plan hub** — directly adjacent to Hallway + Balcony + Corridor (the front entry). Plus the auto-fold pulls in Kitchen + Dining Room + Entrance via zone-name heuristic / manual map.

### Living Room sub-room fold sources
Auto-fold heuristic in `state_manager` looks for zones starting with the sub-room name. Living Room's zones include:
- `Kitchen Bar`, `Kitchen Cooking`, `Kitchen Walkway` → folds Kitchen.
- `Dining Table` → does NOT auto-fold "Dining Room" (zone name doesn't start with "Dining Room ").
- `Hallway Walkway` → does NOT auto-fold "Hallway" (Hallway has its own layout, so it's not a sub-room).

Plus the manual map adds Dining Room + Entrance as Living Room sub-rooms.

So the fold collapses up to 5 rooms (Living Room + Kitchen + Dining Room + Entrance) into 1 counted unit.

---

## 12. Today's lock-change history

Only **3 lock changes** in the entire day (1289 emits):

| time (IDT) | locked | source |
|---|---|---|
| 06:01:25 | 2 | inferred_entry |
| 11:45:05 | 1 | inferred_exit |
| 15:37:15 | 2 | inferred_entry |

Since 15:37 → locked has been **2** for ~3.5 hours straight despite:
- Main Door cycles at 18:03 + 18:04
- A peak `live=5` at 18:04:54
- Many inferred entries/exits in between

Each of those events DID trigger the stabilize-and-snapshot path (we see `state` flip to `recounting` in the data), but each snapshot landed on a low live value. Both inferred and door-driven recounts are vulnerable to the end-of-window snapshot bug.

---

## 13. Findings — final ranked list

In order of how much each contributes to the user-visible undercount (5 actual → 2 reported):

| # | issue | contribution | code location |
|---|---|---|---|
| 1 | **End-of-window snapshot** — locked count snapshots `live_count` at the moment stabilize timer expires; misses the entry peak. Today: peak 5, snapshot 2. | Largest. Single biggest improvement target. | [people_home.py:403-406](RULES/rules/people_home.py#L403-L406) |
| 2 | **Sub-room over-folding** — Kitchen + Dining Room + Entrance + Living Room fold to 1 unit, regardless of how long each sub-room has been independently active. | Significant. Caps live at small numbers when residents cluster in the open plan. | [people_home.py:282-297](RULES/rules/people_home.py#L282-L297) |
| 3 | **Architectural rooms-not-heads ceiling** — even with correct snapshot + no folds, max count = distinct active sensor rooms (today: 5). To exceed that you need `target_count` sensors or per-room overrides. | Hard ceiling. Today the peak hit 5, matching reality. So this isn't the cause TODAY but constrains future fixes. | architectural |
| 4 | **`_people_accounted_rooms` over-accumulation** — every transit marks rooms as "accounted"; today's value covers 11 rooms; discovery layer becomes blind. | Medium. Kills the only fallback for catching hidden occupants between door events. | [people_home.py:196-198](RULES/rules/people_home.py#L196-L198), [§7b conditions](RULES/rules/people_home.py#L443-L478) |
| 5 | **Perimeter recount is Main Door only** — Balcony Door open since before 18:03; people entering via balcony don't trigger recount. | Medium. Today's data: irrelevant (entries were Main Door). Future-proofing. | [people_home.py:398](RULES/rules/people_home.py#L398) |
| 6 | **Live count uses current dps state, not held `active_rooms`** — PIR sensors drop still people in 10 s; Home Activity holds them, but People Home doesn't read that hold. | Medium. Today: home_activity held 6 rooms in 19:09 emit while people_home only counted from 3-4 currently-active. | [people_home.py:255-272](RULES/rules/people_home.py#L255-L272) |
| 7 | **Adjacency merge with stale corridor evidence** — corridor timer firing means "person walked through," 30 s window allows merge; doesn't track whether two separate people now sit in the merged rooms. | Small today (Bedroom + Living Room aren't adjacent). Significant for couples in Bedroom + DressRoom. | [people_home.py:312-327](RULES/rules/people_home.py#L312-L327) |

### Why the ranking matters
Fix #1 alone, with no other changes, would have caught today's `live=5` peak and locked at 5. The user's reported "5 actual / 2 reported" gap closes entirely.

Fix #2 + #4 + #6 increase the floor of `live` between door events (so even when sensors decay, the count doesn't drop as far before the next snapshot).

Fix #5 + #7 are correctness improvements that handle edge cases (balcony entries, couples in adjacent rooms).

Fix #3 (architectural) is a separate conversation — about hardware/sensor strategy, not algorithm.

---

## 14. Hardware notes

- **Aeotec Motion Bedroom**: `dps={1: 19, motion: false}`. The "1" value here is **lux (illuminance)**, not battery — confirmed by other Aeotec sensors having same shape (`battery: 100, illuminance: <number>`). So Aeotec sensors only contribute via `motion` (PIR) — no presence-style hold, no target count.
- **Bedroom Presence (Tuya cloud)**: `dps={1: "presence"}` only. Single-value sensor, no extra fields. No target count.
- **Other Tuya local mmWave** (Living Room, Dining Room, DressRoom, Kitchen, Entrance, Corridor, Balcony, Guy Room, My BathRoom, Laundry): all expose 20+ DPS but `1` is the only presence indicator (`presence` / `none`). DPS `107` looks like `motion_amplitude`, `119` looks like `target_distance_small_cm` — neither is a target count.
- **No sensor in this house exposes `target_count`** — the architectural ceiling (#3) holds.

---

## 15. Summary for algorithm-change conversation

User-visible symptom: `people_home = 2`, actual = 5.

Primary root cause: **end-of-window snapshot bug** at [people_home.py:403-406](RULES/rules/people_home.py#L403-L406). Captured live=5 at 18:04:54, locked at 2 at 18:05:32 (38 s later, after sensors decayed).

Secondary contributors (in order): sub-room over-folding, accounted_rooms over-accumulation, Main-Door-only perimeter, current-vs-held state for live count, adjacency merge with stale evidence.

Architectural ceiling: rooms-not-heads — even with all fixes, max count = distinct active sensor rooms. Today's peak 5 matches user's count; tomorrow if 6 people cluster in 4 rooms, max = 4.

---

## 16. Cross-validation: snapshot bug across ALL door cycles today

| Cycle (IDT) | Peak live during recount | Live at snapshot (state→stable) | Locked = | Off by |
|---|---|---|---|---|
| 11:42 | 2 | 1 | **1** | -1 |
| 15:36 | 2 | 2 | 2 | 0 |
| **18:03** | **5** | 2 | **2** | **-3** |

The 11:42 cycle shows the bug independently — peak was 2 (could be 2 people walking through during exit), but the snapshot caught a single-person moment afterward, locking at 1.

The 15:36 cycle happened to land on a flat plateau (live=2 throughout) — by chance the snapshot value matched the peak.

The 18:03 cycle is the catastrophic case — undercount by 3.

→ The bug isn't a one-off. It systematically biases low whenever live count fluctuates during the stabilize window.

---

## 17. Volatility analysis — live count between door events

Pulled per-minute live count summary from 18:00 → 19:10 (the 70 min covering today's main entry + the current stuck-at-2 state):

Key observations:
- During the 18:04 entry sequence, in a single minute (18:04) live touched **5 distinct values** (1, 2, 3, 4, 5). Sensors fire and clear in rapid succession during entry.
- Between 18:05 and 18:51 (post-entry, 5 people present), live oscillated between 2 and 3 — the system saw 1-2 hidden people periodically but never sustained.
- 18:51-18:55: live dropped to 1 (probably someone moved into a sensor-blind position briefly).
- 19:01 onward: live bounced 1→2→3→4 multiple times. **At 19:08-09 live hit 4** — yet locked stayed at 2 because no door event fired.

Implication: any simple "snapshot" approach will be brittle. The right approach is a **rolling max** (or rolling p90) over a meaningful window — minutes, not seconds — to absorb sensor noise.

---

## 18. Discovery layer — works, then dies

`max(people_discovered_count)` today = **1**, only fired briefly at 15:36 (the only successful discovery all day).

Timeline:
- 15:36:32 → discovered=1 (live=2, locked=1, dynamic=2)
- 15:37:00 → discovered=1 still
- 15:37:15 → next door-event recount fired; locked moved 1 → 2; discovered reset to 0
- After that, never fires again — for 3.5 hours

Why it stopped:
- Discovery's Signal 2 (`room not in _people_accounted_rooms`) excludes any room that received a corridor transit.
- After 15:37 the residents moved around. Every room they passed through got added to accounted_rooms.
- Now `_people_accounted_rooms` covers 11 rooms (Balcony, Bedroom, Dining Room, DressRoom, Entrance, Hallway, Kitchen, Laundry, Living Room, My BathRoom, My Room).
- That's literally every counted room. **No room is eligible for discovery.**

So the discovery fallback that was supposed to compensate for the locked-count's slowness is dead in practice during a typical evening.

---

## 19. Active_rooms vs presence_rooms drift — quantified

The 19:09 emits show this directly:
- **`virtual:home_activity`** at 19:09:10: `active_rooms = [Bedroom, Dining Room, DressRoom, Hallway, Living Room, My BathRoom]` — **6 rooms** held
- **`virtual:people_home`** at 19:09:11: `occupied_rooms = [Bedroom, Dining Room, DressRoom, Kitchen, Living Room, My BathRoom]` — **6 rooms** but different membership
- But `presence_rooms` (the basis for `live=3`) only included the rooms whose sensors were **currently** firing: Bedroom, Living Room, Dining Room (folded → 2)

So Home Activity and People Home agree on ~6 occupied rooms. People Home throws away that information when computing the count and only counts currently-firing sensors.

A simple change — read `state.shared['active_rooms']` as the basis for counting instead of `state.devices` direct iteration — would have given live=4 right now (6 rooms minus Hallway transit-only and Dining Room folded into Living Room). Combined with rolling-max snapshot, locked could be 4-5 today.

---

## 20. Sensor capability re-check — no `target_count` anywhere

Re-examined every Tuya mmWave DPS and Aeotec sensor. The 20+ DPS keys on Tuya mmWave sensors are configuration knobs (sensitivity, range, hold time), telemetry (`107=motion_amplitude`, `119=target_distance_small_cm`, `102=target_distance_large_cm`), and status — none expose person count.

DPS `119` (target distance) and `107` (motion amplitude) could in principle indicate "two targets moving at different distances" — but the firmware reports a single value, not multiple targets. So the sensor IS a multi-target radar internally but exposes only its primary target.

Two paths to per-room target count:
- Replace 1-2 sensors with **Aqara FP2** (Wi-Fi mmWave with target tracking + zones; reports `target_count`).
- Replace with **LD2450 DIY module** (UART; reports up to 3 simultaneous targets with positions).

No software-only fix unlocks per-room count on existing sensors.

---

## 21. Final algorithm-impact ranking (updated)

After the volatility + discovery + drift findings:

| # | Issue | Today's contribution to undercount | Fix difficulty |
|---|---|---|---|
| 1 | **Snapshot at end of stabilize window, not max during** | -3 (5 → 2) at 18:04 cycle | tiny — replace `live_count` with rolling max in §7a |
| 2 | **Live count uses current dps, not held `active_rooms`** | -1 to -2 baseline | small — read `state.shared['active_rooms']` as floor in §4 |
| 3 | **Sub-room over-fold** | up to -3 in open-plan situations | medium — gate folding by per-sub-room sustained activity |
| 4 | **`_people_accounted_rooms` over-accumulation** | kills discovery fallback entirely after the first walk-around | small — time-decay or cap accounted_rooms (LRU) |
| 5 | **Adjacency merge with stale corridor evidence** | small (Bedroom not adj to Living Room here) | small — gate merge by sustained activity |
| 6 | **Perimeter recount = Main Door only** | not the cause TODAY (entries were Main Door) | small — add Balcony Door + BedRoom Balcony to perimeter set |
| 7 | **Architectural rooms-not-heads ceiling** | hard ceiling — fixes #1-6 still cap at distinct active sensor rooms | hardware — Aqara FP2 / LD2450 |

### Cumulative effect of fixes #1+#2+#4 (no hardware, no fold/merge changes)

Estimated post-fix behavior using today's data:
- 18:04 entry would lock at **5** (rolling max captures peak).
- Between door events, dynamic count would stay at 5 (discovery accounted_rooms wouldn't blanket-block).
- Live floor would stay at 4-5 throughout (active_rooms held set instead of current dps).

Match user expectation: **5 actual = 5 reported** post-fix.

### Cumulative effect adding #3 (no over-fold)

Slight risk of false transit counts (someone walking from Kitchen to Sofa briefly counts as 2 people). Mitigated by sustained-activity gate: only break the fold if EACH sub-room has been active > 2 × hold_s.

Net: similar accuracy in normal operation, more robust in edge cases.

### #6 (perimeter doors)

Doesn't change today's count (entries went through Main Door). But will matter on days with balcony entries — without it, those days would also undercount.

### #7 (hardware)

Only matters when actual count > distinct active sensor rooms. Currently the house has ~14 controllable rooms with sensors — hard ceiling around 10-12 people. Below that, software fixes suffice.

---

## 22. The shape of the algorithm change (read-only proposal — for user discussion)

NOT an implementation. Just describing what the rewritten `evaluate()` would look like:

1. **Source of presence_rooms**: union of currently-firing sensors AND `state.shared['active_rooms']` (Home Activity held set), minus exterior + transit rooms.
2. **Sub-room folding**: replace blanket fold with conditional fold — only fold if sub-room's sensor has been active **less than** `2 × hold_s`. Otherwise count separately.
3. **Adjacency merge**: same conditional gate — only merge if neither room has been independently active > `2 × hold_s`.
4. **Live count**: same as today (count of presence_rooms after fold + merge), but the new presence_rooms is bigger.
5. **Stabilize snapshot**: track `_recount_max_live = max(_recount_max_live, live_count)` on every event during recount window. At window end, set `locked = _recount_max_live`. Reset `_recount_max_live = 0` on next door event.
6. **Perimeter doors**: maintain `_perimeter_door_set` from `state.spatial.perimeter_doors` or a sentence; trigger recount on close of any of them.
7. **Discovery accounted_rooms**: cap to N most recent (e.g. 4), or time-decay so rooms not visited in last 5 min drop out. Allows discovery to detect new occupants when residents are mostly stationary.
8. **Architectural ceiling**: add a `max(target_count_per_room)` floor — ready for FP2/LD2450 sensors when they're added; uses `dps.target_count` if present, falls back to 1 per active room today.

---

## 23. Hold_s map — actual sensor hold times configured

From `room_device_placements.params.hold_s`:

| Sensor | Room slug (placement) | Type | hold_s |
|---|---|---|---|
| Bathroom Door | bathroom | door_sensor | 120 |
| Main Door | living-room | door_sensor | 120 |
| Aeotec Motion Bedroom | bedroom | presence (PIR) | **15** |
| Hallway Motion / Hallway 2 Motion | hallway | presence (PIR) | **15** |
| Sallon Corner Motion | living-room | presence (PIR) | **15** |
| TV Wall Corner Motion | living-room | presence (PIR) | **15** |
| Kitchen Motion (Aeotec) | living-room | presence (PIR) | **15** |
| Balcony Motion | balcony | presence (PIR) | 15 |
| Balcony presence (mmWave) | balcony | presence (mmWave) | 15 |
| Ring Doorbell | corridor | motion | 15 |
| Bedroom Presence (Tuya cloud) | bedroom | presence (mmWave) | **5** |
| Living Room Presence | living-room | presence (mmWave) | **5** |
| Dining Room Presence | living-room | presence (mmWave) | **5** |
| Kitchen Presence Sensor | living-room | presence (mmWave) | **5** |
| Entrance Presence | living-room | presence (mmWave) | **5** |
| DressRoom Presence | dressroom | presence (mmWave) | **5** |
| My Bathroom Presence | my-bathroom | presence (mmWave) | **5** |
| Guy Room Presence | guy-room | presence (mmWave) | **5** |
| Laundry Room Presence | laundry | presence (mmWave) | **5** |
| Corridor Presence | corridor | presence (mmWave) | **5** |
| My Room presence | my-room | presence (mmWave) | **5** |

**Tuya mmWave hold = 5 s.** That's very short — a still person stops being "detected" within 5 seconds. Aeotec PIRs hold 15 s. After both expire, the room appears empty even if someone is sitting there.

→ The "use Home Activity's `active_rooms` as floor" fix becomes critical: Home Activity adds `hold_off_sec=10` for motion-driven activity and `interact_window_sec=120` for switch-driven, extending the effective hold significantly.

→ Auto-stabilize calculation in [people_home.py:389-396](RULES/rules/people_home.py#L389-L396) reads `hold_s` from placements; with most sensors at 5 s, `auto_stabilize_sec = 5 + 5 = 10 s`. The `door_close_stabilize_sec = 60` knob overrides this (since `effective = max(knob, auto)`). 60 s is generous, but as we saw, even 60 s isn't long enough for the live count to settle to a steady value matching reality — sensors decay faster than residents settle.

---

## 24. Sensor placement vs `devices.room` — the open-plan area is one geographic super-room

Key discrepancy: a sensor's geographic placement (`room_device_placements.slug`) ≠ its operational room name (`devices.room`).

Open-plan area covered by `living-room` slug placement, 7 sensors physically present:

| Sensor | `devices.room` (operational) | `placement.slug` (geographic) |
|---|---|---|
| Living Room Presence | Living Room | living-room |
| Sallon Corner Motion | Living Room | living-room |
| TV Wall Corner Motion | Living Room | living-room |
| Kitchen Motion | Kitchen | living-room |
| Kitchen Presence Sensor | Kitchen | living-room |
| Dining Room Presence | Dining Room | living-room |
| Entrance Presence | Entrance | living-room |

Each of these sensors covers a different **zone** within the open-plan space:
- Sofa Entertainment, TV Wall (Living Room core)
- Kitchen Bar, Kitchen Cooking, Kitchen Walkway (Kitchen)
- Dining Table (Dining Room area)
- Entrance approach

→ The room-based count loses this resolution because all 7 sensors get bucketed into "Living Room" (after fold). **The zone-based count would be 4-7× more precise in this single space.**

---

## 25. Zones — Home Activity already tracks them, People Home ignores them

`virtual:home_activity` carries `active_zones` per emit. Today's stats:

| metric | value |
|---|---|
| `max(active_zones)` today | **8** |
| `avg(active_zones)` today | 3.4 |
| `max(active_rooms)` today | 12 |

At 19:30 the system saw **8 active zones simultaneously**: Balcony Doorway, Bathroom Walkway, Bed Area, Bedroom Doorway, Dining Table, Kitchen Bar, Living Room Doorway, Sofa Entertainment.

Of those, in the open-plan living area alone:
- Sofa Entertainment
- Dining Table
- Kitchen Bar
- Kitchen Cooking
- Living Room Doorway

= 5 distinct zones, suggesting up to 5 different people in the open plan. Today's room-based fold collapses this to 1.

In Bedroom:
- Bed Area + Bedroom Doorway = 2 simultaneous zones → likely 2 people in Bedroom (a couple in bed, or one in bed + one entering).

A **zone-based count** with sub-room aware dedupe would have given today's snapshot a count closer to 5-7 instead of 2.

---

## 26. Per-room activity intensity today

How active was each room today (count of active events):

| Room | Active events | Total events | Activity rate | Sensors |
|---|---|---|---|---|
| Dining Room | 327 | 2558 | 12.8% | 1 mmWave |
| Living Room | 314 | 2119 | 14.8% | 3 (1 mmWave + 2 PIR) |
| Kitchen | 311 | 1474 | 21.1% | 2 (1 mmWave + 1 PIR) |
| Bedroom | 213 | 596 | **35.7%** | 2 (1 mmWave + 1 PIR) |
| Guy Room | 130 | 955 | 13.6% | 1 mmWave |
| Hallway | 90 | 734 | 12.3% | 2 PIR |
| My BathRoom | 80 | 700 | 11.4% | 1 mmWave |
| Entrance | 59 | 789 | 7.5% | 2 |
| DressRoom | 58 | 309 | 18.8% | 1 mmWave |
| Balcony | 55 | 1065 | 5.2% | 2 |
| Laundry | 25 | 462 | 5.4% | 1 mmWave |
| Corridor | 18 | 62 | 29.0% | 1 mmWave |
| My Room | 16 | 32 | 50.0% | 1 mmWave |

→ The 4 hottest rooms today (Dining Room, Living Room, Kitchen, Bedroom) all had 200+ active events. Bedroom's 35.7% activity rate is consistent with sustained occupancy.

→ My Room's 50% rate but only 32 total events = sensor that fires rarely but mostly captures real activity.

→ DressRoom + My BathRoom + Hallway have moderate activity — visited but not lived in.

---

## 27. Snapshot bug — three confirmed cycles today

| Cycle | Peak live during recount | Live at snapshot moment | Locked = | Bias |
|---|---|---|---|---|
| 11:42 | 2 | 1 | 1 | -1 |
| 15:36 | 2 | 2 | 2 | 0 |
| 18:03 | **5** | 2 | **2** | **-3** |

2 of 3 cycles biased low. The bias direction is asymmetric — almost never high (sensors don't randomly fire when no one's there) but often low (sensors decay faster than people settle).

Mean bias today: -4/3 ≈ **-1.3 per cycle**.

→ A simple fix: take `max(live)` over the stabilize window instead of last value. Would have:
  - 11:42: locked = 2 (instead of 1)
  - 15:36: locked = 2 (same)
  - 18:03: locked = **5** (instead of 2) ← user's reported value matches reality

---

## 28. Discovery layer — successful once today, then dead

`max(people_discovered_count)` today = **1**. Total emits where discovery > 0 = **7** (all clustered around 15:36).

Timeline:
- 15:36:32 → discovered=1 (live=2, locked=1, dynamic=2). Discovery worked!
- 15:36:33 to 15:37:00 → still discovered=1
- 15:37:15 → next door-event recount → locked moves 1 → 2; discovered resets to 0
- 15:37:15 to 19:30+ (3.5+ hrs) → discovered stays at 0 forever, despite live regularly hitting 3-4

Why discovery dies after 15:37:
- After 15:37, residents move around. Each corridor transit adds the destination room to `_people_accounted_rooms`.
- After ~30 min of normal evening activity, every plausible counted room is in `accounted_rooms`.
- Discovery's Signal 2 filters out any room in `accounted_rooms`.
- → No room is ever a discovery candidate again until the next door-event recount.

Today, between 15:37 and 19:30 (3.5 hrs), **zero** door-event recounts cleared `accounted_rooms`. So discovery was permanently blind during the period of interest.

→ Fix: **time-decay** `accounted_rooms` (rooms not seen in last 5 min drop out), or cap to N most-recent (LRU). Keeps discovery responsive even during long no-door windows.

---

## 29. Volatility — implications for snapshot window choice

Per-minute live count summary, 18:00 → 19:10:
- 18:04 (entry): 5 distinct live values in 1 minute (1, 2, 3, 4, 5)
- 18:05-18:30 (settling): live oscillates 2-3 with occasional 4-5 spikes
- 18:35-19:10: live mostly 2 with occasional bumps to 3-4
- 19:08-19:10: peak 4 again (recent activity wave)

Interpretation:
- 1-second snapshot at any given moment is highly variable.
- 60-second window of a recount: max value catches the entry peak.
- Multi-minute rolling window: smooths out sensor noise, shows underlying occupancy.

→ Recommend: use **rolling-max over the entire stabilize window** (60+ s) for the lock snapshot. **And** maintain a separate "rolling p90 over last 5 minutes" for the floor between door events — this catches sustained presence even when individual sensors flicker.

---

## 30. Summary of new data for the algorithm conversation

What the rule has access to that it isn't using today:

1. **`state.shared['active_rooms']`** — 6 rooms held vs 3 currently firing. +3 rooms of signal.
2. **`state.shared['active_zones']`** — up to 8 zones simultaneously. Even higher resolution than rooms; explicit sub-zone discrimination.
3. **`hold_s` per placement** — already read for stabilize but could also gate the conditional fold/merge.
4. **`Home Activity`'s `last_motion_zone`** — knows which zone fired most recently; useful for transit identification.
5. **`room_device_placements`** — tells us which sensors are geographically clustered (so we know what Sub-Zone Discrimination can do).

Sensors today don't expose target_count → architectural ceiling stays at unique active sensor zones (= 8 today, plenty for a 5-person count).

Numbers to settle in algorithm changes:
- `sustained_activity_min_sec` for fold/merge gating: 2× hold_s = 10 s minimum, probably 30 s for stability
- `accounted_rooms_decay_sec`: 5 min or 10 min
- `recount_window_sec`: keep 60 s but use rolling max
- `live_floor_window_min`: 5 min rolling p90 between door events
- `perimeter_doors`: Main Door + Balcony Door + BedRoom Balcony Door (currently only Main)

---

## 31. Live snapshot — 19:46 IDT, user confirms 5 people present

User confirmed 5 people in the apartment at 19:46. System state:

| field | value |
|---|---|
| `people_home` (locked) | **2** |
| `people_count_live` | **3** |
| `people_home_dynamic` | 2 |
| `people_discovered_count` | 0 |
| `last_transition_source` | `inferred_entry` |
| `last_transition_ts` (UTC) | 2026-04-25T16:44:10 (= 19:44:10 IDT, 2 min ago) |
| `occupied_rooms` (people_home) | Bedroom, Entrance, Guy Room, Hallway, Kitchen, Living Room |

Home Activity at 19:46:11:
| field | value |
|---|---|
| `active_rooms` | Bedroom, Entrance, Guy Room, Hallway, Kitchen, Living Room, **My BathRoom** (7 rooms) |
| `active_zones` | Bathroom Walkway, Bed Area, Bedroom Doorway, Sofa Entertainment (**4 zones**) |

### Currently firing sensors (RIGHT NOW)

| Sensor | Room | Indicator | Age |
|---|---|---|---|
| Aeotec Motion Bedroom (PIR) | Bedroom | motion=true | 11 s |
| Bedroom Presence (mmWave) | Bedroom | presence | 38 s |
| Hallway Motion (PIR) | Hallway | motion=true | 15 s |
| Living Room Presence (mmWave) | Living Room | presence | 4 s |
| My Bathroom Presence (mmWave) | My BathRoom | true | 5 s |

5 sensors firing now. Folding (no Living Room sub-rooms firing right now besides Living Room itself; Hallway is transit-only). After fold + filter:
- Bedroom (Aeotec PIR + Tuya cloud both firing)
- Living Room (Living Room Presence)
- My BathRoom (My Bathroom Presence)
- Hallway → filtered as transit room

→ presence_rooms after filter = [Bedroom, Living Room, My BathRoom] = 3 → live = 3 ✓

### Cross-check against user's 5

5 people. We see 3 distinct counted rooms + Hallway (transit) + Guy Room held. So 4 rooms with people. Two people must be either:
- Both in Bedroom (couple — Bed Area + Bedroom Doorway zones suggest 2 there)
- Both in Living Room (sofa)
- One in Guy Room (held by Home Activity, not currently firing → invisible to People Home)
- One in Kitchen (held by Home Activity, not currently firing → invisible)

The 19:46 home_activity emit shows **4 active zones** including Bed Area + Bedroom Doorway (2 zones in Bedroom). That's strong evidence of 2 people in Bedroom right now. With sub-zone-aware counting, count would be 4-5 instead of 3.

### What the rule throws away

| Held by Home Activity / not current | Lost when computing live |
|---|---|
| Guy Room (in active_rooms but sensor quiet now) | -1 |
| Kitchen (in active_rooms but sensor quiet) | -1 |
| Bed Area + Bedroom Doorway = 2 zones in Bedroom | -1 (only counts as 1 room) |

→ True count ≈ 5; rule reports 2 (locked) / 3 (live). Discovery layer dead (`people_discovered_count = 0`).

### Pattern — same undercount as 18:04 cycle

Same shape, different rooms:
- Sensors firing right now show ~3 rooms.
- Recent sensor activity (held in Home Activity) covers 7 rooms.
- Some rooms have multi-zone simultaneous activity (Bedroom: Bed Area + Bedroom Doorway).
- The locked count hasn't refreshed because the only door event since 15:37 was the 18:03/18:04 cycle, and that snapshotted at 2.

### Time since last lock vs active people

Last lock change: **15:37:15** (locked = 2). It's now 19:46. The lock is **4 hours, 9 minutes stale**. During that span, peak `live` was 5; right now it's 3; the discovery layer never ran (accounted_rooms over-accumulated). Reality: 5 people stayed home this whole time.

→ A simple "auto-bump locked = max(locked, live) over rolling 5 min window" would have caught the 18:04 peak of 5 and held there. Locked would still be 5 right now even though live is bouncing 2-3.

---

## 32. The "rolling max" idea, applied retroactively to today's data

Hypothetical: at every event, set `locked_proposal = max(locked, max_live_in_last_5_min)`. Walk through today's data:

| time | event | locked_proposal would be |
|---|---|---|
| 06:01 | initial | 2 |
| 11:42 cycle | peak live=2 | 2 |
| 11:45 | inferred_exit drops to 1 | 1 (max-window now sees only 1 for 5 min) |
| 15:36 cycle | peak live=2 | 2 |
| 18:04:54 | peak live=5 | **5** |
| 18:05-18:30 | live oscillating 2-3 | 5 (still in max-window) |
| 18:30+ | rolling 5-min max settles to 3-4 | drops to 3-4 |
| 19:09 | live hits 4 | 4 |
| 19:46 (now) | live = 3 | 3-4 |

→ Locked at 19:46 would be **3-4** instead of 2. Closer but still wrong by 1-2.

That's because rolling max alone doesn't fix the architectural ceiling (rooms not heads). We'd need zone-based or sub-zone discrimination to get 5 from binary mmWave sensors.

### Combined: rolling max + zone-based counting

If we count `len(set(active_zones)) - {transit, exterior}` instead of rooms:
- Right now: 4 zones (Bathroom Walkway, Bed Area, Bedroom Doorway, Sofa Entertainment) - 0 transit zones
- After dedupe pairs (Bed Area + Bedroom Doorway likely same person, since both in Bedroom but adjacent): 3 zones
- Plus the held-but-not-currently-active rooms (Guy Room + Kitchen) gives us +2

→ Estimated count ≈ 5 ✓

This combination would match user's reality.

---

## 33. Concrete inputs for algorithm-change discussion

When we discuss algorithm changes, here's the data I have ready:

1. **Snapshot bug fix (rolling max during stabilize window)** — would have locked at 5 instead of 2 today.
2. **Zone-based presence count instead of room-based** — would have caught the 2-people-in-Bedroom case via Bed Area + Bedroom Doorway zones.
3. **Held rooms as floor (use Home Activity's `active_rooms`)** — would have included Guy Room + Kitchen this minute.
4. **Conditional fold (only when sub-zone activity is brief)** — for the open-plan space.
5. **`accounted_rooms` LRU/decay** — would have allowed discovery to fire after 15:37.
6. **Perimeter doors expanded** — Balcony Door (open right now); future-proof.
7. **Hardware ceiling** — current Tuya mmWave caps at unique active zones (8 max today). Reality 5-12 people. No software fix above that without target-count sensors.

Each of these is independently shippable; none requires a rewrite. The biggest single win is #1 (snapshot bug). #2 + #3 together close most of the remaining gap.

---

## 34. Sensor flap rates today — how unstable each sensor is

Flap rate = % of consecutive sensor events where the active/inactive state changed. High flap = noisy sensor that toggles frequently. Low flap = stable readings.

| Sensor | Room | Flips today | Total events | Flip % |
|---|---|---|---|---|
| **Kitchen Motion** (Aeotec PIR) | Kitchen | 314 | 355 | **88.5%** |
| **Bedroom Presence** (Tuya cloud) | Bedroom | 218 | 286 | **76.2%** |
| Sallon Corner Motion (PIR) | Living Room | 211 | 337 | 62.6% |
| Aeotec Motion Bedroom (PIR) | Bedroom | 141 | 316 | 44.6% |
| TV Wall Corner Motion (PIR) | Living Room | 96 | 225 | 42.7% |
| DressRoom Presence | DressRoom | 109 | 309 | 35.3% |
| Hallway Motion (PIR) | Hallway | 183 | 529 | 34.6% |
| Kitchen Presence Sensor | Kitchen | 308 | 1125 | 27.4% |
| Guy Room Presence | Guy Room | 259 | 966 | 26.8% |
| Dining Room Presence | Dining Room | 634 | 2605 | 24.3% |
| My Bathroom Presence | My BathRoom | 156 | 719 | 21.7% |
| Living Room Presence | Living Room | 304 | 1600 | **19.0%** |
| Entrance Presence | Entrance | 122 | 803 | 15.2% |
| Balcony presence | Balcony | 78 | 591 | 13.2% |
| Laundry Room Presence | Laundry | 50 | 462 | 10.8% |

### Implications

- **Kitchen Motion (Aeotec PIR) is essentially noise** — 88.5% of its events are state flips. A 1-second snapshot of "active" is not trustworthy. It only becomes meaningful averaged over 30+ seconds.
- **Bedroom Presence (Tuya cloud, hold_s=5)** also flips very fast — likely because of the short hold and someone moving in bed. The Aeotec PIR (hold_s=15) in the same room is more stable.
- **Living Room Presence is the most reliable mmWave** in the whole house (19% flip rate, 1600 events). Strong primary indicator for the open plan.
- **Dining Room Presence** is also reliable (24.3% flip with 2605 events) — high traffic but stable readings.

→ For the algorithm, "sustained activity" gates need to outlast the sensor's typical flip cycle. A naive "active for 2 × hold_s = 10 s" gate would let through Kitchen Motion noise. **Effective sustained-activity threshold ≈ 30-60 s** for high-flip sensors.

---

## 35. Open-plan concurrent-activity prevalence

Today: 377 minutes total, 271 minutes with any open-plan activity.

| Concurrent state | Minutes | % of "open plan active" |
|---|---|---|
| Living Room only | 59 | 21.8% |
| 2 of {LR, Kitchen, Dining} active simultaneously | 212 | **78.2%** |
| All 3 (LR + Kitchen + Dining) active simultaneously | **139** | **51.3%** |

**For 51% of the day's open-plan-active minutes, all 3 sub-rooms had simultaneous sensor activity.** The rule folded all of those to 1 person.

Even allowing for "one person walking from Kitchen to Sofa fires both briefly," the data shows sustained 3-room concurrence — far more consistent with multiple distinct people than transit.

→ The conditional-fold idea (fold only if sub-room activity is < 30 s) wouldn't fold during these 139 minutes. Count would correctly be 2-3 in the open plan during half the day.

---

## 36. Daily summary — held vs counted gap

For the 349 minutes today where both Home Activity and People Home emitted:

| metric | value |
|---|---|
| **Avg rooms held by Home Activity above live count** | **+2.11** |
| Avg rooms held above locked count | +2.04 |
| Avg zones held above locked count | +1.23 |
| Peak rooms held above live | 10 |
| Peak rooms held above locked | 10 |
| Peak zones held above locked | 7 |

→ On average, all day, the system **had +2.04 more rooms of evidence than the locked count.** The information was already in the running state — People Home just wasn't using it.

→ The "use Home Activity's `active_rooms` as a floor" change alone would have lifted the locked count by ~2 on average across the day. Combined with the snapshot-bug fix, today's minute-by-minute count would have averaged roughly the user's reality.

---

## 37. Zone dwell pattern — distinguishing transit from "lived in"

Top zones today by emit-prevalence (proxy for dwell time):

| Zone | Appears in N emits | % of emits | Interpretation |
|---|---|---|---|
| Sofa Entertainment | 1698 | 66.4% | Lived-in (TV/sofa zone) |
| Dining Table | 1628 | 63.6% | Lived-in (dining zone) |
| Bathroom Walkway | 1504 | 58.8% | Lived-in (next to bathroom) |
| Kitchen Bar | 1050 | 41.0% | Lived-in (cooking + bar stool) |
| Bedroom Doorway | 895 | 35.0% | Mixed (transit + lingering) |
| Bed Area | 700 | 27.4% | Lived-in (bed) |
| Kitchen Cooking | 502 | 19.6% | Activity-driven (cooking only) |
| Balcony Doorway | 410 | 16.0% | Mixed transit |
| Living Room Doorway | 146 | 5.7% | Pure transit |
| Entrance Walkway | 94 | 3.7% | Pure transit |
| BBQ Area | 51 | 2.0% | Rare-use |
| My BathRoom Doorway | 12 | 0.5% | Pure transit |

→ Zones with > 25% emit-prevalence are "lived in" (people sit/stand there for sustained periods). Zones < 10% are "transit" (only fired in passing).

→ The discovery layer should weight **lived-in zones** higher than transit zones. Today's logic doesn't differentiate — every corridor transit through any zone goes into `_people_accounted_rooms`, which kills discovery uniformly.

---

## 38. Refined algorithm primitives — what we now have

After all this data, here are the primitives the rule could/should use:

### Reliable signals (high info, low noise)
- `active_zones` from Home Activity — per-zone resolution, already deduplicated by Home Activity's hold logic
- `Living Room Presence` (mmWave, 19% flip) — strongest single sensor for open plan
- `Dining Room Presence` (mmWave, 24% flip) — strongest sub-zone sensor
- Lived-in zones (Sofa Entertainment, Dining Table, Bed Area) when they're active for ≥ 30 s
- `state.shared['active_rooms']` (held by Home Activity) — 2+ rooms more than current dps state on average

### Noisy signals (use carefully, never on a 1-event snapshot)
- Kitchen Motion (88% flip), Bedroom Presence (76% flip), Sallon Corner Motion (62% flip) — these need 30-60s sustained-activity gating before they should be trusted
- Adjacency-merge with stale corridor evidence — the corridor timer fires on any transit but doesn't decay smartly

### Information already in `state.spatial` (set up at boot, refreshed on layout change)
- `subrooms` map (Kitchen → living-room, Dining Room → living-room via manual)
- Adjacency graph (door-based)
- Per-placement `hold_s`
- Zone polygons + per-zone room

### Information NOT in current rule logic
- Zone-level concurrent activity (we have `active_zones` but ignore it for counting)
- Per-sensor flap rate / reliability score (no metric collected)
- Lived-in vs transit classification (no metric — could be derived from emit-prevalence over 7 days)
- Door-event "type" (entry vs exit vs both) — currently treated identically

---

## 39. Test scenarios for the rewritten algorithm

When we ship the algorithm changes, these scenarios from today's data should produce the right answer:

| Scenario | Input | Today's output | Target output |
|---|---|---|---|
| 18:04 entry of 5 people | live peaked at 5 during 60 s recount, decayed to 2 by snapshot | locked = 2 | locked = 5 |
| 19:30 — 5 people present, 4 zones active | 8 zones held by Home Activity, 4 active right now | live = 3, locked = 2 | live ≥ 4, locked ≥ 4 |
| Quiet evening, 2 people on sofa | 1-2 zones consistently active, low flip | live = 1-2 | live = 2 (Sofa Entertainment + Bed Area both active) |
| Person walking Kitchen → Sofa | Kitchen Bar zone fires for 5 s, then Sofa Entertainment fires | (today: 1 person) | (target: 1 person — sustained-activity gate filters the brief Kitchen fire) |
| Couple in Bed Area, one walks to bathroom | Bed Area + Bathroom Walkway both held >30 s | (today: 1, since Bedroom folds + Bathroom is sub-room) | (target: 2 — both lived-in zones sustained) |
| Child in Guy Room sleeping (PIR sensor only fires every 10-30 min) | Guy Room shows brief active + long quiet | (today: drops out within 5-15 s of last fire) | (target: held by Home Activity's 30-min away threshold; counted as 1 person there) |

---

## 40. Ready for algorithm-change discussion

Investigation now covers:
- Current state (§1-2)
- Live count walk-through (§3)
- Knob values (§4)
- Findings ranked (§5, §13, §21)
- Smoking gun snapshot bug (§9)
- Lock change history (§12)
- Spatial graph (§11)
- Cross-cycle validation (§16, §27)
- Volatility analysis (§17, §29)
- Discovery dead post-15:37 (§18, §28)
- Sensor capability — no target_count (§20)
- Algorithm proposal shape (§22)
- Hold_s map (§23)
- Open-plan concentration (§24, §35)
- Zone signal richness (§25, §37)
- Per-room activity (§26)
- Live snapshot at 19:46 (§31)
- Retroactive walkthrough (§32)
- Sensor flap rates (§34)
- Daily held-vs-counted gap (§36)
- Refined primitives (§38)
- Test scenarios (§39)

Concrete decisions waiting for user:
1. Snapshot fix: rolling max during stabilize window? Other shape (median, p90, EMA)?
2. Use `active_rooms` as floor — yes/no?
3. Use `active_zones` as the basis for counting (zone-based) — yes/no? Or keep room-based with smarter folding?
4. Conditional fold gate — `2 × hold_s` or 30 s or 60 s?
5. `accounted_rooms` decay — time-based (5 min) or LRU (cap N)?
6. Perimeter doors — sentence-defined or hardcoded list?
7. Lived-in vs transit zones — derive from emit-prevalence or hardcode?
8. Do we want a manual `room_capacity_overrides` knob as a stop-gap?
9. Hardware change — pursue Aqara FP2 / LD2450 for Living Room + Bedroom?

---

*Investigation log: 40 sections complete.*
