/*
 * Esp_Base.ino — ESP base for salon_bridge (ESP32-C3).
 *
 * Same shape as the My_Bathroom_Smell_6 base block — pulls per-board
 * specifics from Main.h, owns the schema/avail/status/config/command/event
 * MQTT plumbing. Status payload publishes the JuraState struct fields so the
 * rule engine projects them into devices.last_state.dps.
 *
 * BLE communication itself lives in Jura_BLE.ino — this file just owns the
 * MQTT framing + EEPROM + params.
 *
 * Topic convention (driven by device_id in Main.h):
 *   mur/home/esp/<id>/availability   board → broker (online / offline)
 *   mur/home/esp/<id>/schema         board → broker (parameters + actions, retained)
 *   mur/home/esp/<id>/status         board → broker (every 60 s)
 *   mur/home/esp/<id>/config         broker → board (parameter writes, JSON)
 *   mur/home/esp/<id>/command        broker → board (action key as plain string)
 *   mur/home/esp/<id>/event          board → broker (acks + ad-hoc events, JSON)
 */

#include "Main.h"
#include <ArduinoOTA.h>
#include <ArduinoJson.h>
#include <EEPROM.h>

// ─── EEPROM layout ────────────────────────────────────────────────────────
// 0..31  : HA_IP (managed by salon_bridge.ino /set_ip recovery path)
// 32     : magic byte (0xA5 → params written; anything else → defaults)
// 33..36 : poll_interval_sec     (uint32_t)
// 37..40 : reconnect_backoff_sec (uint32_t)
// 41     : auth_retry_max        (uint8_t)
//
// Magic byte history:
//   0xA5 — initial layout (3 fields)
// Bump whenever the on-disk struct changes incompatibly.
#define ESP_PARAMS_ADDR  32
#define ESP_PARAMS_MAGIC 0xA5

// Schema published once on every Mosquitto connect (retained). Kept in
// PROGMEM so the literal stays out of RAM. Built-in actions (`restart`,
// `factory_reset`) are dispatched without needing schema entries — the
// dashboard renders them automatically.
//
// Cleaning cycle is intentionally NOT in actions — the cleaning_required
// bool DPS surfaces the need, the user triggers cleaning on the machine.
static const char ESP_SCHEMA_JSON[] PROGMEM = R"json({"parameters":[{"key":"poll_interval_sec","type":"int","default":30,"min":5,"max":300,"persistent":true,"description":"BlueFrog stats poll interval (seconds)"},{"key":"reconnect_backoff_sec","type":"int","default":10,"min":5,"max":120,"persistent":true,"description":"BLE reconnect cooldown after disconnect (seconds)"},{"key":"auth_retry_max","type":"int","default":3,"min":1,"max":10,"persistent":true,"description":"Jutta-Proto auth handshake attempts before reboot"}],"actions":[{"key":"on","label":"Power ON","description":"Wake + brew espresso (alias for brew_espresso)"},{"key":"off","label":"Power OFF","description":"Put machine in standby (alias for standby)"},{"key":"enter_ota_mode","label":"Enter OTA Mode","description":"Reboot with BLE off for 5 min so OTA can push — this board's BLE sessions otherwise block the loop and starve ArduinoOTA (press then push OTA)"},{"key":"brew_espresso","label":"Brew Espresso","description":"Start a single espresso"},{"key":"brew_coffee","label":"Brew Coffee","description":"Start a single coffee"},{"key":"brew_2x_espresso","label":"Brew 2× Espresso","description":"Two espressos in succession"},{"key":"brew_2x_coffee","label":"Brew 2× Coffee","description":"Two coffees in succession"},{"key":"hot_water","label":"Hot Water","description":"Dispense hot water"},{"key":"cancel","label":"Cancel","description":"Abort current operation"},{"key":"standby","label":"Standby","description":"Put machine in standby"}]})json";

