package com.muroch.carcam

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/** Start the snapshot service on boot so the car phone is always ready. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED) {
            ContextCompat.startForegroundService(context, Intent(context, CarCamService::class.java))
        }
    }
}
