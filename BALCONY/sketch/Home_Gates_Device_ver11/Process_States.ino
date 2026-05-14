/*
 * Process_States.ino — Action_Timer_1 state machine for the gate +
 * barrier relay sequences. Same logic as the legacy ver10 but:
 *   - Auto-close delays now read from esp_params (tunable via dashboard
 *     Params tab — no flash needed).
 *   - Each transition updates params.gates_state / barrier_progress /
 *     gates_progress and triggers an immediate /status push so a HASP /
 *     Awtrix / Pixoo display can render a live progress bar.
 */

#include "Main.h"

// ─── Helpers ──────────────────────────────────────────────────────────────
// barrier sequence: TOTAL_SEQUENCES * BARRIER_PULSE_NUM pulses total.
// gates  sequence: TOTAL_SEQUENCES * BOTH_GATES_PULSE_NUM pulses total.
// We compute progress in pulses-completed terms (delays don't move the bar).
static int8_t computeBarrierProgress() {
  int total = TOTAL_SEQUENCES * BARRIER_PULSE_NUM;
  int done  = (int)params.Total_Seq_Counter * BARRIER_PULSE_NUM
            + (int)params.Single_Pulse_Counter;
  if (total <= 0) return 0;
  if (done > total) done = total;
  return (int8_t)((done * 100) / total);
}
static int8_t computeGatesProgress() {
  int total = TOTAL_SEQUENCES * BOTH_GATES_PULSE_NUM;
  int done  = (int)params.Total_Seq_Counter * BOTH_GATES_PULSE_NUM
            + (int)params.Single_Pulse_Counter;
  if (total <= 0) return 0;
  if (done > total) done = total;
  return (int8_t)((done * 100) / total);
}

