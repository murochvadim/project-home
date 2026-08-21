/*
 * W5500_Diag  v1  —  Electra_AC bridge connection test
 * -----------------------------------------------------
 * ESP32-WROOM + W5500 on VSPI.  USB serial @ 115200.
 *
 * Purpose: prove the W5500 wiring WITHOUT the Ethernet stack or LEDs.
 * It hardware-resets the chip via RST, then reads the W5500 VERSIONR
 * register over raw SPI. VERSIONR ALWAYS reads 0x04 on a healthy W5500,
 * so:
 *    VERSIONR == 0x04  -> SCK/MISO/MOSI/CS/RST/3V3/GND are ALL good.
 *    VERSIONR == 0x00  -> MISO not returning data (MISO/CS/power/RST).
 *    VERSIONR == 0xFF  -> MISO floating / no power / CS never asserted.
 *    anything else     -> SPI noise / half-connected SCK or MOSI.
 * Then it reads PHYCFGR for the physical LINK bit (cable + switch).
 *
 * Pins match the Electra_AC schema exactly:
 *   SCK=18  MISO=19  MOSI=23  CS=5  RST=13  INT=4   (W5500 3.3V, NOT 5V)
 */

#include <SPI.h>

#define PIN_SCK   18
#define PIN_MISO  19
#define PIN_MOSI  23
#define PIN_CS    5
#define PIN_RST   13
#define PIN_INT   4

// W5500 common-register-block offsets
#define W5500_VERSIONR  0x0039   // always 0x04 on a good chip
#define W5500_PHYCFGR   0x002E   // bit0=LNK bit1=SPD bit2=DPX

// 4 MHz — deliberately slow for a hand-wired perfboard (raise later if you want)
SPISettings spiSettings(4000000, MSBFIRST, SPI_MODE0);

// Read one byte from a common-register-block address.
// W5500 frame = [addr_hi][addr_lo][control][data].
// control = 0x00  ->  common block (BSB=00000), read (RWB=0), VDM (OM=00).
uint8_t w5500ReadReg(uint16_t addr) {
  SPI.beginTransaction(spiSettings);
  digitalWrite(PIN_CS, LOW);
  SPI.transfer((addr >> 8) & 0xFF);
  SPI.transfer(addr & 0xFF);
  SPI.transfer(0x00);                 // control: common block, read
  uint8_t val = SPI.transfer(0x00);   // clock the data out
  digitalWrite(PIN_CS, HIGH);
  SPI.endTransaction();
  return val;
}

void w5500HardwareReset() {
  pinMode(PIN_RST, OUTPUT);
  digitalWrite(PIN_RST, HIGH);
  delay(10);
  digitalWrite(PIN_RST, LOW);   // RST is active-low
  delay(2);                     // datasheet: hold >500 us
  digitalWrite(PIN_RST, HIGH);
  delay(60);                    // wait for internal PLL lock
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  Serial.println(F("W5500_Diag v1  (Electra_AC bridge connection test)"));
  Serial.println(F("=================================================="));
  Serial.printf("Pins: SCK=%d  MISO=%d  MOSI=%d  CS=%d  RST=%d  INT=%d\n",
                PIN_SCK, PIN_MISO, PIN_MOSI, PIN_CS, PIN_RST, PIN_INT);

  pinMode(PIN_CS, OUTPUT);
  digitalWrite(PIN_CS, HIGH);   // CS idle high
  pinMode(PIN_INT, INPUT);

  Serial.print(F("Driving hardware RST (GPIO13)... "));
  w5500HardwareReset();
  Serial.println(F("done"));

  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, -1);   // -1: we drive CS ourselves
  Serial.println(F("SPI (VSPI) started @ 4 MHz"));
  Serial.println();
}

void loop() {
  uint8_t ver = w5500ReadReg(W5500_VERSIONR);

  Serial.printf("VERSIONR = 0x%02X   ", ver);
  if (ver == 0x04) {
    Serial.println(F("[OK] SPI + RST + power ALL GOOD"));
    uint8_t phy = w5500ReadReg(W5500_PHYCFGR);
    bool link = phy & 0x01;
    Serial.printf("PHYCFGR  = 0x%02X   LINK=%s  SPEED=%s  DUPLEX=%s\n",
                  phy,
                  link ? "UP (cable+switch OK)" : "DOWN (check cable/port)",
                  (phy & 0x02) ? "100M" : "10M",
                  (phy & 0x04) ? "FULL" : "HALF");
    if (!link)
      Serial.println(F("  -> chip is healthy; only the CABLE/SWITCH-PORT link is missing."));
  } else if (ver == 0x00) {
    Serial.println(F("[FAIL] 0x00 = no data on MISO."));
    Serial.println(F("  Check: MISO(19) wire, CS(5) reaching W5500 SCS, 3.3V+GND, RST not stuck low."));
  } else if (ver == 0xFF) {
    Serial.println(F("[FAIL] 0xFF = MISO floating / module unpowered."));
    Serial.println(F("  Check: W5500 has 3.3V (NOT 5V) + GND, MISO(19) actually connected, CS(5) wired."));
  } else {
    Serial.println(F("[FAIL] unexpected = SPI half-connected / noise."));
    Serial.println(F("  Check: SCK(18) and MOSI(23) joints, shared GND, shorten perfboard stubs."));
  }
  Serial.println(F("---"));
  delay(1500);
}