// ─── EEPROM-backed param load / save ──────────────────────────────────────
static void loadEspParams() {
  EEPROM.begin(EEPROM_SIZE);
  uint8_t magic = EEPROM.read(ESP_PARAMS_ADDR);
  if (magic != ESP_PARAMS_MAGIC) {
    Serial.println("ESP params: defaults (no EEPROM marker)");
    return;
  }
  int addr = ESP_PARAMS_ADDR + 1;
  EEPROM.get(addr, esp_params.poll_interval_sec);     addr += 4;
  EEPROM.get(addr, esp_params.reconnect_backoff_sec); addr += 4;
  esp_params.auth_retry_max = EEPROM.read(addr);
  Serial.printf("ESP params loaded: poll=%lus reconnect=%lus auth_retry=%u\n",
    (unsigned long)esp_params.poll_interval_sec,
    (unsigned long)esp_params.reconnect_backoff_sec,
    esp_params.auth_retry_max);
}

static void saveEspParams() {
  EEPROM.begin(EEPROM_SIZE);
  int addr = ESP_PARAMS_ADDR;
  EEPROM.write(addr, ESP_PARAMS_MAGIC);                addr++;
  EEPROM.put(addr, esp_params.poll_interval_sec);      addr += 4;
  EEPROM.put(addr, esp_params.reconnect_backoff_sec);  addr += 4;
  EEPROM.write(addr, esp_params.auth_retry_max);
  EEPROM.commit();
  Serial.println("ESP params saved to EEPROM");
}

// ─── Outbound publishers ──────────────────────────────────────────────────
static void publishEspStatus() {
  if (!client_Moskuitto.connected()) return;
  StaticJsonDocument<1536> doc;
  doc["ip"]                 = WiFi.localIP().toString();
  doc["rssi"]               = WiFi.RSSI();
  doc["uptime_s"]           = millis() / 1000;
  doc["free_heap"]          = ESP.getFreeHeap();
  doc["sketch_name"]        = sketch_name;
  doc["sketch_version"]     = sketch_version;
  doc["build_ts"]           = build_ts;
  doc["mosq_connected"]     = client_Moskuitto.connected();
  // Jura DPS — projected into devices.last_state by rule_engine's
  // _ESP_STATUS_DPS_FIELDS (must include these names there).
  doc["power_state"]        = jura_state.power_state;
  doc["current_drink"]      = jura_state.current_drink;
  doc["stats_valid"]        = jura_state.stats_valid;
  // Counters + maintenance are published ONLY once a BLE read has actually
  // succeeded this boot (stats_valid). Otherwise they'd be default 0s and the
  // rule engine's JSONB merge would clobber the DB's real last-known counts
  // (e.g. wipe 10987 -> 0 on a reboot while the machine is off).
  // NOTE: live alert bits (water/beans/grounds/tray/…) are intentionally NOT
  // published — MACHINE_STATUS echoes the stats command on this machine, so
  // the bits are unreliable (see [[project_jura_phase2]]). Removed rather than
  // show wrong data; counters + maintenance are solid.
  if (jura_state.stats_valid) {
    doc["total_dispensed"]      = jura_state.total_dispensed;
    doc["cnt_ristretto"]        = jura_state.cnt_ristretto;
    doc["cnt_espresso"]         = jura_state.cnt_espresso;
    doc["cnt_coffee"]           = jura_state.cnt_coffee;
    doc["cnt_cappuccino"]       = jura_state.cnt_cappuccino;
    doc["cnt_esp_macchiato"]    = jura_state.cnt_esp_macchiato;
    doc["cnt_latte"]            = jura_state.cnt_latte;
    doc["cnt_milk"]             = jura_state.cnt_milk;
    doc["cnt_hotwater"]         = jura_state.cnt_hotwater;
    doc["cnt_2ristretti"]       = jura_state.cnt_2ristretti;
    doc["cnt_2espressi"]        = jura_state.cnt_2espressi;
    doc["cnt_2coffee"]          = jura_state.cnt_2coffee;
    doc["cnt_flat_white"]       = jura_state.cnt_flat_white;
    doc["pct_cleaning"]         = jura_state.pct_cleaning;
    doc["pct_filter"]           = jura_state.pct_filter;
    doc["pct_descale"]          = jura_state.pct_descale;
    doc["maint_cleanings"]      = jura_state.maint_cleanings;
    doc["maint_filter_changes"] = jura_state.maint_filter_changes;
    doc["maint_descalings"]     = jura_state.maint_descalings;
    doc["maint_milk_rinses"]    = jura_state.maint_milk_rinses;
    doc["maint_coffee_rinses"]  = jura_state.maint_coffee_rinses;
    doc["maint_milk_cleans"]    = jura_state.maint_milk_cleans;
  }
  // Bridge diagnostic (dashboard Status sub-tab):
  doc["ble_connected"]      = jura_state.ble_connected;
  doc["ble_rssi"]           = jura_state.ble_rssi;
  doc["auth_ok"]            = jura_state.auth_ok;
  doc["last_poll_unix"]     = jura_state.last_poll_unix;
  char buf[1536];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  client_Moskuitto.publish(esp_status_topic.c_str(), (const uint8_t*)buf, n, false);
}

