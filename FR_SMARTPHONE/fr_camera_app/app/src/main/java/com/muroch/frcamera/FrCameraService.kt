package com.muroch.frcamera

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Keep-alive foreground service for the entrance panel ("processes run always").
 *
 * Android will not kill a foreground service, so this keeps the app's PROCESS —
 * and therefore the camera + MJPEG stream + MQTT connection that live in
 * MainActivity — alive no matter what the screen is doing. It holds a CPU
 * wake lock + a high-perf WiFi lock so the panel never dozes off WiFi, and
 * returns START_STICKY so the OS restarts it if it is ever killed. Started by
 * MainActivity (onCreate) and by BootReceiver on power-up.
 */
class FrCameraService : Service() {

    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "frcamera:keepalive").apply {
            setReferenceCounted(false); acquire()
        }
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                   else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifi = wm.createWifiLock(mode, "frcamera:wifi").apply {
            setReferenceCounted(false); acquire()
        }
        Log.i(TAG, "keep-alive service up (wake + wifi locks held)")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Bring the kiosk to the front (e.g. after a boot). NEW_TASK is required
        // from a service context; LineageOS/AOSP allows it, and a device-owner
        // kiosk always may.
        try {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            )
        } catch (e: Exception) { Log.w(TAG, "launch activity: ${e.message}") }
        return START_STICKY
    }

    override fun onDestroy() {
        try { wake?.release() } catch (_: Exception) {}
        try { wifi?.release() } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CH_ID, "Entrance panel", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Keeps the entrance camera panel running"
                    setShowBadge(false)
                }
            )
        }
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CH_ID)
            .setContentTitle("Entrance panel active")
            .setContentText("Camera + door recognition running")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(tap)
            .build()
    }

    companion object {
        const val TAG = "FRService"
        const val CH_ID = "fr_keepalive"
        const val NOTIF_ID = 1001

        /** Start (or re-assert) the keep-alive service. */
        fun start(ctx: Context) {
            val i = Intent(ctx, FrCameraService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }
}
