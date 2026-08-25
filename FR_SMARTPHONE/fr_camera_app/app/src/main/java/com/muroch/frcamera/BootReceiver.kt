package com.muroch.frcamera

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Auto-start on power-up ("survive power loss for X time"). When the phone
 * boots — after a power cut, a reboot, or an app update — this fires and brings
 * the entrance panel back by itself, with no human touch. It starts the
 * keep-alive service, which in turn brings the kiosk activity to the front.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",   // some OEMs use this
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Log.i("FRBoot", "boot (${intent.action}) -> starting panel")
                FrCameraService.start(context)
            }
        }
    }
}
