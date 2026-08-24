# WATER — home water-consumption metering

Measure **whole-house COLD-water consumption** (real liters) with a **non-invasive clamp-on ultrasonic flow
meter** on the incoming cold main, feed it to MQTT → the dashboard, and reconcile **actual usage against the
water bill**. Dashboard-only agent (no dedicated LXC) — the meter reports via an **ESP32** in the `esp_boards`
framework, ingested by the rule engine.

**Status (2026-08-24): PLANNED — meter on order.** Nothing built yet; this doc is the roadmap + the first
commit of the home-water project. Meter ships **Sept 8–17** (to NYC), so the build starts when it arrives.

## The measurement decision (settled 2026-08-24)
- **Sensor: clamp-on ultrasonic (transit-time)** — non-invasive, straps onto the *outside* of the pipe, no
  cutting the main. Chosen because it "sits on the pipe."
- **⚠ Mount on the BRASS section of the ¾″ cold main — NOT the PEX.** Clamp-on ultrasonic needs a **rigid pipe
  that carries ultrasound cleanly** (copper/brass/steel/rigid PPR). **PEX is soft + acoustically lossy**, and
  ¾″ PEX at domestic flow is the *worst* case — a cheap clamp-on can't get a stable signal on it. The run has a
  **brass section** → clamp there (rigid metal, reads well). Needs a **straight run** (~10× dia before / 5×
  after, no valve/bend at the sensor) and a **full pipe**.
- **It's COLD water** → the **standard transducer** is correct; **no high-temp (-HT) version needed.**

## The hardware to buy
- **Meter:** **TUF-2000M** clamp-on ultrasonic flowmeter module (Amazon listing "**Host Plus TS-2**", ~$184).
- **Transducer:** **TS-2** (clamp-on, **DN15–100 mm**) — fits the ¾″ main. **Standard TS-2, NOT TS-2-HT** (cold
  water). Reject TM-1/TL-1 (bigger pipes), TC-1 (insertion/invasive), and the multi-transducer combos.
- **ESP side:** an **ESP32** + a **MAX485 RS-485 module** (~$2). (Or use the meter's pulse output — see below.)
- ⚠ **Origin note (`feedback_no_chinese_tools`):** the TUF-2000M is **Chinese-made**, but it's a **standalone
  Modbus device with no network/cloud path** (can't phone home), so it doesn't breach the *data-connection*
  rule. No affordable non-Chinese clamp-on exists on consumer Amazon (industrial = hundreds+). User accepted.

## ⚠ You need the whole meter — you can NOT wire raw transducers to the ESP32
The TS-2 transducers are **dumb piezo elements**. Ultrasonic flow works by timing the **transit-time difference**
upstream vs downstream — **nanoseconds/picoseconds** — which an ESP32 **cannot** time. That measurement +
algorithm is the entire value of the TUF-2000M box (the transducers are cheap). DIY-ing it would need a
dedicated ultrasonic AFE (TI TDC1000/MAX35101/MSP430FR6047) + the whole flow algorithm — not worth it. **The
ESP32 talks to the METER, not the transducers.**

## Integration architecture (the `esp_boards` + Modbus pattern)
```
TS-2 clamp on the BRASS ¾″ cold main → TUF-2000M (does the ultrasonic timing)
    → RS-485 Modbus  →  ESP32 (+ MAX485)  → MQTT (mur/home/esp/water_meter/…)  → rule engine → dashboard
```
- Same shape as the **Electra A/C board** (ESP32 + RS-485 + Modbus) — see [../ELECTRA_AIR_CONDITIONS/CLAUDE.md](../ELECTRA_AIR_CONDITIONS/CLAUDE.md).
- **Simplest alternative:** the TUF-2000M has a **configurable pulse output** (e.g. 1 pulse/liter) — the ESP32
  just counts pulses on a GPIO (no Modbus). Modbus gives instant flow + totalizer + diagnostics; pulse is easier.
- Register the board via `/create-board`; project status fields = flow (L/min) + totalizer (L).

## Dashboard
- **Water page** (`BOILER/dashboard/public/water.html`, sidebar **Agents → Water Agent**) — live flow +
  daily/monthly liters + trend (planned). Config under `dashboard_settings.water.*`.
- **Reconciliation:** pairs with the existing **Boiler → Water tab** (bill history + Maya Water PDF parser,
  see [[project_agent_water]]) — compare **metered actual liters** vs the billed amount.

## Build phases (when the meter arrives)
1. **Mount + configure:** clamp TS-2 on the brass main; set the TUF-2000M (pipe OD + wall thickness, material =
   brass/copper, fluid = water, transducer = TS-2); confirm it holds a stable signal on the brass.
2. **ESP32 bridge:** `/create-board` a `water_meter` ESP32 (RS-485 Modbus read of flow + totalizer, or pulse
   count) → MQTT.
3. **Water page:** live flow + daily/monthly totals + trend graph.
4. **Bill reconciliation:** overlay metered usage against the water bill on the Boiler → Water tab.

## References
- Existing water surface (bills): [[project_agent_water]] (Boiler → Water tab)
- ESP32 + RS-485/Modbus pattern: [../ELECTRA_AIR_CONDITIONS/CLAUDE.md](../ELECTRA_AIR_CONDITIONS/CLAUDE.md)
- Board onboarding: `/create-board` + [../BOILER/dashboard/docs/esp_boards.md](../BOILER/dashboard/docs/esp_boards.md)
