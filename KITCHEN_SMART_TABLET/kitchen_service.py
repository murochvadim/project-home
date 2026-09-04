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
import json, logging, math, re, time, html
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
        _rematch_recipes()          # a recipe that wanted this product can now find it
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
        _rematch_recipes()          # soft delete: rows pointing at it must not keep it
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
        if added:
            _log('product_added', added[-1])
        return jsonify({'ok': True, 'added': added, 'missing': [p['name'] for p in low]})
    except Exception as e:
        return _err(e)

# ── shopping list (single shared active list) ──────────────────────
def _log(kind, name=None):
    """Record a list change. Removals are hard DELETEs, so this is the ONLY trace they leave -
    and the name is snapshotted here so the bar still reads right after the row is gone."""
    try:
        q("INSERT INTO kitchen_activity (kind, name) VALUES (%s,%s)", (kind, name), fetch='none')
    except Exception:
        log.exception('activity log failed')      # never let the trail break the action itself

def _product_name(pid):
    r = q("SELECT name FROM kitchen_products WHERE id=%s", (pid,), fetch='one') if pid else None
    return r['name'] if r else None

def _item_name(iid):
    """Read the name BEFORE the row is deleted - afterwards there is nothing to read."""
    r = q("""SELECT COALESCE(p.name, i.free_text) AS nm FROM kitchen_shopping_items i
               LEFT JOIN kitchen_products p ON p.id = i.product_id WHERE i.id=%s""",
          (iid,), fetch='one') if iid else None
    return r['nm'] if r else None

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
        # Only recipes that still have a line: items can vanish four ways (row delete, qty 0,
        # clear, clear-checked) and each cascades its lines, so this one read-side rule keeps the
        # מתכונים section honest without patching every delete path.
        recipes = q("""SELECT lr.* FROM kitchen_list_recipes lr
                        WHERE lr.list_id=%s
                          AND EXISTS (SELECT 1 FROM kitchen_list_recipe_items li
                                       WHERE li.list_recipe_id = lr.id)
                        ORDER BY lr.added_at""", (lid,))
        act = q("SELECT kind, name, ts FROM kitchen_activity ORDER BY ts DESC, id DESC LIMIT 1",
                fetch='one')
        return jsonify({'list_id': lid, 'items': items, 'recipes': recipes, 'last_activity': act})
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
                _log('product_added', _product_name(pid))
                return jsonify(row)
        row = q("""INSERT INTO kitchen_shopping_items (list_id, product_id, free_text, qty)
                   VALUES (%s,%s,%s,%s) RETURNING *""",
                (lid, pid, ft, add_qty), fetch='one')
        _log('product_added', _product_name(pid) if pid else ft)
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
            _log('product_removed', _item_name(iid))
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
        lid = _active_list_id()
        q("DELETE FROM kitchen_shopping_items WHERE list_id=%s", (lid,), fetch='none')
        q("DELETE FROM kitchen_list_recipes  WHERE list_id=%s", (lid,), fetch='none')
        _log('list_cleared')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/list/remove', methods=['POST'])
