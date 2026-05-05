/* Jura_BLE.ino — Bluedroid BLE client (poll-and-disconnect pattern)
 *
 *   Uses ESP32 Arduino's stock Bluedroid BLE library (<BLEDevice.h>) instead
 *   of NimBLE-Arduino. NimBLE consistently panics on ESP32-C3 at PC
 *   0x4038ab62 deep in IRAM regardless of how we structure connections,
 *   regardless of TX power, regardless of deinit/disconnect ordering. The
 *   crash is in pre-compiled library code, not fixable from sketch level.
 *   Bluedroid uses different host code paths and is the supported BLE
 *   library for ESP32 Arduino — heavier RAM but stable.
 *
 *   Strategy: SHORT-LIVED BLE SESSIONS.
 *     - Every esp_params.poll_interval_sec (default 30 s), open a session:
 *         connect → auth → read stats → (send queued cmd) → disconnect
 *     - Between sessions: BLE radio idle. WiFi gets the air uncontested.
 *     - Brew commands queue and fire on the next session (3-5 s latency).
 *
 *   Phase 2 (next): port pyjura's bit-permutation auth + 56-byte stats
 *   decoder + FA opcodes.
 *
 *   References:
 *     - https://github.com/Jutta-Proto/protocol-bt-cpp
 *     - https://github.com/Jutta-Proto/pyjura
 */

#include "Main.h"
#include <BLEDevice.h>
#include <BLEClient.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <BLERemoteCharacteristic.h>
#include <esp_gap_ble_api.h>   // for BLE_ADDR_TYPE_RANDOM (regular ESP32 only)

// ─── BLE state ────────────────────────────────────────────────────────────
static BLEClient*           _client      = nullptr;
static BLERemoteService*    _svc         = nullptr;
// BlueFrog uses a static-random BLE address (top 2 bits of D5 == 0b11).
// On regular ESP32 we can pass the type explicitly via Bluedroid's
// esp_ble_addr_type_t — without this hint the controller would default
// to public-address resolution and time out slowly (~30 s) on connect,
// tripping the task watchdog.
static BLEAddress           _bluefrog(BLUEFROG_MAC, BLE_ADDR_TYPE_RANDOM);
static unsigned long        _last_session_ms     = 0;
static unsigned long        _last_failed_attempt_ms = 0;   // when did the most recent session abort (no dongle / connect failed)
// When a session fails (scan didn't see the BlueFrog, or connect refused),
// wait this long before retrying — even if a brew command is queued.
// Without this, cmd_pending overrides the poll-interval timer and the
// loop hammers back-to-back 5 s scans every tick, which both spams the
// serial AND keeps the radio so busy that the BlueFrog can't get a
// quiet window to advertise. 12 s gives advertising bursts room.
static const unsigned long  FAILED_RETRY_BACKOFF_MS = 12000;
static String               _pending_cmd_action;   // queued brew/cancel/standby; one slot, latest wins

// Connection callbacks — these fire on the BLE host task, which runs on
// a DIFFERENT core from loopTask on the dual-core ESP32. Calling
// PubSubClient (MQTT) here is unsafe — the client isn't thread-safe and
// triggers a heap/state assertion that aborts the board. So callbacks
// JUST set flags; the main loop sees the flag flips and does the MQTT
// publish from the safe core.
static volatile bool _ble_event_connected_pending    = false;
static volatile bool _ble_event_disconnected_pending = false;

class _ClientCallbacks : public BLEClientCallbacks {
  void onConnect(BLEClient* c) override {
    jura_state.ble_connected = true;
    _ble_event_connected_pending = true;     // loop will publish
  }
  void onDisconnect(BLEClient* c) override {
    jura_state.ble_connected = false;
    jura_state.auth_ok       = false;
    _ble_event_disconnected_pending = true;  // loop will publish
  }
};
static _ClientCallbacks _cb;

// Drain the pending event flags from the BLE callbacks. Called from the
// main loop (safe core) so MQTT publishes happen serialised with the
// rest of the app's MQTT activity.
static void drainPendingBleEvents() {
  if (_ble_event_connected_pending) {
    _ble_event_connected_pending = false;
    Serial.println("BLE: connected to BlueFrog");
    publishEspEvent("state", "ble", "bluefrog", "connected");
  }
  if (_ble_event_disconnected_pending) {
    _ble_event_disconnected_pending = false;
    Serial.println("BLE: disconnected");
    publishEspEvent("state", "ble", "bluefrog", "disconnected");
  }
}

