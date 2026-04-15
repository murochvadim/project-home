---
description: Create, edit, list, or remove a room's outer shape + grid geometry (foundation for future layout layers — zones, device placement, doorways).
user-invocable: true
---

# /room-shape — Room Shape & Grid Geometry

You are defining the physical bounds of a room: its outer boundary, real-world dimensions in meters, and the grid resolution that later layers (zones, device positions, doorways) snap to.

This is the foundation of the spatial model. **Intentionally no zones, devices, or cross-room connections here** — those are separate skills that plug into the same `dashboard_settings` key once shapes exist.

> **Visual editor now exists**: the Living Room Layout tab (`BOILER/dashboard/public/living-room.html`) is a click-and-draw SVG editor that writes to the same `room_layouts.<slug>` key — including walls, windows, doors, sliding doors, dividers, and `shared_with`. Prefer the visual editor for authoring new rooms. This skill remains the authority for: **List** (summary across all rooms), **Audit** (consistency checks), **Remove** (delete a layout cleanly), and chat-based authoring when you'd rather type coordinates than click.

## Storage

All room data lives under `dashboard_settings` keys of the form `room_layouts.<slug>`. This skill writes ONLY the `shape`, `grid`, and `orientation` fields; future skills will add `zones`, `devices`, `doorways` without touching these.

Room slugs come from the `rooms` table — they are the source of truth. Use the existing slug exactly; never invent one.

## Step 0: Action

Ask the user which action:
- **Create** — define shape for a room that has no layout yet
- **Edit** — modify an existing shape (keeps any zones/devices/doorways already defined by other skills)
- **List** — show a table of rooms + whether they have a shape
- **Remove** — delete the shape portion of a room's layout (warns if zones/devices/doorways exist for that room, since they will be orphaned)

### List flow

```sql
SELECT r.name, r.slug,
       (ds.value ? 'shape') AS has_shape,
       (ds.value ? 'zones') AS has_zones,
       (ds.value ? 'devices') AS has_devices
FROM rooms r
LEFT JOIN dashboard_settings ds ON ds.key = 'room_layouts.' || r.slug
ORDER BY r.name
```

Render as a markdown table: Room | Slug | Shape | Zones | Devices. Done — no further prompts.

### Remove flow

1. Show the List table
2. AskUserQuestion: which room to remove the shape from
3. If `zones`/`devices`/`doorways` exist on that key, WARN: "this room has other layout data — removing the shape will leave that data orphaned (dimensions unknown). Remove anyway? (yes/no)"
4. On yes: `UPDATE dashboard_settings SET value = value - 'shape' - 'grid' - 'orientation' WHERE key = 'room_layouts.<slug>'`
5. If after removal the value is `{}`, delete the row entirely

## Step 1: Pick room (Create / Edit)

Query:
```sql
SELECT r.name, r.slug,
       (ds.value ? 'shape') AS has_shape
FROM rooms r
LEFT JOIN dashboard_settings ds ON ds.key = 'room_layouts.' || r.slug
ORDER BY r.name
```

For **Create**: offer only rooms where `has_shape = false`. If the user picked **Create** but all rooms already have shapes, switch to Edit flow automatically and tell them.

For **Edit**: offer only rooms where `has_shape = true`. Same auto-switch if none.

Store `<slug>` and `<name>` for later.

## Step 2: Shape type

AskUserQuestion:
- **Rectangle** — defined by width_m + length_m (covers 90%+ of rooms, fastest)
- **Polygon** — defined by a sequence of (x_m, y_m) vertices (for L-shapes, trapezoids, irregular rooms)

### Rectangle path (Step 2a)

Ask:
- `width_m` (float, meters along the X axis) — typical 3 to 8
- `length_m` (float, meters along the Y axis) — typical 3 to 8

Validate: both > 0.5, both < 25 (sanity bounds — warn if outside).

Shape JSON:
```json
{"type": "rect", "width_m": <W>, "length_m": <L>}
```

### Polygon path (Step 2b)

Ask for vertices one at a time in clockwise order, starting from the south-west corner. Each vertex is `(x_m, y_m)` with origin at the bottom-left of the enclosing bounding box.

Loop:
- AskUserQuestion for the next vertex as "x,y" string (e.g., `0,0` then `6,0` then `6,3` ...)
- Allow "done" when at least 3 vertices entered
- After each vertex, show the running list