void Action_Timer_1(void) {
  switch (params.machine_1_state) {

    case STATE_IDLE:
      // Idle — no progress to publish unless we just transitioned in.
      break;

    case STATE_BARRIER_REQUEST:
      params.buzzer_flag         = ON;
      params.Total_Seq_Counter   = 0;
      params.Single_Pulse_Counter= 0;
      params.Delay_Btw_Counter   = 0;
      params.sequence_state      = SEQ_PULSE;
      params.pulse_mode          = 0;   // BARRIER
      digitalWrite(Relay_1, LOW);
      digitalWrite(Relay_2, LOW);
      params.relay_state         = ON;
      params.machine_1_state     = STATE_OPEN_BARRIER_GATE;
      params.gates_state         = "barrier_opening";
      params.barrier_progress    = 0;
      params.gates_progress      = -1;
      publishEspStatusNow();
      break;


    case STATE_BOTH_REQUEST:
      params.buzzer_flag         = ON;
      params.Total_Seq_Counter   = 0;
      params.Single_Pulse_Counter= 0;
      params.Delay_Btw_Counter   = 0;
      params.sequence_state      = SEQ_PULSE;
      params.pulse_mode          = 2;   // BOTH
      digitalWrite(Relay_1, LOW);
      digitalWrite(Relay_2, LOW);
      params.relay_state         = ON;
      params.machine_1_state     = STATE_OPEN_BOTH_GATES;
      params.gates_state         = "both_opening";
      params.barrier_progress    = -1;
      params.gates_progress      = 0;
      publishEspStatusNow();
      break;

    case STATE_OPEN_BARRIER_GATE:
      
      switch (params.sequence_state) {
        case SEQ_PULSE:
          if (params.Single_Pulse_Counter++ < BARRIER_PULSE_NUM) {
            Gate_Pulse();
            Serial.print("\n Gate Pulse...");
          } else {
            params.Delay_Btw_Counter = 0;
            params.sequence_state    = SEQ_DELAY_BTW;
          }
          params.barrier_progress = computeBarrierProgress();
          publishEspStatusNow();
          break;
        case SEQ_DELAY_BTW:
          if ((params.Delay_Btw_Counter++ < (uint8_t)esp_params.delay_btw_pulses_barrier)
              && (params.Total_Seq_Counter < TOTAL_SEQUENCES - 1)) {
            Serial.print("\n Sequence Delay...");
          } else {
            if (params.Total_Seq_Counter++ < TOTAL_SEQUENCES - 1) {
              params.Single_Pulse_Counter = 0;
              params.sequence_state       = SEQ_PULSE;
              Serial.print("\n Next Sequence...");
            } else {
              command = "end-barrier";
              client_Moskuitto.publish(sensor_value_topic.c_str(), command, true);
              params.machine_1_state  = STATE_IDLE;
              params.gates_state      = "barrier_done";
              params.barrier_progress = 100;
              publishEspStatusNow();
              publishEspEvent("state", "gates", "barrier", "done");
              Serial.print("\n Finished BARRIER...");
              // Immediately re-publish idle so the panel clears the
              // corner overlay without waiting on the 60 s heartbeat.
              params.gates_state      = "idle";
              params.barrier_progress = -1;
              publishEspStatusNow();
            }
          }
          break;
      }
      break;

    case STATE_OPEN_BOTH_GATES:
      switch (params.sequence_state) {
        case SEQ_PULSE:
          if (params.Single_Pulse_Counter++ < BOTH_GATES_PULSE_NUM) {
            if (params.Single_Pulse_Counter < 5) {
              Gate_Pulse();
              Serial.print("\n Gate Pulse...");
            } else {
              Barrier_Pulse();
              Serial.print("\n Barrier Pulse...");
            }
          } else {
            params.Delay_Btw_Counter = 0;
            params.sequence_state    = SEQ_DELAY_BTW;
          }
          params.gates_progress = computeGatesProgress();
          publishEspStatusNow();
          break;
        case SEQ_DELAY_BTW:
          if ((params.Delay_Btw_Counter++ < (uint8_t)esp_params.delay_btw_pulses_both)
              && (params.Total_Seq_Counter < TOTAL_SEQUENCES - 1)) {
            Serial.print("\n Sequence Delay...");
          } else {
            if (params.Total_Seq_Counter++ < TOTAL_SEQUENCES - 1) {
              params.Single_Pulse_Counter = 0;
              params.sequence_state       = SEQ_PULSE;
              Serial.print("\n Next Sequence...");
            } else {
              command = "end-both_gates";
              client_Moskuitto.publish(sensor_value_topic.c_str(), command, true);
              params.machine_1_state = STATE_IDLE;
              params.gates_state     = "both_done";
              params.gates_progress  = 100;
              publishEspStatusNow();
              publishEspEvent("state", "gates", "both", "done");
              Serial.print("\n Finished BOTH GATES...");
              // Immediately re-publish idle so the panel clears the
              // corner overlay without waiting on the 60 s heartbeat.
              params.gates_state    = "idle";
              params.gates_progress = -1;
              publishEspStatusNow();
            }
          }
          break;
      }
      break;
  }
}

// ─── Pulse helpers — toggle relay between ON / OFF on each call ──────────
void Barrier_Pulse() {
  switch (params.relay_state) {
    case ON:
      digitalWrite(Relay_2, HIGH);
      params.relay_state = OFF;
      Serial.print("\n Barrier Relay ON");
      break;
    case OFF:
      digitalWrite(Relay_2, LOW);
      params.relay_state = ON;
      Serial.print("\n Barrier Relay OFF");
      break;
  }
}

void Gate_Pulse() {
  switch (params.relay_state) {
    case ON:
      digitalWrite(Relay_1, HIGH);
      params.relay_state = OFF;
      Serial.print("\n Gate Relay ON");
      break;
    case OFF:
      digitalWrite(Relay_1, LOW);
      params.relay_state = ON;
      Serial.print("\n Gate Relay OFF");
      break;
  }
}
