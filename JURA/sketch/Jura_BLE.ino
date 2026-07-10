/* Jura_BLE.ino — NimBLE client (poll-and-disconnect pattern)
 *
 *   Migrated Bluedroid → NimBLE on 2026-07-10. The root cause of the
 *   year-long "can't read stats" block was HEAP, not the protocol:
 *   Bluedroid + WiFi left only ~15-21 KB free on this ESP32, too little for
 *   GATT service/characteristic discovery — getCharacteristic() returned
 *   null (proven live: "poll-chars cmd=0 dat=0"). Freeing heap by turning
 *   WiFi off during the read reached 60 KB and discovery worked, but that
 *   left MQTT operating on a dead network stack and CRASHED the board
 *   (SW_CPU_RESET). NimBLE uses ~60-80 KB LESS RAM than Bluedroid and
 *   discovers characteristics on-demand, so BLE + WiFi coexist with plenty
 *   of headroom: discovery + the stats read succeed with WiFi STAYING ON.
 *   (The prior "NimBLE panics on ESP32-C3" note was C3-specific — this is a
 *   regular ESP32, where NimBLE is stable.)
 *
 *   Strategy unchanged — SHORT-LIVED BLE SESSIONS: every poll_interval_sec,
 *   connect → read stats → (send queued cmd) → disconnect. Between sessions
 *   the radio is idle so WiFi/MQTT get the air uncontested.
 *
 *   Simplifications vs the Bluedroid version:
 *     - Direct connect-by-address (NimBLE handles the BlueFrog's static-random
 *       address reliably; Bluedroid needed a scan-first dance).
 *     - No advertisement parsing: the encryption key is the static 0x2A
 *       already validated from the laptop, so it's hardcoded (still the
 *       Jutta-Proto key = manufacturer_data[171][0] on this dongle).
 *
 *   References:
 *     - https://github.com/Jutta-Proto/protocol-bt-cpp
 *     - https://github.com/AlexxIT/Jura   (key derivation)
 */

#include "Main.h"
#include <NimBLEDevice.h>

// ─── BLE state ────────────────────────────────────────────────────────────
static NimBLEClient*         _client = nullptr;
static NimBLERemoteService*  _svc    = nullptr;
// BlueFrog advertises a static-random address (top 2 bits of D5 == 0b11).
// NimBLEAddress with BLE_ADDR_RANDOM tells the host to resolve it as random,
// so connect-by-address is fast (no ~30 s public-address timeout).
static NimBLEAddress         _bluefrog(BLUEFROG_MAC, BLE_ADDR_RANDOM);
static unsigned long         _last_session_ms        = 0;
static unsigned long         _last_failed_attempt_ms = 0;   // when the last session aborted
// After a failed session (connect refused / dongle asleep), hold off this
// long before retrying — even with a brew queued — so back-to-back connect
// attempts don't starve the BlueFrog's advertising window.
static const unsigned long   FAILED_RETRY_BACKOFF_MS = 12000;
static String                _pending_cmd_action;          // queued brew/cancel; latest wins

// ─── Jutta-Proto encryption (ported from protocol-bt-cpp) ────────────────
//
// There's no challenge/response handshake — the "key" is a static byte
// (manufacturer_data[171][0] = 0x2A on this BlueFrog) fed to encDecBytes()
// for every characteristic read/write. Two 16-byte permutation tables +
// a per-nibble shuffle; symmetric in usage (encDec(encDec(x)) == x).
static const uint8_t JURA_NUM1[16] = {14, 4, 3, 2, 1, 13, 8, 11, 6, 15, 12, 7, 10, 5, 0, 9};
static const uint8_t JURA_NUM2[16] = {10, 6, 13, 12, 14, 11, 1, 9, 15, 7, 0, 5, 3, 2, 4, 8};

static inline uint8_t jura_mod256(int i) {
  while (i > 255) i -= 256;
  while (i < 0)   i += 256;
  return (uint8_t)i;
}

