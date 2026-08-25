package com.muroch.frcamera

import android.app.admin.DeviceAdminReceiver

/**
 * Device-admin component for kiosk mode ("survive unauthorized touch").
 *
 * Once this app is made DEVICE-OWNER (one-time, over adb, on the de-Googled A71
 * which has no accounts):
 *
 *     adb shell dpm set-device-owner com.muroch.frcamera/.FrAdminReceiver
 *
 * MainActivity can then silently enter Lock Task Mode — the app is pinned to the
 * front and every touch stays inside it (no swipe-away, no recents, no home, no
 * launching anything else). To undo: adb shell dpm remove-active-admin, or a
 * factory reset. Until device-owner is set, the app runs normally (kiosk lock
 * simply stays inactive), so installing is always safe.
 */
class FrAdminReceiver : DeviceAdminReceiver()
