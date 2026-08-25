package com.muroch.frcamera

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Bundle
import android.util.Log
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
import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * FR Camera — entrance face-recognition camera node (LineageOS A71).
 *
 * FEATURE 1 (2026-08-25): front camera → MJPEG stream on :8080.
 *   - CameraX front cam (RGBA frames via ImageAnalysis)
 *   - each frame → rotate upright → JPEG → published as the "latest frame"
 *   - NanoHTTPD MjpegServer serves it at http://<ip>:8080/  (go2rtc pulls it)
 *   - local PreviewView + a status line
 *
 * NEXT: Paho MQTT client + status UI (Recognizing / Welcome / Not allowed),
 * once LXC 112 (the recognizer) exists. Architecture A — phone = camera + screen.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private lateinit var previewView: PreviewView
    private val analysisExecutor = Executors.newSingleThreadExecutor()

    @Volatile private var latestJpeg: ByteArray? = null
    private var mjpeg: MjpegServer? = null
    private lateinit var faceFrame: FaceFrameView

    // TEST/inject trigger (LXC 112 will drive the same setState over MQTT later):
    //   adb shell am broadcast -a com.muroch.frcamera.STATE --es state allowed --es name Vadim
    //   states: idle | allowed | denied | unknown
    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            val nm = i?.getStringExtra("name") ?: ""
            val st = when ((i?.getStringExtra("state") ?: "idle").lowercase()) {
                "allowed" -> FaceFrameView.St.ALLOWED
                "denied"  -> FaceFrameView.St.DENIED
                "unknown" -> FaceFrameView.St.UNKNOWN
                else       -> FaceFrameView.St.IDLE
            }
            faceFrame.setState(st, nm)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)
        previewView = findViewById(R.id.preview)
        faceFrame = findViewById(R.id.faceframe)
        ContextCompat.registerReceiver(
            this, stateReceiver, IntentFilter(ACTION_STATE), ContextCompat.RECEIVER_EXPORTED
        )

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

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(stateReceiver) } catch (_: Exception) {}
        try { mjpeg?.stop() } catch (_: Exception) {}
        analysisExecutor.shutdown()
    }

    companion object {
        const val TAG = "FRCamera"
        const val REQ_CAM = 1
        const val ACTION_STATE = "com.muroch.frcamera.STATE"
    }
}
