"""Regenerate BALCONY/pages.jsonl from pages_backup.jsonl with the current
4-button page-1 design (GATES / BARRIER / LIGHT 1 / LIGHT 2).

Workflow:
  python BALCONY/build_pages.py
    -> writes BALCONY/pages_new.jsonl
  Then upload to the panel:
    curl -X DELETE http://192.168.1.141/edit?path=/pages.jsonl
    python -c "import requests; \
               requests.post('http://192.168.1.141/edit', \
                 files={'data':('/pages.jsonl', open('BALCONY/pages_new.jsonl','rb'))})"
  Reboot the panel:
    curl -X POST http://192.168.1.141/reboot
"""
import re, json, sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC  = ROOT / 'pages_backup.jsonl'
DST  = ROOT / 'pages_new.jsonl'

with open(SRC, encoding='utf-8') as f:
    lines = f.readlines()

# Strip every active page-1 line except the bg-color (id:0) anchor.
keep, removed = [], 0
for line in lines:
    s = line.strip()
    if s.startswith('//') or s == '':
        keep.append(line); continue
    m = re.match(r'\{"page":1,"id":(\d+),', s)
    if m and int(m.group(1)) != 0:
        removed += 1
        continue
    keep.append(line)

# Icons baked into the existing OpenHASP font, render at text_font=48
ICON_CAR  = ''  # car
ICON_LAMP = ''  # lightbulb / lamp

# Symmetric layout: 50 px top + 50 px bottom margins (above the global nav row).
BTN_W, BTN_H = 225, 140
specs = [
    # x, y, btn_id, icon_id, name_id, name, icon, dim_bg
    # Brightened 2026-05-01 — panel is on the balcony in direct sun, dim colors
    # were washing out. Mid-tone vivid colors hold up under daylight.
    (10,  50, 110, 111, 112, 'GATES',   ICON_CAR,  '#1a4775'),  # mid blue
    (245, 50, 120, 121, 122, 'BARRIER', ICON_CAR,  '#471a75'),  # mid purple
    (10, 220, 130, 131, 132, 'LIGHT 1', ICON_LAMP, '#1a7547'),  # mid green
    (245,220, 140, 141, 142, 'LIGHT 3', ICON_LAMP, '#75471a'),  # mid amber
]
TXT = '#ffffff'

new_objs = []
for x, y, bid, iid, nid, name, icon, dim_bg in specs:
    # Toggle button — bg flips to theme color2 on @checked (uniform across panel)
    new_objs.append(json.dumps({
        "page": 1, "id": bid, "obj": "btn",
        "x": x, "y": y, "w": BTN_W, "h": BTN_H,
        "toggle": True, "radius": 18, "border_width": 0,
        "bg_color": dim_bg, "bg_grad_color": dim_bg,
    }, ensure_ascii=False, separators=(',', ':')))
    # Icon label — click=false so taps reach the button below
    new_objs.append(json.dumps({
        "page": 1, "id": iid, "obj": "label",
        "x": x, "y": y + 15, "w": BTN_W, "h": 60,
        "text": icon, "text_font": 48, "align": 1, "text_color": TXT,
        "click": False,
    }, ensure_ascii=False, separators=(',', ':')))
    # Name label — same click=false
    new_objs.append(json.dumps({
        "page": 1, "id": nid, "obj": "label",
        "x": x, "y": y + 85, "w": BTN_W, "h": 40,
        "text": name, "text_font": 24, "align": 1, "text_color": TXT,
        "click": False,
    }, ensure_ascii=False, separators=(',', ':')))

# Insert after the page-1 bg-color anchor
final = []
inserted = False
for line in keep:
    final.append(line)
    if not inserted and line.strip() == '{"page":1,"id":0,"bg_color":"#111"}':
        final.append('\n//---- Page 1 v5: 4 buttons, icon+text, taps fall through to btn ----\n')
        for o in new_objs:
            final.append(o + '\n')
        final.append('\n')
        inserted = True

if not inserted:
    print('FATAL: page-1 anchor not found in pages_backup.jsonl'); sys.exit(1)

with open(DST, 'w', encoding='utf-8', newline='\n') as f:
    f.writelines(final)

data = open(DST, 'rb').read()
print(f'wrote {DST.name}: bytes={len(data)} non-ascii={sum(1 for b in data if b > 127)} (expect 18)')
print(f'  removed {removed} old page-1 objects, added {len(new_objs)} new')
