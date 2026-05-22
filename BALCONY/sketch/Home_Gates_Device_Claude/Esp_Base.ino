/*
 * Esp_Base.ino — ESP base for Home_Gates_Device (Phase 2 onboarding).
 *
 * Same shape as the reference RemoteXY_ESP8266_Claude/Esp_Base.ino:
 *   mur/home/esp/<id>/availability   board → broker (online / offline LWT)
 *   mur/home/esp/<id>/schema         board → broker (parameters + actions, retained)
 *   mur/home/esp/<id>/status         board → broker (60 s heartbeat + on every state change)
 *   mur/home/esp/<id>/config         broker → board (parameter writes, JSON)
 *   mur/home/esp/<id>/command        broker → board (test action key as plain string)
 *   mur/home/esp/<id>/event          board → broker (acks + ad-hoc events, JSON)
 *
 * Per-board adaptations vs the reference:
 *   - 2 tunable params (gate auto-close delays) instead of 7
 *   - 4 actions (open_barrier / open_both_gates / clear_eeprom / reset_wifi)
 *     plus built-in `restart`. NO HiveMQ — this board doesn't bridge to cloud.
 *   - /status carries live progress (gates_state / barrier_progress /
 *     gates_progress) so a HASP/Awtrix/Pixoo display can render a progress
 *     bar via the rule engine projecting these into devices.last_state.
 */

#include "Main.h"
#include <ArduinoOTA.h>
#include <ArduinoJson.h>
#include <EEPROM.h>
#include <esp_task_wdt.h>   // OTA onStart/onEnd hooks below toggle loop-task WDT subscription

// ─── EEPROM layout ────────────────────────────────────────────────────────
// 0..31  : HA_IP (legacy, managed by Home_Gates_Device_ver11.ino)
// 32     : magic byte (0xB1 → params written; anything else → use defaults)
// 33..36 : delay_btw_pulses_barrier (uint32_t)
// 37..40 : delay_btw_pulses_both    (uint32_t)
//
// Magic byte history:
//   0xB1 — initial Home_Gates esp_boards onboarding (2026-05-05)
// Bump whenever EspParams changes shape.
#define ESP_PARAMS_ADDR   32
#define ESP_PARAMS_MAGIC  0xB1

// Schema published once on every Mosquitto connect (retained). PROGMEM-resident.
static const char ESP_SCHEMA_JSON[] PROGMEM = R"json({"parameters":[{"key":"delay_btw_pulses_barrier","type":"int","default":3,"min":1,"max":10,"persistent":true,"description":"Barrier auto-close delay between pulses (sec)"},{"key":"delay_btw_pulses_both","type":"int","default":2,"min":1,"max":10,"persistent":true,"description":"Both-gates auto-close delay between pulses (sec)"}],"actions":[{"key":"open_barrier","label":"Open Barrier","description":"Run the barrier pulse sequence — opens then auto-closes"},{"key":"open_both_gates","label":"Open Both Gates","description":"Run the full gate+barrier sequence"},{"key":"restart","label":"Restart","description":"Reboot the board (ESP.restart)"},{"key":"clear_eeprom","label":"Clear EEPROM","description":"Wipe stored broker IP"},{"key":"reset_wifi","label":"Force WiFi Reset","description":"Simulate WiFi loss — recovery path runs automatically"}]})json";

// ─── EEPROM-backed param load / save ──────────────────────────────────────
static void loadEspParams() {
  EEPROM.begin(EEPROM_SIZE);
  uint8_t magic = EEPROM.read(ESP_PARAMS_ADDR);
  if (magic != ESP_PARAMS_MAGIC) {
    Serial.println("ESP params: defaults (no EEPROM marker)");
    return;
  }
  int addr = ESP_PARAMS_ADDR + 1;
  EEPROM.get(addr, esp_params.delay_btw_pulses_barrier);  addr += 4;
  EEPROM.get(addr, esp_params.delay_btw_pulses_both);     addr += 4;
  Serial.printf("ESP params loaded: barrier_delay=%lus both_delay=%lus\n",
    (unsigned long)esp_params.delay_btw_pulses_barrier,
    (unsigned long)esp_params.delay_btw_pulses_both);
}

static void saveEspParams() {
  EEPROM.begin(EEPROM_SIZE);
  int addr = ESP_PARAMS_ADDR;
  EEPROM.write(addr, ESP_PARAMS_MAGIC);                   addr++;
  EEPROM.put(addr, esp_params.delay_btw_pulses_barrier);  addr += 4;
  EEPROM.put(addr, esp_params.delay_btw_pulses_both);     addr += 4;
  EEPROM.commit();
  Serial.println("ESP params saved to EEPROM");
}

// ─── Outbound publishers ──────────────────────────────────────────────────
static void publishEspStatus() {
  if (!client_Moskuitto.connected()) return;
  StaticJsonDocument<384> doc;
  doc["ip"]                = WiFi.localIP().toString();
  doc["rssi"]              = WiFi.RSSI();
  doc["uptime_s"]          = millis() / 1000;
  doc["free_heap"]         = ESP.getFreeHeap();
  doc["sketch_name"]       = sketch_name;
  doc["sketch_version"]    = sketch_version;
  doc["build_ts"]          = build_ts;
  doc["mosq_connected"]    = client_Moskuitto.connected();
  // Live state — projected into devices.last_state by the rule engine
  // (rule_engine.py _ESP_STATUS_DPS_FIELDS — must include these keys).
  doc["gates_state"]       = params.gates_state;
  doc["barrier_progress"]  = (int)params.barrier_progress;
  doc["gates_progress"]    = (int)params.gates_progress;
  char buf[384];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  client_Moskuitto.publish(esp_status_topic.c_str(), (const uint8_t*)buf, n, false);
}

