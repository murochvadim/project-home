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
import json, logging
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

if __name__ == '__main__':
    log.info('kitchen-service starting on :%d (static=%s)', PORT, STATIC_DIR)
    app.run(host='0.0.0.0', port=PORT, threaded=True)