static uint8_t juraShuffle(int dataNibble, int nibbleCount, int keyL, int keyR) {
  uint8_t i5 = jura_mod256(nibbleCount >> 4);
  uint8_t t1 = JURA_NUM1[jura_mod256(dataNibble + nibbleCount + keyL) % 16];
  uint8_t t2 = JURA_NUM2[jura_mod256(t1 + keyR + i5 - nibbleCount - keyL) % 16];
  uint8_t t3 = JURA_NUM1[jura_mod256(t2 + keyL + nibbleCount - keyR - i5) % 16];
  return jura_mod256(t3 - nibbleCount - keyL) % 16;
}

// In-place encode/decode. Same call works both ways.
static void juraEncDec(uint8_t* data, size_t len, uint8_t key) {
  uint8_t keyL = key >> 4;
  uint8_t keyR = key & 0x0F;
  int nibCount = 0;
  for (size_t off = 0; off < len; off++) {
    uint8_t d  = data[off];
    uint8_t dL = d >> 4;
    uint8_t dR = d & 0x0F;
    uint8_t rL = juraShuffle(dL, nibCount++, keyL, keyR);
    uint8_t rR = juraShuffle(dR, nibCount++, keyL, keyR);
    data[off]  = (rL << 4) | rR;
  }
}

// ─── Encryption key (static for the lifetime of the dongle) ──────────────
// The Jutta-Proto key = FIRST BYTE of the advertisement manufacturer-data
// PAYLOAD (the byte AFTER the 2-byte company id 0xAB 0x00) = 0x2A on this
// BlueFrog. Validated live from the laptop 2026-07-10. Hardcoded because it
// never changes; if the dongle is ever reflashed the value would need a
// re-read, but that's a one-line change here.
static const uint8_t _jura_key = 0x2A;

// Sets the diagnostic auth flag — there is no real handshake, only the key.
static void runAuthHandshake() {
  Serial.printf("BLE: using key 0x%02X for encDec\n", _jura_key);
  jura_state.auth_ok = true;
}

// ─── Statistics + maintenance + machine-status reads ─────────────────────
//
// All validated live from the laptop tools (JURA/tools/) 2026-07-10, key 0x2A.
// Common stats flow: write encrypt([key, ds_hi, ds_lo, FF, FF]) to
// STATISTICS_COMMAND (5a401533), poll-read it until byte[1] != 0xE1
// (0xE1 = not ready), then read STATISTICS_DATA (5a401534) and decrypt.
// Dataset selector `ds`:
//   0x0001 = product counters   (total + per-drink, 3-byte BE each)
//   0x0004 = maintenance counters (cleaning/filter/descale/rinses, u16 BE each)
//   0x0008 = maintenance percent  (cleaning/filter/descale, 1 byte each)
// Live alerts come from MACHINE_STATUS (5a401524) after a P_MODE heartbeat.
// NimBLE's writeValue has an internal ACK timeout (returns false on failure),
// so a non-ACKing peer no longer wedges the loop into a watchdog crash.
//
// Reads decrypt in place into out[] and return the decrypted length.
static size_t readStatsDataset(uint16_t ds, uint8_t* out, size_t outMax) {
  NimBLERemoteCharacteristic* cmd = _svc->getCharacteristic(NimBLEUUID(JURA_CHAR_STATISTICS_COMMAND));
  NimBLERemoteCharacteristic* dat = _svc->getCharacteristic(NimBLEUUID(JURA_CHAR_STATISTICS_DATA));
  if (!cmd || !dat) return 0;
  uint8_t req[5] = { _jura_key, (uint8_t)(ds >> 8), (uint8_t)(ds & 0xFF), 0xFF, 0xFF };
  juraEncDec(req, sizeof(req), _jura_key);
  if (!cmd->writeValue(req, sizeof(req), true)) return 0;
  for (int i = 0; i < 20; i++) {                    // wait for byte[1] != 0xE1 (max ~8 s)
    NimBLEAttValue st = cmd->readValue();
    if (st.length() > 1 && st.data()[1] != 0xE1) break;
    delay(400);
  }
  NimBLEAttValue data = dat->readValue();
  size_t n = data.length();
  if (n > outMax) n = outMax;
  memcpy(out, data.data(), n);
  juraEncDec(out, n, _jura_key);                    // decrypt in place
  return n;
}

