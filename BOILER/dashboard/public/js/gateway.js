// Project Gateway — frontend for the NetBird peer identity overlay + tenant
// alert settings. Polls /api/gateway/peers, /api/gateway/routes,
// /api/gateway/settings, /api/gateway/status, /api/gateway/events every
// REFRESH_MS milliseconds.
//
// Until the NETBIRD_API_TOKEN is configured in BOILER/dashboard/.env, the
// /api/gateway/* endpoints return 503; this shell renders a friendly
// "token missing" message in each card instead of error states.
//
// See NETBIRD/CLAUDE.md for the agent's full architecture.

(function () {
  const REFRESH_MS = 10_000;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ageString(iso) {
    if (!iso) return '—';
    const sec = (Date.now() - new Date(iso).getTime()) / 1000;
    if (sec < 60)   return `${Math.round(sec)} s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)} m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
    return `${Math.round(sec / 86400)} d ago`;
  }

  function statusDot(status) {
    const ok = (status || '').toLowerCase() === 'connected' || status === true;
    const color = ok ? '#27ae60' : '#c0392b';
    return `<span style="color:${color}; font-size:1.1rem;">●</span> <span style="color:${ok ? '#1a1a1a' : '#888'};">${esc(status || 'Offline')}</span>`;
  }

  function severityChip(sev) {
    const map = { info: '#888', warn: '#e67e22', error: '#c0392b', critical: '#c0392b' };
    const color = map[(sev || '').toLowerCase()] || '#666';
    return `<span style="background:${color}; color:#fff; padding:2px 8px; border-radius:10px; font-size:0.72rem; text-transform:uppercase;">${esc(sev || '?')}</span>`;
  }

  // ─── Status header ────────────────────────────────────────────────
  async function loadStatus() {
    const line = document.getElementById('gw-status-line');
    if (!line) return;
    try {
      const r = await fetch('/api/gateway/status');
      const d = await r.json().catch(() => ({}));
      if (r.status === 503) {
        line.style.color = '#e67e22';
        line.innerHTML = `⚠ ${esc(d.error || 'NetBird API token not configured')} — add <code>NETBIRD_API_TOKEN</code> to <code>BOILER/dashboard/.env</code> and restart the dashboard via <code>pm2 delete + start</code>.`;
        return;
      }
      if (!r.ok) {
        line.style.color = '#c0392b';
        line.textContent = `Error: ${d.error || r.statusText}`;
        return;
      }
      const peers   = d.peers   || { total: 0, online: 0 };
      const routes  = d.routes  || { total: 0, healthy: 0 };
      const alerts  = d.alerts  || { active: 0 };
      const allGood = (peers.online === peers.total) && (routes.healthy === routes.total) && alerts.active === 0;
      const color   = allGood ? '#27ae60' : (alerts.active > 0 ? '#c0392b' : '#e67e22');
      line.style.color = color;
      line.innerHTML = `
        <span style="font-weight:600;">NetBird tenant:</span>
        ${peers.online}/${peers.total} peers online ·
        ${routes.healthy}/${routes.total} routes healthy ·
        ${alerts.active} active alert${alerts.active === 1 ? '' : 's'}
      `;
    } catch (e) {
      line.style.color = '#c0392b';
      line.textContent = `Fetch error: ${e.message}`;
    }
  }

  // ─── Peers card ───────────────────────────────────────────────────
  async function loadPeers() {
    const tbody = document.getElementById('gw-peers-tbody');
    if (!tbody) return;
    try {
      const r = await fetch('/api/gateway/peers');
      const d = await r.json().catch(() => ({}));
      if (r.status === 503) {
        tbody.innerHTML = `<tr><td colspan="9" style="padding:14px; text-align:center; color:#e67e22;">⚠ ${esc(d.error || 'Token missing — see status above.')}</td></tr>`;
        return;
      }
      if (!r.ok) {
        tbody.innerHTML = `<tr><td colspan="9" style="padding:14px; text-align:center; color:#c0392b;">Error: ${esc(d.error || r.statusText)}</td></tr>`;
        return;
      }
      const peers = Array.isArray(d.peers) ? d.peers : [];
      if (!peers.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="padding:14px; text-align:center; color:#aaa;">No peers in tenant yet.</td></tr>';
        return;
      }
      tbody.innerHTML = peers.map(p => `
        <tr style="border-top:1px solid #f0eee8;">
          <td style="padding:6px 12px; font-weight:600;">${esc(p.name)}</td>
          <td style="padding:6px 12px; color:#666;">${esc(p.fqdn || '')}</td>
          <td style="padding:6px 12px; text-align:center; font-family:monospace; color:#444;">${esc(p.ip || '—')}</td>
          <td style="padding:6px 12px; text-align:center;">${statusDot(p.connected ? 'Connected' : 'Offline')}</td>
          <td style="padding:6px 12px; text-align:center; color:#888;">${p.connected ? '<span style="color:#27ae60;">active</span>' : esc(ageString(p.last_seen))}</td>
          <td style="padding:6px 12px;">${esc(p.user_name || '—')}</td>
          <td style="padding:6px 12px;">${esc(p.role || '—')}</td>
          <td style="padding:6px 12px;">${esc(p.device_label || '—')}</td>
          <td style="padding:6px 12px; text-align:center; white-space:nowrap;">
            <button onclick="gwEditPeer('${esc(p.peer_id)}')" style="padding:2px 7px; font-size:0.7rem; background:#fff; border:1px solid #888; color:#444; border-radius:3px; cursor:pointer;">Edit</button>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" style="padding:14px; text-align:center; color:#c0392b;">Fetch error: ${esc(e.message)}</td></tr>`;
    }
  }

  // ─── Routes card ──────────────────────────────────────────────────
  async function loadRoutes() {
    const tbody = document.getElementById('gw-routes-tbody');
    if (!tbody) return;
    try {
      const r = await fetch('/api/gateway/routes');
      const d = await r.json().catch(() => ({}));
      if (r.status === 503) {
        tbody.innerHTML = `<tr><td colspan="4" style="padding:14px; text-align:center; color:#e67e22;">⚠ ${esc(d.error || 'Token missing — see status above.')}</td></tr>`;
        return;
      }
      if (!r.ok) {
        tbody.innerHTML = `<tr><td colspan="4" style="padding:14px; text-align:center; color:#c0392b;">Error: ${esc(d.error || r.statusText)}</td></tr>`;
        return;
      }
      const routes = Array.isArray(d.routes) ? d.routes : [];
      if (!routes.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding:14px; text-align:center; color:#aaa;">No routes configured.</td></tr>';
        return;
      }
      tbody.innerHTML = routes.map(r => `
        <tr style="border-top:1px solid #f0eee8;">
          <td style="padding:6px 12px; font-weight:600;">${esc(r.network_name || r.name || '—')}</td>
          <td style="padding:6px 12px; text-align:center; font-family:monospace;">${esc(r.cidr || r.network || '—')}</td>
          <td style="padding:6px 12px;">${esc((r.routing_peers || []).join(', ') || '—')}</td>
          <td style="padding:6px 12px; text-align:center;">${statusDot(r.enabled ? 'Connected' : 'Offline')}</td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" style="padding:14px; text-align:center; color:#c0392b;">Fetch error: ${esc(e.message)}</td></tr>`;
    }
  }

  // ─── Tenant settings card ─────────────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch('/api/gateway/settings');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return;
      const newPeerEl = document.getElementById('gw-alert-new-peer');
      const routeEl   = document.getElementById('gw-alert-route-drop');
      const pollEl    = document.getElementById('gw-poll-interval');
      const trustedEl = document.getElementById('gw-trusted-peers');
      if (newPeerEl) newPeerEl.checked = !!d.alert_new_peer;
      if (routeEl)   routeEl.checked   = !!d.alert_route_drop;
      if (pollEl)    pollEl.value      = d.poll_interval_sec || 60;
      if (trustedEl) {
        const tp = Array.isArray(d.trusted_peers) ? d.trusted_peers : [];
        trustedEl.textContent = tp.length
          ? `${tp.length} trusted peers configured`
          : '(none — any peer joining the tenant counts as "new" for the alert)';
      }
    } catch (_) { /* keep prior state on transient fail */ }
  }

  // Trust all currently-connected NetBird peers in one click.
  // After save, alerts auto-resolve on the next watchdog tick (≤5 min) — or
  // hit "Run watchdog now" alongside for instant clearance.
  window.gwTrustAll = async function () {
    const msg = document.getElementById('gw-settings-msg');
    msg.style.color = '#888';
    msg.textContent = 'Trusting all current peers…';
    try {
      const pr = await fetch('/api/gateway/peers');
      const pd = await pr.json().catch(() => ({}));
      if (!pr.ok) throw new Error(pd.error || pr.statusText);
      const ids = (pd.peers || []).map(p => p.peer_id).filter(Boolean);
      if (!ids.length) { msg.textContent = 'No peers to trust.'; return; }
      const sr = await fetch('/api/gateway/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trusted_peers: ids }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok) throw new Error(sd.error || sr.statusText);
      msg.style.color = '#27ae60';
      msg.textContent = `✓ ${ids.length} peers trusted. Run watchdog now to clear alerts immediately, or wait ≤5 min for cron.`;
      loadSettings();
    } catch (e) {
      msg.style.color = '#c0392b';
      msg.textContent = `Error: ${e.message}`;
    }
  };

  // Trigger the LXC 104 watchdog NOW (SSH from dashboard server.js).
  // Without this the next tick is whenever cron decides — up to 5 min away.
  window.gwRunWatchdog = async function () {
    const msg = document.getElementById('gw-settings-msg');
    msg.style.color = '#888';
    msg.textContent = 'Running watchdog on LXC 104…';
    try {
      const r = await fetch('/api/gateway/watchdog/run', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      msg.style.color = '#27ae60';
      msg.textContent = `✓ Watchdog ran: ${d.summary || 'OK'}. Refreshing events…`;
      setTimeout(() => { loadEvents(); loadStatus(); }, 500);
    } catch (e) {
      msg.style.color = '#c0392b';
      msg.textContent = `Error: ${e.message}`;
    }
  };

  window.gwSaveSettings = async function () {
    const msg = document.getElementById('gw-settings-msg');
    msg.style.color = '#888';
    msg.textContent = 'Saving…';
    const body = {
      alert_new_peer:    document.getElementById('gw-alert-new-peer').checked,
      alert_route_drop:  document.getElementById('gw-alert-route-drop').checked,
      poll_interval_sec: parseInt(document.getElementById('gw-poll-interval').value, 10) || 60,
    };
    try {
      const r = await fetch('/api/gateway/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.style.color = '#c0392b';
        msg.textContent = `Error: ${d.error || r.statusText}`;
        return;
      }
      msg.style.color = '#27ae60';
      msg.textContent = '✓ Saved';
      setTimeout(() => { msg.textContent = ''; }, 2500);
    } catch (e) {
      msg.style.color = '#c0392b';
      msg.textContent = `Error: ${e.message}`;
    }
  };

  // ─── Events card ──────────────────────────────────────────────────
  async function loadEvents() {
    const tbody = document.getElementById('gw-events-tbody');
    if (!tbody) return;
    try {
      const r = await fetch('/api/gateway/events?limit=20');
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(d.events)) return;
      if (!d.events.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:14px; text-align:center; color:#aaa;">No NetBird events yet.</td></tr>';
        return;
      }
      tbody.innerHTML = d.events.map(e => {
        const resolved = !!e.resolved_at;
        const opacity = resolved ? 'opacity:0.55;' : '';
        return `
          <tr style="border-top:1px solid #f0eee8; ${opacity}">
            <td style="padding:6px 12px; color:#666;">${esc(ageString(e.ts))}</td>
            <td style="padding:6px 12px; font-family:monospace; color:#444;">${esc(e.alert_type)}</td>
            <td style="padding:6px 12px; text-align:center;">${severityChip(e.severity)}</td>
            <td style="padding:6px 12px;">${esc(e.message)}</td>
            <td style="padding:6px 12px; text-align:center; color:${resolved ? '#27ae60' : '#c0392b'};">${resolved ? '✓ resolved' : 'active'}</td>
          </tr>
        `;
      }).join('');
    } catch (_) { /* transient — leave prior render */ }
  }

  // ─── Clear resolved NetBird events ───────────────────────────────
  window.gwClearResolvedEvents = async function () {
    if (!confirm('Delete ALL resolved netbird:* alerts? Active alerts will be kept.')) return;
    try {
      const r = await fetch('/api/gateway/events/clear-resolved', { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { await loadEvents(); }
      else alert('Clear failed: ' + (d.error || r.statusText));
    } catch (e) { alert('Clear failed: ' + e.message); }
  };

  // ─── Clear peer transitions (keep last 10 as a safety window) ─────
  window.gwClearTransitions = async function () {
    if (!confirm('Clear the peer-transitions log? This deletes all logged transitions except the most recent 10.')) return;
    try {
      const r = await fetch('/api/gateway/transitions/clear', { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { await loadTransitions(); }
      else alert('Clear failed: ' + (d.error || r.statusText));
    } catch (e) { alert('Clear failed: ' + e.message); }
  };

  // ─── Transitions card ────────────────────────────────────────────
  async function loadTransitions() {
    const tbody = document.getElementById('gw-transitions-tbody');
    if (!tbody) return;
    try {
      const r = await fetch('/api/gateway/transitions?limit=20');
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !Array.isArray(d.transitions)) return;
      if (!d.transitions.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding:14px; text-align:center; color:#aaa;">No transitions logged yet.</td></tr>';
        return;
      }
      tbody.innerHTML = d.transitions.map(t => {
        const went_offline = t.to_state === 'disconnected';
        const arrow = went_offline ? '↓' : '↑';
        const color = went_offline ? '#c0392b' : '#27ae60';
        return `
          <tr style="border-top:1px solid #f0eee8;">
            <td style="padding:6px 12px; color:#666;">${esc(ageString(t.ts))}</td>
            <td style="padding:6px 12px; font-weight:600;">${esc(t.peer_name || t.peer_id)}</td>
            <td style="padding:6px 12px; text-align:center; color:${color}; font-family:monospace;">
              ${esc(t.from_state)} ${arrow} ${esc(t.to_state)}
            </td>
            <td style="padding:6px 12px; color:#888; font-size:0.85rem;">${esc(t.source || 'dashboard_cache')}</td>
          </tr>
        `;
      }).join('');
    } catch (_) { /* transient — leave prior render */ }
  }

  // ─── Inline peer edit (modal opens via gwEditPeer; PATCH on save) ─
  let _editingPeer = null;

  window.gwEditPeer = async function (peerId) {
    // Find the peer in the last-fetched list. Re-fetch if stale.
    const r = await fetch('/api/gateway/peers');
    const d = await r.json().catch(() => ({}));
    const p = (d.peers || []).find(x => x.peer_id === peerId);
    if (!p) { alert('Peer not found in latest fetch.'); return; }
    _editingPeer = p;
    const name = esc(p.name);
    const inp = 'padding:7px 10px; border:1px solid #d0cbc4; border-radius:4px; font-size:0.95rem; width:100%; box-sizing:border-box;';
    const html = `
      <div id="gw-edit-modal" style="position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:1010; display:flex; align-items:center; justify-content:center;">
        <div style="background:#fff; max-width:720px; width:92%; max-height:92vh; overflow-y:auto; border-radius:8px; padding:26px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
            <h2 style="margin:0; font-size:1.2rem;">Edit peer — ${name}</h2>
            <button onclick="gwEditClose()" style="background:none; border:none; font-size:1.5rem; cursor:pointer; color:#888;">✕</button>
          </div>
          <div style="color:#888; font-size:0.85rem; margin-bottom:18px;">
            FQDN: <code>${esc(p.fqdn)}</code> · NetBird IP: <code>${esc(p.ip)}</code> · ID: <code>${esc(p.peer_id)}</code>
          </div>
          <div style="display:grid; grid-template-columns:180px 1fr; gap:14px 18px; align-items:center;">
            <label for="gw-edit-user">User name:</label>
            <input id="gw-edit-user" type="text" placeholder="e.g. muroch, Maya, Guy" value="${esc(p.user_name || '')}" style="${inp}" />

            <label for="gw-edit-role">Role:</label>
            <select id="gw-edit-role" style="${inp}">
              <option value="">— pick —</option>
              <option value="admin"      ${p.role === 'admin' ? 'selected' : ''}>admin</option>
              <option value="family"     ${p.role === 'family' ? 'selected' : ''}>family</option>
              <option value="guest"      ${p.role === 'guest' ? 'selected' : ''}>guest</option>
              <option value="contractor" ${p.role === 'contractor' ? 'selected' : ''}>contractor</option>
            </select>

            <label for="gw-edit-device">Device label:</label>
            <input id="gw-edit-device" type="text" placeholder="e.g. iPhone 14, newasus laptop" value="${esc(p.device_label || '')}" style="${inp}" />

            <label for="gw-edit-offline-min">Offline alert after (min):</label>
            <input id="gw-edit-offline-min" type="number" min="0" max="10080" placeholder="empty = default (60 min) · 0 = no alert" value="${p.alert_offline_min ?? ''}" style="padding:7px 10px; border:1px solid #d0cbc4; border-radius:4px; font-size:0.95rem; width:260px; box-sizing:border-box;" />

            <label for="gw-edit-on-join" style="line-height:1.3;">Alert when peer reconnects after long absence:</label>
            <input id="gw-edit-on-join" type="checkbox" ${p.alert_on_join ? 'checked' : ''} style="justify-self:start; transform:scale(1.2);" />

            <label for="gw-edit-notes" style="align-self:start; padding-top:7px;">Notes:</label>
            <textarea id="gw-edit-notes" rows="4" style="${inp}; resize:vertical;">${esc(p.notes || '')}</textarea>
          </div>
          <div id="gw-edit-msg" style="margin-top:14px; font-size:0.92rem; min-height:1.2em;"></div>
          <div style="margin-top:18px; display:flex; gap:12px;">
            <button class="btn btn-primary btn-sm" onclick="gwEditSave()" style="padding:9px 22px; font-size:0.95rem;">💾 Save</button>
            <button class="btn btn-secondary btn-sm" onclick="gwEditClose()" style="padding:9px 22px; font-size:0.95rem;">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  };

  window.gwEditClose = function () {
    _editingPeer = null;
    const el = document.getElementById('gw-edit-modal');
    if (el) el.remove();
  };

  window.gwEditSave = async function () {
    if (!_editingPeer) return;
    const msg = document.getElementById('gw-edit-msg');
    msg.style.color = '#888';
    msg.textContent = 'Saving…';
    const rawOffline = document.getElementById('gw-edit-offline-min').value.trim();
    const body = {
      user_name:         document.getElementById('gw-edit-user').value.trim() || null,
      role:              document.getElementById('gw-edit-role').value || null,
      device_label:      document.getElementById('gw-edit-device').value.trim() || null,
      alert_offline_min: rawOffline === '' ? null : parseInt(rawOffline, 10),
      alert_on_join:     document.getElementById('gw-edit-on-join').checked,
      notes:             document.getElementById('gw-edit-notes').value.trim() || null,
    };
    try {
      const r = await fetch(`/api/gateway/peer/${encodeURIComponent(_editingPeer.peer_id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.style.color = '#c0392b';
        msg.textContent = `Error: ${d.error || r.statusText}`;
        return;
      }
      msg.style.color = '#27ae60';
      msg.textContent = '✓ Saved';
      setTimeout(() => { gwEditClose(); loadPeers(); }, 600);
    } catch (e) {
      msg.style.color = '#c0392b';
      msg.textContent = `Error: ${e.message}`;
    }
  };

  // ─── Refresh loop ─────────────────────────────────────────────────
  window.refreshAll = function () {
    loadStatus();
    loadPeers();
    loadRoutes();
    loadSettings();
    loadEvents();
    loadTransitions();
    const el = document.getElementById('last-refresh');
    if (el) {
      el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  });
})();
