# Jura Coffee Machine

Planning + protocol notes. Integration not started yet; this doc captures
what's known so the next session (Path B prototype, then Path A
ESPHome+HA wiring) doesn't have to re-discover anything.

## Hardware

| Item | Value |
|---|---|
| Machine model | Jura Impressa J6 |
| Wireless adapter | **BlueFrog** (third-party Smart Connect alternative; TT214H Telink BLE SoC) |
| Adapter physical link | Plugged into the J6 service port (already done by user) |
| BLE address | `D5:B2:75:CC:85:CB` |
| BLE GAP name | `TT214H BlueFrog` |
| Smart Connect service UUID | `5a401523-ab2e-2548-c435-08c300000710` (matches [Jutta-Proto](https://github.com/Jutta-Proto/protocol-bt-cpp) spec) |

The BlueFrog is functionally interchangeable with Jura's own Smart Connect
dongle for protocol purposes — same service UUIDs, same
encrypted/handshake flow. Phone-side **J.O.E. app** confirmed compatible.

## Verified 2026-05-02

End-to-end BLE communication tested from the Windows dashboard host
(within ~5 m of the machine) using `bleak`:

- Discovery + GATT enumeration: ✓
- Connect + service tree:
  - `00001800` Generic Access (Device Name = `TT214H BlueFrog`)
  - `5a401523` Smart Connect — 14 characteristics (read + write + notify mix)
  - `5a401623` secondary service (about / aux)
  - `00001530` Nordic DFU (firmware update)
- **Statistics characteristic** `5a401531` (read, 56 bytes) — returns
  varying bytes per read (real counter data, not all-zero placeholders).
- **About / product / name reads** (`5a401524` / `5a401534` / `5a401537`) —
  return data with the same 20-byte encrypted prefix (`77e1 3dd6 8881 d3de
  a323 fa98 a4a3 faab 4756 a626…`) until the auth handshake is performed.

Conclusion: **the protocol family is the supported Jutta-Proto Smart
Connect**. Decoded data requires the auth handshake (next step).

## Available data surface (from Jutta-Proto spec)

When the auth handshake is implemented, expect to read:

### Live state
- Power state (on / standby / brewing / heating)
- Currently dispensing (drink id if active)
- Service alerts: water tank empty · beans empty · grounds full · drip tray full · door open
- Maintenance flags: cleaning required · descale required · filter exhausted
- Temperature ready / warming up

### Lifetime counters
- Total products dispensed (single counter)
- Per-product counters (one each): ristretto, espresso, coffee, 2× espresso, 2× coffee, hot water, plus milk-frothed drinks if the J6 has the milk system attachment
- Cleaning cycles · descaling cycles · filter replacements · hot-water cycles

### Maintenance
- Cycles since last cleaning
- Cycles since last descale
- Brew unit cycles

### Static info
- Machine model code (e.g. `EF553` → maps to a model name)
- EEPROM version
- Dongle firmware version

### Commands
- Start drink N (write to FA command channel)
- Cancel current operation
- Standby / wake
- Trigger cleaning / rinse cycle

## Integration paths

### Path A — ESPHome BLE proxy + HA integration (target architecture)

```
J6 service port → BlueFrog dongle → BLE
                                      → ESP32 (flashed with ESPHome bluetooth_proxy:)
                                      → Wi-Fi
                                      → HA (LXC 101) + HACS Jura integration
                                      → HA WebSocket
                                      → device_agent (LXC 103) → devices table
                                      → rule engine + dashboard
```

Hardware: any spare ESP32 (~$5-10) within ~5 m of the machine, USB-powered.
Effort: ~30-45 min one-time. Result: persistent integration; brew counters,
service alerts, brew commands all available as `devices` rows + rule
chips + display-template sources.

### Path B — Python prototype on laptop (verification only)

Implement the Jutta-Proto auth handshake (~150 lines) in a throwaway
script on the dashboard host, read decoded values once, prove the
protocol works. **No persistence, no rules, no dashboard.** User chose
Path B as the next concrete step.

Handshake outline:
1. Read 1-byte connection key from `5a401524`
2. Derive response via Jutta-Proto bit-permutation + XOR mask
3. Write derived response to `5a401525`
4. Now reads `5a401534` (product info), `5a401537` (machine name),
   `5a401531` (statistics) return decoded bytes
5. Statistics layout: 4-byte counters back-to-back; first = total, then
   per-product

## BLE radio constraints

- Range: ~5 m clear line-of-sight; ~3 m through one wall
- One client at a time — while ESP32 (Path A) is connected, the J.O.E.
  app on a phone won't connect, and vice versa
- BlueFrog accepts connections without bonding/pairing prompts (J.O.E.
  app pattern)

## Future work checklist

- [ ] **Path B**: implement Jutta-Proto handshake on dashboard host,
      decode statistics + machine info, confirm full data set visible
- [ ] **Path A**: flash ESPHome `bluetooth_proxy:` on a spare ESP32
- [ ] Power ESP32 within BLE range of the J6
- [ ] HA: install HACS Jura integration (pick the most-maintained one
      — likely [Jutta-Proto/Home-Assistant](https://github.com/Jutta-Proto)
      or successor)
- [ ] Verify HA discovers entities; pair them to the right area
- [ ] device_agent's HA adapter ingests entities → row in `devices`
      with `protocol='ha_api'`
- [ ] Optional: register the BlueFrog in the `devices` table with its
      MAC for the ARP-link IP fallback (same pattern as
      `pixoo` / `hasp:balcony` / `awtrix_05ec2c`)
- [ ] Add Jura action vocabulary to `/create-rule` and the device
      picker (similar to the display-chip work for Awtrix/Pixoo)

## References

- [Jutta-Proto/protocol-bt-cpp](https://github.com/Jutta-Proto/protocol-bt-cpp) — definitive C++ implementation, includes the full spec
- [Jutta-Proto/pyjura](https://github.com/Jutta-Proto/pyjura) — Python port
- [Jutta-Proto/Home-Assistant](https://github.com/Jutta-Proto) — HA integration variants
- [BlueFrog product page](https://blue-frog.shop) — vendor docs (when available)
