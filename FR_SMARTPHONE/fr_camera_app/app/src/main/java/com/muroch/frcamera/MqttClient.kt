package com.muroch.frcamera

import android.util.Log
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * The phone's MQTT "ear": connects to the home broker (LXC 107), subscribes to
 * the FR state topic, and hands each message to `onState(state, name)`. The LXC
 * (corridor presence + LXC 112 recogniser) publishes there; the phone just obeys.
 *
 * Payload accepted:
 *   JSON  {"state":"allowed","name":"Vadim"}   (preferred)
 *   plain  "black"                              (state only)
 * States: idle | allowed | denied | unknown | black|sleep|off
 *
 * Auto-reconnects + re-subscribes (clean session), so a dropped WiFi / a
 * not-yet-reachable broker (phone away from home) self-heals when it's back.
 */
class MqttClient(
    private val host: String,
    private val user: String,
    private val pass: String,
    private val topic: String,
    private val onState: (String, String) -> Unit,
) {
    private var client: MqttAsyncClient? = null

    fun connect() {
        thread(name = "fr-mqtt") {
            try {
                val c = MqttAsyncClient("tcp://$host:1883", "fr_phone_" + System.currentTimeMillis(), MemoryPersistence())
                c.setCallback(object : MqttCallbackExtended {
                    override fun connectComplete(reconnect: Boolean, serverURI: String?) {
                        try { c.subscribe(topic, 1) } catch (e: Exception) { Log.w(TAG, "resub: ${e.message}") }
                        Log.i(TAG, if (reconnect) "MQTT RECONNECTED + subscribed $topic" else "MQTT connected + subscribed $topic")
                    }
                    override fun connectionLost(cause: Throwable?) { Log.w(TAG, "mqtt lost: ${cause?.message}") }
                    override fun messageArrived(t: String?, m: MqttMessage?) {
                        val payload = m?.payload?.let { String(it) }?.trim() ?: return
                        Log.i(TAG, "state msg: $payload")
                        try {
                            val j = JSONObject(payload)
                            onState(j.optString("state", "idle"), j.optString("name", ""))
                        } catch (e: Exception) {
                            onState(payload, "")   // allow a plain-string payload ("black" etc.)
                        }
                    }
                    override fun deliveryComplete(token: IMqttDeliveryToken?) {}
                })
                val opts = MqttConnectOptions().apply {
                    userName = user
                    password = pass.toCharArray()
                    isAutomaticReconnect = true
                    isCleanSession = true
                    connectionTimeout = 10
                    keepAliveInterval = 30
                }
                c.connect(opts).waitForCompletion(10_000)
                client = c
                Log.i(TAG, "MQTT connect() to tcp://$host:1883 issued")
            } catch (e: Exception) {
                Log.e(TAG, "mqtt connect failed: ${e.message} (auto-reconnect will retry)", e)
            }
        }
    }

    fun disconnect() {
        try { client?.disconnectForcibly() } catch (_: Exception) {}
    }

    companion object { const val TAG = "FRMqtt" }
}