def list_remove():
    try:
        iid = (request.get_json(force=True, silent=True) or {}).get('id')
        _log('product_removed', _item_name(iid))
        q("DELETE FROM kitchen_shopping_items WHERE id=%s", (iid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

# ── a recipe onto the shopping list, and back off it again ────────
@app.route('/api/kitchen/list/add-recipe', methods=['POST'])
def list_add_recipe():
    """Put a recipe's products on the list. Two rules, both deliberate:
       1. WHAT amount - never the recipe's own number (400 ג' of flour is not 400 packs); the
          conversion table turns it into how many of the PRODUCT to buy.
       2. WHETHER to add - only while the list already holds no more than the Common-list quantity,
          i.e. "you have enough already" wins."""
    try:
        rid = (request.get_json(force=True, silent=True) or {}).get('recipe_id')
        rec = q("SELECT id, name, emoji FROM kitchen_recipes WHERE id=%s", (rid,), fetch='one')
        if not rec:
            return jsonify({'error': 'recipe not found'}), 404
        _rematch_recipes(rid)       # always use today's products, not the ones that existed at import
        items = q("""SELECT i.*, p.name AS product_name, COALESCE(p.common_qty,0) AS common_qty
                       FROM kitchen_recipe_items i
                       LEFT JOIN kitchen_products p ON p.id = i.product_id
                      WHERE i.recipe_id=%s ORDER BY i.sort_order""", (rid,))
        lid, rules = _active_list_id(), _recipe_conversions()

        lr = q("SELECT id FROM kitchen_list_recipes WHERE list_id=%s AND recipe_id=%s",
               (lid, rid), fetch='one')
        if lr:
            lrid = lr['id']
        else:
            lrid = q("""INSERT INTO kitchen_list_recipes (list_id, recipe_id, recipe_name, recipe_emoji)
                        VALUES (%s,%s,%s,%s) RETURNING id""",
                     (lid, rid, rec['name'], rec['emoji']), fetch='one')['id']
        # re-recorded fresh on every add, so a second add reflects the CURRENT state
        q("DELETE FROM kitchen_list_recipe_items WHERE list_recipe_id=%s AND kind='skipped'",
          (lrid,), fetch='none')

        added, skipped, missing = [], [], []
        for it in items:
            if not it['product_id']:                      # no product for this ingredient
                name = (it['parsed_name'] or it['raw_line'] or '').strip()
                if not name:
                    continue
                txt = 'חסר: ' + name
                dup = q("""SELECT 1 FROM kitchen_list_recipe_items li
                             JOIN kitchen_shopping_items si ON si.id = li.item_id
                            WHERE li.list_recipe_id=%s AND li.kind='missing' AND si.free_text=%s""",
                        (lrid, txt), fetch='one')
                if dup:                                   # adding twice must not duplicate it
                    continue
                iid = q("""INSERT INTO kitchen_shopping_items (list_id, free_text, qty)
                           VALUES (%s,%s,1) RETURNING id""", (lid, txt), fetch='one')['id']
                q("""INSERT INTO kitchen_list_recipe_items (list_recipe_id, item_id, qty_added, kind)
                     VALUES (%s,%s,1,'missing')""", (lrid, iid), fetch='none')
                missing.append(name)
                continue

            pid = it['product_id']
            have = float(q("""SELECT COALESCE(SUM(qty),0) AS q FROM kitchen_shopping_items
                               WHERE list_id=%s AND product_id=%s AND checked=false""",
                           (lid, pid), fetch='one')['q'] or 0)
            common = float(it['common_qty'] or 0)
            if have > common:                             # rule 2: already enough on the list
                q("""INSERT INTO kitchen_list_recipe_items (list_recipe_id, item_id, qty_added, kind)
                     VALUES (%s,NULL,0,'skipped')""", (lrid,), fetch='none')
                skipped.append(it['product_name'])
                continue

            buy = _buy_qty(it['qty'], it['unit'], rules)  # rule 1: in the PRODUCT's units
            ex = q("""SELECT id FROM kitchen_shopping_items
                       WHERE list_id=%s AND product_id=%s AND checked=false ORDER BY id LIMIT 1""",
                   (lid, pid), fetch='one')
            if ex:
                q("UPDATE kitchen_shopping_items SET qty=qty+%s WHERE id=%s", (buy, ex['id']), fetch='none')
                iid = ex['id']
            else:
                iid = q("""INSERT INTO kitchen_shopping_items (list_id, product_id, qty)
                           VALUES (%s,%s,%s) RETURNING id""", (lid, pid, buy), fetch='one')['id']
            q("""INSERT INTO kitchen_list_recipe_items (list_recipe_id, item_id, qty_added, kind)
                 VALUES (%s,%s,%s,'product')""", (lrid, iid, buy), fetch='none')
            added.append({'product': it['product_name'], 'qty': buy})
        _log('recipe_added', rec['name'])     # one event for the recipe, not one per product
        return jsonify({'ok': True, 'list_recipe_id': lrid,
                        'added': added, 'skipped': skipped, 'missing': missing})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/list/remove-recipe', methods=['POST'])
def list_remove_recipe():
    """Undo exactly what that recipe contributed - not everything that looks like it came from one."""
    try:
        lrid = (request.get_json(force=True, silent=True) or {}).get('id')
        if not lrid:
            return jsonify({'error': 'id required'}), 400
        lines = q("""SELECT li.*, si.qty AS item_qty, si.checked
                       FROM kitchen_list_recipe_items li
                       LEFT JOIN kitchen_shopping_items si ON si.id = li.item_id
                      WHERE li.list_recipe_id=%s""", (lrid,))
        # Aggregate per ITEM first. One item can carry several lines (the same recipe added twice
        # tops the same product up twice), and subtracting line-by-line off the qty read at the top
        # makes each subtraction clobber the last, leaving the product behind.
        per_item = {}
        for ln in lines:
            if not ln['item_id'] or ln['checked']:
                continue          # skipped line, or you already bought it -> leave it alone
            e = per_item.setdefault(ln['item_id'], {'qty': float(ln['item_qty'] or 0),
                                                    'take': 0.0, 'drop': False})
            if ln['kind'] == 'missing':
                e['drop'] = True
            elif ln['kind'] == 'product':
                e['take'] += float(ln['qty_added'] or 0)
        for iid, e in per_item.items():
            left = e['qty'] - e['take']
            if e['drop'] or left <= 0.0001:
                q("DELETE FROM kitchen_shopping_items WHERE id=%s", (iid,), fetch='none')
            else:                  # a quantity you raised by hand survives, minus this recipe's share
                q("UPDATE kitchen_shopping_items SET qty=%s WHERE id=%s", (left, iid), fetch='none')
        nm = q("SELECT recipe_name FROM kitchen_list_recipes WHERE id=%s", (lrid,), fetch='one')
        _log('recipe_removed', nm['recipe_name'] if nm else None)
        q("DELETE FROM kitchen_list_recipes WHERE id=%s", (lrid,), fetch='none')   # lines cascade
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
_UNITS = ['קילוגרם', 'קילו', 'גרם', "ג'", 'ק"ג', 'מ״ל', 'מ"ל', 'מיל', 'ליטר',
          'כפיות', 'כפית', 'כפות', 'כף', 'כוסות', 'כוס',
          # קופסת / חבילת are the construct forms ("a tin/pack OF"); listed before the plain
          # forms so the longer one wins the startswith test.
          'קופסאות', 'קופסת', 'קופסה', 'חבילות', 'חבילת', 'חבילה',
          'צרור', 'שיני', 'שן']
# descriptive / preparation words that are not part of the product's name
_DROP = ['בינוניים', 'בינוני', 'בינונית', 'גדולים', 'גדולה', 'גדול', 'קטנות', 'קטנים', 'קטן', 'קטנה',
         'מגורדים', 'מגורד', 'מגורדת', 'סחוטים', 'סחוט', 'סחוטה', 'קצוצה', 'קצוץ', 'קצוצים',
         'פרוסות', 'פרוס', 'פרוסה', 'חתוך', 'חתוכה', 'חתוכים', 'בשלות', 'בשל', 'רכות', 'רך',
         'מומסת', 'מומס', 'קלוף', 'קלופה', 'טרי', 'טריים']
# a trailing clause starting with one of these is preparation, not the name
_CUT = ['חתוך', 'חתוכה', 'חתוכים', 'פרוס', 'פרוסות', 'קצוץ', 'קצוצה', 'מגורד', 'מגורדים', 'כל']
_NOISE = ['נגיעה של', 'מעט פחות', 'מעט']
_DROP += ['דק', 'דקה']
# ⚠ מלא/מלאה/גדוש are NOT in _DROP: they mean "heaped" after a unit (כף מלאה סילאן) but they are
# part of real PRODUCT names too (קמח מלא, אורז מלא). Dropping them everywhere made a wholemeal-flour
# recipe silently match WHITE flour. They are only removed directly after the unit - see below.
_AFTER_UNIT = ['מלאה', 'מלא', 'גדושה', 'גדוש']
_DROP += ['מסוננות', 'מסוננים', 'מסוננת', 'מסונן', 'מפוררות', 'מפוררים', 'מפוררת', 'מפורר']   # drained / crumbled
# ...and they also END the name: everything after them is preparation, so cut there too
# ("2 קופסאות טונה מסוננות ומפוררות" -> טונה).
_DROP += ['חם', 'חמים', 'חמימים', 'חצוי', 'חצויה', 'חצויים', 'יותר', 'כתוש', 'כתושה', 'כתושים', 'מגורדות', 'קר', 'קרים']   # halved / crushed / grated / warm / "more"
_CUT += ['מסוננות', 'מסוננים', 'מסוננת', 'מסונן', 'מפוררות', 'מפוררים', 'מפוררת', 'מפורר', 'חצוי', 'חצויה', 'חצויים', 'כתוש', 'כתושה', 'לפרוסות', 'לקוביות', 'לטבעות', 'לרצועות']

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
        # A range - "7 - 8 תפוחי אדמה" (any dash, including the en-dash the sites use). Take the
        # UPPER bound: this feeds a shopping list, and buying the smaller number leaves you short.
        rng = re.match(r'^\s*[-–—]\s*(\d+(?:[.,]\d+)?)\s*(.*)$', s)
        if rng:
            qty = max(qty, float(rng.group(1).replace(',', '.')))
            s = rng.group(2)
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
    # "כף מלאה סילאן" / "כף גדושה קטשופ" - heaped describes the SPOON, so it is only
    # noise here, immediately after the unit. Anywhere else the same word belongs to the product.
    first = s.split(' ', 1)
    if unit and first and first[0] in _AFTER_UNIT:
        s = first[1] if len(first) > 1 else ''
    for ph in _NOISE:
        s = s.replace(ph, ' ')
    # A dash introduces an explanation of the ingredient, never part of its name:
    #   "חלקי עוף – כרעיים, שוקיים, כנפיים עם העור"  ->  "חלקי עוף"
    s = re.split(r'\s[-–—]\s', s)[0]
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

# ── recipe amount -> how many of the PRODUCT to buy ───────────────
# The recipe measures in cooking units (400 ג', רבע צרור); the shop sells packages. So the recipe's
# number is never copied to the list - it is converted through this table, which the user edits in
# Settings -> Recipe Settings. 'same' means "use the recipe's own amount", which is right only when
# the two units are the same word (2 קופסאות טונה -> 2 boxes).
DEFAULT_CONVERSIONS = [
    {'unit': "ג'",       'min': 1,   'max': 900,  'buy': 1},
    {'unit': "ג'",       'min': 901, 'max': 1800, 'buy': 2},
    {'unit': 'מ"ל',      'min': 1,   'max': 1000, 'buy': 1},
    {'unit': 'מ"ל',      'min': 1001,'max': 2000, 'buy': 2},
    {'unit': '',         'min': 1,   'max': 7,    'buy': 1},
    {'unit': '',         'min': 8,   'max': 14,   'buy': 2},
    {'unit': 'כוס',      'min': 1,   'max': 999,  'buy': 1},
    {'unit': 'כף',       'min': 1,   'max': 999,  'buy': 1},
    {'unit': 'כפית',     'min': 1,   'max': 999,  'buy': 1},
    {'unit': 'צרור',     'min': 1,   'max': 999,  'buy': 1},
    {'unit': 'קופסאות',  'min': 1,   'max': 99,   'buy': 'same'},
]
# plural / spelling variants folded onto one key, so a rule for כף also covers כפות
_UNIT_SYN = {'גרם': "ג'", 'ג': "ג'", "ג'": "ג'", 'גר': "ג'",
             'מל': 'מ"ל', 'מ"ל': 'מ"ל', 'מיליליטר': 'מ"ל',
             'כפות': 'כף', 'כף': 'כף', 'כפיות': 'כפית', 'כפית': 'כפית',
             'כוסות': 'כוס', 'כוס': 'כוס',
             'קופסה': 'קופסאות', 'קופסת': 'קופסאות', 'קופסאות': 'קופסאות'}

def _norm_unit(u):
    u = (u or '').strip()
    return _UNIT_SYN.get(u, u)

def _recipe_conversions():
    row = q("SELECT config FROM kitchen_settings WHERE id=1", fetch='one')
    cfg = (row['config'] if row else {}) or {}
    rules = cfg.get('recipe_conversions')
    return rules if isinstance(rules, list) and rules else DEFAULT_CONVERSIONS

def _buy_qty(qty, unit, rules):
    """How many of the product to buy for this recipe line. Unknown -> 1 (you need the product)."""
    amount = float(qty) if qty is not None else 1.0     # a line with no amount counts as 1
    u = _norm_unit(unit)
    for r in rules:
        if _norm_unit(r.get('unit')) != u:
            continue
        try:
            lo, hi = float(r.get('min') or 0), float(r.get('max') or 10 ** 9)
        except (TypeError, ValueError):
            continue
        if lo <= amount <= hi:
            buy = r.get('buy')
            if str(buy).strip().lower() == 'same':
                return max(1, int(math.ceil(amount)))
            try:
                return max(1, int(float(buy)))
            except (TypeError, ValueError):
                return 1
    return 1

@app.route('/api/kitchen/recipe-conversions')
def recipe_conversions_get():
    try:
        return jsonify(_recipe_conversions())
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipe-conversions', methods=['POST'])
def recipe_conversions_set():
    try:
        rules = (request.get_json(force=True, silent=True) or {}).get('rules')
        if not isinstance(rules, list):
            return jsonify({'error': 'rules[] required'}), 400
        clean = []
        for r in rules:
            buy = r.get('buy')
            if str(buy).strip().lower() == 'same':
                buy = 'same'
            else:
                try:
                    buy = max(1, int(float(buy or 1)))
                except (TypeError, ValueError):
                    return jsonify({'error': 'buy must be a number or "same"'}), 400
            try:                                  # bad input is the caller's fault, not a 500
                lo, hi = float(r.get('min') or 0), float(r.get('max') or 0)
            except (TypeError, ValueError):
                return jsonify({'error': 'min and max must be numbers'}), 400
            clean.append({'unit': (r.get('unit') or '').strip(),
                          'min': lo, 'max': hi, 'buy': buy})
        # merges into the existing config blob, so sites and tablet timings are untouched
        q("""INSERT INTO kitchen_settings (id, config, updated_at) VALUES (1, %s::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET config = kitchen_settings.config || EXCLUDED.config,
                                            updated_at = now()""",
          (json.dumps({'recipe_conversions': clean}),), fetch='none')
        return jsonify(clean)
    except Exception as e:
        return _err(e)

# Hebrew plurals and construct forms, so בצלים finds בצל and תפוח אדמה finds תפוחי אדמה.
_FINALS = str.maketrans('ךםןףץ', 'כמנפצ')   # ךםןףץ -> כמנפצ

def _stem(w, is_last):
    """Strip a plural ending. Deliberately conservative:
    - only יות / ות / ים, never a final ה or ת. Stripping ה would make חלבה (halva) match
      חלב (milk); stripping ת would make שמנת (cream) match שמן (oil).
    - a stem must keep >= 3 letters, so מים does not collapse to מ.
    - a trailing י is the construct form (תפוחי אדמה) and is only dropped on a NON-final
      word, where that form actually occurs."""
    w = w.translate(_FINALS)
    for suf in ('יות', 'ות', 'ים'):
        # ⚠ the suffix needs the SAME final-letter normalisation as the word: בצלים becomes
        # regular-mem above, so a suffix still holding the FINAL mem would never match.
        suf = suf.translate(_FINALS)
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[:-len(suf)]
    if not is_last and w.endswith('י') and len(w) >= 4:
        return w[:-1]
    return w

def _words(name):
    ws = re.sub(r'\s+', ' ', (name or '').strip()).split()
    return [_stem(w, i == len(ws) - 1) for i, w in enumerate(ws)]

def _same_ingredient(a, b):
    """Are these two ingredient names the same thing?

    Compared word by word on stems, so plural/singular and construct forms match:
      בצל / בצלים · תפוח אדמה / תפוחי אדמה · מלח / מלח גס

    Hebrew puts the HEAD NOUN FIRST, so an addition extends a name to the RIGHT. A word added on
    the LEFT changes what the thing IS, and must NOT match:
      עגבניות / רסק עגבניות (tomatoes vs tomato PASTE) · פלפל שחור / פלפל חריף
    So: the shorter word-list must be a PREFIX of the longer one. Never a suffix."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return False
    short, long_ = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    return long_[:len(short)] == short



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
            # ⚠ Rank the candidates - two earlier rules each picked the WRONG product:
            #   "longest name wins" made בצלים match בצל אדום (red onion) over plain בצל;
            #   "fewest words wins" made תפוח אדמה match תפוחים (apples) over תפוחי אדמה.
            # So: an exact stem match always wins; only then prefer the closest length.
            want = _words(name)

            def _rank(prod):
                wp = _words(prod['name'].strip())
                return (0 if wp == want else 1, abs(len(wp) - len(want)), len(prod['name'].strip()))

            cands = [p for p in prods if _same_ingredient(p['name'].strip(), name)]
            if cands:
                hit, how = min(cands, key=_rank)['id'], 'fuzzy'
        it['product_id'], it['match'] = hit, how
    return items

def _rematch_recipes(recipe_id=None):
    """A recipe row keeps the product it matched AT IMPORT, and nothing ever revisited it - so a
    product created later could never reach the recipes imported without it (אריסה stayed 'missing'
    after the product existed). Re-resolve the open rows against the products as they are NOW.

    'Open' is not just product_id IS NULL: products/delete is a SOFT delete, so a row can point at an
    inactive product that would otherwise be added to the shopping list forever."""
    sql = ("""SELECT i.id, i.recipe_id, i.parsed_name, i.raw_line, i.product_id AS cur_pid
                FROM kitchen_recipe_items i
                LEFT JOIN kitchen_products p ON p.id = i.product_id
               WHERE (i.product_id IS NULL OR p.active IS NOT TRUE)""")
    args = ()
    if recipe_id:
        sql += " AND i.recipe_id=%s"; args = (recipe_id,)
    rows = q(sql, args or None)
    if not rows:
        return []
    items = [{'parsed_name': r['parsed_name']} for r in rows]
    _match_products(items)                      # exact -> learned alias -> whole-word-prefix fuzzy
    fixed = []
    for r, it in zip(rows, items):
        if not it.get('product_id'):
            # its product was soft-deleted and nothing replaces it: the row must go back to
            # unmatched, or the list would keep being offered a product that no longer exists.
            if r['cur_pid'] is not None:
                q("UPDATE kitchen_recipe_items SET product_id=NULL, updated_at=now() WHERE id=%s",
                  (r['id'],), fetch='none')
            continue
        q("UPDATE kitchen_recipe_items SET product_id=%s, updated_at=now() WHERE id=%s",
          (it['product_id'], r['id']), fetch='none')
        fixed.append({'item_id': r['id'], 'recipe_id': r['recipe_id'],
                      'name': r['parsed_name'], 'product_id': it['product_id']})
        # the "חסר: X" line this recipe put on a list is now untrue - drop it. Scoped through the
        # recipe's own link rows, so nothing the user added by hand is ever touched.
        q("""DELETE FROM kitchen_shopping_items si
              USING kitchen_list_recipe_items li, kitchen_list_recipes lr
              WHERE li.item_id = si.id AND li.kind = 'missing'
                AND lr.id = li.list_recipe_id AND lr.recipe_id = %s
                AND si.free_text = %s""",
          (r['recipe_id'], 'חסר: ' + (r['parsed_name'] or '')), fetch='none')
    if fixed:
        log.info('rematch: %d recipe row(s) resolved', len(fixed))
    return fixed

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
        rows = []
        for it in parsed['items']:
            qty, unit, name, note = _norm_ingredient(it['raw_line'])
            if not name:
                # The site sometimes puts a note on its own line - "(כל קופסת טונה 160 ג')".
                # Stripping the brackets leaves nothing, so it used to become an empty row.
                # It belongs to the ingredient above it.
                if rows:
                    prev = rows[-1]
                    prev['note'] = ((prev.get('note') + ' ') if prev.get('note') else '') + it['raw_line'].strip()
                continue
            it.update({'sort_order': len(rows), 'qty': qty, 'unit': unit, 'parsed_name': name, 'note': note})
            rows.append(it)
        parsed['items'] = rows
        _match_products(parsed['items'])
        # NOT merged: a recipe is stored exactly as the site writes it. Merging duplicate
        # products here made a shopping list out of it and threw the detail away - the oil in
        # פריקסה became one 240 מל row instead of the 60 and 180 the method actually calls for,
        # and 3 of 14 lines vanished. The shopping list still ends up with one of each, because
        # add-recipe skips a product that is already on the list (the common-quantity rule).
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
        _rematch_recipes()          # the same ingredient in every OTHER recipe learns it too
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/recipes')
def recipes_list():
    try:
        sql = ("SELECT r.*, c.name AS category_name, c.emoji AS category_emoji, "
               "(SELECT count(*) FROM kitchen_recipe_items i WHERE i.recipe_id=r.id) AS item_count, "
               # in the tablet's refresh signature: without it a re-match changes nothing the
               # tablet can notice, and it keeps serving a cached 'missing' until a manual reload
               "(SELECT count(*) FROM kitchen_recipe_items i WHERE i.recipe_id=r.id AND i.product_id IS NOT NULL) AS matched_count "
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
                # Safety net: recipe deletes are HARD now, so an inactive row should not exist. If one
                # ever does (set by hand, or a future soft-delete), revive it rather than refusing to
                # re-import a recipe the user cannot see - that was a dead end before 2026-09-03.
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
        # HARD delete. Products and categories are soft-deleted because other rows point at them;
        # nothing points at a recipe except its own ingredient rows, which go with it via
        # ON DELETE CASCADE. Keeping dead recipes only made the table read 3 when the user had 1.
        q("DELETE FROM kitchen_recipes WHERE id=%s", (rid,), fetch='none')
        return jsonify({'ok': True})
    except Exception as e:
        return _err(e)

if __name__ == '__main__':
    log.info('kitchen-service starting on :%d (static=%s)', PORT, STATIC_DIR)
    app.run(host='0.0.0.0', port=PORT, threaded=True)