// Lifetime product counters (dataset 0x0001). Indices are Jura product codes.
static void readProductStats() {
  uint8_t buf[64];
  size_t n = readStatsDataset(0x0001, buf, sizeof(buf));
  if (n < 3) { publishEspEvent("stats", "ble", "products", "empty"); return; }
  auto val = [&](size_t idx) -> uint32_t {
    size_t o = idx * 3;
    if (o + 2 >= n) return 0;
    uint32_t v = ((uint32_t)buf[o] << 16) | ((uint32_t)buf[o + 1] << 8) | (uint32_t)buf[o + 2];
    return (v == 0xFFFF) ? 0 : v;   // 0xFFFF = unused-drink-slot sentinel -> 0
  };
  jura_state.total_dispensed   = val(0);
  jura_state.cnt_ristretto     = val(1);
  jura_state.cnt_espresso      = val(2);
  jura_state.cnt_coffee        = val(3);
  jura_state.cnt_cappuccino    = val(4);
  jura_state.cnt_esp_macchiato = val(6);
  jura_state.cnt_latte         = val(7);
  jura_state.cnt_milk          = val(10);
  jura_state.cnt_hotwater      = val(13);
  jura_state.cnt_2ristretti    = val(17);
  jura_state.cnt_2espressi     = val(18);
  jura_state.cnt_2coffee       = val(19);
  jura_state.cnt_flat_white    = val(46);
  Serial.printf("BLE: total=%lu esp=%lu cof=%lu capp=%lu\n",
    (unsigned long)jura_state.total_dispensed, (unsigned long)jura_state.cnt_espresso,
    (unsigned long)jura_state.cnt_coffee, (unsigned long)jura_state.cnt_cappuccino);
  char tot[16]; snprintf(tot, sizeof(tot), "%lu", (unsigned long)jura_state.total_dispensed);
  publishEspEvent("stats-total", "ble", "", tot);
}

// Maintenance percentages (0x0008, 1 byte each) + counters (0x0004, u16 BE).
// ⚠ These read zero while the machine is in its own maintenance menu — the
// values are valid on the MAIN/idle screen (product counters are unaffected).
static void readMaintenance() {
  uint8_t buf[32];
  size_t n = readStatsDataset(0x0008, buf, sizeof(buf));
  if (n >= 1) jura_state.pct_cleaning = buf[0];
  if (n >= 2) jura_state.pct_filter   = buf[1];
  if (n >= 3) jura_state.pct_descale  = buf[2];

  n = readStatsDataset(0x0004, buf, sizeof(buf));
  auto u16 = [&](size_t o) -> uint32_t { return (o + 1 < n) ? (((uint32_t)buf[o] << 8) | buf[o + 1]) : 0; };
  jura_state.maint_cleanings      = u16(0);
  jura_state.maint_filter_changes = u16(2);
  jura_state.maint_descalings     = u16(4);
  jura_state.maint_milk_rinses    = u16(6);
  jura_state.maint_coffee_rinses  = u16(8);
  jura_state.maint_milk_cleans    = u16(10);
}