// ─── Jutta-Proto encryption (Phase 2 — ported from protocol-bt-cpp) ──────
//
// Discovery 2026-05-04: there's NO challenge/response handshake. The
// "key" is just byte 0 of the BLE advertisement's manufacturer data —
// we read it from the scan and use it as input to encDecBytes() for
// every characteristic write/read.
//
// Reference: github.com/Jutta-Proto/protocol-bt-cpp src/bt/ByteEncDecoder.cpp
//
// Two 16-byte permutation tables + a per-nibble shuffle. Symmetric in
// usage — calling encDecBytes(encDecBytes(data, key), key) returns the
// original.
static const uint8_t JURA_NUM1[16] = {14, 4, 3, 2, 1, 13, 8, 11, 6, 15, 12, 7, 10, 5, 0, 9};
static const uint8_t JURA_NUM2[16] = {10, 6, 13, 12, 14, 11, 1, 9, 15, 7, 0, 5, 3, 2, 4, 8};

static inline uint8_t jura_mod256(int i) {
  while (i > 255) i -= 256;
  while (i < 0)   i += 256;
  return (uint8_t)i;
}

static uint8_t juraShuffle(int dataNibble, int nibbleCount, int keyL, int keyR) {
  uint8_t i5   = jura_mod256(nibbleCount >> 4);
  uint8_t t1   = JURA_NUM1[jura_mod256(dataNibble + nibbleCount + keyL) % 16];
  uint8_t t2   = JURA_NUM2[jura_mod256(t1 + keyR + i5 - nibbleCount - keyL) % 16];
  uint8_t t3   = JURA_NUM1[jura_mod256(t2 + keyL + nibbleCount - keyR - i5) % 16];
  return jura_mod256(t3 - nibbleCount - keyL) % 16;
}

// ─── FreeRTOS-task wrapper for writeValue (timeout protection) ───────────
//
// Bluedroid's BLERemoteCharacteristic::writeValue() blocks indefinitely
// when the peer (J6 BlueFrog) doesn't ACK at the GATT layer. Both
// response=true and response=false can hang because the characteristic
// only exposes Write-with-Response and Bluedroid falls back to that.
// Wrapping the write on a separate FreeRTOS task lets the main loop
// abandon a stuck write after a software timeout — the loop stays
// responsive, the next session re-establishes the BLE link cleanly.
// Note: parameters typed as `void*` (not BLERemoteCharacteristic*) so
// Arduino's auto-prototype generator — which inserts prototypes BEFORE
// local includes — doesn't fail on the unknown class name. The body
// casts back to the proper type, since by then BLERemoteCharacteristic.h
// is in scope.
struct _WriteJob {
  void*    chr;        // BLERemoteCharacteristic*
  uint8_t* data;
  size_t   len;
  bool     response;
  volatile bool done;
};

static void _writeTask(void* p) {
  _WriteJob* job = (_WriteJob*)p;
  if (job->chr) {
    ((BLERemoteCharacteristic*)job->chr)->writeValue(job->data, job->len, job->response);
  }
  job->done = true;
  vTaskDelete(NULL);
}

// Returns true if the write completed within timeout_ms, false if it
// timed out (in which case the task is intentionally leaked — it'll
// either eventually finish or stay blocked until the next disconnect
// tears down the BLE stack and reclaims it).
static bool writeValueWithTimeout(void* chr,
                                  uint8_t* data, size_t len,
                                  bool response, uint32_t timeout_ms) {
  static _WriteJob job;   // static so its memory survives task lifetime
  job.chr      = chr;
  job.data     = data;
  job.len      = len;
  job.response = response;
  job.done     = false;
  // 4 KB stack — BLE write path is shallow; pin to Core 0 (BLE host core)
  // so the call doesn't compete with the loop on Core 1.
  TaskHandle_t h = nullptr;
  xTaskCreatePinnedToCore(_writeTask, "blewrite", 4096, &job, 1, &h, 0);
  unsigned long t0 = millis();
  while (!job.done && (millis() - t0) < timeout_ms) {
    delay(50);
  }
  return job.done;
}

// In-place encode/decode. Same call works both ways (the algorithm is
// involutory in usage given the same key + same starting nibble counter).
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

