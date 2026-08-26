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
  GET  /api/kitchen/list                -> the active shopping list + its items
  POST /api/kitchen/list/add            -> add an item (product_id | free_text, qty)
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
        sql = "SELECT * FROM kitchen_products"
        if request.args.get('all') != '1':
            sql += " WHERE active IS NOT FALSE"
        sql += " ORDER BY sort_order, name"
        return jsonify(q(sql))
    except Exception as e:
        return _err(e)

@app.route('/api/kitchen/products', methods=['POST'])
def products_upsert():
    try:
        b = request.get_json(force=True, silent=True) or {}
        name = (b.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name required'}), 400
        p = {
            'name': name,
            'name_en': b.get('name_en'),
            'category': b.get('category'),
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
        }
        pid = b.get('id')
        if pid:
            row = q("""UPDATE kitchen_products SET
                         name=%(name)s, name_en=%(name_en)s, category=%(category)s, emoji=%(emoji)s,
                         unit=%(unit)s, price=%(price)s, calories_per_unit=%(calories_per_unit)s,
                         nutri_score=%(nutri_score)s, health_score=%(health_score)s, barcode=%(barcode)s,
                         notes=%(notes)s, sort_order=%(sort_order)s, allergens=%(allergens)s::jsonb,
                         updated_at=now()
                       WHERE id=%(id)s RETURNING *""",
                    {**p, 'id': pid}, fetch='one')
        else:
            row = q("""INSERT INTO kitchen_products
                         (name,name_en,category,emoji,unit,price,calories_per_unit,nutri_score,
                          health_score,barcode,notes,sort_order,allergens)
                       VALUES (%(name)s,%(name_en)s,%(category)s,%(emoji)s,%(unit)s,%(price)s,
                          %(calories_per_unit)s,%(nutri_score)s,%(health_score)s,%(barcode)s,
                          %(notes)s,%(sort_order)s,%(allergens)s::jsonb)
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
        items = q("""SELECT i.*, p.name AS product_name, p.emoji AS product_emoji
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
        row = q("""INSERT INTO kitchen_shopping_items (list_id, product_id, free_text, qty)
                   VALUES (%s,%s,%s,%s) RETURNING *""",
                (_active_list_id(), pid, ft, b.get('qty') or 1), fetch='one')
        return jsonify(row)
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
