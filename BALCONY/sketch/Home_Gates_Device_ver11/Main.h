#ifndef MAIN_H
#define MAIN_H

// ─── Home Gates Device — Project Boards Phase 2 (ESP32 build) ────────────
//
// ESP32 controller for the building garage's gate + barrier relays.
// Plain MQTT to Mosquitto on LXC 107 (192.168.1.189). Acts as an
// esp_boards subsystem participant — schema/status/availability +
// /command + /event topics.
//
// Real-time progress fields (`gates_state`, `barrier_progress`,
// `gates_progress`) are projected into devices.last_state by the rule
// engine on LXC 105 (see _ESP_STATUS_DPS_FIELDS) so a HASP / Awtrix /
// Pixoo display can render a live progress bar.
//
// Migrated from ESP8266 → ESP32 on 2026-05-05 (legacy MAC kept getting
// REASON_AUTH_FAIL on the DECO mesh; ESP32 has a different MAC and
// fresh association state at the AP).
//
// See root CLAUDE.md → Project Boards row, BOILER/dashboard/docs/
// esp_boards.md for the onboarding contract.

#include <ArduinoJson.h>
#include <PubSubClient.h>

// ─── Board-state flags shared with the .ino ──────────────────────────────
bool          http_server_enabled  = false;
bool          awaiting_new_mqtt_ip = false;
String        ha_ip                = "";
volatile bool tick_1s              = false;

// ─── Hardware pins (verify against your ESP32 wiring) ────────────────────
// On ESP32 dev module, GPIO 14 / 12 / 13 are still safe outputs; if your
// wiring uses different pins update here.
const int Buzzer  = 14;
const int Relay_1 = 12;   // gate relay
const int Relay_2 = 13;   // barrier relay

// ─── Wi-Fi ───────────────────────────────────────────────────────────────
char ssid[] = "Home";
char pass[] = "Pt9n+M13";

// ─── MQTT (Mosquitto on LXC 107) ─────────────────────────────────────────
WiFiClient    espClient_moskuitto;
PubSubClient  client_Moskuitto(espClient_moskuitto);

const char* mqtt_server_moskuitto = "192.168.1.189";
const char* mqtt_user_moskuitto   = "esp_boards";
const char* mqtt_pass_moskuitto   = "=N!9ioNYZWH-8Rz+y+6n";
const int   mqtt_port_moskuitto   = 1883;

// ─── Sketch identity ─────────────────────────────────────────────────────
const char* device_id      = "gates_01";
const char* sketch_name    = "Home_Gates_Device";   // dashboard chip-detection treats this as ESP32 (esp32 OTA on port 3232)
const char* sketch_version = "v11";
const char* build_ts       = __DATE__ " " __TIME__;

#define OTA_PASSWORD "uZf-vPmFw!fho!@Q"

// ─── Legacy sensor topic (kept for the existing HOME_REQUEST flow) ───────
const char* sensor_name = "control";
String sensor_value_topic;
String availability_topic;   // legacy "tele/<id>/LWT" — kept for back-compat
const char* command = "";

// ─── ESP-base topic Strings (built once in espBaseSetup) ─────────────────
String esp_avail_topic;
String esp_schema_topic;
String esp_status_topic;
String esp_config_topic;
String esp_command_topic;
String esp_event_topic;

// ─── Tunable parameters (loaded from EEPROM in espBaseSetup) ─────────────
struct EspParams {
  uint32_t delay_btw_pulses_barrier = 3;   // sec
  uint32_t delay_btw_pulses_both    = 2;   // sec
} esp_params;

// ─── State machine + progress (consumed by Process_States.ino) ───────────
struct {
  uint8_t  machine_1_state       = 1;   // STATE_IDLE
  uint8_t  setup_state           = 0;
  uint8_t  wifi_flag             = 0;
  uint8_t  mqtt_flag             = 0;
  uint8_t  buzzer_flag           = 0;
  uint8_t  sequence_state        = 0;
  uint8_t  pulse_mode            = 0;
  uint8_t  relay_state           = 0;
  uint8_t  Delay_Btw_Counter     = 0;
  uint8_t  Total_Seq_Counter     = 0;
  uint8_t  Single_Pulse_Counter  = 0;
  uint8_t  relay_state_gate      = 0;
  uint8_t  relay_state_barrier   = 0;

  // Projected into devices.last_state by rule engine (read-only display data).
  String   gates_state          = "idle";
  int8_t   barrier_progress     = -1;
  int8_t   gates_progress       = -1;
} params;

// ─── Action_Timer state machine values ───────────────────────────────────
#define STATE_IDLE               1
#define STATE_BOTH_REQUEST       2
#define STATE_BARRIER_REQUEST    3
#define STATE_OPEN_BOTH_GATES    4
#define STATE_OPEN_BARRIER_GATE  5

// ─── Sequence states ─────────────────────────────────────────────────────
#define SEQ_PULSE     0
#define SEQ_DELAY_BTW 1

// ─── Pulse counts (compile-time; wiring-dependent) ───────────────────────
#define TOTAL_SEQUENCES        4
#define BOTH_GATES_PULSE_NUM   8
#define BARRIER_PULSE_NUM      4

#define ON  1
#define OFF 0

// ─── WiFi / MQTT link state ──────────────────────────────────────────────
#define LINK_DISCONNECTED 0
#define LINK_CONNECTED    1
#ifndef CONNECTED
  #define CONNECTED    LINK_CONNECTED
  #define DISCONNECTED LINK_DISCONNECTED
#endif

// ─── EEPROM ──────────────────────────────────────────────────────────────
#define EEPROM_SIZE        64
#define EEPROM_HA_IP_ADDR  0

// ─── Forward decls (Esp_Base.ino) ────────────────────────────────────────
void  espBaseSetup();
void  espBaseOnMosquittoConnect();
void  espBaseLoop();
bool  espBaseHandleMessage(const char* topic, byte* payload, unsigned int length);
void  publishEspEvent(const char* kind, const char* src, const char* topic, const char* payload);
void  publishEspStatusNow();

// Forward decls (main .ino)
void  reconnect_Mosquitto();
void  clearStoredHaIp();

// Forward decls (Process_States.ino)
void  Action_Timer_1();
void  Barrier_Pulse();
void  Gate_Pulse();

#endif