// ─── Encryption key (read from BLE advertisement during scan) ────────────
// Set by the connect path when we see the BlueFrog's manufacturer data.
// Required for every characteristic read/write. The key is STATIC for the
// lifetime of the dongle — observed value 0xAB on this J6's BlueFrog.
// Hardcoded as a fallback so we can encrypt even on advertisements that
// happen to omit the mfg-data field.
#define JURA_KEY_FALLBACK 0xAB
static uint8_t _jura_key      = JURA_KEY_FALLBACK;
static bool    _jura_key_seen = true;          // start with the cached value

// Stub kept for compatibility with juraBleLoop's call site — the real
// key extraction now happens during the scan.
static bool runAuthHandshake() {
  if (!_jura_key_seen) {
    Serial.println("BLE: no advertisement key seen yet — read characteristics will be encrypted noise");
    jura_state.auth_ok = false;
    return false;
  }
  Serial.printf("BLE: using advertisement key 0x%02X for encDec\n", _jura_key);
  jura_state.auth_ok = true;
  return true;
}

// ─── Stats decoder (Jutta-Proto: 3-byte big-endian counters) ─────────────
//
// After juraEncDec(rawBytes, key), the payload is a sequence of 3-byte
// big-endian counters. The first counter at offset 0 is the total
// products dispensed. Subsequent counters are indexed by the machine's
// per-product code (e.g. coffee = 0x03 → counter at offset 0x03 * 3 = 9).
// Real product codes for the J6 come from its machine file (see
// github.com/Jutta-Proto/machinefiles); for now we log the total + a
// few well-known generic codes.
static size_t getStatVal(const uint8_t* buf, size_t len, size_t productIdx) {
  size_t off = productIdx * 3;
  if (off + 2 >= len) return (size_t)-1;
  return ((size_t)buf[off] << 16) | ((size_t)buf[off + 1] << 8) | (size_t)buf[off + 2];
}

static void decodeStatsPayload(const uint8_t* enc, size_t len) {
  if (len == 0) {
    Serial.println("BLE: stats payload empty (read returned 0 bytes)");
    return;
  }
  // Make a working copy + decrypt in place using the advertisement key.
  static uint8_t buf[64];
  size_t n = (len > sizeof(buf)) ? sizeof(buf) : len;
  memcpy(buf, enc, n);
  juraEncDec(buf, n, _jura_key);
  size_t total = getStatVal(buf, n, 0);
  Serial.printf("BLE: stats len=%u total=%u (key=0x%02X) first16=", (unsigned)n, (unsigned)total, _jura_key);
  for (size_t i = 0; i < n && i < 16; i++) Serial.printf("%02X ", buf[i]);
  Serial.println();
  if (total != (size_t)-1) {
    jura_state.total_dispensed = (uint32_t)total;
  }
}

// ─── Per-session: read live state → decode → update jura_state ───────────
//
// 2026-05-04: switched from JURA_CHAR_STATISTICS_DATA (5a401531) to
// JURA_CHAR_MACHINE_STATUS (5a401524). Enumeration of this BlueFrog
// confirms only 8 chars on the service and NONE at the protocol-bt-cpp's
// claimed STATISTICS_DATA UUID 5a401534. The MACHINE_STATUS characteristic
// is the readable live-state surface — power state, dispensing, alerts —
// which is what we actually want to project into jura_state for the
// dashboard. (Long-running counters via STATISTICS_COMMAND/DATA require
// the command-then-read flow which we'll wire later when needed.)
static void pollStats() {
  if (!_svc) return;
  BLERemoteCharacteristic* stat = _svc->getCharacteristic(BLEUUID(JURA_CHAR_MACHINE_STATUS));
  if (!stat) { Serial.println("BLE: MACHINE_STATUS characteristic not found"); return; }
  String data = stat->readValue();
  decodeStatsPayload((const uint8_t*)data.c_str(), data.length());
  jura_state.last_poll_unix = (uint32_t)(millis() / 1000);
  publishEspEvent("poll", "ble", "machine_status", String(data.length()).c_str());
}

// ─── Public API: command dispatch (called from Esp_Base.ino) ─────────────
//
// In poll-and-disconnect mode the BLE link is closed most of the time, so
// we DON'T write directly here. The action is queued; the next session
// (next poll interval, or sooner — _last_session_ms gets reset) opens the
// link, auths, fires the FA write, and disconnects.
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

  _last_session_ms = 0;   // trigger immediate session on next loop tick
  return true;
}

