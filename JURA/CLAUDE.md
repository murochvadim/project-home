# Jura Coffee Machine

Planning + protocol notes. Integration STARTED 2026-05-04 — chosen
implementation route is **Path C** (custom Arduino sketch on a spare
ESP32-C3, fits our `esp_boards` subsystem). Paths A and B are kept
below for context but are not the active route.

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

### ⭐ Path C — custom Arduino sketch on ESP32-C3 (CHOSEN, 2026-05-04)

```
J6 service port → BlueFrog dongle → BLE (5 m line-of-sight)
                                      → ESP32-C3 (custom Arduino sketch)
                                      → Wi-Fi → Mosquitto (LXC 107)
                                      → mur/home/esp/jura_bridge_01/{status,event,command}
                                      → rule engine (LXC 105) → devices.last_state
                                      → dashboard (Project Boards tab + rule sentence chips)
```

The C3 sketch:
- Runs the Jutta-Proto auth handshake natively in C++ (~150 lines
  ported from `pyjura` / `protocol-bt-cpp`)
- Polls the BlueFrog every N seconds (Settings-tunable) for stats +
  service flags
- Publishes decoded state to MQTT in the same shape as every other
  ESP board in the project (so it appears as a Project Board tab,
  gets OTA, is rule-targetable via `dps_config.action_on/action_off`)
- Subscribes to `mur/home/esp/jura_bridge_01/command` for brew /
  cancel / cleaning actions

Hardware: spare ESP32-C3 (already on hand, separate from
`My_Bathroom_Smell_6`), USB-powered, placed within ~5 m of the J6.

Effort: ~1 day (port the auth handshake + status decoding + scaffold
via `/create-board`). More upfront work than Path A but the result is
a first-class device in our system — no HA dependency, no extra hops,
same patterns as RemoteXY / smell board.

**BlueFrog reachability re-verified 2026-05-04** — bleak scan from the
Windows host found `D5:B2:75:CC:85:CB "TT214H BlueFrog"` advertising.

### Path A — ESPHome BLE proxy + HA integration (NOT CHOSEN, kept for context)

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

**Why not chosen (2026-05-04 decision):** Adds HA + HACS dependency for
one device, extra hop in the data path, and doesn't slot into our
`esp_boards` subsystem (no Project Boards tab, no MQTT-direct OTA).

### Path B — Python prototype on laptop (verification only)

Implement the Jutta-Proto auth handshake (~150 lines) in a throwaway
script on the dashboard host, read decoded values once, prove the
protocol works. **No persistence, no rules, no dashboard.** Skipped
2026-05-04 — Path C will port the handshake straight to Arduino, so a
laptop dry-run isn't a prerequisite.

Handshake outline (still applies — same code lands in the sketch):
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

## Path C work checklist (active)

- [x] Re-verify BlueFrog still reachable via BLE scan (2026-05-04)
- [ ] Decide DPS shape for `devices.last_state` (status fields the
      sketch publishes — see proposal below)
- [ ] Decide action vocabulary (sketch action keys → rule on/off
      mappings via `dps_config.action_on/action_off`)
- [ ] Use `/create-board` skill to scaffold sketch + DB rows for
      `jura_bridge_01` (board id, MAC, room, dps_labels, dps_config)
- [ ] Port Jutta-Proto auth handshake from `pyjura` to Arduino C++
      (~150 lines: read connection key, bit-permutation + XOR, write
      derived response)
- [ ] Implement BLE client in sketch using ESP32 Arduino BLE library
      (`NimBLE-Arduino` is preferred — smaller footprint than the
      stock Bluedroid stack, plenty for one peripheral connection)
- [ ] Status poll loop: every N seconds reconnect-or-reuse, read
      stats characteristic, decode, publish status
- [ ] Command dispatch: subscribe to `mur/home/esp/jura_bridge_01/command`
      and route action keys to the FA write characteristic
- [ ] USB-flash once; then OTA from Project Boards page like every
      other ESP board
- [ ] Optional: register the BlueFrog in `net_devices` for ARP-link
      MAC bookkeeping (BlueFrog itself is BLE-only, so no IP — skip)

## References

- [Jutta-Proto/protocol-bt-cpp](https://github.com/Jutta-Proto/protocol-bt-cpp) — definitive C++ implementation, includes the full spec
- [Jutta-Proto/pyjura](https://github.com/Jutta-Proto/pyjura) — Python port
- [Jutta-Proto/Home-Assistant](https://github.com/Jutta-Proto) — HA integration variants
- [BlueFrog product page](https://blue-frog.shop) — vendor docs (when available)
