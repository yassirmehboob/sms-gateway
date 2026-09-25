package com.example.smsgateway

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import com.example.smsgateway.data.*
import com.example.smsgateway.messaging.SyncScheduler
import com.example.smsgateway.messaging.GatewayForegroundService
import com.example.smsgateway.security.*
import com.example.smsgateway.telephony.PhoneState
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.util.UUID

class MainActivity : Activity() {
    private lateinit var secrets: SecretStore
    private lateinit var status: TextView
    private lateinit var layout: LinearLayout
    private val statusHandler = Handler(Looper.getMainLooper())
    private val statusRefresh = object : Runnable {
        override fun run() { refresh(); statusHandler.postDelayed(this, 5000) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        secrets = SecretStore(this)
        layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        val scroll = ScrollView(this).apply { addView(layout) }
        scroll.setOnApplyWindowInsetsListener { view, insets -> view.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom); insets }
        setContentView(scroll)
        label("SMS Gateway", 26f)
        label("Dedicated phone • private deployment\nStarts paused. Only approved, single-segment messages are supported.")
        status = label("Loading…")
        val origin = field(if (BuildConfig.DEBUG) "API origin (HTTPS or local HTTP)" else "HTTPS API origin", secrets.get("origin") ?: "")
        val device = field("Operator-assigned device UUID", secrets.get("deviceId") ?: "")
        button("Save gateway identity") {
            try {
                val url = Protocol.origin(origin.text.toString(), BuildConfig.DEBUG); val id = UUID.fromString(device.text.toString().trim()).toString()
                require(secrets.get("origin").let { it == null || it == url } && secrets.get("deviceId").let { it == null || it == id })
                secrets.put("origin", url); secrets.put("deviceId", id); secrets.paused = true
                toast("Gateway saved and paused")
            } catch (_: Exception) { toast("Check the API origin and UUID. Debug builds allow HTTP with a private IPv4 address. A saved identity cannot be replaced.") }
        }
        button("Copy public key for operator") {
            val pem = DeviceIdentity().publicPem()
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Gateway public key", pem))
            toast("Public key copied. SHA-256: ${Protocol.hash(pem.toByteArray()).take(16)}")
        }
        button("Grant SMS, reply and notification permissions") {
            val permissions = mutableListOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_PHONE_STATE, Manifest.permission.RECEIVE_SMS)
            if (Build.VERSION.SDK_INT >= 33) permissions.add(Manifest.permission.POST_NOTIFICATIONS)
            requestPermissions(permissions.toTypedArray(), 1)
        }
        label("Reply handling: only STOP and START on the selected SIM are processed. Background mode uses an ongoing notification and more battery; keep this dedicated phone charged.")
        button("Open app settings / battery settings") { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
        button("Confirm approved SIM") {
            val sims = PhoneState(this, secrets).subscriptions()
            if (sims.isEmpty()) { toast("Grant phone permission and insert an active SIM"); return@button }
            AlertDialog.Builder(this).setTitle("Select the operator-approved SIM").setItems(sims.map { "Slot ${it.simSlotIndex + 1}: ${it.carrierName} (subscription ${it.subscriptionId})" }.toTypedArray()) { _, index ->
                synchronized(GatewayApplication.sendLock) {
                    secrets.paused = true
                    val sim = sims[index]
                    secrets.put("subscriptionId", sim.subscriptionId.toString()); secrets.put("simSlot", sim.simSlotIndex.toString()); secrets.put("carrierId", sim.carrierId.toString())
                }
                toast("SIM selected; gateway remains paused"); refresh()
            }.show()
        }
        val challenge = field("One-time enrollment token", "").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setSaveEnabled(false) }
        button("Enroll with approved key") {
            val token = challenge.text.toString().trim(); challenge.text.clear()
            background {
                val reply = GatewayApi(secrets).post("/enroll", JSONObject().put("enrollmentToken", token))
                confirmEnrollment(reply)
            }
        }
        button("Recover enrollment / check server") { background { confirmEnrollment(GatewayApi(secrets).post("/heartbeat", PhoneState(this, secrets).json())) } }
        button("Resume gateway") {
            try {
                require(secrets.get("enrolled") == "true")
                synchronized(GatewayApplication.sendLock) {
                    secrets.paused = false
                    if (!PhoneState(this, secrets).ready()) { secrets.paused = true; error("Not ready") }
                }
                GatewayForegroundService.start(this)
                SyncScheduler.enqueue(this); refresh()
            } catch (_: Exception) { toast("Complete enrollment and confirm SIM/permissions first") }
        }
        button("PAUSE — stop new local sends") {
            synchronized(GatewayApplication.sendLock) { secrets.paused = true }
            GatewayForegroundService.stop(this)
            refresh(); toast("Paused. A message already submitted cannot be recalled.")
        }
        button("Sync now / refresh status") { SyncScheduler.enqueue(this); refresh() }
        try { FirebaseMessaging.getInstance().token.addOnSuccessListener { secrets.put("fcmToken", it); SyncScheduler.enqueue(this) } } catch (_: IllegalStateException) { /* Manual/periodic sync works without Firebase configuration. */ }
        refresh()
    }
    override fun onResume() {
        super.onResume()
        statusHandler.post(statusRefresh)
        if (!secrets.paused && secrets.get("enrolled") == "true") {
            try { GatewayForegroundService.start(this) }
            catch (_: IllegalStateException) { toast("Tap Resume gateway to restart background mode") }
        }
    }
    override fun onPause() { statusHandler.removeCallbacks(statusRefresh); super.onPause() }
    private fun confirmEnrollment(reply: JSONObject) {
        require(reply.getInt("subscriptionId") == PhoneState(this, secrets).subscriptionId())
        if (secrets.get("enrolled") != "true") secrets.paused = true
        secrets.put("enrolled", "true")
    }
    private fun background(action: () -> Unit) {
        GatewayApplication.executor.execute {
            val success = try { action(); true } catch (_: Exception) { false }
            runOnUiThread { toast(if (success) "Enrollment confirmed. ${if (secrets.paused) "Gateway is paused." else "Gateway remains enabled."}" else "Request failed. Check origin, key approval, SIM, token and device clock."); refresh() }
        }
    }
    private fun refresh() {
        GatewayApplication.executor.execute {
            val count = Journal.get(this).dao().count()
            val blocked = Journal.get(this).dao().blockedCount()
            val controls = Journal.get(this).dao().controlCount()
            runOnUiThread { status.text = "${if (secrets.paused) "PAUSED" else "ENABLED LOCALLY"} • ${if (secrets.get("enrolled") == "true") "Enrolled" else "Not enrolled"}\nSubscription: ${secrets.get("subscriptionId") ?: "not selected"}\nJournaled attempts: $count\nEvents needing operator review: $blocked\nPending/rejected STOP/START commands: $controls\n${secrets.get("lastSync") ?: "No sync yet"}\nServer pause and policy are checked before each attempt." }
        }
    }
    private fun label(text: String, size: Float = 16f) = TextView(this).apply { this.text = text; textSize = size; setPadding(0, 12, 0, 12); this@MainActivity.layout.addView(this) }
    private fun field(hint: String, value: String) = EditText(this).apply { this.hint = hint; setSingleLine(); setText(value); this@MainActivity.layout.addView(this) }
    private fun button(text: String, action: () -> Unit) { layout.addView(Button(this).apply { this.text = text; setOnClickListener { action() } }) }
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