Validate:
- ≥ 3 vertices
- No duplicate consecutive vertices
- Polygon is simple (non-self-intersecting) — basic check: no edge crossing
- All x, y ≥ 0 (origin at SW corner)

Shape JSON:
```json
{"type": "polygon", "vertices": [[0,0],[6,0],[6,3],[4,3],[4,4],[0,4]]}
```

Also compute the bounding box (`max(x)` → `width_m`, `max(y)` → `length_m`) and store these alongside for convenience — future layers use them to compute grid size.

## Step 3: Grid resolution

AskUserQuestion for `cell_m` (meters per grid cell). Common values:
- **0.5** (default) — good balance, ~half a tile of flooring
- **0.3** — fine resolution, ideal for sensors with narrow coverage
- **1.0** — coarse, fine for whole-room zones only

Auto-compute from shape bounding box:
```
cols = ceil(width_m  / cell_m)
rows = ceil(length_m / cell_m)
```

Show to user for sanity: "6.0m × 4.0m at 0.5m/cell → 12 × 8 cells = 96 addressable positions". Warn if cols * rows > 2500 (likely too fine) or < 16 (likely too coarse).

Grid JSON:
```json
{"cell_m": 0.5, "cols": 12, "rows": 8}
```

## Step 4: Orientation (optional)

AskUserQuestion: "Where is north on the grid?" Options: `top`, `bottom`, `left`, `right`, `skip`.

If not `skip`, also ask: "Where is the main entrance / primary door?" Same 4 options.

Orientation helps the future `/room-scene` skill describe positions in words ("entrance on south wall", "window facing east") — that language is far more useful for AI than raw x,y coordinates.

Orientation JSON (omitted entirely if user skipped):
```json
{"north": "top", "main_entrance": "south"}
```

## Step 5: ASCII preview + JSON review

Render the shape to chat as an ASCII grid so the user can sanity-check:

```
12 × 8 cells (6.0m × 4.0m)
. . . . N . . . . . . .    ← north (orientation)
# # # # # # # # # # # #
# . . . . . . . . . . #
# . . . . . . . . . . #
# . . . . . . . . . . #    (interior of rectangle)
# . . . . . . . . . . #
# . . . . . . . . . . #
# # # # # # # # # # # #
. . . . E . . . . . . .    ← main entrance (orientation)
```

For polygons, fill only the inside of the polygon with `.` and the boundary with `#`, leave outside blank.

Print the full JSON that will be saved:

```json
{
  "shape": {...},
  "grid":  {...},
  "orientation": {...}
}
```

## Step 6: Confirm & save

AskUserQuestion: "Save this shape for <room name>? (yes/no)"

On yes, save to Postgres via MCP. The SQL must preserve any zones/devices/doorways that already exist on the same key (Edit flow case) — only touch the three fields this skill owns:

```sql
INSERT INTO dashboard_settings (key, value, updated_at)
VALUES ('room_layouts.<slug>', %s::jsonb, NOW())
ON CONFLICT (key) DO UPDATE SET
  value      = dashboard_settings.value
               || jsonb_build_object(
                    'shape',       %s::jsonb,
                    'grid',        %s::jsonb,
                    'orientation', %s::jsonb),
  updated_at = NOW()
```

(If `orientation` was skipped, remove it from the update so any previous orientation is preserved. Use `value - 'orientation'` if you need to explicitly clear it.)

## Step 7: Next steps

After a successful save, tell the user:
- Run `/room-shape list` to see the updated table.
- Run `/room-shape create` on the next room to build up the full house.
- Once all rooms have shapes, the next logical skill is `/room-zones` (to be written — adds named regions inside rooms) or `/room-scene` (to be written — AI serialization).

## Never do

- Don't write to `devices`, `zones`, or `doorways` fields — those belong to future skills.
- Don't invent a slug. The `rooms` table is the source of truth.
- Don't skip the validation in Step 2 — a non-simple polygon corrupts downstream layers.
- Don't run destructive updates without the explicit Step 6 "yes".

## Scope boundaries

This skill intentionally stops at geometry. When the user asks "can I also place a device here?" or "how do I mark the entrance zone?" — answer clearly that these will be handled by follow-up skills (`/room-devices`, `/room-zones`) once they exist, and do NOT try to extend this skill to cover them.