void publishEspEvent(const char* kind, const char* src, const char* topic, const char* payload) {
  if (!client_Moskuitto.connected()) return;
  StaticJsonDocument<256> doc;
  doc["kind"] = kind;
  doc["src"]  = src;
  if (topic && *topic)     doc["topic"]   = topic;
  if (payload && *payload) doc["payload"] = payload;
  doc["ts"] = (uint32_t)(millis() / 1000);
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  client_Moskuitto.publish(esp_event_topic.c_str(), (const uint8_t*)buf, n, false);
}

static void publishEspSchema() {
  if (!client_Moskuitto.connected()) return;
  client_Moskuitto.publish_P(
    esp_schema_topic.c_str(),
    (const uint8_t*)ESP_SCHEMA_JSON,
    strlen_P(ESP_SCHEMA_JSON),
    true
  );
}

static void publishEspAck(const char* action) {
  if (!client_Moskuitto.connected()) return;
  StaticJsonDocument<128> doc;
  doc["kind"]   = "ack";
  doc["action"] = action;
  doc["ts"]     = (uint32_t)(millis() / 1000);
  char buf[128];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  client_Moskuitto.publish(esp_event_topic.c_str(), (const uint8_t*)buf, n, false);
}

// ─── Setup hook (called from salon_bridge.ino setup()) ─────────────────
void espBaseSetup() {
  String idStr = String(device_id);
  esp_avail_topic   = "mur/home/esp/" + idStr + "/availability";
  esp_schema_topic  = "mur/home/esp/" + idStr + "/schema";
  esp_status_topic  = "mur/home/esp/" + idStr + "/status";
  esp_config_topic  = "mur/home/esp/" + idStr + "/config";
  esp_command_topic = "mur/home/esp/" + idStr + "/command";
  esp_event_topic   = "mur/home/esp/" + idStr + "/event";

  loadEspParams();

  // ArduinoOTA — wireless flash listener. ESP32 family default port 3232.
  ArduinoOTA.setHostname(device_id);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  // Pause BLE on OTA start. The C3 has a single 2.4 GHz radio shared by
  // WiFi + BLE (TDMA); active NimBLE polling steals airtime from WiFi and
  // makes espota.py's UDP handshake drop packets ("No response from the
  // ESP" after 10 invites). juraBlePrepareForOta() does a race-safe
  // disconnect + deinit so the BLE task isn't yanked mid-operation.
  ArduinoOTA.onStart   ([](){
    Serial.println("OTA: start");
    juraBlePrepareForOta();
    publishEspEvent("state", "ota", "phase", "starting");
  });
  ArduinoOTA.onEnd     ([](){ Serial.println("\nOTA: end (rebooting)"); publishEspEvent("state", "ota", "phase", "complete"); });
  ArduinoOTA.onProgress([](unsigned int p, unsigned int t){ Serial.printf("OTA: %u%%\r", t ? (p / (t / 100)) : 0); });
  ArduinoOTA.onError   ([](ota_error_t e){ Serial.printf("OTA error %u\n", e); publishEspEvent("state", "ota", "error", String((int)e).c_str()); });
  ArduinoOTA.begin();
  Serial.println("OTA: ready");
}

