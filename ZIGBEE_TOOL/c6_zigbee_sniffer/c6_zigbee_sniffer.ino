/* c6_zigbee_sniffer.ino — minimal 802.15.4 (Zigbee) sniffer for ESP32-C6
 *
 * Listens promiscuously on a Zigbee channel and prints every MAC frame it hears:
 * type, seq, PAN, source -> dest (short addresses), RSSI/LQI. It also keeps a
 * live list of the device short-addresses transmitting on YOUR network, so you
 * can watch which devices are active.
 *
 * Set CHANNEL to your Z2M channel (11) and FILTER_PAN to your PAN (0x1a62) to
 * see only your network (set FILTER_PAN 0 to see everything).
 *
 * SCOPE: Zigbee PAYLOADS are encrypted with your network key — this shows the
 * MAC headers (who talks, to whom, how often) in the clear, NOT the decrypted
 * values. To decode the actual data you'd feed frames to Wireshark with the
 * network key (ESP-IDF sniffer + extcap) — a bigger setup.
 *
 * Tools: Board = DFRobot Beetle ESP32-C6 (or ESP32C6 Dev Module),
 *        USB CDC On Boot = Enabled, Port COM6. Default partition is fine.
 */
#include <Arduino.h>
#include "esp_ieee802154.h"

static const uint8_t  CHANNEL    = 11;       // your Z2M channel
static const uint16_t FILTER_PAN = 0x1a62;   // your PAN ID; 0 = show ALL networks

// ── ISR-safe ring buffer of captured frames (copy in callback, print in loop) ──
#define RB   32
#define FMAX 128
static volatile uint16_t _head = 0, _tail = 0;
static uint8_t _buf[RB][FMAX];
static int8_t  _rssi[RB];
static uint8_t _lqi[RB];

// Called from the 802.15.4 driver context — keep MINIMAL: copy + return.
extern "C" void esp_ieee802154_receive_done(uint8_t *frame, esp_ieee802154_frame_info_t *info) {
  uint16_t n = (_head + 1) % RB;
  if (n != _tail) {                     // drop if full
    uint8_t len = frame[0];
    if (len > FMAX - 1) len = FMAX - 1;
    memcpy((void *)_buf[_head], frame, len + 1);
    _rssi[_head] = info ? info->rssi : 0;
    _lqi[_head]  = info ? info->lqi : 0;
    _head = n;
  }
}

// ── device tracking (short addresses seen on FILTER_PAN) ──────────────────
#define MAXDEV 64
static uint16_t _dev[MAXDEV];
static uint32_t _devCnt[MAXDEV];
static int _nDev = 0;
static void noteDev(uint16_t a) {
  if (a == 0xFFFF || a == 0x0000) return;   // broadcast / coordinator
  for (int i = 0; i < _nDev; i++) if (_dev[i] == a) { _devCnt[i]++; return; }
  if (_nDev < MAXDEV) { _dev[_nDev] = a; _devCnt[_nDev] = 1; _nDev++; }
}

static const char *ftype(uint8_t t) {
  switch (t) { case 0: return "BEACON"; case 1: return "DATA"; case 2: return "ACK"; case 3: return "CMD"; default: return "?"; }
}

static void parse(uint8_t *f, int8_t rssi, uint8_t lqi) {
  uint8_t len = f[0];
  uint8_t *m = f + 1;                  // MPDU
  if (len < 3) return;
  uint16_t fcf = m[0] | (m[1] << 8);
  uint8_t type    = fcf & 0x7;
  uint8_t panComp = (fcf >> 6) & 1;
  uint8_t dstMode = (fcf >> 10) & 3;
  uint8_t srcMode = (fcf >> 14) & 3;
  uint8_t seq = m[2];
  int idx = 3;
  uint16_t dstPan = 0, dst = 0, srcPan = 0, src = 0;
  bool haveDst = false, haveSrc = false;
  if (dstMode == 2) { dstPan = m[idx] | (m[idx + 1] << 8); idx += 2; dst = m[idx] | (m[idx + 1] << 8); idx += 2; haveDst = true; }
  else if (dstMode == 3) { dstPan = m[idx] | (m[idx + 1] << 8); idx += 2; idx += 8; }
  if (srcMode) {
    if (!panComp) { srcPan = m[idx] | (m[idx + 1] << 8); idx += 2; } else srcPan = dstPan;
    if (srcMode == 2) { src = m[idx] | (m[idx + 1] << 8); idx += 2; haveSrc = true; }
    else if (srcMode == 3) { idx += 8; }
  }
  uint16_t pan = haveDst ? dstPan : srcPan;
  if (FILTER_PAN && pan != FILTER_PAN) return;   // not our network
  if (haveSrc) noteDev(src);
  Serial.printf("CH%u rssi=%4d lqi=%3u %-6s seq=%3u pan=0x%04x %s%04x -> %s%04x len=%u\n",
                CHANNEL, rssi, lqi, ftype(type), seq, pan,
                haveSrc ? "0x" : "  ", src, haveDst ? "0x" : "  ", dst, len);
}

void setup() {
  Serial.begin(115200);
  delay(600);
  Serial.printf("\nESP32-C6 802.15.4 sniffer — channel %u, PAN filter 0x%04x\n", CHANNEL, FILTER_PAN);
  esp_ieee802154_enable();
  esp_ieee802154_set_channel(CHANNEL);
  esp_ieee802154_set_promiscuous(true);
  esp_ieee802154_set_rx_when_idle(true);
  esp_ieee802154_receive();
  Serial.println("Listening...\n");
}

static uint32_t _lastSummary = 0;

void loop() {
  while (_tail != _head) {
    uint8_t local[FMAX];
    int8_t rs = _rssi[_tail];
    uint8_t lq = _lqi[_tail];
    memcpy(local, (const void *)_buf[_tail], FMAX);
    _tail = (_tail + 1) % RB;
    parse(local, rs, lq);
  }
  if (millis() - _lastSummary > 12000 && _nDev > 0) {
    _lastSummary = millis();
    Serial.printf("\n--- devices seen on PAN 0x%04x (%d) ---\n", FILTER_PAN, _nDev);
    for (int i = 0; i < _nDev; i++) Serial.printf("   0x%04x : %lu frames\n", _dev[i], (unsigned long)_devCnt[i]);
    Serial.println();
  }
  delay(5);
}
