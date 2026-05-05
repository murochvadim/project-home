#ifndef MAIN_H
#define MAIN_H

// ─── Jura Coffee Bridge (ESP32-C3) — Project Boards Phase 2 ──────────────
//
// BLE client + Wi-Fi → MQTT bridge for the Jura Impressa J6 + BlueFrog
// dongle. Acts as a Smart Connect client: connects via NimBLE, runs the
// Jutta-Proto auth handshake, polls the stats characteristic on a configurable
// interval, and publishes decoded state to mur/home/esp/jura_bridge_01/status.
// Subscribes to .../command for brew / cancel / standby actions.
//
// See JURA/CLAUDE.md (Path C) for the architecture overview.

#include <ArduinoJson.h>
#include <PubSubClient.h>

// ─── Board-state flags shared with the .ino ──────────────────────────────
bool          http_server_enabled  = false;
bool          awaiting_new_mqtt_ip = false;
String        ha_ip                = "";
volatile bool tick_1s              = false;

// ─── Wi-Fi ───────────────────────────────────────────────────────────────
char ssid[] = "Home";
char pass[] = "Pt9n+M13";

// ─── MQTT (Mosquitto on LXC 107) ─────────────────────────────────────────
WiFiClient        espClient_moskuitto;
PubSubClient      client_Moskuitto(espClient_moskuitto);

const char* mqtt_server_moskuitto = "192.168.1.189";
const char* mqtt_user_moskuitto   = "esp_boards";
const char* mqtt_pass_moskuitto   = "=N!9ioNYZWH-8Rz+y+6n";
const int   mqtt_port_moskuitto   = 1883;

// ─── Sketch identity ─────────────────────────────────────────────────────
const char* device_id      = "jura_bridge_01";
const char* sketch_name    = "Jura_Coffee_Bridge";
const char* sketch_version = "v1";
const char* build_ts       = __DATE__ " " __TIME__;

// Shared OTA password (every board uses the same value via .env ESP_OTA_PASSWORD).
#define OTA_PASSWORD "uZf-vPmFw!fho!@Q"

// ─── Target peripheral (BlueFrog on the Jura J6 service port) ────────────
// MAC fixed by the BlueFrog hardware; service UUID is the Jutta-Proto
// Smart Connect service. UUIDs corrected 2026-05-04 against the
// definitive source (Jutta-Proto/protocol-bt-cpp src/jutta_bt_proto/
// CoffeeMaker.cpp `RelevantUUIDs::RelevantUUIDs()`).
#define BLUEFROG_MAC                  "D5:B2:75:CC:85:CB"
#define JURA_SERVICE_UUID             "5a401523-ab2e-2548-c435-08c300000710"
// Characteristics within the Smart Connect service:
#define JURA_CHAR_MACHINE_STATUS      "5a401524-ab2e-2548-c435-08c300000710"  // power state, dispensing, alerts
#define JURA_CHAR_START_PRODUCT       "5a401525-ab2e-2548-c435-08c300000710"  // WRITE drink-start commands here
#define JURA_CHAR_PRODUCT_PROGRESS    "5a401527-ab2e-2548-c435-08c300000710"  // notification while dispensing
#define JURA_CHAR_UPDATE_PRODUCT      "5a401528-ab2e-2548-c435-08c300000710"  // tweak in-progress brew
#define JURA_CHAR_P_MODE              "5a401529-ab2e-2548-c435-08c300000710"  // power mode write
#define JURA_CHAR_BARISTA_MODE        "5a401530-ab2e-2548-c435-08c300000710"
#define JURA_CHAR_ABOUT_MACHINE       "5a401531-ab2e-2548-c435-08c300000710"  // model + firmware ids
#define JURA_CHAR_STATISTICS_COMMAND  "5a401533-ab2e-2548-c435-08c300000710"  // WRITE the request
// NOTE: protocol-bt-cpp lists STATISTICS_DATA as 5a401534, but on the
// J6's BlueFrog the actual readable stats characteristic is 5a401531
// (verified 2026-05-02 via bleak scan + read returned 56 bytes).
// 5a401534 doesn't exist on this firmware. Different J6 models /
// BlueFrog firmware revisions may use different UUIDs.
#define JURA_CHAR_STATISTICS_DATA     "5a401531-ab2e-2548-c435-08c300000710"  // READ encrypted stats
#define JURA_CHAR_P_MODE_READ         "5a401538-ab2e-2548-c435-08c300000710"

// ─── ESP-base topic Strings (built once in espBaseSetup) ─────────────────
String esp_avail_topic;
String esp_schema_topic;
String esp_status_topic;
String esp_config_topic;
String esp_command_topic;
String esp_event_topic;

// ─── Tunable parameters (loaded from EEPROM in espBaseSetup) ─────────────
struct EspParams {
  uint32_t poll_interval_sec      = 30;    // BlueFrog stats read interval
  uint32_t reconnect_backoff_sec  = 10;    // BLE reconnect cooldown after disconnect
  uint8_t  auth_retry_max         = 3;     // handshake attempts before reboot
} esp_params;

// ─── Wi-Fi / MQTT state for the .ino state machine ───────────────────────
struct {
  uint8_t wifi_flag = 0;
  uint8_t mqtt_flag = 0;
} params;

// LINK_* — namespaced to avoid colliding with NimBLE's enum ConnStatus
// { CONNECTED, DISCONNECTED, ... } via the preprocessor.
#define LINK_DISCONNECTED 0
#define LINK_CONNECTED    1

#define EEPROM_SIZE       64
#define EEPROM_HA_IP_ADDR 0

// ─── Decoded Jura state (live snapshot, mutated by Jura_BLE.ino) ─────────
// Published in publishEspStatus() so the rule engine projects these fields
// into devices.last_state.dps for rules + dashboard.
struct JuraState {
  String  power_state          = "unknown";   // standby | on | brewing | heating
  String  current_drink        = "";          // drink id while dispensing
  bool    water_low            = false;
  bool    beans_low            = false;
  bool    grounds_full         = false;
  bool    cleaning_required    = false;
  bool    descale_required     = false;
  uint32_t total_dispensed     = 0;
  uint32_t espressos_today     = 0;
  // Bridge state (not Jura state — diagnostic for the dashboard):
  bool    ble_connected        = false;
  bool    auth_ok              = false;
  uint32_t last_poll_unix      = 0;
} jura_state;

// ─── Forward decls implemented in Esp_Base.ino ───────────────────────────
void  espBaseSetup();
void  espBaseOnMosquittoConnect();
void  espBaseLoop();
bool  espBaseHandleMessage(const char* topic, byte* payload, unsigned int length);
void  publishEspEvent(const char* kind, const char* src, const char* topic, const char* payload);

// Forward decls implemented in the .ino (called from Esp_Base.ino).
void reconnect_Mosquitto();
void clearStoredHaIp();

// Forward decls implemented in Jura_BLE.ino.
void juraBleSetup();                       // called once from setup()
void juraBleLoop();                        // called every loop tick — owns connect / poll / reconnect
bool juraSendCommand(const char* action);  // dispatch a sketch action key (brew_*, cancel, standby)
void juraBlePrepareForOta();               // graceful BLE shutdown — call from ArduinoOTA.onStart

// OTA-only boot mode (defined in jura_bridge_01.ino). Set the RTC flag,
// reboot, and the next setup() skips BLE entirely so ArduinoOTA has the
// radio to itself. Auto-reverts to normal mode after OTA completes or
// after the safety timeout.
extern bool g_ota_mode;       // true if THIS boot is OTA-only
void enterOtaModeAndReboot(); // sets RTC flag + ESP.restart()

#endif