// Live alerts (MACHINE_STATUS 5a401524). A P_MODE (5a401529) heartbeat write
// [key,7F,80] refreshes the status; then read + decrypt + bit-decode.
//   bit b -> byte (b>>3)+1, position 7-(b&7)
static void readMachineStatus() {
  NimBLERemoteCharacteristic* pmode = _svc->getCharacteristic(NimBLEUUID(JURA_CHAR_P_MODE));
  NimBLERemoteCharacteristic* mstat = _svc->getCharacteristic(NimBLEUUID(JURA_CHAR_MACHINE_STATUS));
  if (!mstat) return;
  // Heartbeat P_MODE [key,7F,80] then read — repeated a few times so the
  // machine settles to a real MACHINE_STATUS frame (a single quick read right
  // after connect can catch a not-ready frame with every alert bit set). The
  // laptop tool loops the same way; the LAST read is the accurate one.
  uint8_t st[32];
  size_t  n = 0;
  for (int attempt = 0; attempt < 3; attempt++) {
    if (pmode) {
      uint8_t hb[3] = { _jura_key, 0x7F, 0x80 };
      juraEncDec(hb, sizeof(hb), _jura_key);
      pmode->writeValue(hb, sizeof(hb), true);
    }
    delay(1000);
    NimBLEAttValue raw = mstat->readValue();
    n = raw.length();
    if (n > sizeof(st)) n = sizeof(st);
    memcpy(st, raw.data(), n);
    juraEncDec(st, n, _jura_key);
  }
  // Dump the decrypted status bytes so the decode can be verified over MQTT
  // (an all-FF frame = machine asleep/not-ready; alerts are only valid awake).
  { char hx[48]; size_t k = 0;
    for (size_t i = 0; i < n && k + 2 < sizeof(hx); i++) k += snprintf(hx + k, sizeof(hx) - k, "%02X", st[i]);
    publishEspEvent("mstatus", "ble", "raw", hx); }
  auto bit = [&](int b) -> bool {
    size_t by = (b >> 3) + 1;
    return (by < n) && ((st[by] >> (7 - (b & 7))) & 1);
  };
  jura_state.water_low         = bit(1);
  jura_state.grounds_full      = bit(2);
  jura_state.tray_full         = bit(3);
  jura_state.beans_low         = bit(10);
  jura_state.filter_required   = bit(32);
  jura_state.descale_required  = bit(33);
  jura_state.cleaning_required = bit(34);
  jura_state.power_state       = "on";   // a successful status read = machine reachable/on
}

// One session's full read: products + live alerts + maintenance.
static void pollStats() {
  if (!_svc) return;
  NimBLERemoteCharacteristic* probe = _svc->getCharacteristic(NimBLEUUID(JURA_CHAR_STATISTICS_COMMAND));
  { char hb[40]; snprintf(hb, sizeof(hb), "chars=%d h=%u", probe ? 1 : 0, (unsigned)ESP.getFreeHeap());
    publishEspEvent("poll-chars", "ble", probe ? "ok" : "MISSING", hb); }
  // Machine status FIRST — reading it in isolation (only a P_MODE heartbeat
  // before it) keeps it clean. Running any STATISTICS_COMMAND first pollutes
  // the MACHINE_STATUS characteristic (it echoes the last stats request:
  // "2A00<ds>..."), so the alert bits come out stale/garbage. The laptop's
  // status tool read it standalone for the same reason.
  readMachineStatus();
  readProductStats();
  readMaintenance();
  jura_state.last_poll_unix = (uint32_t)(millis() / 1000);
}

// ─── Public API: command dispatch (called from Esp_Base.ino) ─────────────
//
// The BLE link is closed most of the time, so we queue the action; the next
// session opens the link, writes the FA opcode, and disconnects.
bool juraSendCommand(const char* action) {
  if (!action || !*action) return false;
  static const char* const KNOWN_ACTIONS[] = {
    "on", "off", "brew_espresso", "brew_coffee", "brew_2x_espresso",
    "brew_2x_coffee", "hot_water", "cancel", "standby",
  };
  bool known = false;
  for (auto* k : KNOWN_ACTIONS) { if (!strcmp(action, k)) { known = true; break; } }
  if (!known) return false;

  if (_pending_cmd_action.length()) {
    Serial.printf("BLE: replacing queued '%s' with '%s'\n", _pending_cmd_action.c_str(), action);
  }
  _pending_cmd_action = action;
  Serial.printf("BLE: queued '%s' for next session\n", action);
  publishEspEvent("cmd-queued", "ble", action, "");
  _last_session_ms = 0;   // trigger an immediate session on the next loop tick
  return true;
}

// ─── Setup (called once from setup()) ────────────────────────────────────
void juraBleSetup() {
  Serial.println("BLE: NimBLE init");
  NimBLEDevice::init(device_id);
  _client = NimBLEDevice::createClient();
}

