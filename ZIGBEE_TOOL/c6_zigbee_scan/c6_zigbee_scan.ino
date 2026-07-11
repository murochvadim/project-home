/* c6_zigbee_scan.ino — minimal Zigbee network scanner for ESP32-C6 (DFR1117)
 *
 * Scans for nearby Zigbee networks and prints each: PAN ID, channel, whether
 * it's accepting joins, router/end-device capacity, extended PAN ID.
 * Your Zigbee2MQTT network (coordinator on LXC 103) will show up here — you can
 * match it by channel / PAN ID against what Z2M reports.
 *
 * ⚠ SCOPE: this sees NETWORKS, not individual devices. Enumerating your paired
 * devices is the COORDINATOR's job — Zigbee2MQTT already lists them. The C6 as a
 * plain scanner can't list another network's devices without joining it (and even
 * then, only the coordinator holds the device table). For per-device visibility
 * you'd sniff 802.15.4 into Wireshark (separate sniffer firmware) or just use Z2M.
 *
 * REQUIRED Tools settings (or it won't compile / run):
 *   Board:            DFRobot Beetle ESP32-C6  (or ESP32C6 Dev Module)
 *   Zigbee mode:      Zigbee ZCZR (coordinator/router)
 *   Partition Scheme: Zigbee ZCZR 4MB with spiffs
 *   USB CDC On Boot:  Enabled
 *   Port:             COM6
 */
#include <Arduino.h>
#if !defined(ZIGBEE_MODE_ED) && !defined(ZIGBEE_MODE_ZCZR)
#error "Select a Zigbee mode in Tools -> Zigbee mode (use 'Zigbee ZCZR')"
#endif
#include "Zigbee.h"

#ifdef ZIGBEE_MODE_ZCZR
zigbee_role_t role = ZIGBEE_ROUTER;       // a coordinator can't scan itself, so scan as a router
#else
zigbee_role_t role = ZIGBEE_END_DEVICE;
#endif

void printNetworks(uint16_t found) {
  if (found == 0) { Serial.println("No Zigbee networks found this scan."); return; }
  zigbee_scan_result_t *r = Zigbee.getScanResult();
  Serial.printf("\n%u Zigbee network(s) found:\n", found);
  Serial.println("Nr | PAN ID | CH | Permit Join | Router | ED  | Extended PAN ID");
  for (int i = 0; i < found; i++) {
    Serial.printf("%2d | 0x%04x | %2u | %-11s | %-6s | %-3s | %02x:%02x:%02x:%02x:%02x:%02x:%02x:%02x\n",
                  i + 1, r[i].short_pan_id, r[i].logic_channel,
                  r[i].permit_joining ? "Yes" : "No",
                  r[i].router_capacity ? "Yes" : "No",
                  r[i].end_device_capacity ? "Yes" : "No",
                  r[i].extended_pan_id[7], r[i].extended_pan_id[6], r[i].extended_pan_id[5], r[i].extended_pan_id[4],
                  r[i].extended_pan_id[3], r[i].extended_pan_id[2], r[i].extended_pan_id[1], r[i].extended_pan_id[0]);
    delay(10);
  }
  Serial.println("(one of these is your Zigbee2MQTT network — match its channel/PAN in Z2M)\n");
  Zigbee.scanDelete();
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nESP32-C6 Zigbee network scan");
  if (!Zigbee.begin(role)) {
    Serial.println("Zigbee failed to start! Check Tools -> Zigbee mode + Partition. Rebooting...");
    delay(1000);
    ESP.restart();
  }
  Serial.println("Scanning all channels...");
  Zigbee.scanNetworks();
}

void loop() {
  int16_t st = Zigbee.scanComplete();
  if (st >= 0) {                 // scan finished
    printNetworks(st);
    Zigbee.scanNetworks();       // scan again
  } else if (st == ZB_SCAN_FAILED) {
    Serial.println("Scan failed — retrying.");
    Zigbee.scanNetworks();
  }
  delay(1000);
}