// Public wrapper — Process_States.ino calls this on every progress
// change (each pulse, each delay tick) so the display sees real-time
// movement instead of waiting for the 60 s heartbeat.
void publishEspStatusNow() { publishEspStatus(); }

// publishEspEvent — fire a small JSON event to the /event topic. Used for
// HOME_REQUEST rx + ack + state change notifications. The dashboard's
// page-level Live MQTT Events card subscribes to mur/home/esp/+/event
// via WebSocket and renders.
void publishEspEvent(const char* kind, const char* src, const char* topic, const char* payload) {
  if (!client_Moskuitto.connected()) return;
  StaticJsonDocument<256> doc;
  doc["kind"] = kind;          // 'rx' | 'ack' | 'state'
  doc["src"]  = src;
  if (topic   && *topic)   doc["topic"]   = topic;
  if (payload && *payload) doc["payload"] = payload;
  doc["ts"]   = (uint32_t)(millis() / 1000);
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
    true   // retained — dashboard reads on board enrol
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

// ─── Setup hook (called from Home_Gates_Device_ver11.ino setup()) ─────────
void espBaseSetup() {
  String idStr      = String(device_id);
  esp_avail_topic   = "mur/home/esp/" + idStr + "/availability";
  esp_schema_topic  = "mur/home/esp/" + idStr + "/schema";
  esp_status_topic  = "mur/home/esp/" + idStr + "/status";
  esp_config_topic  = "mur/home/esp/" + idStr + "/config";
  esp_command_topic = "mur/home/esp/" + idStr + "/command";
  esp_event_topic   = "mur/home/esp/" + idStr + "/event";

  loadEspParams();

  ArduinoOTA.setHostname(device_id);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  // OTA hooks. onStart removes the loop task from TWDT — Update.write()
  // can block several seconds per chunk during the flash, longer than
  // the 8 s default. onEnd re-adds (no-op since we're about to reboot,
  // but defensive). Without this the ESP32 watchdog can panic mid-upload
  // and the dashboard sees WinError 10054 around 30-40%.
  ArduinoOTA.onStart   ([]() {
    esp_task_wdt_delete(NULL);
    Serial.println("OTA: start (loop WDT detached)");
  });
  ArduinoOTA.onEnd     ([]() {
    esp_task_wdt_add(NULL);
    Serial.println("\nOTA: end");
  });
  ArduinoOTA.onProgress([](unsigned int p, unsigned int t){ Serial.printf("OTA: %u%%\r", t ? (p / (t / 100)) : 0); });
  ArduinoOTA.onError   ([](ota_error_t e)                 { Serial.printf("OTA error %u\n", e); });
  ArduinoOTA.begin();
  Serial.println("OTA: ready");
}

// ─── Mosquitto-connect hook (called from reconnect_Mosquitto success) ────
void espBaseOnMosquittoConnect() {
  client_Moskuitto.publish(esp_avail_topic.c_str(), "online", true);
  publishEspSchema();
  publishEspStatus();
  client_Moskuitto.subscribe(esp_config_topic.c_str());
  client_Moskuitto.subscribe(esp_command_topic.c_str());
  Serial.println("ESP base: connected — schema/status published, /config + /command subscribed");
}

// ─── Loop hook — 60 s status heartbeat (in addition to per-state pushes) ─
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
    StaticJsonDocument<192> doc;
    DeserializationError err = deserializeJson(doc, payload, length);
    if (err) {
      Serial.print("ESP /config parse error: ");
      Serial.println(err.c_str());
      return true;
    }
    if (doc.containsKey("delay_btw_pulses_barrier"))
      esp_params.delay_btw_pulses_barrier = doc["delay_btw_pulses_barrier"].as<uint32_t>();
    if (doc.containsKey("delay_btw_pulses_both"))
      esp_params.delay_btw_pulses_both    = doc["delay_btw_pulses_both"].as<uint32_t>();
    saveEspParams();
    Serial.println("ESP /config applied + persisted");
    return true;
  }

  if (t == esp_command_topic) {
    String cmd = "";
    for (unsigned int i = 0; i < length; i++) cmd += (char)payload[i];
    cmd.trim();
    Serial.println("ESP /command: " + cmd);
    publishEspEvent("rx", "command", esp_command_topic.c_str(), cmd.c_str());

    if (cmd == "open_barrier") {
      params.machine_1_state = STATE_BARRIER_REQUEST;
      publishEspAck("open_barrier");
    } else if (cmd == "open_both_gates") {
      params.machine_1_state = STATE_BOTH_REQUEST;
      publishEspAck("open_both_gates");
    } else if (cmd == "clear_eeprom") {
      publishEspAck("clear_eeprom");
      clearStoredHaIp();
      ha_ip = "";
      client_Moskuitto.disconnect();
      reconnect_Mosquitto();
    } else if (cmd == "reset_wifi") {
      publishEspAck("reset_wifi");
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF);
    } else if (cmd == "restart") {
      publishEspAck("restart");
      delay(200);
      ESP.restart();
    } else {
      Serial.println("ESP /command: unknown action");
    }
    return true;
  }

  return false;
}
