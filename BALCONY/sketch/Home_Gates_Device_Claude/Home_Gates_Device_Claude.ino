/* Home_Gates_Device — Project Boards onboarding (v12, ESP32; orig 2026-05-05, v12 2026-06-08)
 *
 *   v12 (2026-06-08): MQTT self-heal — reconnect ALWAYS retries the known broker
 *   (awaiting_new_mqtt_ip is informational only, no longer blocks reconnect); the
 *   /set_ip HTTP fallback opens only after MOSQ_FAIL_HTTP_THRESHOLD consecutive
 *   failures. Mirrors the proven RemoteXY_ESP8266_Claude reconnect pattern.
 *
 *   Migrated from ESP8266 to ESP32 because the ESP8266 board's MAC
 *   (4c:eb:d6:1f:ef:c6) was stuck in REASON_AUTH_FAIL on the DECO mesh
 *   after a flash storm. ESP32 has a fresh MAC + association state.
 *
 *   ESP32 Dev Module → Wi-Fi → Mosquitto on LXC 107.
 *   Topics: mur/home/esp/gates_01/...
 *
 *   Behavior unchanged from the ESP8266 build:
 *     - Listens on legacy MQTT topic "HOME_REQUEST" for "12" (barrier),
 *       "13" (both gates) — keeps existing publishers working.
 *     - Listens on mur/home/esp/gates_01/command for the new action keys.
 *     - Publishes live progress to /status (gates_state /
 *       barrier_progress / gates_progress) on every state machine
 *       transition.
 *
 *   ESP32-specific changes vs the ESP8266 build:
 *     - <WiFi.h> + <WebServer.h> (not the ESP8266 variants)
 *     - esp_task_wdt_* watchdog API (not ESP.wdtEnable)
 *     - esp_timer_* for the 1 Hz tick (not timer1_*)
 *     - WiFi.onEvent for disconnect handling (not onStationModeDisconnected)
 *     - esp_wifi_set_max_tx_power / WiFi.setMinSecurity / disable PMF —
 *       same crowded-AP hardening pattern as the smell board sketch.
 *     - OTA port 3232 (auto-selected by ArduinoOTA on ESP32).
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <EEPROM.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include <ArduinoOTA.h>
#include "Main.h"

WebServer server(80);

// ─── Watchdog ────────────────────────────────────────────────────────────
static bool wdt_initialized = false;
static inline void ensureWdtEnabled(uint32_t timeout_ms = 8000) {
  if (!wdt_initialized) {
    const esp_task_wdt_config_t twdt_cfg = {
      .timeout_ms     = (int)timeout_ms,
      .idle_core_mask = 0,
      .trigger_panic  = true
    };
    esp_task_wdt_init(&twdt_cfg);
    esp_task_wdt_add(NULL);
    wdt_initialized = true;
  }
}
static inline void wdt_feed_safe() { esp_task_wdt_reset(); }

// ─── Wi-Fi helpers ───────────────────────────────────────────────────────
static inline bool wifiIsUp() {
  return (WiFi.status() == WL_CONNECTED) && (WiFi.localIP() != IPAddress(0,0,0,0));
}

static const char* wlStatusName(wl_status_t s) {
  switch (s) {
    case WL_IDLE_STATUS:     return "IDLE";
    case WL_NO_SSID_AVAIL:   return "NO_SSID";
    case WL_SCAN_COMPLETED:  return "SCAN_DONE";
    case WL_CONNECTED:       return "CONNECTED";
    case WL_CONNECT_FAILED:  return "CONNECT_FAILED";
    case WL_CONNECTION_LOST: return "CONN_LOST";
    case WL_DISCONNECTED:    return "DISCONNECTED";
    default:                 return "UNKNOWN";
  }
}

static bool waitForWifiStable(uint32_t dwell_ms = 800, uint32_t timeout_ms = 20000) {
  const unsigned long t0 = millis();
  unsigned long dwell_start = 0;
  IPAddress last_ip(0,0,0,0);
  Serial.println("Waiting for Wi-Fi to stabilize...");
  while (true) {
    unsigned long now = millis();
    wl_status_t st = WiFi.status();
    IPAddress ip = WiFi.localIP();
    bool good = (st == WL_CONNECTED) && (ip != IPAddress(0,0,0,0));
    if (good) {
      if (dwell_start == 0 || ip != last_ip) { dwell_start = now; last_ip = ip; }
      if (now - dwell_start >= dwell_ms) {
        Serial.printf("Wi-Fi stable (ip=%s)\n", ip.toString().c_str());
        return true;
      }
    } else {
      dwell_start = 0;
    }
    if (timeout_ms && (now - t0 >= timeout_ms)) { Serial.println("Wi-Fi did not stabilize."); return false; }
    wdt_feed_safe();
    delay(10);
  }
}

static bool wifi_blocking_connect_with_timeout(uint32_t timeout_ms = 20000) {
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < timeout_ms) {
    wdt_feed_safe();
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) { waitForWifiStable(800, 3000); return true; }
  return false;
}

void disablePMF() {
  wifi_config_t cfg;
  esp_wifi_get_config(WIFI_IF_STA, &cfg);
  cfg.sta.pmf_cfg.capable  = false;
  cfg.sta.pmf_cfg.required = false;
  esp_wifi_set_config(WIFI_IF_STA, &cfg);
}

// ─── Wi-Fi recovery (event-driven, with bounded retry) ───────────────────
volatile bool wifi_disconnected_evt = false;

void start_wifi_again() {
  static unsigned long wifi_retry_start = 0;
  static bool retrying_wifi = false;
  params.wifi_flag = LINK_DISCONNECTED;
  params.mqtt_flag = LINK_DISCONNECTED;
  if (!retrying_wifi) {
    retrying_wifi = true;
    wifi_retry_start = millis();
    Serial.println("Wi-Fi reconnect started...");
    WiFi.disconnect(true, true);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.setSleep(false);
    WiFi.setHostname(device_id);
    delay(100);
    WiFi.begin(ssid, pass);
  }
  wdt_feed_safe();
  if (WiFi.status() == WL_CONNECTED) {
    if (WiFi.localIP() == IPAddress(0,0,0,0)) return;
    Serial.println("Wi-Fi reconnected: " + WiFi.localIP().toString());
    waitForWifiStable(800, 3000);
    retrying_wifi = false;
    params.wifi_flag = LINK_CONNECTED;
    return;
  }
  if (millis() - wifi_retry_start > 20000) {
    Serial.println("Wi-Fi failed to reconnect — restarting");
    retrying_wifi = false;
    esp_restart();
  }
}

// ─── Buzzer ──────────────────────────────────────────────────────────────
#define BUZZER_BEEP_MS 200
static inline void buzzWrite(bool on) { digitalWrite(Buzzer, on ? HIGH : LOW); }

void buzzer() {
  if (params.buzzer_flag == ON) {
    buzzWrite(true);
    delay(BUZZER_BEEP_MS);
    buzzWrite(false);
    params.buzzer_flag = OFF;
  }
}

// ─── MQTT reconnect bookkeeping ──────────────────────────────────────────
unsigned long last_mosq_attempt = 0;
const unsigned long MOSQ_RETRY_MS = 1000;
// Consecutive Mosquitto connect failures before the /set_ip HTTP fallback opens.
// Mirrors RemoteXY's esp_params.mosq_fail_http_threshold — a transient blip must
// NOT trip the fallback; loop() keeps retrying the known broker regardless.
#define MOSQ_FAIL_HTTP_THRESHOLD 10
static uint8_t mosq_fail_count = 0;
unsigned long last_ip_print_time = 0;
bool schedule_http_server_close = false;
unsigned long http_server_close_time = 0;
static unsigned long ip_handover_until_ms = 0;

// ─── 1 Hz tick — drives Action_Timer_1 in Process_States.ino ─────────────
IRAM_ATTR void onTimerISR() { tick_1s = true; }

// ─── HTTP /set_ip recovery handler ───────────────────────────────────────
void handle_set_ip() {
  if (!server.hasArg("ip")) { server.send(400, "text/plain", "Missing ip"); return; }
  String ipArg = server.arg("ip");
  IPAddress parsed;
  if (!parsed.fromString(ipArg)) { server.send(400, "text/plain", "Invalid IPv4"); return; }
  ha_ip = ipArg;
  EEPROM.begin(EEPROM_SIZE);
  for (int i = 0; i < 32; i++) EEPROM.write(EEPROM_HA_IP_ADDR + i, i < (int)ha_ip.length() ? ha_ip[i] : 0);
  EEPROM.commit();
  awaiting_new_mqtt_ip = false;
  schedule_http_server_close = true;
  http_server_close_time = millis() + 15000;
  ip_handover_until_ms = millis() + 2000;
  reconnect_Mosquitto();
  server.send(200, "text/plain", "IP received");
}

void clearStoredHaIp() {
  EEPROM.begin(EEPROM_SIZE);
  for (int i = 0; i < 32; i++) EEPROM.write(EEPROM_HA_IP_ADDR + i, 0);
  EEPROM.commit();
  Serial.println("EEPROM: HA_IP cleared");
}

// ─── MQTT callback — delegates to ESP base then handles legacy topics ────
void callback_Mosquitto(char* topic, byte* payload, unsigned int length) {
  if (espBaseHandleMessage(topic, payload, length)) return;

  String incoming = "";
  for (unsigned int i = 0; i < length; i++) incoming += (char)payload[i];

  if (String(topic) == "HOME_REQUEST") {
    publishEspEvent("rx", "home_request", topic, incoming.c_str());
    if (incoming == "12") {
      command = "open-barrier";
      client_Moskuitto.publish(sensor_value_topic.c_str(), command, true);
      params.machine_1_state = STATE_BARRIER_REQUEST;
    } else if (incoming == "13") {
      command = "open-both_gates";
      client_Moskuitto.publish(sensor_value_topic.c_str(), command, true);
      params.machine_1_state = STATE_BOTH_REQUEST;
    } else if (incoming == "clear_eeprom") {
      clearStoredHaIp();
      ha_ip = "";
      client_Moskuitto.disconnect();
      reconnect_Mosquitto();
    } else if (incoming == "reset_wifi") {
      WiFi.disconnect(true, true);
    }
  }
}

// ─── Mosquitto reconnect (plain, port 1883) ──────────────────────────────
void reconnect_Mosquitto() {
  if (client_Moskuitto.connected()) return;
  if (!wifiIsUp()) return;
  bool ok = false;
  bool tried_eeprom = false, tried_hardcoded = false;
  const bool has_eeprom = (ha_ip.length() > 6 && ha_ip.indexOf('.') > 0);

  if (!ok && has_eeprom) {
    tried_eeprom = true;
    client_Moskuitto.setServer(ha_ip.c_str(), mqtt_port_moskuitto);
    Serial.println("Trying EEPROM IP: " + ha_ip);
    client_Moskuitto.setSocketTimeout(5);
    ok = client_Moskuitto.connect(device_id, mqtt_user_moskuitto, mqtt_pass_moskuitto,
                                  esp_avail_topic.c_str(), 0, true, "offline");
  }
  if (!ok) {
    tried_hardcoded = true;
    client_Moskuitto.setServer(mqtt_server_moskuitto, mqtt_port_moskuitto);
    Serial.println("Trying Hardcoded IP: " + String(mqtt_server_moskuitto));
    client_Moskuitto.setSocketTimeout(5);
    ok = client_Moskuitto.connect(device_id, mqtt_user_moskuitto, mqtt_pass_moskuitto,
                                  esp_avail_topic.c_str(), 0, true, "offline");
  }

  if (ok) {
    Serial.println("Mosquitto Server connected (plain)");
    client_Moskuitto.subscribe("HOME_REQUEST");
    params.mqtt_flag = LINK_CONNECTED;
    mosq_fail_count = 0;
    awaiting_new_mqtt_ip = false;
    if (http_server_enabled) { server.stop(); http_server_enabled = false; }
    espBaseOnMosquittoConnect();
    return;
  }

  Serial.println("MQTT connect failed across all paths.");
  params.mqtt_flag = LINK_DISCONNECTED;
  if (mosq_fail_count < 255) mosq_fail_count++;
  // Mirror RemoteXY: only fall back to the /set_ip HTTP recovery after MANY
  // consecutive failures — a transient blip must NOT latch us off the broker.
  // loop() keeps calling reconnect_Mosquitto() every MOSQ_RETRY_MS regardless,
  // so the board self-heals the moment the broker is reachable again.
  if (mosq_fail_count >= MOSQ_FAIL_HTTP_THRESHOLD) {
    awaiting_new_mqtt_ip = (tried_hardcoded && (tried_eeprom || !has_eeprom));
    if (!http_server_enabled && tried_hardcoded && (tried_eeprom || !has_eeprom) && wifiIsUp()) {
      server.on("/set_ip", handle_set_ip);
      server.begin();
      http_server_enabled = true;
      last_ip_print_time = millis();
      Serial.println("HTTP /set_ip enabled");
    }
  }
}

// ─── setup ───────────────────────────────────────────────────────────────
void setup() {
  params.machine_1_state    = STATE_IDLE;
  params.wifi_flag          = LINK_DISCONNECTED;
  params.mqtt_flag          = LINK_DISCONNECTED;
  params.gates_state        = "idle";
  params.barrier_progress   = -1;
  params.gates_progress     = -1;

  pinMode(Relay_1, OUTPUT);
  pinMode(Relay_2, OUTPUT);
  digitalWrite(Relay_1, LOW);
  digitalWrite(Relay_2, LOW);
  params.relay_state_gate    = ON;
  params.relay_state_barrier = ON;

  pinMode(Buzzer, OUTPUT);
  buzzWrite(false);

  Serial.begin(115200);
  delay(50);
  ensureWdtEnabled(8000);

  esp_wifi_restore();
  Serial.println("RF calibration reset done");

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.disconnect(true, true);
  delay(500);

  esp_wifi_set_max_tx_power(78);                  // ~19.5 dBm
  WiFi.setMinSecurity(WIFI_AUTH_WPA2_PSK);

  Serial.println("Starting WiFi scan...");
  int n = WiFi.scanNetworks();
  Serial.printf("%d networks found\n", n);

  // Lock to strongest BSSID for our SSID — survives crowded APs better.
  int best = -1;
  int bestRSSI = -1000;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == ssid && WiFi.RSSI(i) > bestRSSI) {
      bestRSSI = WiFi.RSSI(i);
      best = i;
    }
  }
  if (best == -1) {
    Serial.println("Target SSID not found — falling back to begin(ssid,pass)");
    WiFi.setAutoReconnect(true);
    WiFi.setSleep(false);
    disablePMF();
    WiFi.setHostname(device_id);
    WiFi.begin(ssid, pass);
  } else {
    uint8_t* bssid = WiFi.BSSID(best);
    int channel = WiFi.channel(best);
    Serial.printf("Connecting to BSSID — RSSI=%d ch=%d\n", bestRSSI, channel);
    WiFi.setAutoReconnect(true);
    WiFi.setSleep(false);
    disablePMF();
    WiFi.setHostname(device_id);
    WiFi.begin(ssid, pass, channel, bssid, true);
  }

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 25) {
    wdt_feed_safe();
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nFailed to connect after 25 attempts.");
  } else {
    Serial.printf("\nConnected. IP=%s MAC=%s RSSI=%d\n",
      WiFi.localIP().toString().c_str(),
      WiFi.macAddress().c_str(),
      WiFi.RSSI());
  }

  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      Serial.printf("Wi-Fi disconnected — reason=%u\n", info.wifi_sta_disconnected.reason);
      if (client_Moskuitto.connected()) {
        client_Moskuitto.publish(esp_avail_topic.c_str(), "offline", true);
        client_Moskuitto.disconnect();
      }
      params.wifi_flag = LINK_DISCONNECTED;
      params.mqtt_flag = LINK_DISCONNECTED;
      wifi_disconnected_evt = true;
    }
  });

  if (!wifi_blocking_connect_with_timeout(20000)) {
    Serial.println("Wi-Fi not available; will keep retrying in loop()");
  } else {
    params.wifi_flag = LINK_CONNECTED;
  }

  // Load stored Mosquitto IP from EEPROM (legacy /set_ip recovery slot).
  EEPROM.begin(EEPROM_SIZE);
  char stored_ip[33];
  for (int i = 0; i < 32; i++) stored_ip[i] = EEPROM.read(EEPROM_HA_IP_ADDR + i);
  stored_ip[32] = '\0';
  String storedHaIp = String(stored_ip);
  if (storedHaIp.length() > 6 && storedHaIp.indexOf('.') > 0) ha_ip = storedHaIp;

  // ESP base — registers OTA, builds topics, loads EEPROM params.
  espBaseSetup();

  // MQTT transport.
  static WiFiClient mosqPlain;
  client_Moskuitto.setClient(mosqPlain);
  client_Moskuitto.setCallback(callback_Mosquitto);
  client_Moskuitto.setKeepAlive(15);   // matches RemoteXY — stable because reconnect always retries (the bug was the latch, not the keepalive)
  client_Moskuitto.setSocketTimeout(5);
  client_Moskuitto.setBufferSize(4096);

  // Legacy topics (kept for back-compat with existing HOME_REQUEST publishers).
  sensor_value_topic = "homeassistant/sensor/" + String(device_id) + "/" + String(sensor_name) + "/state";
  availability_topic = "tele/" + String(device_id) + "/LWT";

  // Register HTTP route but DON'T start the server (only on MQTT failure).
  server.on("/set_ip", handle_set_ip);

  reconnect_Mosquitto();

  // 1 Hz tick → Action_Timer_1.
  {
    const esp_timer_create_args_t onesec_args = {
      .callback = [](void*){ onTimerISR(); },
      .arg = nullptr,
      .dispatch_method = ESP_TIMER_TASK,
      .name = "tick1s"
    };
    static esp_timer_handle_t onesec_timer;
    esp_timer_create(&onesec_args, &onesec_timer);
    esp_timer_start_periodic(onesec_timer, 1000000);
  }
}

// ─── loop ────────────────────────────────────────────────────────────────
void loop() {
  wdt_feed_safe();
  ArduinoOTA.handle();
  buzzer();

  unsigned long now_ms = millis();

  if (tick_1s) {
    tick_1s = false;
    Action_Timer_1();
  }

  static unsigned long last_wifi_retry = 0;
  if ((!wifiIsUp()) || wifi_disconnected_evt) {
    wifi_disconnected_evt = false;
    if (now_ms - last_wifi_retry > 15000) {
      Serial.println("Wi-Fi link down — calling start_wifi_again()");
      start_wifi_again();
      last_wifi_retry = now_ms;
    }
  }

  // Always retry the known broker while WiFi is up — exactly like the proven
  // RemoteXY sketch. The awaiting_new_mqtt_ip latch is INFORMATIONAL ONLY (it
  // drives the optional /set_ip fallback server) and must NEVER block
  // reconnection. Previously a single transient connect failure latched it and
  // parked the board off MQTT until a manual reboot (the 2026-06-08 gates_01
  // "offline but network ok" incident: WiFi/ping alive, MQTT dead forever).
  if (wifiIsUp() && !client_Moskuitto.connected()) {
    if (millis() >= ip_handover_until_ms && now_ms - last_mosq_attempt > MOSQ_RETRY_MS) {
      reconnect_Mosquitto();
      last_mosq_attempt = now_ms;
    }
  }

  if (http_server_enabled) {
    server.handleClient();
    if (awaiting_new_mqtt_ip
        && (millis() - last_ip_print_time > 10000)
        && !schedule_http_server_close) {
      Serial.println("Waiting IP...");
      last_ip_print_time = millis();
    }
  }
  if (schedule_http_server_close && millis() > http_server_close_time) {
    if (http_server_enabled) { server.stop(); http_server_enabled = false; }
    schedule_http_server_close = false;
  }

  if (wifiIsUp() && client_Moskuitto.connected()) {
    client_Moskuitto.loop();
    espBaseLoop();
  }
}
