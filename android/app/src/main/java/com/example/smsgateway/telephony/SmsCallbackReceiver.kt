package com.example.smsgateway.telephony

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsMessage
import com.example.smsgateway.GatewayApplication
import com.example.smsgateway.data.DeviceEvent
import com.example.smsgateway.data.Journal
import com.example.smsgateway.messaging.SyncScheduler
import java.util.UUID

class SmsCallbackReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val uri = intent.data ?: return
        if (uri.scheme != "gateway" || uri.pathSegments.size != 2) return
        val result = resultCode
        val pending = goAsync()
        GatewayApplication.executor.execute {
            try {
                val dao = Journal.get(context).dao()
                val attempt = dao.attempt(uri.pathSegments[0]) ?: return@execute
                if (attempt.callbackId != uri.pathSegments[1]) return@execute
                val type = when (uri.authority) {
                    "sent" -> if (result == Activity.RESULT_OK) "SENT_TO_CARRIER" else "UNKNOWN"
                    "delivery" -> {
                        val pdu = intent.getByteArrayExtra("pdu") ?: return@execute
                        val message = SmsMessage.createFromPdu(pdu, intent.getStringExtra("format") ?: "3gpp") ?: return@execute
                        if (message.status == 0) "DELIVERED" else return@execute
                    }
                    else -> return@execute
                }
                val eventId = UUID.nameUUIDFromBytes("${attempt.jobId}:$type".toByteArray()).toString()
                dao.addEvent(DeviceEvent(eventId, attempt.jobId, attempt.leaseId, type, System.currentTimeMillis()))
                SyncScheduler.enqueue(context)
            } finally { pending.finish() }
        }
    }
}
