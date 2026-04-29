---
name: pss-update
description: Make a routine update to the UPS subsystem — status check, threshold adjustment, SAFETY_MODE toggle, orchestrator edit, peer add/remove, going-live procedure. Read [UPS/CLAUDE.md](UPS/CLAUDE.md) first.
---

# /pss-update — UPS subsystem update

Use this skill when you need to change something about the home UPS setup. Reads [UPS/CLAUDE.md](UPS/CLAUDE.md) for context every run, then walks through one of the named actions below.

## Step 0: Action

Use `AskUserQuestion` to pick:

- **Status** — read live UPS state, recent events, polling daemon health, current SAFETY_MODE / BATTERYLEVEL values. Read-only.
- **Adjust BATTERYLEVEL** — change the trigger threshold on PVE (`/etc/apcupsd/apcupsd.conf`).
- **Toggle SAFETY_MODE** — flip the orchestrator between log-only and live (creates or removes `/etc/apcupsd/SAFETY_MODE` on PVE).
- **Edit orchestrator** — modify `/etc/apcupsd/doshutdown` to add/remove a peer device, change shutdown order, change timeouts.
- **Go live** — full going-live procedure (Phase 4 from UPS/CLAUDE.md): bump BATTERYLEVEL, enable apcupsd at boot, remove SAFETY_MODE, run BATTERYLEVEL=95 + mains-pull verification.
- **Audit** — read-only sanity check across PVE master + LXC 105 slave + DB table + dashboard endpoints. Reports broken state, drift, or stale data.

If user picks something unclear, ask one short clarifying question.

## Universal pre-flight (every run)

Before touching anything, run a 3-line read-only sanity check:

```bash
ssh root@192.168.1.101 'systemctl is-active apcupsd && apcaccess status | head -8'
ssh root@192.168.1.187 'systemctl is-active net-ups-poll.timer && tail -1 /var/log/net-ups-poll.log'
ssh root@192.168.1.219 'psql -U postgres -d home_data -c "SELECT MAX(ts), COUNT(*) FROM ups_status WHERE ts > NOW() - interval '"'"'10 min'"'"'"'
```

If any of: master daemon inactive, polling timer not active, fewer than 8 rows in last 10 min — STOP and surface the discrepancy. Don't proceed with the action.

## Action: Status

Just shows live state. No changes. Useful when user wants to know "is it working right now?" Format:

```
UPS:        ONLINE / ONLINE SLAVE / ONBATT / COMMLOST
Battery:    98% (BATTV 27.2 V — healthy)
Runtime:    62 min estimated at current load (0%)
Line V:     232 V (normal range)
Polling:    last run 2026-04-29 14:09:05, 12 rows in last 10 min
SAFETY_MODE: present (orchestrator log-only)
BATTERYLEVEL: 5
Recent events: (last 5 lines from /var/log/apcupsd.events)
```

## Action: Adjust BATTERYLEVEL

Ask: "What value? (typical 30 for production, 95 for mains-pull testing, 5 for paranoid-safe)"

Validate:
- Must be 1-99
- If user picks > 50, warn: "this is high — mains-pull test territory. Confirm?"
- If SAFETY_MODE is absent AND user picks > 50, double-confirm: "this WILL fire the real orchestrator on the next mains pull. Confirm?"

Apply:
```bash
ssh root@192.168.1.101 'sed -i "s/^BATTERYLEVEL.*/BATTERYLEVEL   $NEW_VAL/" /etc/apcupsd/apcupsd.conf && systemctl restart apcupsd && sleep 4 && grep "^BATTERYLEVEL" /etc/apcupsd/apcupsd.conf && apcaccess status | grep MBATTCHG'
```

Verify the new value reads back correctly. Don't trust the sed — confirm by re-reading.

## Action: Toggle SAFETY_MODE

Ask: "Currently `SAFETY_MODE` is [present/absent]. Switch to [absent/present]?"

If switching from present → absent (going live):
- Confirm explicitly: "After this, the orchestrator will fire for real on the next BATTERYLEVEL trigger."
- Verify SSH to QNAP works first (if QNAP is on UPS): run `_ups_test_qnap_ssh` test. If it returns "Permission denied", warn and ask if user wants to proceed anyway (orchestrator will log the failure but continue).

Apply:
```bash
# Remove (going live)
ssh root@192.168.1.101 'rm -f /etc/apcupsd/SAFETY_MODE && (ls /etc/apcupsd/SAFETY_MODE 2>&1 | head -1)'

# Restore (back to log-only)
ssh root@192.168.1.101 'touch /etc/apcupsd/SAFETY_MODE && ls -la /etc/apcupsd/SAFETY_MODE'
```

## Action: Edit orchestrator

Ask: "What change?"
- Add a new peer device (SSH `poweroff` to a new IP)
- Remove a peer
- Change shutdown order
- Change timeout (e.g. give HA more flush time)
- Change PEER_TIMEOUT for unreachable hosts
- Other (free-form)

