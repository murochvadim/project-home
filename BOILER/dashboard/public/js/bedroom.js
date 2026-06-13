// Bedroom Agent — page logic.
// Dashboard-only agent (no LXC service). Tab switcher + refresh stub for now;
// per-tab feature wiring is added here as features arrive.
(function () {
  function showTab(name, btn) {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    const panel = document.getElementById('tab-' + name);
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
  }
  window.showTab = showTab;

  function refreshPage() {
    const el = document.getElementById('last-refresh');
    if (el) el.textContent = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' });
    // Per-tab refresh wiring added later as features are built.
  }
  window.refreshPage = refreshPage;
  window.addEventListener('DOMContentLoaded', refreshPage);
})();
