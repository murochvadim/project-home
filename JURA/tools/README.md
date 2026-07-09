# Jura BLE tools (laptop / dashboard host)

Read-only Python probes that talk to the Jura (BlueFrog dongle) over the
**laptop's** Bluetooth. The laptop is the only radio close enough (the balcony
bridge is out of range). `pip install bleak` first.

**Breakthrough 2026-07-10:** the laptop reads everything the ESP32 sketch could
not, and the statistics decode correctly once you use the right key. See
[../CLAUDE.md](../CLAUDE.md) "BREAKTHROUGH".

## The key (was wrong for a year)
`key = manufacturer_data[171][0]` — the **first byte of the BLE advertisement's
manufacturer payload** (company id 171 = 0xAB). On this dongle the key = **0x2A**.
The old sketch hardcoded `0xAB`, which is the company *id*, not the key — that's
why nothing ever decoded.

## Scripts
- **`jura_stats.py`** — the payoff. Sends the statistics request → polls until
  ready (status byte[1] != 0xE1) → reads + decrypts → prints the per-drink
  counters + total. The request is a *read-command* (no brewing). Verified live.
- **`jura_read.py`** — connect + dump every readable characteristic (raw +
  decrypted). Diagnostic.
- **`jura_capture.py <label>`** — dump readable chars to `cap_<label>.txt` for
  on/off diffing. On/off is really detected by **advertising presence**: dongle
  visible = machine ON, dongle absent = machine OFF.

## What works / doesn't
- ✅ On/off (advert presence), model/firmware (plaintext), **coffee counters**.
- ✅ Machine status/alerts + brew + maintenance = reachable (same key + machine file).
- ❌ **Power-off has no command** — not in Jura's own machine file (EF557). Impossible by design.
