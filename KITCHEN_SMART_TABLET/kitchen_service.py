#!/usr/bin/env python3
"""
Kitchen Service — LXC 113 (192.168.1.208), port 8772.

Serves the fridge food/shopping-list PWA + a DATA-ONLY CRUD API, laptop-independent.
Mirrors panel_service.py / bobo_game_service.py (same pool + q() + static + _nocache),
but has NO MQTT / no device control — pure Postgres CRUD. Fronted by Caddy for HTTPS
(the barcode camera needs a secure context). Postgres on LXC 102 via TRUST AUTH
(192.168.1.0/24 — no password).

Static: the PWA from ./kitchen/ (index.html + kitchen.js/css + manifest).
API:
  GET  /health
  GET  /api/kitchen/products            -> active catalog (add ?all=1 for inactive too)
  POST /api/kitchen/products            -> upsert one product (id present = update), RETURNING
  POST /api/kitchen/products/delete     -> soft-delete (active=false)
  POST /api/kitchen/products/<id>/photo -> upload a product photo (multipart file -> <id>.jpg on disk)
  DEL  /api/kitchen/products/<id>/photo -> remove the product photo (file + photo_path)
  GET  /media/<file>                    -> serve a product photo (cached; NOT no-cache)
  GET  /api/kitchen/categories          -> managed Hebrew categories (sort_order = tablet page order)
  POST /api/kitchen/categories          -> upsert one category (id present = update)
  POST /api/kitchen/categories/delete   -> soft-delete (active=false)
  POST /api/kitchen/categories/reorder  -> set sort_order from an ordered id list
  POST /api/kitchen/amounts             -> set קצת/בינוני/הרבה buy amounts on a product
  POST /api/kitchen/stock               -> set qty_on_hand / low_stock_threshold on a product
  POST /api/kitchen/stock/check-missing -> add at/below-threshold products to the active list
  GET  /api/kitchen/list                -> the active shopping list + items (+ product unit/stock/low)
  POST /api/kitchen/list/add            -> add an item (product_id bumps qty if already on the list)
  POST /api/kitchen/list/qty            -> set an item's qty (0 = remove)
  POST /api/kitchen/list/check          -> toggle an item checked
  POST /api/kitchen/list/remove         -> delete an item
  GET  /api/kitchen/barcode/<code>      -> Open Food Facts lookup (non-Chinese), cache-aware

Runs as systemd service kitchen-service.service. No secret needed (trust-auth DB).
"""
import json, logging, re, time, html
from pathlib import Path
import psycopg2, psycopg2.extras, psycopg2.pool
import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

PORT       = 8772
STATIC_DIR = str(Path(__file__).resolve().parent / 'kitchen')
MEDIA_DIR  = Path(__file__).resolve().parent / 'product_media'   # per-product photos (<id>.jpg)
MEDIA_DIR.mkdir(exist_ok=True)
DB_HOST    = '192.168.1.219'
DB_NAME    = 'home_data'
DB_USER    = 'postgres'          # trust auth from 192.168.1.0/24 — no password

# ── DB pool + q() (identical to panel_service.py / bobo_game_service.py) ──
_pool = None
def _get_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            1, 6, host=DB_HOST, dbname=DB_NAME, user=DB_USER,
        )
    return _pool

def q(sql, params=None, fetch='all'):
    pool = _get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or ())
            row = None
            if fetch == 'all':
                row = cur.fetchall()
            elif fetch == 'one':
                row = cur.fetchone()
            conn.commit()
            return row
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)

def _err(e):
    log.exception('kitchen-service error')
    return jsonify({'error': str(e)}), 500

# ── static (the PWA) ───────────────────────────────────────────────
def _nocache(resp):
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/')
def index():
    return _nocache(send_from_directory(STATIC_DIR, 'index.html'))

# product photos — served with a real cache (NOT no-cache); clients bust with ?v=<updated_at>.
# Declared before the catch-all so it isn't shadowed (Flask picks the more specific rule anyway).
@app.route('/media/<path:fn>')
def media_file(fn):
    resp = send_from_directory(str(MEDIA_DIR), fn)
    resp.headers['Cache-Control'] = 'max-age=300'
    return resp

@app.route('/<path:fn>')
def static_file(fn):
    return _nocache(send_from_directory(STATIC_DIR, fn))

# ── health ─────────────────────────────────────────────────────────
@app.route('/health')
def health():
    return jsonify({'ok': True, 'service': 'kitchen-service', 'port': PORT})

# ── products (catalog) ─────────────────────────────────────────────
@app.route('/api/kitchen/products')
def products_list():
    try:
        sql = ("SELECT p.*, c.name AS category_name, c.emoji AS category_emoji "
               "FROM kitchen_products p LEFT JOIN kitchen_categories c ON c.id = p.category_id")
        if request.args.get('all') != '1':
            sql += " WHERE p.active IS NOT FALSE"
        sql += " ORDER BY p.sort_order, p.name"
        return jsonify(q(sql))
    except Exception as e:
        return _err(e)

def _amount_defaults(unit):
    u = (unit or '').lower()
    if u in ('kg', 'l'):
        return (0.5, 1, 2, 3)       # weight/volume → fractional
    if u in ('piece', 'tray'):
        return (1, 3, 6, 10)        # תבנית counts like יחידה
    return (1, 2, 4, 6)            # pack/bottle/etc