// ─── Graceful shutdown for OTA (called from ArduinoOTA.onStart) ──────────
volatile bool _ota_in_progress = false;
void juraBlePrepareForOta() {
  _ota_in_progress = true;
  Serial.printf("OTA-prepare: free heap before BLE shutdown = %u\n", ESP.getFreeHeap());
  if (_client && _client->isConnected()) {
    Serial.println("OTA-prepare: disconnecting BLE client");
    _client->disconnect();
    delay(300);
  }
  jura_state.ble_connected = false;
  jura_state.auth_ok       = false;
  Serial.println("OTA-prepare: NimBLEDevice::deinit(true) to free heap");
  NimBLEDevice::deinit(true);
  delay(200);
  Serial.printf("OTA-prepare: free heap after  BLE shutdown = %u\n", ESP.getFreeHeap());
}

// ─── Loop (called every 1 s from loop()) ─────────────────────────────────
//
// Poll-and-disconnect. Each session runs synchronously in this tick:
//   1. connect() to BlueFrog by address + resolve service
//   2. runAuthHandshake() — sets auth_ok (key is static)
//   3. queued command (if any) — written BEFORE the stats read so a stalled
//      read can't kill the brew
//   4. pollStats()
//   5. ALWAYS disconnect() before returning
void juraBleLoop() {
  if (g_ota_mode)       return;   // OTA-only boot — BLE never initialized
  if (_ota_in_progress) return;   // OTA underway — keep BLE quiet

  // Lazy BLE init: defer 60 s after boot so every fresh reset gives a clean
  // OTA window (no BLE blocking the loop, max free heap for Update.write()).
  if (!_client) {
    if (millis() < 60000) return;
    Serial.println("BLE: 60 s OTA window expired — initializing NimBLE");
    juraBleSetup();
    if (!_client) return;
  }

  unsigned long now = millis();

  if (_last_failed_attempt_ms != 0 &&
      now - _last_failed_attempt_ms < FAILED_RETRY_BACKOFF_MS) {
    return;
  }

  bool poll_due    = (_last_session_ms == 0) ||
                     (now - _last_session_ms >= (unsigned long)esp_params.poll_interval_sec * 1000UL);
  bool cmd_pending = (_pending_cmd_action.length() > 0);
  if (!poll_due && !cmd_pending) return;

  _last_session_ms = now;
  Serial.printf("BLE: opening session (poll=%d cmd=%d)\n", poll_due, cmd_pending);

  // ── Step 0: clean any stale connection ───────────────────────────
  if (_client->isConnected()) {
    Serial.println("BLE: stale connection — disconnecting first");
    _client->disconnect();
    delay(200);
  }

  // ── Step 1: connect by address (NimBLE handles random-addr resolve) ─
  Serial.println("BLE: connecting to BlueFrog by address...");
  if (!_client->connect(_bluefrog)) {
    Serial.println("BLE: connect failed — backing off");
    publishEspEvent("connect-fail", "ble", "", "");
    jura_state.ble_connected = false;
    _last_failed_attempt_ms = millis();
    return;
  }
  jura_state.ble_connected = true;
  Serial.println("BLE: connected to BlueFrog");
  publishEspEvent("state", "ble", "bluefrog", "connected");
  { char hb[16]; snprintf(hb, sizeof(hb), "%u", (unsigned)ESP.getFreeHeap());
    publishEspEvent("heap-connect", "ble", "", hb); }

  // ── Step 2: resolve service (retry once — first getService triggers
  // NimBLE's on-demand service discovery) ──────────────────────────
  _svc = _client->getService(NimBLEUUID(JURA_SERVICE_UUID));
  if (!_svc) { delay(300); _svc = _client->getService(NimBLEUUID(JURA_SERVICE_UUID)); }
  { char hb[16]; snprintf(hb, sizeof(hb), "%u", (unsigned)ESP.getFreeHeap());
    publishEspEvent("heap-svc", "ble", _svc ? "found" : "null", hb); }
  if (!_svc) {
    Serial.println("BLE: Jura service not found — closing session");
    _client->disconnect();
    delay(150);
    jura_state.ble_connected = false;
    _last_failed_attempt_ms = millis();
    return;
  }

  // One-shot enumeration so we KNOW what's on this BlueFrog.
  static bool _chars_dumped = false;
  if (!_chars_dumped) {
    _chars_dumped = true;
    std::vector<NimBLERemoteCharacteristic*> chars = _svc->getCharacteristics(true);
    Serial.printf("BLE: service %s has %u characteristics:\n",
                  JURA_SERVICE_UUID, (unsigned)chars.size());
    for (auto* c : chars) {
      Serial.printf("  %s  props=%s%s%s%s\n",
                    c->getUUID().toString().c_str(),
                    c->canRead()     ? "R" : "-",
                    c->canWrite()    ? "W" : "-",
                    c->canNotify()   ? "N" : "-",
                    c->canIndicate() ? "I" : "-");
    }
  }

  // ── Step 3: auth (key is static — sets auth_ok) ──────────────────
  runAuthHandshake();

  // ── Step 4: queued command FIRST (before the stats read) ─────────
  if (cmd_pending) {
    String action = _pending_cmd_action;
    _pending_cmd_action = "";

    if (!_client->isConnected()) {
      Serial.printf("BLE: skipping queued '%s' — link dropped before write\n", action.c_str());
      _pending_cmd_action = action;   // re-queue
      publishEspEvent("cmd-blocked", "ble", action.c_str(), "link_dropped");
    } else {
      // Per-drink product codes for the Jura J6 (verified against
      // ryanalden/esphome-jura-component). Written at byte[1] of the
      // 18-byte START_PRODUCT packet.
      uint8_t product_code = 0;
      if      (action == "brew_espresso")    product_code = 0x07;
      else if (action == "brew_2x_espresso") product_code = 0x08;
      else if (action == "brew_coffee")      product_code = 0x09;
      else if (action == "brew_2x_coffee")   product_code = 0x0A;
      else if (action == "hot_water")        product_code = 0x06;
      else if (action == "on" || action == "off" ||
               action == "cancel" || action == "standby") {
        // Power on/off uses the AN: prefix (not the FA: drink prefix);
        // routing it through the BlueFrog needs P_MODE wiring — TODO.
        Serial.printf("BLE: '%s' uses AN: prefix — needs P_MODE wiring (TODO)\n", action.c_str());
        publishEspEvent("cmd-blocked", "ble", action.c_str(), "an_prefix_pending");
        action = "";
      }
      if (action.length()) {
        // 18-byte START_PRODUCT packet — protocol-bt-cpp's verified example
        // attributes (water 0x28, strength 0x02, option 0x01) extended to
        // 18 bytes per AlexxIT (key at [0] and [17]).
        uint8_t cmdBuf[18] = {
          0x00, product_code,
          0x00, 0x04, 0x28, 0x00, 0x00, 0x02, 0x00, 0x01,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00,
        };
        cmdBuf[0]  = _jura_key;
        cmdBuf[17] = _jura_key;
        juraEncDec(cmdBuf, sizeof(cmdBuf), _jura_key);

        NimBLERemoteCharacteristic* startProd =
            _svc->getCharacteristic(NimBLEUUID(JURA_CHAR_START_PRODUCT));
        if (startProd) {
          Serial.printf("BLE: cmd '%s' product_code=0x%02X — writeValue (18 bytes)...\n",
                        action.c_str(), product_code);
          bool ok = startProd->writeValue(cmdBuf, sizeof(cmdBuf), true);
          publishEspEvent("cmd", "ble", action.c_str(), ok ? "sent" : "write_fail");
        } else {
          Serial.println("BLE: START_PRODUCT characteristic not found");
          publishEspEvent("cmd-blocked", "ble", action.c_str(), "no_start_char");
        }
      }
    }
  }

  // ── Step 5: stats read ───────────────────────────────────────────
  pollStats();

  // ── Step 6: clean disconnect (always) ────────────────────────────
  Serial.println("BLE: closing session");
  _client->disconnect();
  delay(150);
  jura_state.ble_connected = false;
  jura_state.auth_ok       = false;
  publishEspEvent("state", "ble", "bluefrog", "disconnected");
  _last_failed_attempt_ms = 0;   // reached the end — clear backoff
}