static bool resolveOpcode(const char* action, uint8_t* out_op) {
  if      (!strcmp(action, "on"))               { *out_op = 0x01; return true; }
  else if (!strcmp(action, "off"))              { *out_op = 0x07; return true; }
  else if (!strcmp(action, "brew_espresso"))    { *out_op = 0x01; return true; }
  else if (!strcmp(action, "brew_coffee"))      { *out_op = 0x02; return true; }
  else if (!strcmp(action, "brew_2x_espresso")) { *out_op = 0x03; return true; }
  else if (!strcmp(action, "brew_2x_coffee"))   { *out_op = 0x04; return true; }
  else if (!strcmp(action, "hot_water"))        { *out_op = 0x05; return true; }
  else if (!strcmp(action, "cancel"))           { *out_op = 0x06; return true; }
  else if (!strcmp(action, "standby"))          { *out_op = 0x07; return true; }
  return false;
}

// ─── Setup (called once from setup()) ────────────────────────────────────
void juraBleSetup() {
  Serial.println("BLE: Bluedroid init");
  BLEDevice::init(device_id);
  // ~+3 dBm — gentler on WiFi coex, plenty for ~5 m link to BlueFrog.
  esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, ESP_PWR_LVL_P3);
  _client = BLEDevice::createClient();
  _client->setClientCallbacks(&_cb);
}

// ─── Graceful shutdown for OTA (called from ArduinoOTA.onStart) ──────────
//
// Disconnect + deinit Bluedroid to free ~30 KB of heap. ArduinoOTA's
// Update.write() needs buffer space; without freeing BLE we end up at
// ~25 KB free heap and the upload fails with "OTA error 3" (RECEIVE_ERROR).
// On regular ESP32 BLEDevice::deinit() is stable (unlike NimBLE on C3).
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
  Serial.println("OTA-prepare: BLEDevice::deinit() to free heap");
  BLEDevice::deinit(true);   // release controller + host stack memory
  delay(200);
  Serial.printf("OTA-prepare: free heap after  BLE shutdown = %u\n", ESP.getFreeHeap());
}

