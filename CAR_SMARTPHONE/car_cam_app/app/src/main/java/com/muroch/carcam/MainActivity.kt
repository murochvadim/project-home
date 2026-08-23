package com.muroch.carcam

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Car Cam — on-demand forward-camera snapshot for the car tracker phone.
 * The MainActivity only grants permissions + starts the foreground service;
 * all the work (MQTT command -> capture 1 JPEG -> upload) is in CarCamService,
 * which keeps the camera OFF between shots (low power for a parked car).
 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        findViewById<TextView>(R.id.status).text = "Car Cam — snapshot on command"
        requestPermsThenStart()
    }

    private fun requestPermsThenStart() {
        val need = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (need.isNotEmpty()) ActivityCompat.requestPermissions(this, need.toTypedArray(), 1) else startSvc()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        startSvc()
    }

    private fun startSvc() {
        ContextCompat.startForegroundService(this, Intent(this, CarCamService::class.java))
    }
}
