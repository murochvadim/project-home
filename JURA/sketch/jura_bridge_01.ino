/* jura_bridge_01 — Path C of the Jura Coffee Machine integration.
 *
 *   ESP32-C3 → BLE client to BlueFrog → Wi-Fi → Mosquitto on LXC 107
 *   Slots into our esp_boards subsystem (Project Boards tab, OTA, rule
 *   chips). See JURA/CLAUDE.md for the architecture.
 *
 *   This .ino is the standard ESP-base entry point (WiFi setup, Mosquitto
 *   reconnect, HTTP /set_ip recovery, 1 Hz tick). BLE communication is in
 *   Jura_BLE.ino — driven once per loop tick from juraBleLoop().
 *
 *   Reference sketches: My_Bathroom_Smell_6 (the closest sibling), and
 *   RemoteXY_ESP8266_ver13 (the original ESP base pattern).
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

// ─── OTA-only boot mode (RTC-memory flag) ────────────────────────────────
// Magic value persists across reboots (RTC slow memory) but NOT across
// power-cycle — exactly what we want: a manual power-cycle always returns
// to normal mode in case OTA mode gets stuck.
//   0xA110_07A1 = "ALLO OTA1" mnemonic
RTC_DATA_ATTR uint32_t _ota_mode_magic = 0;
#define OTA_MODE_MAGIC      0xA11007A1
#define OTA_MODE_TIMEOUT_MS 300000UL   // 5 min hard ceiling — auto-reboot

bool g_ota_mode = false;   // populated in setup() — read by other files

void enterOtaModeAndReboot() {
  _ota_mode_magic = OTA_MODE_MAGIC;
  Serial.println("OTA-MODE: flag set, restarting into OTA-only mode");
  delay(200);
  ESP.restart();
}

// ─── Watchdog ────────────────────────────────────────────────────────────
// We DON'T want the Arduino loop task watchdog active — Bluedroid's
// BLE connect() can legitimately block for several seconds while the
// controller establishes the connection, which trips the default 5 s
// loop WDT. The hardware/interrupt watchdogs still run (catches actual
// hangs); only the loopTask task-WDT is removed.
//
// Earlier attempts to widen the WDT via esp_task_wdt_init silently fail
// in arduino-esp32 3.x because the framework initialises TWDT before
// setup() runs ("TWDT already initialized" warning).
static inline void disableLoopTaskWdt() {
  // arduino-esp32 3.x doesn't always auto-subscribe loopTask to the TWDT.
  // Calling esp_task_wdt_delete(NULL) when there's no subscription logs
  // a benign-but-noisy `E (NN) task_wdt: delete_entry(NN): task not found`
  // line on every boot. Status-check first → silent on boards where it's
  // already unsubscribed.
  if (esp_task_wdt_status(NULL) == ESP_OK) {
    esp_task_wdt_delete(NULL);
  }
}
// No-op: the loop task was removed from the TWDT in setup(), so calling
// esp_task_wdt_reset() now logs "task not found" once per call. We keep
// the symbol so existing call sites compile unchanged.
static inline void wdt_feed_safe() { /* loop task is exempt from TWDT */ }

// ─── Wi-Fi helpers (same pattern as smell board) ─────────────────────────
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
    WiFi.setSleep(WIFI_PS_NONE);
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

// ─── MQTT reconnect bookkeeping ──────────────────────────────────────────
unsigned long last_mosq_attempt = 0;
const unsigned long MOSQ_RETRY_MS = 1000;
static unsigned long ip_handover_until_ms = 0;
unsigned long last_ip_print_time = 0;
bool schedule_http_server_close = false;
unsigned long http_server_close_time = 0;

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

// ─── MQTT callback — delegates to ESP base dispatcher ────────────────────
void callback_Mosquitto(char* topic, byte* payload, unsigned int length) {
  if (espBaseHandleMessage(topic, payload, length)) return;
  Serial.print("MQTT msg unhandled topic: ");
  Serial.println(topic);
}

// ─── Mosquitto reconnect (plain, port 1883) ──────────────────────────────
void reconnect_Mosquitto() {
  if (client_Moskuitto.connected()) return;
  if (!wifiIsUp()) return;
  bool ok = false;
  const bool has_eeprom = (ha_ip.length() > 6 && ha_ip.indexOf('.') > 0);

  if (!ok && has_eeprom) {
    client_Moskuitto.setServer(ha_ip.c_str(), mqtt_port_moskuitto);
    Serial.println("Trying EEPROM IP: " + ha_ip);
    client_Moskuitto.setSocketTimeout(5);
    ok = client_Moskuitto.connect(device_id, mqtt_user_moskuitto, mqtt_pass_moskuitto,
                                  esp_avail_topic.c_str(), 0, true, "offline");
  }
  if (!ok) {
    client_Moskuitto.setServer(mqtt_server_moskuitto, mqtt_port_moskuitto);
    Serial.println("Trying Hardcoded IP: " + String(mqtt_server_moskuitto));
    client_Moskuitto.setSocketTimeout(5);
    ok = client_Moskuitto.connect(device_id, mqtt_user_moskuitto, mqtt_pass_moskuitto,
                                  esp_avail_topic.c_str(), 0, true, "offline");
  }
  if (ok) {
    Serial.println("MQTT Connected.");
    params.mqtt_flag = LINK_CONNECTED;
    awaiting_new_mqtt_ip = false;
    if (http_server_enabled) { server.stop(); http_server_enabled = false; }
    espBaseOnMosquittoConnect();
  } else {
    params.mqtt_flag = LINK_DISCONNECTED;
    awaiting_new_mqtt_ip = false;
    if (!http_server_enabled && wifiIsUp()) { server.begin(); http_server_enabled = true; }
  }
}