@app.route('/api/kitchen/products', methods=['POST'])
def products_upsert():
    try:
        b = request.get_json(force=True, silent=True) or {}
        name = (b.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name required'}), 400
        all_year = b.get('season_all_year')
        all_year = True if all_year is None else bool(all_year)
        p = {
            'name': name,
            'name_en': b.get('name_en'),
            'category_id': b.get('category_id'),
            'emoji': b.get('emoji'),
            'unit': b.get('unit') or 'piece',
            'price': b.get('price'),
            'calories_per_unit': b.get('calories_per_unit'),
            'nutri_score': b.get('nutri_score'),
            'health_score': b.get('health_score'),
            'barcode': b.get('barcode'),
            'notes': b.get('notes'),
            'sort_order': b.get('sort_order') or 0,
            'allergens': json.dumps(b.get('allergens') or []),
            'season_all_year': all_year,
            'season_start_month': None if all_year else b.get('season_start_month'),
            'season_end_month': None if all_year else b.get('season_end_month'),
        }
        pid = b.get('id')
        if pid:
            row = q("""UPDATE kitchen_products SET
                         name=%(name)s, name_en=%(name_en)s, category_id=%(category_id)s, emoji=%(emoji)s,
                         unit=%(unit)s, price=%(price)s, calories_per_unit=%(calories_per_unit)s,
                         nutri_score=%(nutri_score)s, health_score=%(health_score)s, barcode=%(barcode)s,
                         notes=%(notes)s, sort_order=%(sort_order)s, allergens=%(allergens)s::jsonb,
                         season_all_year=%(season_all_year)s, season_start_month=%(season_start_month)s,
                         season_end_month=%(season_end_month)s, updated_at=now()
                       WHERE id=%(id)s RETURNING *""",
                    {**p, 'id': pid}, fetch='one')
        else:
            p['amount_little'], p['amount_medium'], p['amount_lots'], p['amount_extra'] = _amount_defaults(p['unit'])
            row = q("""INSERT INTO kitchen_products
                         (name,name_en,category_id,emoji,unit,price,calories_per_unit,nutri_score,
                          health_score,barcode,notes,sort_order,allergens,
                          season_all_year,season_start_month,season_end_month,
                          amount_little,amount_medium,amount_lots,amount_extra)
                       VALUES (%(name)s,%(name_en)s,%(category_id)s,%(emoji)s,%(unit)s,%(price)s,
                          %(calories_per_unit)s,%(nutri_score)s,%(health_score)s,%(barcode)s,
                          %(notes)s,%(sort_order)s,%(allergens)s::jsonb,
                          %(season_all_year)s,%(season_start_month)s,%(season_end_month)s,
                          %(amount_little)s,%(amount_medium)s,%(amount_lots)s,%(amount_extra)s)
                       RETURNING *""", p, fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/products/delete', methods=['POST'])
def products_delete():
    try:
        pid = (request.get_json(force=True, silent=True) or {}).get('id')
        if not pid:
            return jsonify({'error': 'id required'}), 400
        q("UPDATE kitchen_products SET active=false, updated_at=now() WHERE id=%s", (pid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

# ── product photo (one <id>.jpg per product on this LXC's own disk) ─
@app.route('/api/kitchen/products/<int:pid>/photo', methods=['POST'])
def product_photo_set(pid):
    try:
        exists = q("SELECT id FROM kitchen_products WHERE id=%s", (pid,), fetch='one')
        if not exists:
            return jsonify({'error': 'product not found'}), 404
        f = request.files.get('file')
        if not f or not f.filename:
            return jsonify({'error': 'file required'}), 400
        if not (f.mimetype or '').startswith('image/'):
            return jsonify({'error': 'not an image'}), 400
        blob = f.read()
        if len(blob) > 2 * 1024 * 1024:                      # ~2 MB ceiling (client sends a 400px JPEG)
            return jsonify({'error': 'image too large'}), 400
        rel = f'{pid}.jpg'
        (MEDIA_DIR / rel).write_bytes(blob)                  # replace-in-place → no orphan buildup
        row = q("UPDATE kitchen_products SET photo_path=%s, updated_at=now() WHERE id=%s "
                "RETURNING id, photo_path, updated_at", (rel, pid), fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/products/<int:pid>/photo', methods=['DELETE'])
def product_photo_del(pid):
    try:
        try:
            (MEDIA_DIR / f'{pid}.jpg').unlink()
        except FileNotFoundError:
            pass
        q("UPDATE kitchen_products SET photo_path=NULL, updated_at=now() WHERE id=%s", (pid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

# ── categories (managed Hebrew set; sort_order = tablet page order) ─
@app.route('/api/kitchen/categories')
def categories_list():
    try:
        sql = "SELECT * FROM kitchen_categories"
        if request.args.get('all') != '1':
            sql += " WHERE active IS NOT FALSE"
        sql += " ORDER BY sort_order, name"
        return jsonify(q(sql))
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/categories', methods=['POST'])
def categories_upsert():
    try:
        b = request.get_json(force=True, silent=True) or {}
        name = (b.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name required'}), 400
        c = {'name': name, 'emoji': b.get('emoji'), 'sort_order': b.get('sort_order') or 0}
        cid = b.get('id')
        if cid:
            row = q("""UPDATE kitchen_categories SET name=%(name)s, emoji=%(emoji)s,
                         sort_order=%(sort_order)s, updated_at=now()
                       WHERE id=%(id)s RETURNING *""", {**c, 'id': cid}, fetch='one')
        else:
            row = q("""INSERT INTO kitchen_categories (name, emoji, sort_order)
                       VALUES (%(name)s,%(emoji)s,%(sort_order)s) RETURNING *""", c, fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/categories/delete', methods=['POST'])
def categories_delete():
    try:
        cid = (request.get_json(force=True, silent=True) or {}).get('id')
        if not cid:
            return jsonify({'error': 'id required'}), 400
        # soft-delete: drops out of the active set + tablet pages; products keep their FK.
        q("UPDATE kitchen_categories SET active=false, updated_at=now() WHERE id=%s", (cid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/categories/reorder', methods=['POST'])
def categories_reorder():
    try:
        order = (request.get_json(force=True, silent=True) or {}).get('order') or []
        for i, cid in enumerate(order):
            q("UPDATE kitchen_categories SET sort_order=%s, updated_at=now() WHERE id=%s", (i + 1, cid), fetch='none')
        return jsonify({'ok': True, 'n': len(order)})
    except Exception as e:
        return _err(e)

# ── recipe categories (מרקים / סלטים …) ────────────────────────
# Their OWN table, not a flavour of kitchen_categories: the fridge home screen draws a circle for
# every row of kitchen_categories, so recipe categories living there would show up among the food.
@app.route('/api/kitchen/recipe-categories')
def recipe_categories_list():
    try:
        sql = "SELECT * FROM kitchen_recipe_categories"
        if request.args.get('all') != '1':
            sql += " WHERE active IS NOT FALSE"
        sql += " ORDER BY sort_order, name"
        return jsonify(q(sql))
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipe-categories', methods=['POST'])
def recipe_categories_upsert():
    try:
        b = request.get_json(force=True, silent=True) or {}
        name = (b.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name required'}), 400
        c = {'name': name, 'emoji': b.get('emoji'), 'sort_order': b.get('sort_order') or 0}
        cid = b.get('id')
        if cid:
            row = q("""UPDATE kitchen_recipe_categories SET name=%(name)s, emoji=%(emoji)s,
                         sort_order=%(sort_order)s, updated_at=now()
                       WHERE id=%(id)s RETURNING *""", {**c, 'id': cid}, fetch='one')
        else:
            row = q("""INSERT INTO kitchen_recipe_categories (name, emoji, sort_order)
                       VALUES (%(name)s,%(emoji)s,%(sort_order)s) RETURNING *""", c, fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipe-categories/delete', methods=['POST'])
def recipe_categories_delete():
    try:
        cid = (request.get_json(force=True, silent=True) or {}).get('id')
        if not cid:
            return jsonify({'error': 'id required'}), 400
        # soft-delete, like the product categories: drops out of the active set, recipes keep their FK.
        q("UPDATE kitchen_recipe_categories SET active=false, updated_at=now() WHERE id=%s", (cid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipe-categories/reorder', methods=['POST'])
def recipe_categories_reorder():
    try:
        order = (request.get_json(force=True, silent=True) or {}).get('order') or []
        for i, cid in enumerate(order):
            q("UPDATE kitchen_recipe_categories SET sort_order=%s, updated_at=now() WHERE id=%s", (i + 1, cid), fetch='none')
        return jsonify({'ok': True, 'n': len(order)})
    except Exception as e:
        return _err(e)

# ── settings (singleton config: idle-return timeout, etc.) ──────────
@app.route('/api/kitchen/settings')
def settings_get():
    try:
        row = q("SELECT config FROM kitchen_settings WHERE id=1", fetch='one')
        return jsonify(row['config'] if row else {})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/settings', methods=['POST'])
def settings_set():
    try:
        b = request.get_json(force=True, silent=True) or {}
        q("""INSERT INTO kitchen_settings (id, config, updated_at) VALUES (1, %s::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET config = kitchen_settings.config || EXCLUDED.config, updated_at=now()""",
          (json.dumps(b),), fetch='none')
        row = q("SELECT config FROM kitchen_settings WHERE id=1", fetch='one')
        return jsonify(row['config'] if row else {})
    except Exception as e:
        return _err(e)

# ── common list (weekly staple quantity per product) ───────────────
@app.route('/api/kitchen/common', methods=['POST'])
def common_set():
    try:
        b = request.get_json(force=True, silent=True) or {}
        pid = b.get('id')
        if not pid:
            return jsonify({'error': 'id required'}), 400
        qv = b.get('common_qty')
        row = q("UPDATE kitchen_products SET common_qty=%s, updated_at=now() WHERE id=%s RETURNING id, common_qty",
                (qv, pid), fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

# ── stock (qty_on_hand + low_stock_threshold, in the product's unit) ─
@app.route('/api/kitchen/stock', methods=['POST'])
def stock_set():
    try:
        b = request.get_json(force=True, silent=True) or {}
        pid = b.get('id')
        if not pid:
            return jsonify({'error': 'id required'}), 400
        sets, params = [], {'id': pid}
        if 'qty_on_hand' in b:
            sets.append('qty_on_hand=%(qty_on_hand)s'); params['qty_on_hand'] = b.get('qty_on_hand')
        if 'low_stock_threshold' in b:
            sets.append('low_stock_threshold=%(low_stock_threshold)s'); params['low_stock_threshold'] = b.get('low_stock_threshold')
        if not sets:
            return jsonify({'error': 'nothing to set'}), 400
        row = q(f"UPDATE kitchen_products SET {','.join(sets)}, updated_at=now() "
                f"WHERE id=%(id)s RETURNING id, qty_on_hand, low_stock_threshold", params, fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/amounts', methods=['POST'])
def amounts_set():
    try:
        b = request.get_json(force=True, silent=True) or {}
        pid = b.get('id')
        if not pid:
            return jsonify({'error': 'id required'}), 400
        sets, params = [], {'id': pid}
        for k in ('amount_little', 'amount_medium', 'amount_lots', 'amount_extra'):
            if k in b:
                sets.append(f'{k}=%({k})s'); params[k] = b.get(k)
        if not sets:
            return jsonify({'error': 'nothing to set'}), 400
        row = q(f"UPDATE kitchen_products SET {','.join(sets)}, updated_at=now() "
                f"WHERE id=%(id)s RETURNING id, amount_little, amount_medium, amount_lots", params, fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/stock/check-missing', methods=['POST'])
def stock_check_missing():
    try:
        lid = _active_list_id()
        # "missing" = at or below the low threshold (threshold must be set)
        low = q("""SELECT id, name FROM kitchen_products
                    WHERE active IS NOT FALSE AND low_stock_threshold IS NOT NULL
                      AND COALESCE(qty_on_hand, 0) <= low_stock_threshold
                    ORDER BY sort_order, name""")
        added = []
        for p in low:
            ex = q("""SELECT 1 FROM kitchen_shopping_items
                       WHERE list_id=%s AND product_id=%s AND checked=false LIMIT 1""",
                   (lid, p['id']), fetch='one')
            if not ex:
                q("INSERT INTO kitchen_shopping_items (list_id, product_id, qty) VALUES (%s,%s,1)",
                  (lid, p['id']), fetch='none')
                added.append(p['name'])
        return jsonify({'ok': True, 'added': added, 'missing': [p['name'] for p in low]})
    except Exception as e:
        return _err(e)

# ── shopping list (single shared active list) ──────────────────────
def _active_list_id():
    row = q("SELECT id FROM kitchen_shopping_lists WHERE active IS NOT FALSE ORDER BY id DESC LIMIT 1", fetch='one')
    if row:
        return row['id']
    return q("INSERT INTO kitchen_shopping_lists (name) VALUES ('Shopping') RETURNING id", fetch='one')['id']

@app.route('/api/kitchen/list')
def list_get():
    try:
        lid = _active_list_id()
        items = q("""SELECT i.*, p.name AS product_name, p.emoji AS product_emoji,
                            p.photo_path AS product_photo, p.updated_at AS product_updated,
                            p.unit AS product_unit, p.qty_on_hand AS product_stock,
                            p.low_stock_threshold AS product_low, p.price AS product_price,
                            p.category_id AS product_category_id
                       FROM kitchen_shopping_items i
                       LEFT JOIN kitchen_products p ON p.id = i.product_id
                      WHERE i.list_id=%s ORDER BY i.checked, i.added_at""", (lid,))
        return jsonify({'list_id': lid, 'items': items})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/list/add', methods=['POST'])
def list_add():
    try:
        b = request.get_json(force=True, silent=True) or {}
        pid = b.get('product_id')
        ft = (b.get('free_text') or '').strip() or None
        if not pid and not ft:
            return jsonify({'error': 'product_id or free_text required'}), 400
        lid = _active_list_id()
        add_qty = b.get('qty') or 1
        # tap/add the same product again -> bump its qty instead of a duplicate row
        if pid:
            ex = q("""SELECT id FROM kitchen_shopping_items
                       WHERE list_id=%s AND product_id=%s AND checked=false
                       ORDER BY id LIMIT 1""", (lid, pid), fetch='one')
            if ex:
                row = q("UPDATE kitchen_shopping_items SET qty=qty+%s WHERE id=%s RETURNING *",
                        (add_qty, ex['id']), fetch='one')
                return jsonify(row)
        row = q("""INSERT INTO kitchen_shopping_items (list_id, product_id, free_text, qty)
                   VALUES (%s,%s,%s,%s) RETURNING *""",
                (lid, pid, ft, add_qty), fetch='one')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/list/qty', methods=['POST'])
def list_qty():
    try:
        b = request.get_json(force=True, silent=True) or {}
        iid, qty = b.get('id'), b.get('qty')
        if iid is None or qty is None:
            return jsonify({'error': 'id + qty required'}), 400
        qty = max(0, float(qty))
        if qty <= 0:                       # dial down to 0 = remove from the list
            q("DELETE FROM kitchen_shopping_items WHERE id=%s", (iid,), fetch='none')
            return jsonify({'ok': True, 'removed': True})
        q("UPDATE kitchen_shopping_items SET qty=%s WHERE id=%s", (qty, iid), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/list/check', methods=['POST'])
def list_check():
    try:
        b = request.get_json(force=True, silent=True) or {}
        checked = bool(b.get('checked'))
        q("""UPDATE kitchen_shopping_items
                SET checked=%s, checked_at=CASE WHEN %s THEN now() ELSE NULL END
              WHERE id=%s""", (checked, checked, b.get('id')), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/list/clear', methods=['POST'])
def list_clear():
    try:
        q("DELETE FROM kitchen_shopping_items WHERE list_id=%s", (_active_list_id(),), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/list/remove', methods=['POST'])
def list_remove():
    try:
        iid = (request.get_json(force=True, silent=True) or {}).get('id')
        q("DELETE FROM kitchen_shopping_items WHERE id=%s", (iid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

# ── barcode → Open Food Facts (non-Chinese; catalog-cache-aware) ───
@app.route('/api/kitchen/barcode/<code>')
def barcode_lookup(code):
    try:
        code = ''.join(ch for ch in code if ch.isdigit())
        if not code:
            return jsonify({'error': 'bad barcode'}), 400
        existing = q("SELECT * FROM kitchen_products WHERE barcode=%s LIMIT 1", (code,), fetch='one')
        if existing:
            return jsonify({'found': True, 'source': 'catalog', 'product': existing})
        r = requests.get(f'https://world.openfoodfacts.org/api/v2/product/{code}.json',
                         timeout=8, headers={'User-Agent': 'kitchen-tablet/1.0'})
        d = r.json()
        if d.get('status') == 1:
            p = d.get('product', {})
            return jsonify({'found': True, 'source': 'off', 'suggestion': {
                'name':        p.get('product_name_he') or p.get('product_name') or '',
                'name_en':     p.get('product_name_en'),
                'barcode':     code,
                'nutri_score': (p.get('nutriscore_grade') or '').upper() or None,
                'category':    (p.get('categories_tags') or [None])[0],
            }})
        return jsonify({'found': False, 'barcode': code})
    except Exception as e:
        return _err(e)

# ── recipe import from external recipe sites ────────────────────────
# One page per explicit user action - never a crawl. nikib.co.il's robots.txt allows ordinary
# clients (Allow: / , only /wp-admin blocked) but sets ai-train=no, use=reference and blocks every
# named AI crawler, reserving rights under EU copyright. So: the user names one recipe, we fetch
# that one page with an honest User-Agent and a per-site gap, and the result stays in this private
# database. Nothing is bulk-collected, republished, or used for training.
RECIPE_UA       = 'KitchenAgent/1.0 (personal home kitchen shopping-list app; LAN only)'
RECIPE_MIN_GAP  = 2.0          # seconds between fetches of the same site
_recipe_last_fetch = {}

def _recipe_fetch(url, site_key='?'):
    wait = RECIPE_MIN_GAP - (time.time() - _recipe_last_fetch.get(site_key, 0))
    if wait > 0:
        time.sleep(wait)
    _recipe_last_fetch[site_key] = time.time()
    r = requests.get(url, headers={'User-Agent': RECIPE_UA}, timeout=25)
    r.raise_for_status()
    # ⚠ Decode explicitly. This page sends no charset in its headers, and requests then falls back
    # to ISO-8859-1, which turns every Hebrew word into mojibake - the ingredient names come out
    # garbled AND the unit list stops matching, so everything looks unmatched. Trust the header
    # charset when it is given, else the <meta charset> in the HTML, else UTF-8.
    enc = None
    m = re.search(r'charset=([\w-]+)', r.headers.get('Content-Type', ''), re.I)
    if m:
        enc = m.group(1)
    if not enc:
        m = re.search(rb'<meta[^>]+charset=([^\s">;]+)', r.content[:2000], re.I)
        if m:
            enc = re.sub(rb'[^A-Za-z0-9_-]', b'', m.group(1)).decode('ascii', 'ignore')
    return r.content.decode(enc or 'utf-8', 'replace')

def _txt(x):
    """Tag soup -> a clean single-line string."""
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', x))).strip()

# ── Hebrew ingredient normaliser ────────────────────────────────────
# Turns "2 תפוחי אדמה בינוניים מגורדים וסחוטים" into (2, None, "תפוחי אדמה").
_FRACTION = {'חצי': 0.5, 'שליש': 1 / 3.0, 'רבע': 0.25}
_UNITS = ['גרם', "ג'", 'ק"ג', 'מ״ל', 'מ"ל', 'מיל', 'ליטר',
          'כפיות', 'כפית', 'כפות', 'כף', 'כוסות', 'כוס',
          'קופסאות', 'קופסה', 'חבילות', 'חבילה', 'צרור', 'שיני', 'שן']
# descriptive / preparation words that are not part of the product's name
_DROP = ['בינוניים', 'בינוני', 'בינונית', 'גדולים', 'גדולה', 'גדול', 'קטנות', 'קטנים', 'קטן', 'קטנה',
         'מגורדים', 'מגורד', 'מגורדת', 'סחוטים', 'סחוט', 'סחוטה', 'קצוצה', 'קצוץ', 'קצוצים',
         'פרוסות', 'פרוס', 'פרוסה', 'חתוך', 'חתוכה', 'חתוכים', 'בשלות', 'בשל', 'רכות', 'רך',
         'מומסת', 'מומס', 'קלוף', 'קלופה', 'טרי', 'טריים', 'גדושה', 'גדוש']
# a trailing clause starting with one of these is preparation, not the name
_CUT = ['חתוך', 'חתוכה', 'חתוכים', 'פרוס', 'פרוסות', 'קצוץ', 'קצוצה', 'מגורד', 'מגורדים', 'כל']
_NOISE = ['נגיעה של', 'מעט פחות', 'מעט']

def _norm_ingredient(line):
    """-> (qty|None, unit|None, product_name, note|None)"""
    note = ' '.join(re.findall(r'\(([^)]*)\)', line)) or None
    s = re.sub(r'\s+', ' ', re.sub(r'\([^)]*\)', ' ', line)).strip(' ,.')
    qty = unit = None
    m = re.match(r'^\s*(\d+\s*/\s*\d+|\d+(?:[.,]\d+)?)\s*(.*)$', s)
    if m:
        raw = m.group(1).replace(' ', '')
        if '/' in raw:
            a, b = raw.split('/')
            qty = round(float(a) / float(b), 3) if float(b) else None
        else:
            qty = float(raw.replace(',', '.'))
        s = m.group(2)
    else:
        for w, v in _FRACTION.items():
            if s.startswith(w + ' '):
                qty = round(v, 3)
                s = s[len(w) + 1:]
                break
    for u in _UNITS:
        if s.startswith(u + ' ') or s == u:
            unit = u
            s = s[len(u):].strip()
            break
    for ph in _NOISE:
        s = s.replace(ph, ' ')
    words = s.split()
    for i, w in enumerate(words):
        if w in _CUT:
            words = words[:i]
            break
    # a leading vav ("and-") glues onto the next adjective (ורכות = "and soft"); strip it
    # before matching or the word slips past the drop list.
    words = [w for w in words if w not in _DROP and not (w.startswith('ו') and w[1:] in _DROP)]
    return qty, unit, re.sub(r'\s+', ' ', ' '.join(words)).strip(' ,.'), note

# ── site adapters ───────────────────────────────────────────────────
# A new site = a new adapter here, not a rewrite. nikib.co.il is WordPress, so its own REST API
# does the "search by name" (no scraping of search pages) and the article HTML holds the recipe.
def _wp_search(base, term, limit=8):   # 'term' not 'q' - q() is the global DB helper
    url = ('%s/wp-json/wp/v2/posts?per_page=%d&_fields=link,title&search=%s'
           % (base.rstrip('/'), limit, requests.utils.quote(term)))
    return [{'title': _txt(p['title']['rendered']), 'url': p['link']}
            for p in json.loads(_recipe_fetch(url, base))]

def _nikib_parse(page):
    """The theme's markup: #ingredients > .ingredients-list > <h3> + <p> blocks whose lines are
    separated by <br>, with <strong> marking a sub-group (רוטב: / תבלינים:). Verified against the
    whole div (walked to its matching close): 1 title + 2 groups + 21 ingredients, nothing missed."""
    title = re.search(r'<h1[^>]*>(.*?)</h1>', page, re.S)
    i = page.find('<div id="ingredients">')
    items, group = [], None
    if i >= 0:
        depth, k = 0, i
        while k < len(page):                       # walk to the matching </div>
            m = re.compile(r'<div\b|</div>').search(page, k)
            if not m:
                break
            depth += 1 if m.group(0).startswith('<div') else -1
            k = m.end()
            if depth == 0:
                break
        block = page[i:k]
        for p in re.findall(r'<p[^>]*>(.*?)</p>', block, re.S):
            g = re.match(r'\s*<strong[^>]*>(.*?)</strong>', p, re.S)
            if g:
                group = _txt(g.group(1))
            for part in re.split(r'<br\s*/?>', p):
                t = _txt(part)
                if t and t != group:
                    items.append({'raw_line': t, 'group_label': group})
    j = page.find('receipt-page-under-ingredients')
    steps = [s for s in (_txt(x) for x in re.findall(r'<p[^>]*>(.*?)</p>', page[j:j + 9000], re.S))
             if len(s) > 25] if j >= 0 else []
    return {'title': _txt(title.group(1)) if title else '', 'items': items, 'steps': steps}

RECIPE_ADAPTERS = {'nikib': {'base': 'https://nikib.co.il', 'search': _wp_search, 'parse': _nikib_parse}}

def _recipe_sites():
    row = q("SELECT config FROM kitchen_settings WHERE id=1", fetch='one')
    cfg = (row['config'] if row else {}) or {}
    return cfg.get('recipe_sites') or [{'key': 'nikib', 'name': 'nikib.co.il',
                                        'base': 'https://nikib.co.il', 'adapter': 'nikib'}]

def _same_ingredient(a, b):
    """Are these two ingredient names the same thing?

    Hebrew puts the HEAD NOUN FIRST, so an addition extends a name to the RIGHT:
      מלח / מלח גס            -> same thing (coarse salt is salt)
      פלפל שחור / פלפל שחור גרוס -> same thing
    but a word added on the LEFT changes what the thing IS:
      עגבניות / רסק עגבניות    -> tomatoes vs tomato PASTE - NOT the same
      פלפל שחור / פלפל חריף    -> black pepper vs chilli   - NOT the same
    So: equal, or the shorter is a whole-WORD PREFIX of the longer. Never a suffix,
    and never a partial word (which would make פלפל match פלפלת)."""
    a = re.sub(r'\s+', ' ', (a or '').strip())
    b = re.sub(r'\s+', ' ', (b or '').strip())
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return long_.startswith(short + ' ')


def _merge_items(items):
    """One row per PRODUCT - what a recipe is for here is the shopping list.

    A recipe legitimately names the same thing twice (this tuna recipe seasons the patties and
    the sauce separately), but for buying that is one entry. Quantities add up when the units
    match; when they do not, the leftovers are recorded in `qty_note` rather than being faked
    into a single number. Every original line is kept in `merged_from`, so nothing is lost."""
    out = []
    for it in items:
        tgt = None
        for m in out:
            if it.get('product_id') and m.get('product_id') == it.get('product_id'):
                tgt = m
                break
            if not it.get('product_id') and not m.get('product_id') \
                    and _same_ingredient(it.get('parsed_name'), m.get('parsed_name')):
                tgt = m
                break
            if it.get('product_id') and m.get('product_id') is None \
                    and _same_ingredient(it.get('parsed_name'), m.get('parsed_name')):
                tgt = m
                break
        if tgt is None:
            row = dict(it)
            row['merged_from'] = [it.get('raw_line')]
            row['qty_note'] = None
            out.append(row)
            continue
        tgt['merged_from'].append(it.get('raw_line'))
        # a mapped product always wins over an unmapped one, and the SHORTER name is the head noun
        if it.get('product_id') and not tgt.get('product_id'):
            tgt['product_id'], tgt['match'] = it['product_id'], it.get('match')
        if it.get('parsed_name') and len(it['parsed_name']) < len(tgt.get('parsed_name') or ''):
            tgt['parsed_name'] = it['parsed_name']
        a, b = tgt.get('qty'), it.get('qty')
        if (tgt.get('unit') or None) == (it.get('unit') or None):
            tgt['qty'] = (1 if a is None else a) + (1 if b is None else b)
        else:                                   # cannot add teaspoons to tablespoons - say so
            extra = ('%s %s' % ('' if b is None else b, it.get('unit') or '')).strip()
            tgt['qty_note'] = ((tgt.get('qty_note') + ' + ') if tgt.get('qty_note') else '+ ') + extra
        if tgt.get('group_label') != it.get('group_label'):
            tgt['group_label'] = None           # it now belongs to more than one part of the recipe
    for n, row in enumerate(out):
        row['sort_order'] = n
    return out


def _match_products(items):
    """exact product name -> learned alias -> normalised 'contains' -> unmatched.
    Never guesses silently: every row reports HOW it matched so the UI can show it."""
    prods = q("SELECT id, name, unit FROM kitchen_products WHERE active IS NOT FALSE")
    aliases = {a['alias']: a['product_id'] for a in q("SELECT alias, product_id FROM kitchen_ingredient_aliases")}
    by_name = {p['name'].strip(): p for p in prods}
    for it in items:
        name = (it.get('parsed_name') or '').strip()
        hit, how = None, 'none'
        if name and name in by_name:
            hit, how = by_name[name]['id'], 'exact'
        elif name and name in aliases:
            hit, how = aliases[name], 'alias'
        elif name:
            # ⚠ NOT a plain substring test: that matched רסק עגבניות (tomato paste) to a
            # tomato product. _same_ingredient only accepts a whole-word PREFIX.
            best = None
            for p in prods:
                pn = p['name'].strip()
                if _same_ingredient(pn, name):
                    if best is None or len(pn) > len(best['name'].strip()):
                        best = p
            if best:
                hit, how = best['id'], 'fuzzy'
        it['product_id'], it['match'] = hit, how
    return items

@app.route('/api/kitchen/recipe-sites')
def recipe_sites_get():
    try:
        return jsonify(_recipe_sites())
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipe-sites', methods=['POST'])
def recipe_sites_set():
    try:
        sites = (request.get_json(force=True, silent=True) or {}).get('sites')
        if not isinstance(sites, list):
            return jsonify({'error': 'sites[] required'}), 400
        clean = []
        for s in sites:
            base = (s.get('base') or '').strip().rstrip('/')
            if not base.startswith('http'):
                continue
            clean.append({'key': (s.get('key') or base).strip(),
                          'name': (s.get('name') or base).strip(),
                          'base': base,
                          'adapter': (s.get('adapter') or 'nikib').strip()})
        # merges into the existing config blob, so the tablet timings are untouched
        q("""INSERT INTO kitchen_settings (id, config, updated_at) VALUES (1, %s::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET config = kitchen_settings.config || EXCLUDED.config,
                                            updated_at = now()""",
          (json.dumps({'recipe_sites': clean}),), fetch='none')
        return jsonify(clean)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipe-search')
def recipe_search():
    try:
        site_key = request.args.get('site') or 'nikib'
        term = (request.args.get('q') or '').strip()
        if not term:
            return jsonify({'error': 'q required'}), 400
        site = next((s for s in _recipe_sites() if s['key'] == site_key), None)
        if not site:
            return jsonify({'error': 'unknown site'}), 400
        ad = RECIPE_ADAPTERS.get(site.get('adapter') or 'nikib')
        if not ad:
            return jsonify({'error': 'no adapter for this site'}), 400
        return jsonify({'site': site_key, 'hits': ad['search'](site['base'], term)})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipe-parse')
def recipe_parse():
    try:
        url = (request.args.get('url') or '').strip()
        site_key = request.args.get('site') or 'nikib'
        if not url.startswith('http'):
            return jsonify({'error': 'url required'}), 400
        site = next((s for s in _recipe_sites() if s['key'] == site_key), None)
        if not site or not url.startswith(site['base']):
            return jsonify({'error': 'url does not belong to the selected site'}), 400
        ad = RECIPE_ADAPTERS.get(site.get('adapter') or 'nikib')
        parsed = ad['parse'](_recipe_fetch(url, site_key))
        for n, it in enumerate(parsed['items']):
            qty, unit, name, note = _norm_ingredient(it['raw_line'])
            it.update({'sort_order': n, 'qty': qty, 'unit': unit, 'parsed_name': name, 'note': note})
        _match_products(parsed['items'])
        parsed['items'] = _merge_items(parsed['items'])
        existing = q("SELECT id, name FROM kitchen_recipes WHERE source_url=%s", (url,), fetch='one')
        return jsonify({'site': site_key, 'source_url': url, 'title': parsed['title'],
                        'steps': parsed['steps'], 'items': parsed['items'],
                        'already_imported': existing})      # the UI offers "open" instead of a duplicate
    except Exception as e:
        return _err(e)

# The learned map, with a screen behind it. Without one a mis-click is permanent AND invisible:
# a stray pick once stored עגבניות -> אורז (rice) and kept re-applying on every import.
@app.route('/api/kitchen/ingredient-aliases')
def ingredient_aliases_list():
    try:
        return jsonify(q("""SELECT a.id, a.alias, a.product_id, p.name AS product_name, p.unit AS product_unit
                              FROM kitchen_ingredient_aliases a
                              LEFT JOIN kitchen_products p ON p.id = a.product_id
                             ORDER BY a.alias"""))
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/ingredient-aliases/delete', methods=['POST'])
def ingredient_alias_delete():
    """Hard delete on purpose - an alias is a preference, not a record. Forgetting one simply means
    the next import asks about that ingredient again. Saved recipes keep their own product ids."""
    try:
        b = request.get_json(force=True, silent=True) or {}
        aid = b.get('id')
        alias = (b.get('alias') or '').strip()
        if not aid and not alias:
            return jsonify({'error': 'id or alias required'}), 400
        if aid:
            q("DELETE FROM kitchen_ingredient_aliases WHERE id=%s", (aid,), fetch='none')
        else:
            q("DELETE FROM kitchen_ingredient_aliases WHERE alias=%s", (alias,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/ingredient-aliases', methods=['POST'])
def ingredient_alias_set():
    """Remember one manual mapping so the same ingredient is never asked about twice."""
    try:
        b = request.get_json(force=True, silent=True) or {}
        alias, pid = (b.get('alias') or '').strip(), b.get('product_id')
        if not alias or not pid:
            return jsonify({'error': 'alias + product_id required'}), 400
        q("""INSERT INTO kitchen_ingredient_aliases (alias, product_id) VALUES (%s,%s)
             ON CONFLICT (alias) DO UPDATE SET product_id=EXCLUDED.product_id, updated_at=now()""",
          (alias, pid), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipes')
def recipes_list():
    try:
        sql = ("SELECT r.*, c.name AS category_name, c.emoji AS category_emoji, "
               "(SELECT count(*) FROM kitchen_recipe_items i WHERE i.recipe_id=r.id) AS item_count "
               "FROM kitchen_recipes r LEFT JOIN kitchen_recipe_categories c ON c.id=r.category_id")
        if request.args.get('all') != '1':
            sql += " WHERE r.active IS NOT FALSE"
        sql += " ORDER BY r.sort_order, r.name"
        return jsonify(q(sql))
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipes/<int:rid>')
def recipe_get(rid):
    try:
        r = q("SELECT * FROM kitchen_recipes WHERE id=%s", (rid,), fetch='one')
        if not r:
            return jsonify({'error': 'not found'}), 404
        r['items'] = q("""SELECT i.*, p.name AS product_name, p.unit AS product_unit
                            FROM kitchen_recipe_items i
                            LEFT JOIN kitchen_products p ON p.id = i.product_id
                           WHERE i.recipe_id=%s ORDER BY i.sort_order""", (rid,))
        return jsonify(r)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipes', methods=['POST'])
def recipe_save():
    try:
        b = request.get_json(force=True, silent=True) or {}
        name = (b.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name required'}), 400
        src = (b.get('source_url') or '').strip() or None
        rid = b.get('id')
        if src and not rid:
            dup = q("SELECT id, name, active FROM kitchen_recipes WHERE source_url=%s", (src,), fetch='one')
            if dup and dup['active']:    # a LIVE one exists -> never create a second copy
                return jsonify({'error': 'already_imported', 'recipe': dup}), 409
            if dup:
                # It was deleted. Deleting is soft (active=false) but source_url stays UNIQUE, so a
                # plain 409 here would refuse to re-import a recipe the user can no longer see -
                # a dead end. Revive that row instead: same id, fresh contents.
                rid = dup['id']
        rec = {'category_id': b.get('category_id'), 'name': name, 'emoji': b.get('emoji'),
               'servings': b.get('servings'), 'instructions': b.get('instructions'),
               'source_url': src, 'source_site': b.get('source_site'), 'notes': b.get('notes'),
               'sort_order': b.get('sort_order') or 0}
        if rid:
            row = q("""UPDATE kitchen_recipes SET category_id=%(category_id)s, name=%(name)s,
                         emoji=%(emoji)s, servings=%(servings)s, instructions=%(instructions)s,
                         source_url=%(source_url)s, source_site=%(source_site)s, notes=%(notes)s,
                         sort_order=%(sort_order)s, active=true, updated_at=now()
                       WHERE id=%(id)s RETURNING *""", {**rec, 'id': rid}, fetch='one')
        else:
            row = q("""INSERT INTO kitchen_recipes
                         (category_id,name,emoji,servings,instructions,source_url,source_site,notes,sort_order)
                       VALUES (%(category_id)s,%(name)s,%(emoji)s,%(servings)s,%(instructions)s,
                               %(source_url)s,%(source_site)s,%(notes)s,%(sort_order)s)
                       RETURNING *""", rec, fetch='one')
        items = b.get('items')
        if isinstance(items, list):
            q("DELETE FROM kitchen_recipe_items WHERE recipe_id=%s", (row['id'],), fetch='none')
            for n, it in enumerate(items):
                raw = (it.get('raw_line') or it.get('parsed_name') or '').strip()
                if not raw:
                    continue
                q("""INSERT INTO kitchen_recipe_items
                       (recipe_id, sort_order, group_label, raw_line, qty, unit, parsed_name, product_id)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                  (row['id'], n, it.get('group_label'), raw, it.get('qty'), it.get('unit'),
                   it.get('parsed_name'), it.get('product_id')), fetch='none')
        return jsonify(row)
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipes/delete', methods=['POST'])
def recipe_delete():
    try:
        rid = (request.get_json(force=True, silent=True) or {}).get('id')
        if not rid:
            return jsonify({'error': 'id required'}), 400
        q("UPDATE kitchen_recipes SET active=false, updated_at=now() WHERE id=%s", (rid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

if __name__ == '__main__':
    log.info('kitchen-service starting on :%d (static=%s)', PORT, STATIC_DIR)
    app.run(host='0.0.0.0', port=PORT, threaded=True)
