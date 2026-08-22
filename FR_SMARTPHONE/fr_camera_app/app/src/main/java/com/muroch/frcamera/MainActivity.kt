package com.muroch.frcamera

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * FR Camera — entrance face-recognition camera node (LineageOS A71).
 *
 * SCAFFOLD (2026-08-22). Builds + runs. The real logic gets filled in in-flight:
 *   - CameraX front-camera capture (32 MP door face-panel)
 *   - NanoHTTPD MJPEG server on :8080  -> go2rtc pulls it (phone_entrance_cam)
 *   - Paho MQTT client -> receive FR result -> update the status UI
 *   - Status UI: "Recognizing…" / "Welcome, <name>" / "Not allowed"
 *
 * Architecture A: the phone is ONLY the camera + a status screen; recognition
 * runs on LXC 112. See FR_SMARTPHONE/CLAUDE.md + FR_BACKEND_PLAN.md.
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        findViewById<TextView>(R.id.status).text = "FR Camera — scaffold ready"
        // TODO(in-flight): request CAMERA permission, start CameraX front cam,
        // start MJPEG server, connect MQTT, wire status updates.
    }
}
