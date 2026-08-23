package com.muroch.carcam

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallback
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * On-demand car-camera snapshot service.
 *
 * Flow: a foreground service holds an MQTT connection (broker LXC 107) and
 * subscribes to `mur/home/esp/car_camera/command`. On a `{"action":"snapshot"}`
 * message it opens the camera, captures ONE JPEG, RELEASES the camera (off
 * between shots — low power for a parked car), uploads the frame to the media
 * agent (LXC 100 `:8767/api/media/upload` → `Car Snapshots/`), and publishes an
 * ack on `.../status`. Camera work runs on the main thread (CameraX requirement);
 * the service is its own LifecycleOwner via a LifecycleRegistry.
 *
 * Can also be triggered locally for testing:
 *   adb shell am start-foreground-service -n com.muroch.carcam/.CarCamService -a com.muroch.carcam.SNAPSHOT
 */
class CarCamService : Service(), LifecycleOwner {

    companion object {
        private const val TAG = "CarCam"
        const val ACTION_SNAPSHOT = "com.muroch.carcam.SNAPSHOT"

        private const val MQTT_URL = "tcp://192.168.1.189:1883"
        private const val MQTT_USER = "esp_boards"
        private const val CMD_TOPIC = "mur/home/esp/car_camera/command"
        private const val STATUS_TOPIC = "mur/home/esp/car_camera/status"
        private const val UPLOAD_URL = "http://192.168.1.138:8767/api/media/upload"
        private const val TARGET_DIR = "Car Snapshots"

        private const val CHANNEL_ID = "carcam"
        private const val NOTIF_ID = 42
    }

    private val lifecycleRegistry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = lifecycleRegistry

    private val main = Handler(Looper.getMainLooper())
    private var mqtt: MqttAsyncClient? = null
    @Volatile private var capturing = false

    override fun onCreate() {
        super.onCreate()
        lifecycleRegistry.currentState = Lifecycle.State.CREATED
        startForeground(NOTIF_ID, buildNotification("Car Cam ready"))
        lifecycleRegistry.currentState = Lifecycle.State.RESUMED
        connectMqtt()
        Log.i(TAG, "service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_SNAPSHOT) {
            Log.i(TAG, "snapshot triggered via intent")
            main.post { captureAndUpload("manual") }
        }
        return START_STICKY
    }

    // ─── MQTT ────────────────────────────────────────────────────────────
    private fun connectMqtt() {
        thread(name = "carcam-mqtt") {
            try {
                val c = MqttAsyncClient(MQTT_URL, "carcam_" + System.currentTimeMillis(), MemoryPersistence())
                c.setCallback(object : MqttCallback {
                    override fun connectionLost(cause: Throwable?) { Log.w(TAG, "mqtt lost: ${cause?.message}") }
                    override fun messageArrived(topic: String?, message: MqttMessage?) {
                        Log.i(TAG, "cmd on $topic: ${message?.payload?.let { String(it) }}")
                        main.post { captureAndUpload("mqtt") }
                    }
                    override fun deliveryComplete(token: org.eclipse.paho.client.mqttv3.IMqttDeliveryToken?) {}
                })
                val opts = MqttConnectOptions().apply {
                    userName = MQTT_USER
                    password = Secrets.MQTT_PASS.toCharArray()
                    isAutomaticReconnect = true
                    isCleanSession = true
                    connectionTimeout = 10
                    keepAliveInterval = 60
                }
                c.connect(opts).waitForCompletion(10_000)
                c.subscribe(CMD_TOPIC, 1)
                mqtt = c
                Log.i(TAG, "mqtt connected + subscribed $CMD_TOPIC")
                publishStatus("{\"state\":\"ready\"}")
            } catch (e: Exception) {
                Log.e(TAG, "mqtt connect failed: ${e.message}", e)
                main.postDelayed({ connectMqtt() }, 15_000)
            }
        }
    }

    private fun publishStatus(json: String) {
        try { mqtt?.takeIf { it.isConnected }?.publish(STATUS_TOPIC, MqttMessage(json.toByteArray()).apply { qos = 0 }) }
        catch (e: Exception) { Log.w(TAG, "status publish: ${e.message}") }
    }