// ─── Mosquitto-connect hook (called from reconnect_Mosquitto on success) ─
void espBaseOnMosquittoConnect() {
  client_Moskuitto.publish(esp_avail_topic.c_str(), "online", true);
  publishEspSchema();
  publishEspStatus();
  client_Moskuitto.subscribe(esp_config_topic.c_str());
  client_Moskuitto.subscribe(esp_command_topic.c_str());
  Serial.println("ESP base: connected — schema/status published, /config + /command subscribed");
}

// ─── Loop hook — 60 s status heartbeat ────────────────────────────────────
void espBaseLoop() {
  static unsigned long last_status_ms = 0;
  unsigned long now_ms = millis();
  if (now_ms - last_status_ms > 60000UL) {
    last_status_ms = now_ms;
    publishEspStatus();
  }
}

// ─── Inbound dispatcher — returns true if topic was an ESP base topic ────
bool espBaseHandleMessage(const char* topic, byte* payload, unsigned int length) {
  String t = String(topic);

  if (t == esp_config_topic) {
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
      Serial.print("ESP /config parse error: ");
      Serial.println(err.c_str());
      return true;
    }
    if (doc.containsKey("poll_interval_sec"))     esp_params.poll_interval_sec     = doc["poll_interval_sec"].as<uint32_t>();
    if (doc.containsKey("reconnect_backoff_sec")) esp_params.reconnect_backoff_sec = doc["reconnect_backoff_sec"].as<uint32_t>();
    if (doc.containsKey("auth_retry_max"))        esp_params.auth_retry_max        = doc["auth_retry_max"].as<uint8_t>();
    saveEspParams();
    Serial.println("ESP /config applied + persisted");
    return true;
  }

  if (t == esp_command_topic) {
    String cmd = "";
    for (unsigned int i = 0; i < length; i++) cmd += (char)payload[i];
    cmd.trim();
    Serial.println("ESP /command: " + cmd);

    if      (cmd == "enter_ota_mode") {
      // Set RTC flag and reboot. Next boot skips BLE init so ArduinoOTA
      // has the radio uncontested. After successful OTA the new firmware
      // boots normally (flag was consumed in setup()). Hard ceiling 5 min
      // — board auto-reboots back to normal mode if no OTA arrives.
      publishEspAck("enter_ota_mode");
      enterOtaModeAndReboot();
    }
    else if (cmd == "restart")       { publishEspAck("restart"); delay(200); ESP.restart(); }
    else if (cmd == "factory_reset") {
      EEPROM.begin(EEPROM_SIZE);
      for (int i = 0; i < EEPROM_SIZE; i++) EEPROM.write(i, 0);
      EEPROM.commit();
      Serial.println("EEPROM cleared — restarting");
      publishEspAck("factory_reset");
      delay(200);
      ESP.restart();
    }
    else {
      // Try Jura BLE dispatch (brew_*, cancel, standby).
      // juraSendCommand returns false EITHER because the action is unknown,
      // OR because BLE wasn't connected/authed, OR because the write itself
      // failed at the BLE layer. Jura_BLE.ino logs the precise reason; here
      // we just relay an ack on success.
      if (juraSendCommand(cmd.c_str())) publishEspAck(cmd.c_str());
    }
    return true;
  }

  return false;
}