// ─── setup ───────────────────────────────────────────────────────────────
void setup() {
  params.wifi_flag = LINK_DISCONNECTED;
  params.mqtt_flag = LINK_DISCONNECTED;
  Serial.begin(115200);
  delay(50);
  disableLoopTaskWdt();   // BLE connect can block several seconds; don't let the 5 s loop WDT panic us
  esp_wifi_restore();

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.disconnect(true, true);
  delay(500);
  esp_wifi_set_max_tx_power(78);
  WiFi.setMinSecurity(WIFI_AUTH_WPA2_PSK);

  // Quick scan + lock to strongest BSSID for our SSID (same pattern as
  // smell board — survives crowded APs better than blind connect).
  Serial.println("WiFi scan...");
  int n = WiFi.scanNetworks();
  int best = -1; int bestRSSI = -1000;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == ssid && WiFi.RSSI(i) > bestRSSI) { bestRSSI = WiFi.RSSI(i); best = i; }
  }
  if (best == -1) { Serial.println("Target SSID not found"); return; }
  uint8_t* bssid = WiFi.BSSID(best);
  int channel = WiFi.channel(best);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  disablePMF();
  WiFi.setHostname(device_id);
  WiFi.begin(ssid, pass, channel, bssid, true);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 25) {
    wdt_feed_safe();
    delay(500);
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Connected. IP=%s MAC=%s RSSI=%d\n",
      WiFi.localIP().toString().c_str(),
      WiFi.macAddress().c_str(),
      WiFi.RSSI());
  }

  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
    if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
      if (client_Moskuitto.connected()) {
        client_Moskuitto.publish(esp_avail_topic.c_str(), "offline", true);
        client_Moskuitto.disconnect();
      }
      params.wifi_flag = LINK_DISCONNECTED;
      params.mqtt_flag = LINK_DISCONNECTED;
      wifi_disconnected_evt = true;
    }
  });

  if (wifi_blocking_connect_with_timeout(20000)) params.wifi_flag = LINK_CONNECTED;

  // Load stored Mosquitto IP from EEPROM (legacy /set_ip recovery slot).
  EEPROM.begin(EEPROM_SIZE);
  char stored_ip[33];
  for (int i = 0; i < 32; i++) stored_ip[i] = EEPROM.read(EEPROM_HA_IP_ADDR + i);
  stored_ip[32] = '\0';
  String storedHaIp = String(stored_ip);
  if (storedHaIp.length() > 6 && storedHaIp.indexOf('.') > 0) ha_ip = storedHaIp;

  espBaseSetup();

  static WiFiClient mosqPlain;
  client_Moskuitto.setClient(mosqPlain);
  client_Moskuitto.setCallback(callback_Mosquitto);
  // Keepalive 60 s — must be longer than the worst-case BLE session
  // (scan 5 s + connect 3-4 s + read 1-2 s + disconnect = ~15 s window
  // during which client.loop() doesn't run). Default 15 s was too tight
  // and caused MQTT to disconnect / reconnect every poll cycle.
  client_Moskuitto.setKeepAlive(60);
  client_Moskuitto.setSocketTimeout(5);
  client_Moskuitto.setBufferSize(4096);

  server.on("/set_ip", handle_set_ip);

  reconnect_Mosquitto();

  // 1 Hz tick.
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

  // OTA-only boot? Skip BLE entirely — the C3's NimBLE host task panics
  // under heavy WiFi TCP load (consistent crash at PC 0x4038ab62).
  // We're in this mode for at most OTA_MODE_TIMEOUT_MS, then auto-reboot
  // back to normal mode (clears the magic so power-cycle = normal).
  g_ota_mode = (_ota_mode_magic == OTA_MODE_MAGIC);
  _ota_mode_magic = 0;   // consume the flag — next reboot is normal unless re-set

  if (g_ota_mode) {
    Serial.println("BOOT: OTA-only mode — BLE will NOT initialize");
    publishEspEvent("state", "boot", "mode", "ota_only");
  } else {
    // Normal boot — but DEFER BLE init by 60 s. This gives every fresh
    // boot a guaranteed clean OTA window: no BLE blocking the loop, max
    // free heap, ArduinoOTA can complete Update.begin and the upload
    // without contention. User workflow: press EN/RESET → push OTA
    // within 1 minute → done. After 60 s, juraBleLoop() lazy-inits BLE.
    Serial.println("BOOT: BLE init deferred 60 s (OTA window) — press RESET + OTA within 1 min for guaranteed flash");
  }
}

// ─── loop ────────────────────────────────────────────────────────────────
void loop() {
  wdt_feed_safe();
  ArduinoOTA.handle();

  unsigned long now_ms = millis();

  // OTA-only mode safety timeout — auto-reboot back to normal mode if
  // no OTA push happened in the time window. Prevents being stuck in
  // headless mode if the user forgot they set OTA mode.
  if (g_ota_mode && now_ms > OTA_MODE_TIMEOUT_MS) {
    Serial.println("OTA-MODE: timeout reached — rebooting into normal mode");
    delay(200);
    ESP.restart();
  }

  if (tick_1s) {
    tick_1s = false;
    juraBleLoop();   // owns BLE connect / poll / reconnect — runs at 1 Hz
                     // (juraBleLoop early-returns when g_ota_mode is true)
  }

  static unsigned long last_wifi_retry = 0;
  if ((!wifiIsUp()) || wifi_disconnected_evt) {
    wifi_disconnected_evt = false;
    if (now_ms - last_wifi_retry > 15000) {
      Serial.println("Wi-Fi disconnected — calling start_wifi_again()");
      start_wifi_again();
      last_wifi_retry = now_ms;
    }
  }

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
