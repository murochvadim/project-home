package com.muroch.frcamera

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * FR Camera — entrance face-recognition camera PANEL (de-Googled LineageOS A71).
 * Architecture A: the phone is ONLY the camera + status screen; recognition and
 * enrollment run on LXC 112, which drives the screen over MQTT.
 *
 *  - CameraX front cam → JPEG → MjpegServer on :8080 (go2rtc / LXC 112 pull it)
 *  - MqttClient subscribes to mur/home/esp/fr_entrance/state → applyState():
 *      black / idle / allowed / denied / unknown  +  enroll* (face-learning)
 *  - FrCameraService keep-alive + BootReceiver auto-start + device-owner kiosk
 *    (Lock Task Mode) make it a tamper-proof, self-healing wall panel.
 * Test any state over adb (see applyState); LXC 112 sends the same over MQTT.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private lateinit var previewView: PreviewView
    private val analysisExecutor = Executors.newSingleThreadExecutor()

    @Volatile private var latestJpeg: ByteArray? = null
    private var mjpeg: MjpegServer? = null
    private lateinit var faceFrame: FaceFrameView

    // TEST/inject trigger (LXC 112 drives the same applyState over MQTT):
    //   adb shell am broadcast -a com.muroch.frcamera.STATE --es state allowed --es name Vadim
    //   states: black|idle|allowed|denied|unknown|enroll|enroll_guide|enroll_closer|
    //           enroll_back|enroll_straight|enroll_dark|enroll_trying|enroll_retry|enroll_done
    private var mqtt: MqttClient? = null

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            applyState(i?.getStringExtra("state") ?: "idle", i?.getStringExtra("name") ?: "")
        }
    }

    // Kiosk escape hatch — controllable over adb so we're NEVER stuck:
    //   unlock  : leave lock-task (stay out until 'lock')   — screen usable again
    //   lock    : re-enter kiosk lock-task
    //   release : leave lock-task AND drop device-owner (full undo, no factory reset)
    // adb shell am broadcast -a com.muroch.frcamera.KIOSK --es cmd unlock
    @Volatile private var kioskWanted = true
    private val kioskReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            when (i?.getStringExtra("cmd")) {
                "unlock" -> { kioskWanted = false; try { stopLockTask() } catch (_: Exception) {}; Log.i(TAG, "kiosk UNLOCKED (adb)") }
                "lock"   -> { kioskWanted = true; enterKioskIfOwner() }
                "release" -> {
                    kioskWanted = false
                    try { stopLockTask() } catch (_: Exception) {}
                    try {
                        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                        @Suppress("DEPRECATION") dpm.clearDeviceOwnerApp(packageName)
                        Log.i(TAG, "device-owner CLEARED (adb release)")
                    } catch (e: Exception) { Log.w(TAG, "clear owner: ${e.message}") }
                }
            }
        }
    }

    /** Apply an FR state — from the adb test broadcast OR the LXC over MQTT.
     *  The LXC decides presence + enrollment steps; the phone just displays.
     *  `enroll` shows the [Start FR] ready screen; the other enroll_* states are
     *  the face-learning steps. See the README state table for the full contract
     *  (which LXC 112 detection condition maps to which message). */
    private fun applyState(state: String, name: String) = runOnUiThread {
        val s = state.lowercase()
        btnStartFr.visibility = if (s == "enroll") View.VISIBLE else View.GONE
        when (s) {
            "black", "sleep", "off" -> sleep()   // no presence → black
            "allowed" -> { wake(); faceFrame.setState(FaceFrameView.St.ALLOWED, name) }
            "denied"  -> { wake(); faceFrame.setState(FaceFrameView.St.DENIED, name) }
            "unknown" -> { wake(); faceFrame.setState(FaceFrameView.St.UNKNOWN, name) }
            "enroll"          -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL) }
            "enroll_guide"    -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_GUIDE) }
            "enroll_closer"   -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_CLOSER) }
            "enroll_back"     -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_BACK) }
            "enroll_straight" -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_STRAIGHT) }
            "enroll_dark"     -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_DARK) }
            "enroll_trying"   -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_TRYING) }
            "enroll_retry"    -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_RETRY) }
            "enroll_done"     -> { wake(); faceFrame.setState(FaceFrameView.St.ENROLL_DONE, name) }
            else       -> { wake(); faceFrame.setState(FaceFrameView.St.IDLE, name) }
        }
    }

    /** Start FR = the phone-side "I'm ready": tell LXC 112 the person is set;
     *  LXC 112 then drives enroll_guide → trying → retry → done back over MQTT. */
    private fun onStartFr() {
        val enrollTopic = Secrets.MQTT_TOPIC.removeSuffix("/state") + "/enroll"
        mqtt?.publish(enrollTopic, "ready")
        btnStartFr.visibility = View.GONE
        faceFrame.setState(FaceFrameView.St.ENROLL_GUIDE)   // immediate feedback while LXC starts
    }

    // Wake/sleep is driven by the LXC (corridor presence / FR), NOT the phone.
    // sleep() covers the screen with black (#000000) + minimal brightness
    // (AMOLED → near-zero power); the camera + MJPEG stream keep running under
    // the cover so the FR backend still gets frames. wake() shows.
    private lateinit var black: View
    private lateinit var btnStartFr: Button

    private fun wake() {
        black.visibility = View.GONE
        setBrightness(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE)  // -1 = system default
    }

    private fun sleep() {
        black.visibility = View.VISIBLE
        setBrightness(0.01f)
    }

    private fun setBrightness(b: Float) {
        val lp = window.attributes; lp.screenBrightness = b; window.attributes = lp
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // Immersive kiosk: hide status + nav bars (clean panel + fully-black idle screen).
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        status = findViewById(R.id.status)
        previewView = findViewById(R.id.preview)
        faceFrame = findViewById(R.id.faceframe)
        black = findViewById(R.id.black)
        btnStartFr = findViewById(R.id.btn_start_fr)
        btnStartFr.setOnClickListener { onStartFr() }
        ContextCompat.registerReceiver(
            this, stateReceiver, IntentFilter(ACTION_STATE), ContextCompat.RECEIVER_EXPORTED
        )
        ContextCompat.registerReceiver(
            this, kioskReceiver, IntentFilter(ACTION_KIOSK), ContextCompat.RECEIVER_EXPORTED
        )
        sleep()   // start BLACK (no presence); the LXC wakes it on presence
        mqtt = MqttClient(Secrets.MQTT_HOST, Secrets.MQTT_USER, Secrets.MQTT_PASS, Secrets.MQTT_TOPIC) {
            s, n -> applyState(s, n)
        }.also { it.connect() }

        FrCameraService.start(this)      // keep-alive: the process (camera+MJPEG+MQTT) runs always
        requestNotifPermission()         // so the ongoing keep-alive notification can show (API 33+)
        selfAllowlistLockTaskIfOwner()   // device-owner kiosk allowlist (no-op until provisioned)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) {
            start()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), REQ_CAM)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAM &&
            grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            start()
        } else {
            status.text = "CAMERA permission denied"
        }
    }

    private fun start() {
        startCamera()
        startMjpeg()
    }

    // ─── CameraX front camera → latestJpeg ───────────────────────────────
    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(analysisExecutor) { img -> onFrame(img) }

                provider.unbindAll()
                provider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_FRONT_CAMERA, preview, analysis
                )
                runOnUiThread { status.text = "● live · MJPEG :8080" }
            } catch (e: Exception) {
                Log.e(TAG, "camera bind failed", e)
                runOnUiThread { status.text = "Camera failed: ${e.message}" }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun onFrame(image: ImageProxy) {
        try {
            var bmp: Bitmap = image.toBitmap()
            val rot = image.imageInfo.rotationDegrees
            if (rot != 0) {
                val m = Matrix().apply { postRotate(rot.toFloat()) }
                bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            }
            val baos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 70, baos)
            latestJpeg = baos.toByteArray()
        } catch (e: Exception) {
            Log.w(TAG, "frame error: ${e.message}")
        } finally {
            image.close()
        }
    }

    // ─── MJPEG server on :8080 ───────────────────────────────────────────
    private fun startMjpeg() {
        try {
            mjpeg = MjpegServer(8080) { latestJpeg }.also {
                it.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
            }
            Log.i(TAG, "MJPEG server started on :8080")
        } catch (e: Exception) {
            Log.e(TAG, "MJPEG start failed", e)
            runOnUiThread { status.text = "MJPEG failed: ${e.message}" }
        }
    }

    override fun onResume() {
        super.onResume()
        enterKioskIfOwner()   // pin to front (kiosk) when device-owner; else harmless no-op
    }

    // ─── Kiosk / keep-alive helpers ──────────────────────────────────────
    /** Enter Lock Task Mode (kiosk) when we're device-owner — every touch stays
     *  inside the app. No-op (no dialog) until `dpm set-device-owner` is run. */
    private fun enterKioskIfOwner() {
        if (!kioskWanted) return   // held OUT of kiosk by an adb 'unlock'
        try {
            val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            if (dpm.isLockTaskPermitted(packageName)) {
                startLockTask()
                Log.i(TAG, "kiosk lock-task engaged")
            }
        } catch (e: Exception) { Log.w(TAG, "lock-task: ${e.message}") }
    }

    /** If we are device-owner, allowlist ourselves so startLockTask() is silent. */
    private fun selfAllowlistLockTaskIfOwner() {
        try {
            val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            if (dpm.isDeviceOwnerApp(packageName)) {
                val admin = ComponentName(this, FrAdminReceiver::class.java)
                dpm.setLockTaskPackages(admin, arrayOf(packageName))
                dpm.setKeyguardDisabled(admin, true)   // no lock screen on the panel
                Log.i(TAG, "device-owner: lock-task allowlisted + keyguard disabled")
            } else {
                Log.i(TAG, "not device-owner yet — kiosk inactive (adb dpm set-device-owner to enable)")
            }
        } catch (e: Exception) { Log.w(TAG, "self-allowlist: ${e.message}") }
    }

    private fun requestNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        mqtt?.disconnect()
        try { unregisterReceiver(stateReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(kioskReceiver) } catch (_: Exception) {}
        try { mjpeg?.stop() } catch (_: Exception) {}
        analysisExecutor.shutdown()
    }

    companion object {
        const val TAG = "FRCamera"
        const val REQ_CAM = 1
        const val REQ_NOTIF = 2
        const val ACTION_STATE = "com.muroch.frcamera.STATE"
        const val ACTION_KIOSK = "com.muroch.frcamera.KIOSK"
    }
}