// ─── Loop (called every 1 s from loop()) ─────────────────────────────────
//
// Poll-and-disconnect: open a short session every poll_interval_sec, or
// sooner if a command is queued. Each session runs synchronously in this
// tick:
//
//   1. scan + extract encryption key from advertisement
//   2. connect() to BlueFrog + resolve service
//   3. runAuthHandshake() — sets auth_ok if key cached
//   4. If a command was queued AND key cached AND link still up: write opcode
//   5. pollStats() — runs AFTER cmd so a stalled read can't kill the brew
//   6. ALWAYS disconnect() before returning — clean teardown is what
//      keeps the BLE stack from racing against remote-initiated drops.
void juraBleLoop() {
  if (g_ota_mode)        return;   // OTA-only mode — BLE never initialized
  if (_ota_in_progress)  return;   // OTA underway — keep BLE quiet

  // Lazy BLE init: defer for 60 s after boot so every fresh reset gives
  // a clean OTA window (no BLE blocking the loop, max free heap).
  if (!_client) {
    if (millis() < 60000) return;            // wait
    Serial.println("BLE: 60 s OTA window expired — initializing Bluedroid");
    juraBleSetup();
    if (!_client) return;
  }

  // Drain BLE callback events FIRST — they came from a different core,
  // we publish them here on the safe core.
  drainPendingBleEvents();

  unsigned long now = millis();

  // Backoff: if the most recent attempt failed, hold off for
  // FAILED_RETRY_BACKOFF_MS before trying again — applies to both
  // poll-driven AND cmd-driven attempts. Otherwise a queued command
  // turns into a continuous 5 s-scan storm that prevents BlueFrog
  // from getting an advertising window.
  if (_last_failed_attempt_ms != 0 &&
      now - _last_failed_attempt_ms < FAILED_RETRY_BACKOFF_MS) {
    return;
  }

  bool poll_due  = (_last_session_ms == 0) ||
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

  // ── Step 1: scan for the BlueFrog AND extract encryption key ─────
  // Direct connect-by-address is unreliable; canonical Bluedroid pattern
  // is scan-first-then-connect. We ALSO use the scan to harvest the
  // encryption key (manufacturer data byte 0) — there's no challenge/
  // response handshake; the key is simply broadcast in the advertisement.
  BLEScan* scan = BLEDevice::getScan();
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(99);
  Serial.println("BLE: scanning 5 s for BlueFrog...");
  BLEScanResults* results = scan->start(5, false);
  // Dump every device seen — diagnostic for "BlueFrog not in scan"
  // when we're certain the dongle is plugged in and the machine is
  // awake. Helps catch: MAC drift on dongle reflash, BlueFrog absent
  // entirely, or another BLE client holding it. Limit to 12 lines so
  // a noisy environment doesn't flood the serial.
  Serial.printf("BLE: scan saw %d devices:\n", results->getCount());
  int dumped = 0;
  for (int i = 0; i < results->getCount() && dumped < 12; i++) {
    BLEAdvertisedDevice d = results->getDevice(i);
    Serial.printf("  %s  rssi=%d  name=%s\n",
                  d.getAddress().toString().c_str(),
                  d.getRSSI(),
                  d.haveName() ? d.getName().c_str() : "(no name)");
    dumped++;
  }
  BLEAdvertisedDevice* found = nullptr;
  for (int i = 0; i < results->getCount(); i++) {
    BLEAdvertisedDevice d = results->getDevice(i);
    if (d.getAddress().equals(_bluefrog)) {
      found = new BLEAdvertisedDevice(d);
      // Extract encryption key from RAW advertisement payload — we look
      // for the AD record `FF` (Manufacturer Specific Data) and read
      // byte 0 of its payload (per Jutta-Proto). The Bluedroid library's
      // haveManufacturerData() flag isn't reliable on the BlueFrog
      // (returns false on some advertisements even when mfg data is
      // present in the raw payload). Walking the AD records ourselves
      // is robust. Cache the key once seen — Jura's key is static for
      // the lifetime of the dongle.
      if (!_jura_key_seen) {
        const uint8_t* pl = d.getPayload();
        size_t plen = d.getPayloadLength();
        if (pl && plen > 0) {
          size_t i = 0;
          while (i + 1 < plen) {
            uint8_t adLen = pl[i];
            if (adLen == 0) break;
            uint8_t adType = pl[i + 1];
            if (adType == 0xFF && adLen >= 4) {
              // mfg data: [adLen][0xFF][company_lo][company_hi][payload...]
              // Per protocol-bt-cpp the key is at byte 0 of payload (after
              // company id) — but their parser passes raw bytes after
              // the AD type byte, so byte 0 of THAT slice = company_lo.
              // On this BlueFrog the value at company_lo is the key
              // (0xAB observed). Take the byte right after the AD type.
              _jura_key      = pl[i + 2];
              _jura_key_seen = true;
              Serial.printf("BLE: extracted key=0x%02X from advertisement mfg data\n", _jura_key);
              break;
            }
            i += adLen + 1;
          }
        }
        if (!_jura_key_seen) {
          Serial.println("BLE: no mfg data in this advertisement — will retry next scan");
        }
      }
      break;
    }
  }
  scan->clearResults();
  if (!found) {
    Serial.println("BLE: BlueFrog not seen in scan — backing off");
    _last_failed_attempt_ms = millis();
    return;
  }
  Serial.printf("BLE: BlueFrog found at RSSI %d, connecting...\n", found->getRSSI());

  // ── Step 2: connect using the scanned device ─────────────────────
  bool connected = _client->connect(found);
  delete found;
  if (!connected) {
    Serial.println("BLE: connect failed — backing off");
    _last_failed_attempt_ms = millis();
    return;
  }

  // ── Step 2: service discovery ────────────────────────────────────
  _svc = _client->getService(BLEUUID(JURA_SERVICE_UUID));
  if (!_svc) {
    Serial.println("BLE: Jura service not found — closing session");
    _client->disconnect();
    delay(150);
    _last_failed_attempt_ms = millis();
    return;
  }
  // One-shot enumeration of characteristics so we KNOW what's on this
  // particular BlueFrog (UUIDs vary between firmware revisions and
  // protocol-bt-cpp's docs don't always match J6 behavior).
  static bool _chars_dumped = false;
  if (!_chars_dumped) {
    _chars_dumped = true;
    auto chars = _svc->getCharacteristics();
    Serial.printf("BLE: service %s has %u characteristics:\n",
      JURA_SERVICE_UUID, (unsigned)(chars ? chars->size() : 0));
    if (chars) {
      for (auto& kv : *chars) {
        BLERemoteCharacteristic* c = kv.second;
        Serial.printf("  %s  props=%s%s%s%s\n",
          c->getUUID().toString().c_str(),
          c->canRead()           ? "R" : "-",
          c->canWrite()          ? "W" : "-",
          c->canNotify()         ? "N" : "-",
          c->canIndicate()       ? "I" : "-");
      }
    }
  }

  // ── Step 3: auth (Phase 2 fills in the real handshake) ───────────
  runAuthHandshake();   // currently sets auth_ok=false (stub)

  // ── Step 4: queued command FIRST (cmd path before stats read) ────
  //
  // Originally the order was poll → cmd, but at marginal RSSI (-84+)
  // the GATT read on MACHINE_STATUS occasionally stalls long enough
  // for the BLE link to drop mid-read. The disconnect callback fires
  // on the BLE host task core and resets jura_state.auth_ok before
  // the cmd block can run, causing the brew write to be silently
  // skipped. Issuing the cmd first means a marginal-link stats read
  // can't kill the cmd path — the brew is already on the wire.
  //
  // Brew command flow per protocol-bt-cpp's CoffeeMaker::write():
  //   1. Build the raw command bytes (drink-specific).
  //   2. Set bytes[0] = key (the write() helper always overwrites byte 0).
  //   3. Set bytes[last] = key (overrideKey=true case).
  //   4. juraEncDec(bytes, key) to obfuscate.
  //   5. Write to JURA_CHAR_START_PRODUCT (5a401525).
  //
  // CAVEAT: per-drink raw byte sequences depend on the J6's machine file
  // (github.com/Jutta-Proto/machinefiles). We don't have that file
  // parsed yet, so for now we use the documented EXAMPLE structure:
  //   "00 03 00 04 14 0000 01 00010000000000 2A"  (= one coffee)
  // …with byte 1 swapped per action. This is a BEST-GUESS until the
  // J6 machine file is parsed; real Jura code per drink may differ.
  if (cmd_pending) {
    String action = _pending_cmd_action;
    _pending_cmd_action = "";

    // Gate on _jura_key_seen (the encryption key — persistent across
    // disconnects) AND _client->isConnected() (live link). DON'T gate
    // on auth_ok — that flag flips false on disconnect and silently
    // skips cmds when the stats-read race fires.
    if (!_jura_key_seen) {
      Serial.printf("BLE: skipping queued '%s' — no advertisement key cached\n", action.c_str());
      publishEspEvent("cmd-blocked", "ble", action.c_str(), "no_key");
    } else if (!_client->isConnected()) {
      Serial.printf("BLE: skipping queued '%s' — link dropped before write\n", action.c_str());
      _pending_cmd_action = action;   // re-queue for next session
      publishEspEvent("cmd-blocked", "ble", action.c_str(), "link_dropped");
    } else {
      // Per-drink opcodes for the Jura J6 — verified against
      // ryanalden/esphome-jura-component (J6-specific Arduino driver).
      // These are the bytes the J6 firmware expects at byte index 1 of
      // the START_PRODUCT write. Product codes here SUPERSEDE the
      // generic 0x03 from protocol-bt-cpp's README example, which was
      // from a different machine model and the J6 doesn't recognise.
      uint8_t product_code = 0;
      if      (action == "brew_espresso")                      product_code = 0x07;   // FA:07
      else if (action == "brew_2x_espresso")                   product_code = 0x08;   // FA:08
      else if (action == "brew_coffee")                        product_code = 0x09;   // FA:09
      else if (action == "brew_2x_coffee")                     product_code = 0x0A;   // FA:0A
      else if (action == "hot_water")                          product_code = 0x06;   // FA:06
      else if (action == "on" || action == "off" ||
               action == "cancel" || action == "standby") {
        // Power on/off uses the AN: prefix in J6 serial protocol (AN:01 /
        // AN:02), not the FA: drink-product prefix. Routing through the
        // BLE BlueFrog is unclear — likely a different characteristic
        // (P_MODE 5a401529 candidate). For now log + skip until we see
        // an AN: capture from the BlueFrog. Brew commands work via the
        // FA: prefix on START_PRODUCT and are handled above.
        Serial.printf("BLE: '%s' uses AN: prefix — needs P_MODE wiring (TODO)\n", action.c_str());
        publishEspEvent("cmd-blocked", "ble", action.c_str(), "an_prefix_pending");
        action = "";
      }
      if (action.length()) {
        // 18-byte START_PRODUCT packet — based on protocol-bt-cpp's
        // hardcoded example "00 03 00 04 28 00 00 02 00 01 00 00 00
        // 00 00 00" (16 bytes), extended to 18 bytes per AlexxIT/Jura
        // (key now at [17] not [15]). Bytes 2-9 carry protocol-bt-cpp's
        // VERIFIED attribute values (water amount 0x28, strength 0x02,
        // option byte 0x01) from a machine that DOES accept the packet
        // — earlier all-zero attributes caused J6 to silently drop the
        // write (no GATT ACK, write timed out at 5 s). The exact J6
        // semantics come from its machine file (Jutta-Proto/machinefiles
        // extracted from JOE Android APK), but these defaults match
        // a typical Smart Connect machine recipe and should at least
        // get past the J6's "valid recipe" check.
        //
        // Layout:
        //   [0]    = key (set below)
        //   [1]    = product_code  (0x09 = 1 coffee)
        //   [2]    = 0x00
        //   [3]    = 0x04
        //   [4]    = 0x28          (water amount)
        //   [5-6]  = 0x00 0x00
        //   [7]    = 0x02          (strength)
        //   [8]    = 0x00
        //   [9]    = 0x01          (option flag)
        //   [10-16]= 0x00 padding
        //   [17]   = key (set below)
        uint8_t cmdBuf[18] = {
          0x00,         // [0]  key
          product_code, // [1]
          0x00, 0x04, 0x28, 0x00, 0x00, 0x02, 0x00, 0x01,
          0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0x00, 0x00,   // [16][17] — [17] gets overwritten with key below
        };
        cmdBuf[0]  = _jura_key;
        cmdBuf[17] = _jura_key;
        juraEncDec(cmdBuf, sizeof(cmdBuf), _jura_key);

        BLERemoteCharacteristic* startProd =
            _svc->getCharacteristic(BLEUUID(JURA_CHAR_START_PRODUCT));
        if (startProd) {
          // Direct writeValue — the FreeRTOS-task wrapper approach
          // (2026-05-04 ~13:00) crashed the chip with a backtrace
          // because abandoning a leaked task that holds Bluedroid
          // mutexes corrupts the BLE stack on the next session. Plain
          // call is safer; if it hangs the BLE stack auto-resets the
          // chip after ~25 s, which is annoying but cleanly recoverable.
          Serial.printf("BLE: cmd '%s' product_code=0x%02X — writeValue (18 bytes, key=0x%02X)...\n",
                        action.c_str(), product_code, _jura_key);
          unsigned long t_before = millis();
          startProd->writeValue(cmdBuf, sizeof(cmdBuf), true);
          unsigned long t_after = millis();
          Serial.printf("BLE: writeValue returned after %lu ms\n", t_after - t_before);
          publishEspEvent("cmd", "ble", action.c_str(), "sent");
        } else {
          Serial.println("BLE: START_PRODUCT characteristic not found");
          publishEspEvent("cmd-blocked", "ble", action.c_str(), "no_start_char");
        }
      }
    }
  }

  // ── Step 5: stats poll DISABLED — Bluedroid's BLERemoteCharacteristic
  // ::readValue() has no timeout and the J6 doesn't respond to plain
  // reads on MACHINE_STATUS or ABOUT_MACHINE without a prior write
  // handshake (protocol-bt-cpp hints at "WRITE STATISTICS_COMMAND →
  // READ STATISTICS_DATA"). Calling readValue() blocks the loop
  // indefinitely, which prevents the cmd block (above) from firing
  // when we click brew. Skip reads entirely until brew is proven and
  // we know what handshake the J6 needs. The brew path doesn't need
  // any reads — writes to START_PRODUCT are fire-and-forget.

  // ── Step 6: clean disconnect (always) ────────────────────────────
  Serial.println("BLE: closing session");
  _client->disconnect();
  delay(150);
  _last_failed_attempt_ms = 0;   // session reached the end — clear backoff
}