    // ─── Capture (main thread) → upload (bg thread) ─────────────────────
    private fun captureAndUpload(source: String) {
        if (capturing) { Log.i(TAG, "already capturing, ignoring"); return }
        capturing = true
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                val imageCapture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                // Dummy preview so the camera actually STREAMS — headless ImageCapture
                // alone doesn't run the sensor, so auto-exposure never converges and the
                // first frame comes out black. Feed preview to a throwaway SurfaceTexture.
                val preview = Preview.Builder().build()
                preview.setSurfaceProvider { request ->
                    val tex = SurfaceTexture(0).apply {
                        setDefaultBufferSize(request.resolution.width, request.resolution.height)
                    }
                    val surface = Surface(tex)
                    request.provideSurface(surface, ContextCompat.getMainExecutor(this)) {
                        surface.release(); tex.release()
                    }
                }
                provider.unbindAll()
                // Forward-facing = rear main camera (faces out when the screen faces the driver).
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageCapture)
                // Let the sensor stream + AE/AWB settle before the shot (else black/dark frame).
                main.postDelayed({
                imageCapture.takePicture(ContextCompat.getMainExecutor(this),
                    object : ImageCapture.OnImageCapturedCallback() {
                        override fun onCaptureSuccess(image: ImageProxy) {
                            val bytes = jpegBytes(image)
                            image.close()
                            provider.unbindAll()          // camera OFF
                            capturing = false
                            Log.i(TAG, "captured ${bytes.size} bytes ($source)")
                            thread(name = "carcam-upload") { upload(bytes) }
                        }
                        override fun onError(exc: ImageCaptureException) {
                            provider.unbindAll(); capturing = false
                            Log.e(TAG, "capture error: ${exc.message}", exc)
                            publishStatus("{\"state\":\"error\",\"err\":\"capture\"}")
                        }
                    })
                }, 1500L)
            } catch (e: Exception) {
                capturing = false
                Log.e(TAG, "camera bind error: ${e.message}", e)
                publishStatus("{\"state\":\"error\",\"err\":\"bind\"}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun jpegBytes(image: ImageProxy): ByteArray {
        val buffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        return bytes
    }

    // ─── Upload (multipart, HttpURLConnection — no extra dep) ────────────
    private fun upload(jpeg: ByteArray) {
        // Fixed name → overwrites, so the dashboard always shows "the latest" with no
        // clutter and no "find newest" logic. (History could be a timestamped 2nd upload later.)
        val fname = "latest.jpg"
        val boundary = "----carcam" + System.currentTimeMillis()
        try {
            val conn = (URL(UPLOAD_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"; doOutput = true; connectTimeout = 15_000; readTimeout = 30_000
                setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            }
            DataOutputStream(conn.outputStream).use { out ->
                fun field(name: String, value: String) {
                    out.writeBytes("--$boundary\r\n")
                    out.writeBytes("Content-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n")
                }
                field("relativePath", fname)
                field("targetPath", TARGET_DIR)
                out.writeBytes("--$boundary\r\n")
                out.writeBytes("Content-Disposition: form-data; name=\"file\"; filename=\"$fname\"\r\n")
                out.writeBytes("Content-Type: image/jpeg\r\n\r\n")
                out.write(jpeg); out.writeBytes("\r\n")
                out.writeBytes("--$boundary--\r\n")
            }
            val code = conn.responseCode
            Log.i(TAG, "upload HTTP $code, file=$fname")
            publishStatus("{\"state\":\"uploaded\",\"http\":$code,\"file\":\"$fname\"}")
            conn.disconnect()
        } catch (e: Exception) {
            Log.e(TAG, "upload failed: ${e.message}", e)
            publishStatus("{\"state\":\"error\",\"err\":\"upload\"}")
        }
    }

    // ─── boilerplate ────────────────────────────────────────────────────
    private fun buildNotification(text: String): Notification {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Car Cam", NotificationManager.IMPORTANCE_LOW))
            }
        }
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setContentTitle("Car Cam").setContentText(text).setSmallIcon(android.R.drawable.ic_menu_camera).build()
    }

    override fun onDestroy() {
        try { mqtt?.disconnectForcibly() } catch (_: Exception) {}
        lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