Read `/etc/apcupsd/doshutdown` from PVE first, propose the diff, get explicit user approval, then write back via `cat > … << EOF` heredoc (don't use sed for multi-line changes — too fragile).

After every write: `bash -n /etc/apcupsd/doshutdown` syntax check, then run the orchestrator with SAFETY_MODE active to confirm the dry-run path still exits 0.

## Action: Go live

This is Phase 4 from UPS/CLAUDE.md. Run as a sequenced procedure with confirmation at each step. The skill should NOT proceed past any step that fails.

**Sequence:**

1. **Pre-check P1-P3** — ask user verbally:
   - PVE physically plugged into UPS output? (yes/no)
   - BIOS "Restore on Power Loss" verified? (yes/no)
   - QNAP/switch on UPS? (which exactly)
   If any "no", STOP. The user must do these physically first.

2. **Pre-check P4** — current BCHARGE > 50%:
   ```bash
   ssh root@192.168.1.101 'apcaccess status | grep BCHARGE'
   ```
   If < 50%, STOP. Tell user to wait until UPS is more charged.

3. **Install QNAP pubkey** (only if QNAP on UPS):
   - Show pubkey: `cat /root/.ssh/id_ed25519_ups.pub` on PVE
   - Tell user to paste into `/share/homes/admin/.ssh/authorized_keys` on QNAP
   - Verify: run `_ups_test_qnap_ssh` test. Must return exit 0 + "qnap-reachable".
   If user skips (QNAP not on UPS), continue.

4. **Bump BATTERYLEVEL to 30** — call this skill's "Adjust BATTERYLEVEL" action with value 30.

5. **Enable apcupsd at boot**:
   ```bash
   ssh root@192.168.1.101 'systemctl enable apcupsd && systemctl is-enabled apcupsd'
   ```

6. **Remove SAFETY_MODE** — call this skill's "Toggle SAFETY_MODE" action.

7. **Verify**: dashboard `_ups_test_dryrun` test should now show real orchestrator logic running (peer SSH attempts, pct/qm shutdown commands logged) — but no actual shutdown unless mains is actually low. Inspect the log tail.

8. **BATTERYLEVEL=95 verification test** (with strong confirmation):
   - Warn user: "this WILL trigger a real shutdown. Confirm by typing 'yes-shutdown'."
   - On confirmation:
     ```bash
     ssh root@192.168.1.101 'sed -i "s/^BATTERYLEVEL.*/BATTERYLEVEL   95/" /etc/apcupsd/apcupsd.conf && systemctl restart apcupsd'
     ```
   - Tell user: "Now physically unplug mains from the UPS for 30 seconds. The full orchestrator will fire. Watch the UPS LCD."
   - Wait for user to confirm "test complete, system halted, replugged mains, PVE auto-booted".
   - On their confirm, restore production values:
     ```bash
     ssh root@192.168.1.101 'sed -i "s/^BATTERYLEVEL.*/BATTERYLEVEL   30/" /etc/apcupsd/apcupsd.conf && systemctl restart apcupsd && touch /etc/apcupsd/SAFETY_MODE.test_complete && grep "^BATTERYLEVEL" /etc/apcupsd/apcupsd.conf'
     ```
     (Note: do NOT touch SAFETY_MODE here — it must already be absent for the test to have actually fired. The marker file `SAFETY_MODE.test_complete` is just a breadcrumb for the audit action.)
   If KILLPOWER didn't fire (PVE didn't auto-boot), troubleshoot per the UPS/CLAUDE.md "Known quirks" section before declaring complete.

9. **Update UPS/CLAUDE.md "Phases" history** — add a line like:
   ```
   - 2026-MM-DD Phase 4 — going live: BATTERYLEVEL=30, SAFETY_MODE removed, BATTERYLEVEL=95 test passed, KILLPOWER + auto-boot verified.
   ```

## Action: Audit

Read-only sanity sweep. Reports each finding with severity. Checks:

| Check | Healthy state |
|---|---|
| PVE apcupsd active + USB comm | `STATUS=ONLINE`, BCHARGE > 30% |
| PVE apcupsd enabled at boot | `enabled` (so it survives reboots) |
| BATTERYLEVEL value | 30 in production, 5 if SAFETY_MODE present |
| SAFETY_MODE flag | Present pre-Phase-4, absent post-Phase-4 |
| LXC 105 slave active | Yes, reading master cleanly |
| Polling timer firing | Last fire ≤ 90 s ago, log has no errors |
| `ups_status` table growing | New rows every 60 s |
| Retention policy in DB | `ups_status` row in `retention_policies`, `auto_clean=true` |
| Latest UPS data on dashboard | `_ups_live` returns row with `age_sec` < 90 |
| `apcupsd.events` recent | At least startup events visible |
| QNAP SSH path | If QNAP on UPS: `_ups_test_qnap_ssh` returns exit 0 |
| KILLPOWER hook (post-test only) | `apcupsd-halt.service` exists and is enabled |
| `/etc/apcupsd/doshutdown` syntax | `bash -n` passes |
| Orchestrator file ownership | Owned by root, mode 755 |

Output format: same per-check table, with ✓ / ⚠ / ✗ marker per row. Followed by a one-line summary "audit clean / N findings".

## Important notes

- **Never edit `/etc/apcupsd/apcupsd.conf` without `apcupsd` restart afterward.** The daemon caches config at start.
- **Never call `apcaccess` without `apcupsd` running.** It will return "Connection refused".
- **Never remove `SAFETY_MODE` without confirming SSH to QNAP works** (if QNAP is on UPS). The orchestrator's first step is QNAP poweroff; if it fails the orchestrator continues but you've lost a peer.
- **Always verify the change after applying.** The skill should re-read the modified file/state and surface the actual value, not trust the sed return code.
- **All changes go through SSH to PVE / LXC 105 / LXC 102.** No code changes needed in this repo for routine updates — only for orchestrator script structure changes (which trigger a follow-up commit of the local source-of-truth copy if any).
