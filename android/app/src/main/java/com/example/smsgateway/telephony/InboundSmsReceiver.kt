package com.example.smsgateway.telephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager
import com.example.smsgateway.GatewayApplication
import com.example.smsgateway.data.*
import com.example.smsgateway.messaging.SyncScheduler
import com.example.smsgateway.security.*
import org.json.JSONObject
import java.util.UUID

class InboundSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val pending = goAsync()
        GatewayApplication.executor.execute {
            try {
                val secrets = SecretStore(context)
                if (secrets.get("enrolled") != "true") return@execute
                // Missing or ambiguous receiving-SIM metadata is rejected, never guessed.
                @Suppress("DEPRECATION")
                val sub = ((intent.extras?.get(SubscriptionManager.EXTRA_SUBSCRIPTION_INDEX)
                    ?: intent.extras?.get("subscription")) as? Number)?.toInt() ?: return@execute
                if (sub != PhoneState(context, secrets).subscriptionId()) return@execute
                val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent)
                if (parts.isEmpty() || parts.size > 2) return@execute
                val from = InboundParser.number(parts.first().originatingAddress ?: "") ?: return@execute
                if (parts.any { InboundParser.number(it.originatingAddress ?: "") != from }) return@execute
                val command = InboundParser.command(parts.joinToString("") { it.messageBody ?: "" }) ?: return@execute
                val receivedAt = parts.first().timestampMillis
                if (receivedAt <= 0) return@execute
                val eventId = UUID.nameUUIDFromBytes("$sub|$from|$receivedAt|$command".toByteArray(Charsets.UTF_8)).toString()
                val json = JSONObject().put("eventId", eventId).put("from", from).put("command", command)
                    .put("subscriptionId", sub).put("receivedAt", receivedAt)
                val journal = Journal.get(context)
                synchronized(GatewayApplication.sendLock) {
                    journal.runInTransaction {
                        if (journal.dao().addControl(InboundControl(eventId, secrets.encrypt("inbound:$eventId", json.toString()), receivedAt)) != -1L) {
                            // Both commands wait for server reconciliation before ordinary sends.
                            journal.dao().setLocalRecipient(LocalRecipient(Protocol.hash(from.toByteArray()), true, eventId))
                        }
                    }
                }
                SyncScheduler.enqueue(context)
            } catch (_: Exception) {
                // If durable inbound handling fails, stop new sends until operator review.
                synchronized(GatewayApplication.sendLock) { SecretStore(context).paused = true }
            } finally { pending.finish() }
        }
    }
}
