package com.example.smsgateway.telephony

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import com.example.smsgateway.data.Attempt

class SmsSender(private val context: Context) {
    @Suppress("DEPRECATION") private fun manager(subscription: Int): SmsManager = if (Build.VERSION.SDK_INT >= 31) context.getSystemService(SmsManager::class.java).createForSubscriptionId(subscription) else SmsManager.getSmsManagerForSubscriptionId(subscription)
    fun singleSegment(subscription: Int, body: String) = manager(subscription).divideMessage(body).size == 1
    fun send(attempt: Attempt, to: String, body: String) {
        val sent = callback(attempt, "sent", PendingIntent.FLAG_IMMUTABLE)
        // Delivery PDU/status must be filled by the system; this explicit intent
        // targets a non-exported receiver and carries a persisted random capability.
        val deliveryFlags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val delivered = callback(attempt, "delivery", deliveryFlags)
        manager(attempt.subscriptionId).sendTextMessage(to, null, body, sent, delivered)
    }
    private fun callback(attempt: Attempt, type: String, flags: Int): PendingIntent {
        val intent = Intent(context, SmsCallbackReceiver::class.java).setAction("com.example.smsgateway.$type")
            .setData(Uri.Builder().scheme("gateway").authority(type).appendPath(attempt.jobId).appendPath(attempt.callbackId).build())
        return PendingIntent.getBroadcast(context, 0, intent, flags or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
