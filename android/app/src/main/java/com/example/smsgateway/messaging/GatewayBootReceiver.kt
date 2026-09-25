package com.example.smsgateway.messaging

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.example.smsgateway.security.SecretStore

class GatewayBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
        val secrets = SecretStore(context)
        SyncScheduler.periodic(context)
        SyncScheduler.enqueue(context)
        if (!secrets.paused && secrets.get("enrolled") == "true") {
            try { GatewayForegroundService.start(context) }
            catch (_: IllegalStateException) { secrets.put("lastSync", "Open the app to restart background gateway mode") }
        }
    }
}
